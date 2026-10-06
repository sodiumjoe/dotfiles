import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { LaunchContext } from "../handler/launch-transitions.js"
import { refreshLaunchState } from "../handler/mutations.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../platform/private-state.js"
import type { ManagedLaunchRecord } from "../platform/types.js"
import type { AgentInventory, AgentStateIssue, AgentStore } from "./store.js"
import { AgentError, agentFailure, parseAgentRecordV3, tupleOfRecord, type AgentCommand as AgentCommandV2, type AgentCommandV3, type AgentRecordV3 as AgentRecord, type OwnedAgentRecord, type AgentTuple, type StartCommandInput } from "./types.js"
type AgentCommand = AgentCommandV2 | AgentCommandV3

export function agentTuple(record: OwnedAgentRecord): AgentTuple
export function agentTuple(record: import("./types.js").AgentRecord): AgentTuple
export function agentTuple(record: AgentRecord): AgentTuple | null
export function agentTuple(record: AgentRecord | import("./types.js").AgentRecord): AgentTuple | null { return record.launch ? { agentId: record.definition.agentId, handlerGeneration: record.launch.handlerGeneration, providerGeneration: record.launch.providerGeneration } : null }

export async function retainUnspawnedRestore(context: LaunchContext, agent: AgentRecord): Promise<void> {
  if (agent.phase !== "restoring" || !agent.launch) return
  const path = join(context.paths.persistentRoot, "launches", agent.launch.launchAttemptId + ".json")
  await refreshLaunchState(context.state, context.mutations, join(context.paths.persistentRoot, "launches"))
  const accepted = context.mutations.accepted.find(entry => entry.record.launchAttemptId === agent.launch!.launchAttemptId)
  if (accepted) {
    if (accepted.path !== path || accepted.record.version !== 2 || accepted.record.owner.kind !== "agent" || accepted.record.owner.agentId !== agent.definition.agentId || accepted.record.owner.providerGeneration !== agent.launch.providerGeneration || accepted.record.handlerGeneration !== agent.launch.handlerGeneration || context.mutations.issues?.some(issue => issue.path === path)) throw new AgentError("CLEANUP_UNVERIFIED")
    return
  }
  const record: ManagedLaunchRecord = { version: 2, owner: { kind: "agent", agentId: agent.definition.agentId, providerGeneration: agent.launch.providerGeneration }, handlerGeneration: agent.launch.handlerGeneration, launchAttemptId: agent.launch.launchAttemptId, launchBootId: await context.adapter.bootId(), launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null }
  try { if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(path), record)) throw new AgentError("CLEANUP_UNVERIFIED") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  await writeLaunchRecord(path, record)
  context.mutations.accepted.push({ path, record })
  await refreshLaunchState(context.state, context.mutations, join(context.paths.persistentRoot, "launches"))
}

export type AgentAssessment = { unavailable: Map<string, AgentStateIssue>; issues: AgentStateIssue[]; configurationPending: Map<string, string[]> }
export type AgentRecoveryRepair = { kind: "agent"; issue: AgentStateIssue; expected: AgentRecord | null; next: AgentRecord } | { kind: "launch"; issue: AgentStateIssue; expected: AgentRecord; next: AgentRecord } | { kind: "command"; issue: AgentStateIssue; expected: AgentCommand; next: AgentCommand }

