import { isDeepStrictEqual } from "node:util"
import type { AdmissionContext } from "../checkout/admission.js"
import { admissionInventoryIssues } from "../checkout/admission.js"
import { inventoryAdmissions, type AdmissionInventory } from "../checkout/records.js"
import { refreshLaunchState } from "../handler/mutations.js"
import { join } from "node:path"
import { lstat, readdir } from "node:fs/promises"
import { UUID } from "../control/protocol.js"
import { assertPrivateDirectory } from "../platform/private-state.js"
import { readProviderStateReceipt, removeProviderState } from "./state.js"
import type { AgentInventory, AgentStore } from "./store.js"
import { AgentError, agentFailure, type AgentFailure, type AgentRecord, type AgentTuple } from "./types.js"

export const agentTuple = (record: AgentRecord): AgentTuple => ({ agentId: record.spec.agentId, handlerGeneration: record.spec.handlerGeneration, providerGeneration: record.spec.providerGeneration })

export function crossCheckAgents(context: AdmissionContext, inventory: AgentInventory, admissions: AdmissionInventory): void {
  if (inventory.issues.length || admissionInventoryIssues(context.paths.hostKey, context.mutations.accepted, admissions).length) throw new AgentError("INVALID_AGENT_STATE")
  const agents = new Map(inventory.agents.map(a => [a.spec.agentId, a])), commands = new Map(inventory.commands.map(c => [c.commandId, c]))
  for (const field of ["leaseId", "launchAttemptId", "providerGeneration", "startCommandId"] as const) if (new Set(inventory.agents.map(a => a.spec[field])).size !== agents.size) throw new AgentError("INVALID_AGENT_STATE")
  for (const record of inventory.agents) {
    const spec = record.spec, command = commands.get(spec.startCommandId), launch = context.mutations.accepted.find(e => e.record.launchAttemptId === spec.launchAttemptId)?.record, admission = admissions.records.find(a => a.launchAttemptId === spec.launchAttemptId)
    if (spec.hostId !== context.paths.hostKey || !command || command.op !== "start" || !isDeepStrictEqual(command.target, agentTuple(record))) throw new AgentError("INVALID_AGENT_STATE")
    const selected = command.input as import("./types.js").StartInput
    if (!isDeepStrictEqual({ ...selected.selection, mode: selected.selection.mode ?? spec.selection.mode }, spec.selection)) throw new AgentError("INVALID_AGENT_STATE")
    if (launch) {
      if (launch.agentId !== spec.agentId || launch.leaseId !== spec.leaseId || launch.handlerGeneration !== spec.handlerGeneration || launch.checkoutId !== spec.checkout.checkoutId || !admission || !isDeepStrictEqual(admission.checkout, spec.checkout)) throw new AgentError("INVALID_AGENT_STATE")
    } else if (admission || record.phase === "ready" || record.session !== null) throw new AgentError("INVALID_AGENT_STATE")
  }
  for (const command of inventory.commands) {
    if (command.hostId !== context.paths.hostKey) throw new AgentError("INVALID_AGENT_STATE")
    if (!command.target) continue
    const record = agents.get(command.target.agentId)
    if (!record) {
      if (command.op !== "start" || command.state === "completed" || context.mutations.accepted.some(e => e.record.agentId === command.target!.agentId) || admissions.records.some(a => a.agentId === command.target!.agentId)) throw new AgentError("INVALID_AGENT_STATE")
      continue
    }
    if (!isDeepStrictEqual(command.target, agentTuple(record)) || command.op === "start" && command.commandId !== record.spec.startCommandId || command.result?.outcome === "started" && !isDeepStrictEqual(command.result.session, record.session)) throw new AgentError("INVALID_AGENT_STATE")
  }
}

