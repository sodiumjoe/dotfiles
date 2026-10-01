import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { LaunchContext } from "../handler/launch-transitions.js"
import { refreshLaunchState } from "../handler/mutations.js"
import type { AgentInventory, AgentStore } from "./store.js"
import { AgentError, agentFailure, tupleOfRecord, type AgentFailure, type AgentRecord, type AgentTuple, type StartCommandInput } from "./types.js"

export const agentTuple = (record: AgentRecord): AgentTuple => tupleOfRecord(record)

export function crossCheckAgents(context: LaunchContext, inventory: AgentInventory): void {
  if (inventory.issues.length) throw new AgentError("INVALID_AGENT_STATE")
  const agents = new Map(inventory.agents.map(record => [record.definition.agentId, record])), commands = new Map(inventory.commands.map(command => [command.commandId, command]))
  if (agents.size !== inventory.agents.length || commands.size !== inventory.commands.length) throw new AgentError("INVALID_AGENT_STATE")
  for (const field of ["launchAttemptId", "providerGeneration", "commandId"] as const) if (new Set(inventory.agents.map(record => record.launch[field])).size !== agents.size) throw new AgentError("INVALID_AGENT_STATE")
  const attempts = new Set(inventory.agents.map(record => record.launch.launchAttemptId))
  if (context.mutations.issues?.some(issue => issue.launchAttemptId !== null && attempts.has(issue.launchAttemptId))) throw new AgentError("INVALID_AGENT_STATE")
  for (const record of inventory.agents) {
    const definition = record.definition, launch = record.launch, command = commands.get(definition.createdCommandId)
    const retained = context.mutations.accepted.find(entry => entry.record.launchAttemptId === launch.launchAttemptId)?.record
    if (definition.hostId !== context.paths.hostKey || !command || command.op !== "start" || !isDeepStrictEqual(command.target, agentTuple(record))) throw new AgentError("INVALID_AGENT_STATE")
    const selected = command.input as StartCommandInput
    if (selected.cwd !== definition.cwd || !isDeepStrictEqual({ ...selected.selection, mode: selected.selection.mode ?? definition.selection.mode }, definition.selection)) throw new AgentError("INVALID_AGENT_STATE")
    if (retained) {
      if (retained.version !== 2 || retained.owner.kind !== "agent" || retained.owner.agentId !== definition.agentId || retained.owner.providerGeneration !== launch.providerGeneration || retained.handlerGeneration !== launch.handlerGeneration) throw new AgentError("INVALID_AGENT_STATE")
    } else if (record.phase === "ready" || record.session !== null) throw new AgentError("INVALID_AGENT_STATE")
  }
  for (const command of inventory.commands) {
    if (command.hostId !== context.paths.hostKey) throw new AgentError("INVALID_AGENT_STATE")
    if (!command.target) continue
    const record = agents.get(command.target.agentId)
    if (!record) {
      if (command.op !== "start" || command.state === "completed" || context.mutations.accepted.some(entry => entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === command.target!.agentId)) throw new AgentError("INVALID_AGENT_STATE")
      continue
    }
    if (!isDeepStrictEqual(command.target, agentTuple(record)) || command.op === "start" && command.commandId !== record.definition.createdCommandId || command.result?.outcome === "started" && !isDeepStrictEqual(command.result.session, record.session)) throw new AgentError("INVALID_AGENT_STATE")
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
        if (!["starting", "ready", "restoring", "stopping"].includes(agent.phase)) continue
        await store.writeAgent({ ...agent, phase: "interrupted", failure: agentFailure(new AgentError("INCOMPLETE")) }, agent)
      }
      for (const command of inventory.commands) {
        if (command.state !== "pending") continue
        await store.writeCommand({ ...command, state: "interrupted", result: { outcome: "interrupted", target: command.target, failure: agentFailure(new AgentError("INCOMPLETE")), session: null } }, command)
      }
      inventory = await store.inventory()
      crossCheckAgents(context, inventory)
    })
    return { inventory, unavailable: null }
  } catch (error) { return { inventory, unavailable: agentFailure(error) } }
}