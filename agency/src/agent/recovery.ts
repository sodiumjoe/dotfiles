import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { LaunchContext } from "../handler/launch-transitions.js"
import { refreshLaunchState } from "../handler/mutations.js"
import { writeLaunchRecord } from "../platform/private-state.js"
import type { ManagedLaunchRecord } from "../platform/types.js"
import type { AgentInventory, AgentStateIssue, AgentStore } from "./store.js"
import { AgentError, agentFailure, tupleOfRecord, type AgentRecord, type AgentTuple, type StartCommandInput } from "./types.js"

export const agentTuple = (record: AgentRecord): AgentTuple => tupleOfRecord(record)

export async function retainUnspawnedRestore(context: LaunchContext, agent: AgentRecord): Promise<void> {
  if (agent.phase !== "restoring" || context.mutations.accepted.some(entry => entry.record.launchAttemptId === agent.launch.launchAttemptId)) return
  const path = join(context.paths.persistentRoot, "launches", agent.launch.launchAttemptId + ".json")
  const record: ManagedLaunchRecord = { version: 2, owner: { kind: "agent", agentId: agent.definition.agentId, providerGeneration: agent.launch.providerGeneration }, handlerGeneration: agent.launch.handlerGeneration, launchAttemptId: agent.launch.launchAttemptId, launchBootId: await context.adapter.bootId(), launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null }
  await writeLaunchRecord(path, record)
  context.mutations.accepted.push({ path, record })
  await refreshLaunchState(context.state, context.mutations, join(context.paths.persistentRoot, "launches"))
}

export type AgentAssessment = { unavailable: Map<string, AgentStateIssue>; issues: AgentStateIssue[] }

export function crossCheckAgents(context: LaunchContext, inventory: AgentInventory): AgentAssessment {
  const unavailable = new Map<string, AgentStateIssue>(), issues: AgentStateIssue[] = []
  const agents = new Map(inventory.agents.map(record => [record.definition.agentId, record])), commands = new Map(inventory.commands.map(command => [command.commandId, command]))
  const records = join(context.paths.persistentRoot, "agents", "records"), commandRoot = join(context.paths.persistentRoot, "agents", "commands"), launches = join(context.paths.persistentRoot, "launches")
  const mark = (agentId: string, kind: AgentStateIssue["kind"], id: string, path: string, message: string): void => {
    if (!unavailable.has(agentId)) unavailable.set(agentId, { kind, id, path, message })
  }
  for (const issue of inventory.issues) {
    const owner = issue.kind === "command" && issue.id ? inventory.agents.find(record => record.definition.createdCommandId === issue.id || record.launch.commandId === issue.id) : undefined
    if (owner) mark(owner.definition.agentId, issue.kind, issue.id!, issue.path, issue.message)
    else issues.push(issue)
  }
  for (const issue of context.mutations.issues ?? []) {
    const owner = inventory.agents.find(record => record.launch.launchAttemptId === issue.launchAttemptId)
    if (owner) mark(owner.definition.agentId, "agent", owner.definition.agentId, issue.path, issue.message)
    else issues.push({ kind: "unknown", id: issue.launchAttemptId, path: issue.path, message: issue.message })
  }
  for (const field of ["launchAttemptId", "providerGeneration", "commandId"] as const) {
    const seen = new Map<string, string>()
    for (const record of inventory.agents) {
      const other = seen.get(record.launch[field])
      if (other) {
        mark(other, "agent", other, join(records, other + ".json"), `duplicate ${field}`)
        mark(record.definition.agentId, "agent", record.definition.agentId, join(records, record.definition.agentId + ".json"), `duplicate ${field}`)
      } else seen.set(record.launch[field], record.definition.agentId)
    }
  }
  for (const record of inventory.agents) {
    const definition = record.definition, launch = record.launch, command = commands.get(definition.createdCommandId), launchCommand = commands.get(launch.commandId)
    if (definition.hostId !== context.paths.hostKey) mark(definition.agentId, "agent", definition.agentId, join(records, definition.agentId + ".json"), "agent host identity mismatch")
    if (!command || command.op !== "start" || command.target?.agentId !== definition.agentId) mark(definition.agentId, "command", definition.createdCommandId, join(commandRoot, definition.createdCommandId + ".json"), "created command missing or mismatched")
    if (!launchCommand || !["start", "restore"].includes(launchCommand.op) || !isDeepStrictEqual(launchCommand.target, agentTuple(record))) mark(definition.agentId, "command", launch.commandId, join(commandRoot, launch.commandId + ".json"), "launch command missing or mismatched")
    if (command) {
      const selected = command.input as StartCommandInput
      if (selected.cwd !== definition.cwd || !isDeepStrictEqual({ ...selected.selection, mode: selected.selection.mode ?? definition.selection.mode }, definition.selection)) mark(definition.agentId, "command", command.commandId, join(commandRoot, command.commandId + ".json"), "created command selection mismatch")
    }
    const retained = context.mutations.accepted.find(entry => entry.record.launchAttemptId === launch.launchAttemptId)?.record
    if (retained) {
      if (retained.version !== 2 || retained.owner.kind !== "agent" || retained.owner.agentId !== definition.agentId || retained.owner.providerGeneration !== launch.providerGeneration || retained.handlerGeneration !== launch.handlerGeneration) mark(definition.agentId, "agent", definition.agentId, join(launches, launch.launchAttemptId + ".json"), "launch ownership mismatch")
    } else if (record.phase !== "restoring" && (record.phase === "ready" || record.session !== null)) mark(definition.agentId, "agent", definition.agentId, join(launches, launch.launchAttemptId + ".json"), "launch record missing")
  }
  for (const command of inventory.commands) {
    const path = join(commandRoot, command.commandId + ".json")
    const record = command.target ? agents.get(command.target.agentId) : undefined
    if (command.hostId !== context.paths.hostKey) {
      if (record) mark(record.definition.agentId, "command", command.commandId, path, "command host identity mismatch")
      else issues.push({ kind: "command", id: command.commandId, path, message: "command host identity mismatch" })
    }
    if (!command.target) continue
    if (!record) {
      if (!inventory.issues.some(issue => issue.kind === "agent" && issue.id === command.target!.agentId) && (command.op !== "start" || command.state === "completed" || context.mutations.accepted.some(entry => entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === command.target!.agentId))) issues.push({ kind: "command", id: command.commandId, path, message: "command target missing" })
      continue
    }
    if (command.op === "start" && command.commandId !== record.definition.createdCommandId) mark(record.definition.agentId, "command", command.commandId, path, "unexpected start command")
    if (isDeepStrictEqual(command.target, agentTuple(record))) {
      if ((command.result?.outcome === "started" || command.result?.outcome === "restored") && !isDeepStrictEqual(command.result.session, record.session)) mark(record.definition.agentId, "command", command.commandId, path, "command session mismatch")
    } else {
      const retained = context.mutations.accepted.find(entry => entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === command.target!.agentId && entry.record.owner.providerGeneration === command.target!.providerGeneration && entry.record.handlerGeneration === command.target!.handlerGeneration)?.record
      const awaitingRestore = command.op === "restore" && command.state !== "completed" && (command.input as import("./types.js").RestoreCommandInput).agentId === record.definition.agentId
      if (!awaitingRestore && (!retained || retained.phase !== "cleanup_verified")) mark(record.definition.agentId, "command", command.commandId, path, "command generation mismatch")
      if (command.result?.session && command.result.session.sessionId !== record.session?.sessionId) mark(record.definition.agentId, "command", command.commandId, path, "command session mismatch")
    }
  }
  return { unavailable, issues }
}