export function crossCheckAgents(context: LaunchContext, inventory: AgentInventory): AgentAssessment {
  const unavailable = new Map<string, AgentStateIssue>(), issues: AgentStateIssue[] = [], configurationPending = new Map<string, string[]>()
  const agents = new Map(inventory.agents.map(record => [record.definition.agentId, record])), commands = new Map(inventory.commands.map(command => [command.commandId, command]))
  const records = join(context.paths.persistentRoot, "agents", "records"), commandRoot = join(context.paths.persistentRoot, "agents", "commands"), launches = join(context.paths.persistentRoot, "launches")
  const mark = (agentId: string, kind: AgentStateIssue["kind"], id: string, path: string, message: string): void => {
    if (!unavailable.has(agentId)) unavailable.set(agentId, { kind, id, path, message })
  }
  for (const issue of inventory.issues) {
    const owner = issue.kind === "command" && issue.id ? inventory.agents.find(record => record.definition.createdCommandId === issue.id || record.launch?.commandId === issue.id || record.configurationState.verification.kind === "pending" && record.configurationState.verification.commandId === issue.id) : undefined
    if (owner) mark(owner.definition.agentId, issue.kind, issue.id!, issue.path, issue.message)
    else issues.push(issue)
  }
  for (const issue of context.mutations.issues ?? []) {
    const owner = inventory.agents.find(record => record.launch?.launchAttemptId === issue.launchAttemptId)
    if (owner) mark(owner.definition.agentId, "agent", owner.definition.agentId, issue.path, issue.message)
    else issues.push({ kind: "unknown", id: issue.launchAttemptId, path: issue.path, message: issue.message })
  }
  for (const field of ["launchAttemptId", "providerGeneration", "commandId"] as const) {
    const seen = new Map<string, string>()
    for (const record of inventory.agents) {
      if (!record.launch) continue
      const other = seen.get(record.launch[field])
      if (other) {
        mark(other, "agent", other, join(records, other + ".json"), `duplicate ${field}`)
        mark(record.definition.agentId, "agent", record.definition.agentId, join(records, record.definition.agentId + ".json"), `duplicate ${field}`)
      } else seen.set(record.launch[field], record.definition.agentId)
    }
  }
  for (const record of inventory.agents) {
    const definition = record.definition, launch = record.launch, command = commands.get(definition.createdCommandId), launchCommand = launch && commands.get(launch.commandId)
    if (definition.hostId !== context.paths.hostKey) mark(definition.agentId, "agent", definition.agentId, join(records, definition.agentId + ".json"), "agent host identity mismatch")
    if (!command || command.op !== (definition.origin === "import" ? "import" : "start") || (command.version === 3 ? command.agentId : command.target?.agentId) !== definition.agentId) mark(definition.agentId, "command", definition.createdCommandId, join(commandRoot, definition.createdCommandId + ".json"), "created command missing or mismatched")
    if (launch && (!launchCommand || !["start", "restore"].includes(launchCommand.op) || !isDeepStrictEqual(launchCommand.target, agentTuple(record)))) mark(definition.agentId, "command", launch.commandId, join(commandRoot, launch.commandId + ".json"), "launch command missing or mismatched")
    if (command) {
      const selected = command.input
      const backend = command.version === 2 ? (selected as StartCommandInput).selection?.providerId : (selected as import("./session-config.js").JsonObject).backendId
      if (!("cwd" in selected) || selected.cwd !== definition.cwd || backend !== definition.backendId || command.op === "import" && (selected as import("./session-config.js").JsonObject).nativeSessionId !== record.session?.sessionId) mark(definition.agentId, "command", command.commandId, join(commandRoot, command.commandId + ".json"), "created command identity mismatch")
    }
    if (record.configurationState.verification.kind === "pending") {
      const pending = commands.get(record.configurationState.verification.commandId)
      if (!pending || pending.version !== 3 || pending.op !== "configure" || pending.agentId !== definition.agentId) mark(definition.agentId, "agent", definition.agentId, join(records, definition.agentId + ".json"), "configuration intent missing or mismatched")
    }
    if (!launch) continue
    const retained = context.mutations.accepted.find(entry => entry.record.launchAttemptId === launch.launchAttemptId)?.record
    if (retained) {
      if (retained.version !== 2 || retained.owner.kind !== "agent" || retained.owner.agentId !== definition.agentId || retained.owner.providerGeneration !== launch.providerGeneration || retained.handlerGeneration !== launch.handlerGeneration) mark(definition.agentId, "agent", definition.agentId, join(launches, launch.launchAttemptId + ".json"), "launch ownership mismatch")
    } else if (record.phase !== "restoring" && (record.phase === "ready" || record.session !== null)) mark(definition.agentId, "agent", definition.agentId, join(launches, launch.launchAttemptId + ".json"), "launch record missing")
  }
  for (const command of inventory.commands) {
    const path = join(commandRoot, command.commandId + ".json")
    const record = agents.get(command.version === 3 ? command.agentId : command.target?.agentId ?? "")
    const reconciled = record?.launch && !isDeepStrictEqual(agentTuple(record), command.target) && record.configurationState.verification.kind === "verified" && commands.get(record.launch.commandId)?.result?.outcome === "restored"
    if (command.version === 3 && command.op === "configure" && command.state !== "completed" && !reconciled) configurationPending.set(command.agentId, [...configurationPending.get(command.agentId) ?? [], command.commandId])
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
      const session = command.result?.session as { sessionId?: unknown } | null | undefined
      if ((command.result?.outcome === "started" || command.result?.outcome === "restored") && session?.sessionId !== record.session?.sessionId) mark(record.definition.agentId, "command", command.commandId, path, "command session mismatch")
    } else {
      const retained = context.mutations.accepted.find(entry => entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === command.target!.agentId && entry.record.owner.providerGeneration === command.target!.providerGeneration && entry.record.handlerGeneration === command.target!.handlerGeneration)?.record
      const awaitingRestore = command.op === "restore" && command.state !== "completed" && (command.input as import("./types.js").RestoreCommandInput).agentId === record.definition.agentId
      if (!awaitingRestore && (!retained || retained.phase !== "cleanup_verified")) mark(record.definition.agentId, "command", command.commandId, path, "command generation mismatch")
      const session = command.result?.session as { sessionId?: unknown } | null | undefined
      if (session && session.sessionId !== record.session?.sessionId) mark(record.definition.agentId, "command", command.commandId, path, "command session mismatch")
    }
  }
  return { unavailable, issues, configurationPending }
}

