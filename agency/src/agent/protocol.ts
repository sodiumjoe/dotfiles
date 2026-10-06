import type { Socket } from "node:net"
import { isDeepStrictEqual } from "node:util"
import { absolutePath, hash, id, keys, object, providerId } from "../catalog/types.js"
import { CURSOR_BYTES, parsePageInput, QUERY_BYTES, type AgentChoices, type AgentPage, type PageInput } from "./queries.js"
import { parseSelection } from "./types.js"
import { ControlError, UUID } from "../control/protocol.js"
import { encodeFrame, receiveFrame } from "../control/wire.js"
import type { LaunchRecord, ProcessIdentity } from "../platform/types.js"
import { AgentError, agentFailure, agentText, parseAgentCommand, parseAgentCommandV3, parseAgentFailure, parseAgentRecordV3, parseLegacyAgentRecord, parsePromptInput, parsePromptView, parseStartInput, parseStopInput, projectStartInput, type AgentFailure, type AgentList, type AgentView, type LegacyAgentView, type CommandView, type CurrentAgents, type PromptInput, type PromptView, type StartInput, type StopInput } from "./types.js"
import type { AgentStateIssue } from "./store.js"
import { parseRestoreRequest, projectRestoreInput, type RestoreRequest } from "./types.js"
import { launchEnvironmentDigest } from "./environment.js"

