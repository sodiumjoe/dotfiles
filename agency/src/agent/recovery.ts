import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { LaunchContext } from "../handler/launch-transitions.js"
import { refreshLaunchState } from "../handler/mutations.js"
import { writeLaunchRecord } from "../platform/private-state.js"
import type { ManagedLaunchRecord } from "../platform/types.js"
import type { AgentInventory, AgentStore } from "./store.js"
import { AgentError, agentFailure, tupleOfRecord, type AgentFailure, type AgentRecord, type AgentTuple, type StartCommandInput } from "./types.js"

export const agentTuple = (record: AgentRecord): AgentTuple => tupleOfRecord(record)

export async function retainUnspawnedRestore(context: LaunchContext, agent: AgentRecord): Promise<void> {
  if (agent.phase !== "restoring" || context.mutations.accepted.some(entry => entry.record.launchAttemptId === agent.launch.launchAttemptId)) return
  const path = join(context.paths.persistentRoot, "launches", agent.launch.launchAttemptId + ".json")
  const record: ManagedLaunchRecord = { version: 2, owner: { kind: "agent", agentId: agent.definition.agentId, providerGeneration: agent.launch.providerGeneration }, handlerGeneration: agent.launch.handlerGeneration, launchAttemptId: agent.launch.launchAttemptId, launchBootId: await context.adapter.bootId(), launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null }
  await writeLaunchRecord(path, record)
  context.mutations.accepted.push({ path, record })
  await refreshLaunchState(context.state, context.mutations, join(context.paths.persistentRoot, "launches"))
}

export function crossCheckAgents(context: LaunchContext, inventory: AgentInventory): void {
  if (inventory.issues.length) throw new AgentError("INVALID_AGENT_STATE")
  const agents = new Map(inventory.agents.map(record => [record.definition.agentId, record])), commands = new Map(inventory.commands.map(command => [command.commandId, command]))
  if (agents.size !== inventory.agents.length || commands.size !== inventory.commands.length) throw new AgentError("INVALID_AGENT_STATE")
  for (const field of ["launchAttemptId", "providerGeneration", "commandId"] as const) if (new Set(inventory.agents.map(record => record.launch[field])).size !== agents.size) throw new AgentError("INVALID_AGENT_STATE")
  const attempts = new Set(inventory.agents.map(record => record.launch.launchAttemptId))
  if (context.mutations.issues?.some(issue => issue.launchAttemptId !== null && attempts.has(issue.launchAttemptId))) throw new AgentError("INVALID_AGENT_STATE")
  for (const record of inventory.agents) {
    const definition = record.definition, launch = record.launch, command = commands.get(definition.createdCommandId), launchCommand = commands.get(launch.commandId)
    const retained = context.mutations.accepted.find(entry => entry.record.launchAttemptId === launch.launchAttemptId)?.record
    if (definition.hostId !== context.paths.hostKey || !command || command.op !== "start" || command.target?.agentId !== definition.agentId || !launchCommand || !["start", "restore"].includes(launchCommand.op) || !isDeepStrictEqual(launchCommand.target, agentTuple(record))) throw new AgentError("INVALID_AGENT_STATE")
    const selected = command.input as StartCommandInput
    if (selected.cwd !== definition.cwd || !isDeepStrictEqual({ ...selected.selection, mode: selected.selection.mode ?? definition.selection.mode }, definition.selection)) throw new AgentError("INVALID_AGENT_STATE")
    if (retained) {
      if (retained.version !== 2 || retained.owner.kind !== "agent" || retained.owner.agentId !== definition.agentId || retained.owner.providerGeneration !== launch.providerGeneration || retained.handlerGeneration !== launch.handlerGeneration) throw new AgentError("INVALID_AGENT_STATE")
    } else if (record.phase !== "restoring" && (record.phase === "ready" || record.session !== null)) throw new AgentError("INVALID_AGENT_STATE")
  }
  for (const command of inventory.commands) {
    if (command.hostId !== context.paths.hostKey) throw new AgentError("INVALID_AGENT_STATE")
    if (!command.target) continue
    const record = agents.get(command.target.agentId)
    if (!record) {
      if (command.op !== "start" || command.state === "completed" || context.mutations.accepted.some(entry => entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === command.target!.agentId)) throw new AgentError("INVALID_AGENT_STATE")
      continue
    }
    if (command.op === "start" && command.commandId !== record.definition.createdCommandId) throw new AgentError("INVALID_AGENT_STATE")
    if (isDeepStrictEqual(command.target, agentTuple(record))) {
      if ((command.result?.outcome === "started" || command.result?.outcome === "restored") && !isDeepStrictEqual(command.result.session, record.session)) throw new AgentError("INVALID_AGENT_STATE")
    } else {
      const retained = context.mutations.accepted.find(entry => entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === command.target!.agentId && entry.record.owner.providerGeneration === command.target!.providerGeneration && entry.record.handlerGeneration === command.target!.handlerGeneration)?.record
      const awaitingRestore = command.op === "restore" && command.state !== "completed" && (command.input as import("./types.js").RestoreCommandInput).agentId === record.definition.agentId
      if (!awaitingRestore && (!retained || retained.phase !== "cleanup_verified")) throw new AgentError("INVALID_AGENT_STATE")
      if (command.result?.session && command.result.session.sessionId !== record.session?.sessionId) throw new AgentError("INVALID_AGENT_STATE")
    }
  }
}

export async function recoverAgents(input: { context: LaunchContext; store: AgentStore }): Promise<{ inventory: AgentInventory; unavailable: AgentFailure | null }> {
  const { context, store } = input
  let inventory: AgentInventory = { agents: [], legacyAgents: [], commands: [], issues: [] }
  try {
    await context.mutations.queue.run(async () => {
      await refreshLaunchState(context.state, context.mutations, join(context.paths.persistentRoot, "launches"))
      inventory = await store.inventory()
      crossCheckAgents(context, inventory)
      for (const agent of inventory.agents) {
        await retainUnspawnedRestore(context, agent)
        const verified = context.mutations.accepted.some(entry => entry.record.launchAttemptId === agent.launch.launchAttemptId && entry.record.phase === "cleanup_verified")
        const next = ["starting", "ready", "restoring", "stopping"].includes(agent.phase) ? { ...agent, phase: agent.session && verified ? "recoverable" as const : "interrupted" as const, failure: agentFailure(new AgentError("INCOMPLETE")) } : agent
        await store.writeAgent(next, agent)
      }
      for (const command of inventory.commands) {
        const next = command.state === "pending" ? { ...command, state: "interrupted" as const, result: { outcome: "interrupted" as const, target: command.target, failure: agentFailure(new AgentError("INCOMPLETE")), session: null } } : command
        await store.writeCommand(next, command)
      }
      inventory = await store.inventory()
      crossCheckAgents(context, inventory)
    })
    return { inventory, unavailable: null }
  } catch (error) { return { inventory, unavailable: agentFailure(error) } }
}