export async function recoverAgents(input: { context: LaunchContext; store: AgentStore }): Promise<{ inventory: AgentInventory; assessment: AgentAssessment; repairs: AgentRecoveryRepair[] }> {
  const { context, store } = input
  let inventory: AgentInventory = { agents: [], legacyAgents: [], commands: [], issues: [] }
  const repairs: AgentRecoveryRepair[] = []
  await context.mutations.queue.run(async () => {
    await refreshLaunchState(context.state, context.mutations, join(context.paths.persistentRoot, "launches"))
    inventory = await store.inventory()
    for (const command of inventory.commands) {
      if (command.version !== 3 || command.op !== "import" || command.state !== "pending" || command.hostId !== context.paths.hostKey) continue
      const record = inventory.agents.find(agent => agent.definition.agentId === command.agentId)
      const identity = inventory.agents.find(agent => agent.definition.hostId === command.hostId && agent.definition.backendId === command.input.backendId && agent.session?.sessionId === command.input.nativeSessionId)
      if (identity && identity.definition.agentId !== command.agentId || inventory.issues.some(issue => issue.id === command.agentId)) continue
      const expected = parseAgentRecordV3({ version: 3, definition: { hostId: command.hostId, agentId: command.agentId, createdCommandId: command.commandId, cwd: command.input.cwd, backendId: command.input.backendId, origin: "import" }, launch: null, phase: "stopped", session: { sessionId: command.input.nativeSessionId, protocolVersion: 1 }, inputRequirements: { mcpServerNames: [] }, settings: {}, configurationState: { verification: { kind: "unknown" }, nonRestorableOptionIds: [] }, failure: null })
      if (record && !isDeepStrictEqual(record, expected)) continue
      if (!record) {
        try { await store.writeAgent(expected, null) }
        catch (error) {
          repairs.push({ kind: "agent", expected: null, next: expected, issue: { kind: "agent", id: command.agentId, path: join(context.paths.persistentRoot, "agents/records", command.agentId + ".json"), message: String(error).slice(0, 512) } })
          continue
        }
      }
      const next = { ...command, state: "completed" as const, result: { outcome: "imported" as const, target: null, failure: null, session: expected.session } }
      try { await store.writeCommand(next, command) }
      catch (error) { repairs.push({ kind: "command", expected: command, next, issue: { kind: "command", id: command.commandId, path: join(context.paths.persistentRoot, "agents/commands", command.commandId + ".json"), message: String(error).slice(0, 512) } }) }
    }
    inventory = await store.inventory()
    const initial = crossCheckAgents(context, inventory)
    let agentDurability: unknown = null, commandDurability: unknown = null
    try { await store.verifyDurability("agent") } catch (error) { agentDurability = error }
    try { await store.verifyDurability("command") } catch (error) { commandDurability = error }
    for (const agent of inventory.agents) {
      if (initial.unavailable.has(agent.definition.agentId)) continue
      const launchPath = agent.launch ? join(context.paths.persistentRoot, "launches", agent.launch.launchAttemptId + ".json") : join(context.paths.persistentRoot, "agents/records", agent.definition.agentId + ".json")
      const recoveryRecord = (verified: boolean): AgentRecord => ["starting", "ready", "restoring", "stopping"].includes(agent.phase) ? { ...agent, phase: agent.session && verified ? "recoverable" : "interrupted", failure: agentFailure(new AgentError("INCOMPLETE")) } : agent
      try { await retainUnspawnedRestore(context, agent) }
      catch (error) {
        repairs.push({ kind: "launch", expected: agent, next: recoveryRecord(true), issue: { kind: "agent", id: agent.definition.agentId, path: launchPath, message: String(error).slice(0, 512) } })
        continue
      }
      const verified = !!agent.launch && context.mutations.accepted.some(entry => entry.record.launchAttemptId === agent.launch!.launchAttemptId && entry.record.phase === "cleanup_verified")
      const next = recoveryRecord(verified)
      if (isDeepStrictEqual(next, agent)) {
        if (agentDurability) repairs.push({ kind: "agent", expected: agent, next, issue: { kind: "agent", id: agent.definition.agentId, path: join(context.paths.persistentRoot, "agents", "records", agent.definition.agentId + ".json"), message: String(agentDurability).slice(0, 512) } })
        continue
      }
      try { await store.writeAgent(next, agent) }
      catch (error) { repairs.push({ kind: "agent", expected: agent, next, issue: { kind: "agent", id: agent.definition.agentId, path: join(context.paths.persistentRoot, "agents", "records", agent.definition.agentId + ".json"), message: String(error).slice(0, 512) } }) }
    }
    for (const command of inventory.commands) {
      if (command.op === "import" && command.state === "pending") continue
      const next = command.state === "pending" ? { ...command, state: "interrupted" as const, result: { outcome: "interrupted" as const, target: command.target, failure: agentFailure(new AgentError("INCOMPLETE")), session: null } } : command
      if (isDeepStrictEqual(next, command)) {
        if (commandDurability) repairs.push({ kind: "command", expected: command, next, issue: { kind: "command", id: command.commandId, path: join(context.paths.persistentRoot, "agents", "commands", command.commandId + ".json"), message: String(commandDurability).slice(0, 512) } })
        continue
      }
      try { await store.writeCommand(next, command) } catch (error) { repairs.push({ kind: "command", expected: command, next, issue: { kind: "command", id: command.commandId, path: join(context.paths.persistentRoot, "agents", "commands", command.commandId + ".json"), message: String(error).slice(0, 512) } }) }
    }
    inventory = await store.inventory()
  })
  const assessment = crossCheckAgents(context, inventory)
  for (const repair of repairs) {
    const issue = repair.issue
    const agentId = repair.kind === "command" ? inventory.commands.find(command => command.commandId === issue.id)?.target?.agentId : issue.id
    const owner = inventory.agents.find(agent => agent.definition.agentId === agentId)
    if (owner) assessment.unavailable.set(owner.definition.agentId, issue)
    else assessment.issues.push(issue)
  }
  return { inventory, assessment, repairs }
}