export async function recoverAgents(input: { context: LaunchContext; store: AgentStore }): Promise<{ inventory: AgentInventory; assessment: AgentAssessment }> {
  const { context, store } = input
  let inventory: AgentInventory = { agents: [], legacyAgents: [], commands: [], issues: [] }
  const failed: AgentStateIssue[] = []
  await context.mutations.queue.run(async () => {
    await refreshLaunchState(context.state, context.mutations, join(context.paths.persistentRoot, "launches"))
    inventory = await store.inventory()
    const initial = crossCheckAgents(context, inventory)
    for (const agent of inventory.agents) {
      if (initial.unavailable.has(agent.definition.agentId)) continue
      try {
        await retainUnspawnedRestore(context, agent)
        const verified = context.mutations.accepted.some(entry => entry.record.launchAttemptId === agent.launch.launchAttemptId && entry.record.phase === "cleanup_verified")
        const next = ["starting", "ready", "restoring", "stopping"].includes(agent.phase) ? { ...agent, phase: agent.session && verified ? "recoverable" as const : "interrupted" as const, failure: agentFailure(new AgentError("INCOMPLETE")) } : agent
        await store.writeAgent(next, agent)
      } catch (error) { failed.push({ kind: "agent", id: agent.definition.agentId, path: join(context.paths.persistentRoot, "agents", "records", agent.definition.agentId + ".json"), message: String(error).slice(0, 512) }) }
    }
    for (const command of inventory.commands) {
      const next = command.state === "pending" ? { ...command, state: "interrupted" as const, result: { outcome: "interrupted" as const, target: command.target, failure: agentFailure(new AgentError("INCOMPLETE")), session: null } } : command
      try { await store.writeCommand(next, command) } catch (error) { failed.push({ kind: "command", id: command.commandId, path: join(context.paths.persistentRoot, "agents", "commands", command.commandId + ".json"), message: String(error).slice(0, 512) }) }
    }
    inventory = await store.inventory()
  })
  const assessment = crossCheckAgents(context, inventory)
  for (const issue of failed) {
    const agentId = issue.kind === "agent" ? issue.id : inventory.commands.find(command => command.commandId === issue.id)?.target?.agentId
    const owner = inventory.agents.find(agent => agent.definition.agentId === agentId)
    if (owner) assessment.unavailable.set(owner.definition.agentId, issue)
    else assessment.issues.push(issue)
  }
  return { inventory, assessment }
}