export const AGENT_PROTOCOL = "agency-agent/3" as const
export type AgentRequest = { protocol: typeof AGENT_PROTOCOL; requestId: string; handlerGeneration: string } & (
  | { op: "agent_choices" } | { op: "agent_page"; input: PageInput } | { op: "agent_start"; input: StartInput } | { op: "agent_restore"; input: RestoreRequest } | { op: "agent_stop"; input: StopInput } | { op: "agent_prompt"; input: PromptInput } | { op: "agent_current"; cwd: string } | { op: "agent_list" } | { op: "agent_command"; commandId: string; commandGeneration: string }
)
export type AgentReply = { protocol: typeof AGENT_PROTOCOL; requestId: string; handlerGeneration: string | null; commandId?: string } & ({ ok: true; result: CommandView | AgentList | CurrentAgents | PromptView | AgentChoices | AgentPage } | { ok: false; error: AgentFailure })
function invalid(): never { throw new AgentError("INVALID_PROTOCOL") }
const commandIdFor = (request: AgentRequest): string | undefined => request.op === "agent_command" ? request.commandId : request.op === "agent_start" || request.op === "agent_restore" || request.op === "agent_stop" ? request.input.commandId : undefined
function identity(input: unknown): ProcessIdentity {
  const v = object(input)
  keys(v, ["bootId", "pid", "birth", "parentPid", "processGroupId", "sessionId", "uid", "gid"])
  for (const key of ["pid", "parentPid", "processGroupId", "sessionId", "uid", "gid"]) if (!Number.isSafeInteger(v[key]) || (v[key] as number) < (key === "uid" || key === "gid" || key === "parentPid" ? 0 : 1)) invalid()
  return { bootId: agentText(v.bootId), birth: agentText(v.birth, 1024), pid: v.pid as number, parentPid: v.parentPid as number, processGroupId: v.processGroupId as number, sessionId: v.sessionId as number, uid: v.uid as number, gid: v.gid as number }
}
function launchRecord(input: unknown): LaunchRecord {
  const v = object(input)
  if (v.version === 2) keys(v, ["version", "owner", "handlerGeneration", "launchAttemptId", "launchBootId", "launchAttempted", "phase", "provider", "reason"])
  else keys(v, ["version", "checkoutId", "leaseId", "agentId", "handlerGeneration", "launchAttemptId", "launchBootId", "launchAttempted", "phase", "provider", "reason"])
  if (typeof v.launchAttempted !== "boolean" || !["launch_pending", "readiness", "active", "exited_unverified", "cleanup_pending", "cleanup_verified", "quarantined"].includes(String(v.phase))) invalid()
  let provider: LaunchRecord["provider"] = null
  if (v.provider !== null) {
    const p = object(v.provider); keys(p, ["kind", "group"])
    const group = object(p.group); keys(group, ["leader", "observed"])
    if (p.kind !== "process-group" || !Array.isArray(group.observed) || group.observed.length > 4096) invalid()
    provider = { kind: "process-group", group: { leader: identity(group.leader), observed: (group.observed as unknown[]).map(identity) } }
  }
  const fields = { handlerGeneration: id(v.handlerGeneration), launchAttemptId: id(v.launchAttemptId), launchBootId: agentText(v.launchBootId), launchAttempted: v.launchAttempted as boolean, phase: v.phase as LaunchRecord["phase"], provider, reason: v.reason === null ? null : agentText(v.reason, 2048) }
  if (v.version === 1) return { version: 1, checkoutId: agentText(v.checkoutId), agentId: id(v.agentId), leaseId: id(v.leaseId), ...fields }
  if (v.version !== 2) invalid()
  const owner = object(v.owner)
  if (owner.kind === "agent") { keys(owner, ["kind", "agentId", "providerGeneration"]); return { version: 2, owner: { kind: "agent", agentId: id(owner.agentId), providerGeneration: id(owner.providerGeneration) }, ...fields } }
  keys(owner, ["kind", "providerId", "commandId"])
  if (owner.kind !== "catalog-probe") invalid()
  return { version: 2, owner: { kind: "catalog-probe", providerId: agentText(owner.providerId) as import("../catalog/types.js").ProviderId, commandId: id(owner.commandId) }, ...fields }
}
function agentView(input: unknown, generation: string | null): AgentView | LegacyAgentView {
  const v = object(input), current = object(v.record)
  keys(v, current.version === 1 ? ["record", "launch", "live", "cleanup"] : ["record", "launch", "live", "cleanup", "unavailable"])
  const recordValue = object(v.record), launch = v.launch === null ? null : launchRecord(v.launch)
  if (recordValue.version === 1) {
    const record = parseLegacyAgentRecord(v.record)
    if (v.live !== false || v.cleanup !== "unknown" && v.cleanup !== "verified" || launch && (launch.version !== 1 || launch.agentId !== record.spec.agentId || launch.launchAttemptId !== record.spec.launchAttemptId)) invalid()
    return { record, launch, live: false, cleanup: v.cleanup as LegacyAgentView["cleanup"] }
  }
  const record = parseAgentRecordV3(v.record)
  const unavailable = v.unavailable === null ? null : stateIssue(v.unavailable)
  if (!record.launch) {
    if (launch !== null || v.live !== false || v.cleanup !== "not_launched") invalid()
    return { record, launch: null, live: false, cleanup: "not_launched", unavailable }
  }
  if (typeof v.live !== "boolean" || !["not_launched", "verified", "unverified", "unknown"].includes(String(v.cleanup))) invalid()
  if (launch && (launch.version !== 2 || launch.owner.kind !== "agent" || launch.owner.agentId !== record.definition.agentId || launch.owner.providerGeneration !== record.launch.providerGeneration || launch.launchAttemptId !== record.launch!.launchAttemptId || launch.handlerGeneration !== record.launch.handlerGeneration)) {
    if (!unavailable || v.live !== false || !unavailable.path.endsWith("/" + record.launch!.launchAttemptId + ".json")) invalid()
    return { record, launch: null, live: false, cleanup: "unknown", unavailable }
  }
  if (v.cleanup === "verified" && launch?.phase !== "cleanup_verified" || v.cleanup === "not_launched" && launch !== null) invalid()
  if (v.live && (record.launch.handlerGeneration !== generation || !["starting", "ready", "recoverable", "restoring", "stopping"].includes(record.phase) || !launch && !["starting", "restoring"].includes(record.phase) || launch?.phase === "cleanup_verified" || launch?.phase === "quarantined")) invalid()
  return { record, launch, live: v.live as boolean, cleanup: v.cleanup as AgentView["cleanup"], unavailable }
}
function stateIssue(input: unknown): AgentStateIssue {
  const v = object(input)
  keys(v, ["kind", "id", "path", "message"])
  if (!["agent", "command", "unknown"].includes(String(v.kind)) || v.id !== null && !UUID.test(String(v.id)) || typeof v.path !== "string" || !v.path.startsWith("/") || typeof v.message !== "string" || Buffer.byteLength(v.message) > 512) invalid()
  return { kind: v.kind as AgentStateIssue["kind"], id: v.id as string | null, path: v.path, message: v.message }
}
export function parseAgentRequest(input: unknown): AgentRequest {
  try {
    const v = object(input)
    if (v.protocol !== AGENT_PROTOCOL) invalid()
    const common = { protocol: AGENT_PROTOCOL, requestId: id(v.requestId), handlerGeneration: id(v.handlerGeneration) }
    if (v.op === "agent_choices") { keys(v, ["protocol", "requestId", "handlerGeneration", "op"]); return { ...common, op: "agent_choices" } }
    if (v.op === "agent_page") { keys(v, ["protocol", "requestId", "handlerGeneration", "op", "input"]); return { ...common, op: "agent_page", input: parsePageInput(v.input) } }
    if (v.op === "agent_list") { keys(v, ["protocol", "requestId", "handlerGeneration", "op"]); return { ...common, op: "agent_list" } }
    if (v.op === "agent_current") { keys(v, ["protocol", "requestId", "handlerGeneration", "op", "cwd"]); return { ...common, op: "agent_current", cwd: absolutePath(v.cwd) } }
    if (v.op === "agent_command") { keys(v, ["protocol", "requestId", "handlerGeneration", "op", "commandId", "commandGeneration"]); return { ...common, op: "agent_command", commandId: id(v.commandId), commandGeneration: id(v.commandGeneration) } }
    keys(v, ["protocol", "requestId", "handlerGeneration", "op", "input"])
    if (v.op === "agent_start") { const input = parseStartInput(v.input); if (input.handlerGeneration !== common.handlerGeneration) invalid(); return { ...common, op: "agent_start", input } }
    if (v.op === "agent_restore") { const input = parseRestoreRequest(v.input); if (input.handlerGeneration !== common.handlerGeneration) invalid(); return { ...common, op: "agent_restore", input } }
    if (v.op === "agent_stop") { const input = parseStopInput(v.input); if (input.handlerGeneration !== common.handlerGeneration) invalid(); return { ...common, op: "agent_stop", input } }
    if (v.op === "agent_prompt") { const input = parsePromptInput(v.input); if (input.handlerGeneration !== common.handlerGeneration) invalid(); return { ...common, op: "agent_prompt", input } }
    return invalid()
  } catch { return invalid() }
}
export function parseAgentReply(input: unknown): AgentReply {
  try {
    const v = object(input)
    if (v.protocol !== AGENT_PROTOCOL || typeof v.ok !== "boolean") invalid()
    const common = { protocol: AGENT_PROTOCOL, requestId: id(v.requestId), handlerGeneration: v.handlerGeneration === null ? null : id(v.handlerGeneration), ...(Object.hasOwn(v, "commandId") ? { commandId: id(v.commandId) } : {}) }
    keys(v, ["protocol", "requestId", "handlerGeneration", ...(common.commandId ? ["commandId"] : []), "ok", v.ok ? "result" : "error"])
    if (!v.ok) return { ...common, ok: false, error: parseAgentFailure(v.error) }
    const r = object(v.result)
    if (r.state === "command") {
      keys(r, ["state", "command", "durability"])
      const command = object(r.command).version === 3 ? parseAgentCommandV3(r.command) : parseAgentCommand(r.command)
      if (common.commandId !== command.commandId || r.durability !== "verified" && r.durability !== "unverified") invalid()
      return { ...common, ok: true, result: { state: "command", command, durability: r.durability as CommandView["durability"] } }
    }
    if (common.commandId) invalid()
    if (r.state === "choices") {
      keys(r, ["state", "choices", "unavailable"])
      if (!Array.isArray(r.choices) || r.choices.length > 4096 || !Array.isArray(r.unavailable) || r.unavailable.length > 2 || Buffer.byteLength(JSON.stringify(r)) > QUERY_BYTES) invalid()
      const choices = r.choices.map(value => { const c = object(value); keys(c, ["displayName", "selection", "snapshotId", "contractFingerprint"]); const selection = parseSelection(c.selection); if (selection.mode === null) invalid(); return { displayName: agentText(c.displayName), selection, snapshotId: id(c.snapshotId), contractFingerprint: hash(c.contractFingerprint) } })
      const unavailable = r.unavailable.map(value => { const u = object(value); keys(u, ["providerId", "reason"]); return { providerId: providerId(u.providerId), reason: agentText(u.reason, 512) } })
      if (new Set(unavailable.map(u => u.providerId)).size !== unavailable.length || new Set(choices.map(c => JSON.stringify(c.selection))).size !== choices.length) invalid()
      return { ...common, ok: true, result: { state: "choices", choices, unavailable } }
    }
    if (r.state === "page") {
      keys(r, ["state", "revision", "agents", "issues", "nextCursor"])
      if (!Array.isArray(r.agents) || !Array.isArray(r.issues) || r.agents.length + r.issues.length > 100 || Buffer.byteLength(JSON.stringify(r)) > QUERY_BYTES) invalid()
      if (r.nextCursor !== null && (typeof r.nextCursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(r.nextCursor) || r.nextCursor.length > CURSOR_BYTES)) invalid()
      const agents = r.agents.map(a => agentView(a, common.handlerGeneration)), ids = agents.map(a => a.record.version === 3 ? a.record.definition.agentId : a.record.spec.agentId)
      if (new Set(ids).size !== ids.length || ids.some((value, index) => index > 0 && ids[index - 1]! >= value)) invalid()
      return { ...common, ok: true, result: { state: "page", revision: id(r.revision), agents, issues: r.issues.map(stateIssue), nextCursor: r.nextCursor as string | null } }
    }
    if (r.state === "prompt") return { ...common, ok: true, result: parsePromptView(r) }
    if (r.state === "agents") {
      keys(r, ["state", "agents", "issues"])
      if (!Array.isArray(r.agents) || r.agents.length > 4096 || !Array.isArray(r.issues) || r.issues.length > 4096) invalid()
      const agents = (r.agents as unknown[]).map(a => agentView(a, common.handlerGeneration))
      if (new Set(agents.map(a => a.record.version === 3 ? a.record.definition.agentId : a.record.spec.agentId)).size !== agents.length) invalid()
      return { ...common, ok: true, result: { state: "agents", agents, issues: (r.issues as unknown[]).map(stateIssue) } }
    }
    if (r.state !== "current") invalid()
    keys(r, ["state", "cwd", "agents"])
    if (!Array.isArray(r.agents) || r.agents.length > 4096) invalid()
    const cwd = absolutePath(r.cwd), agents = (r.agents as unknown[]).map(value => agentView(value, common.handlerGeneration))
    if (agents.some(agent => agent.record.version !== 3 || !agent.live || agent.record.definition.cwd !== cwd) || new Set(agents.map(agent => agent.record.version === 3 ? agent.record.definition.agentId : agent.record.spec.agentId)).size !== agents.length) invalid()
    return { ...common, ok: true, result: { state: "current", cwd, agents: agents as AgentView[] } }
  } catch { return invalid() }
}
export function validateAgentReply(reply: AgentReply, request: AgentRequest): void {
  if (reply.requestId !== request.requestId || reply.commandId !== commandIdFor(request)) invalid()
  if (reply.handlerGeneration !== request.handlerGeneration) throw new AgentError("STALE_HANDLER")
  if (!reply.ok) return
  const result = reply.result
  if (request.op === "agent_choices") { if (result.state !== "choices") invalid(); return }
  if (request.op === "agent_page") {
    if (result.state !== "page" || result.agents.length + result.issues.length > request.input.limit) invalid()
    if (request.input.cwd && result.agents.some(a => (a.record.version === 3 ? a.record.definition.cwd : a.record.spec.checkout.root.path) !== request.input.cwd)) invalid()
    if (request.input.activeOnly && result.agents.some(a => a.record.version !== 3 || a.record.launch?.handlerGeneration !== request.handlerGeneration || !["starting", "ready", "restoring", "stopping"].includes(a.record.phase))) invalid()
    return
  }
  if (request.op === "agent_list") { if (result.state !== "agents") invalid(); return }
  if (request.op === "agent_current") { if (result.state !== "current" || result.cwd !== request.cwd) invalid(); return }
  if (request.op === "agent_prompt") { if (result.state !== "prompt" || !isDeepStrictEqual(result.target, { agentId: request.input.agentId, handlerGeneration: request.input.handlerGeneration, providerGeneration: request.input.providerGeneration })) invalid(); return }
  if (result.state !== "command") return invalid()
  if (request.op === "agent_command") { if (result.command.handlerGeneration !== request.commandGeneration) invalid(); return }
  if (result.command.op !== (request.op === "agent_start" ? "start" : request.op === "agent_restore" ? "restore" : "stop")) invalid()
  if (result.command.version === 2) {
    if (!isDeepStrictEqual(result.command.input, request.op === "agent_start" ? projectStartInput(request.input) : request.op === "agent_restore" ? projectRestoreInput(request.input) : request.input)) invalid()
    return
  }
  const input = result.command.input
  if (request.op === "agent_stop") {
    if (!isDeepStrictEqual(input, { target: { agentId: request.input.agentId, handlerGeneration: request.input.handlerGeneration, providerGeneration: request.input.providerGeneration } })) invalid()
    return
  }
  if (input.environmentDigest !== launchEnvironmentDigest(request.input.environment)) invalid()
  if (request.op === "agent_restore") { if (input.agentId !== request.input.agentId) invalid(); return }
  const selection = object(input.selection)
  if (input.cwd !== request.input.cwd || input.backendId !== request.input.selection.providerId || selection.modelId !== request.input.selection.modelId || request.input.selection.mode && selection.modeId !== request.input.selection.mode) invalid()
  if (request.input.selection.reasoning.kind === "value" && object(selection.configValues).reasoning !== request.input.selection.reasoning.value) invalid()
}
export function agentErrorReply(request: AgentRequest | Pick<AgentReply, "requestId" | "handlerGeneration" | "commandId">, error: unknown): AgentReply {
  const commandId = "op" in request ? commandIdFor(request) : request.commandId
  if (error instanceof ControlError) error = new AgentError(error.code === "ACTIVE_AGENTS" ? "INCOMPLETE" : error.code)
  return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, ...(commandId ? { commandId } : {}), ok: false, error: agentFailure(error) }
}
export function agentExchangeTimeout(request: AgentRequest): number { return request.op === "agent_prompt" ? 0 : 5000 }
export async function exchangeAgent(socket: Socket, request: AgentRequest, timeoutMs = agentExchangeTimeout(request)): Promise<AgentReply> {
  try {
    const frame = encodeFrame(parseAgentRequest(request)), incoming = receiveFrame(socket, timeoutMs)
    socket.end(frame)
    const reply = parseAgentReply(await incoming)
    validateAgentReply(reply, request); return reply
  } catch (error) {
    if (error instanceof ControlError) throw new AgentError(error.code === "INVALID_PROTOCOL" ? "INVALID_PROTOCOL" : error.code === "INCOMPLETE" ? "INCOMPLETE" : "UNAVAILABLE")
    throw error
  } finally { socket.destroy() }
}