export async function recoverAgents(input: { context: AdmissionContext; store: AgentStore }): Promise<{ inventory: AgentInventory; unavailable: AgentFailure | null }> {
  const { context, store } = input
  let inventory: AgentInventory = { agents: [], commands: [], issues: [] }
  try {
    await context.mutations.queue.run(async () => {
      await refreshLaunchState(context.state, context.mutations, join(context.paths.persistentRoot, "launches"))
      inventory = await store.inventory()
      crossCheckAgents(context, inventory, await inventoryAdmissions(context.paths.persistentRoot))
      for (const agent of inventory.agents) {
        const next: AgentRecord = ["starting", "ready", "stopping"].includes(agent.phase) ? { ...agent, phase: "interrupted", failure: agentFailure(new AgentError("INCOMPLETE")) } : agent
        await store.writeAgent(next, agent)
      }
      for (const command of inventory.commands) {
        const next = command.state === "pending" ? { ...command, state: "interrupted" as const, result: { outcome: "interrupted" as const, target: command.target, failure: agentFailure(new AgentError("INCOMPLETE")), session: null } } : command
        await store.writeCommand(next, command)
      }
      inventory = await store.inventory()
      crossCheckAgents(context, inventory, await inventoryAdmissions(context.paths.persistentRoot))
      const state = join(context.paths.persistentRoot, "agents", "provider-state")
      let stateEntries: string[] = []
      try {
        await assertPrivateDirectory(state)
        const stat = await lstat(state)
        if ((stat.mode & 0o777) !== 0o700) throw new AgentError("CLEANUP_UNVERIFIED")
        stateEntries = await readdir(state)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AgentError("CLEANUP_UNVERIFIED") }
      const roots = new Set<string>(), receipts = new Map<string, { pending: boolean; complete: boolean }>()
      for (const name of stateEntries) {
        if (UUID.test(name)) { roots.add(name); continue }
        const match = /^\.cleanup-([0-9a-f-]+)\.(pending|complete)\.json$/.exec(name)
        if (!match || !UUID.test(match[1]!)) throw new AgentError("CLEANUP_UNVERIFIED")
        const receipt = receipts.get(match[1]!) ?? { pending: false, complete: false }
        receipt[match[2]! as "pending" | "complete"] = true
        receipts.set(match[1]!, receipt)
      }
      const attempts = new Set([...roots, ...receipts.keys()])
      for (const agent of inventory.agents) {
        const attempt = agent.spec.launchAttemptId
        const launch = context.mutations.accepted.find(entry => entry.record.launchAttemptId === attempt)?.record
        if (launch?.launchAttempted && launch.phase === "cleanup_verified" && !attempts.has(attempt)) throw new AgentError("CLEANUP_UNVERIFIED")
      }
      for (const attempt of attempts) {
        const agents = inventory.agents.filter(agent => agent.spec.launchAttemptId === attempt)
        const launches = context.mutations.accepted.filter(entry => entry.record.launchAttemptId === attempt)
        if (agents.length !== 1 || launches.length !== 1) throw new AgentError("CLEANUP_UNVERIFIED")
        const spec = agents[0]!.spec, launch = launches[0]!.record
        if (launch.phase !== "cleanup_verified" || launch.agentId !== spec.agentId || launch.leaseId !== spec.leaseId || launch.handlerGeneration !== spec.handlerGeneration || launch.checkoutId !== spec.checkout.checkoutId) throw new AgentError("CLEANUP_UNVERIFIED")
        const evidence = receipts.get(attempt)
        if (evidence?.pending) {
          const pending = await readProviderStateReceipt(context.paths.persistentRoot, attempt, "pending")
          if (!evidence.complete) throw new AgentError("CLEANUP_UNVERIFIED")
          const complete = await readProviderStateReceipt(context.paths.persistentRoot, attempt, "complete")
          if (roots.has(attempt) || !isDeepStrictEqual(pending.root, complete.root)) throw new AgentError("CLEANUP_UNVERIFIED")
        } else if (evidence?.complete) throw new AgentError("CLEANUP_UNVERIFIED")
        else await removeProviderState(context.paths.persistentRoot, attempt)
      }
    })
    return { inventory, unavailable: null }
  } catch (error) { return { inventory, unavailable: agentFailure(error) } }
}