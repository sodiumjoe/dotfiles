import type { Socket } from "node:net"
import { isDeepStrictEqual } from "node:util"
import { id, keys, object, text } from "../catalog/types.js"
import { CURSOR_BYTES, parsePageInput, QUERY_BYTES, type AgentPage } from "./queries.js"
import { ControlError, UUID } from "../control/protocol.js"
import { encodeFrame, receiveFrame } from "../control/wire.js"
import type { LaunchRecord, ProcessIdentity } from "../platform/types.js"
import { AgentError, agentFailure, agentText, parseAgentCommand, parseAgentCommandV3, parseAgentFailure, parseAgentRecordV3, parseLegacyAgentRecord, type AgentFailure, type AgentView, type LegacyAgentView, type CommandView } from "./types.js"
import type { AgentStateIssue } from "./store.js"

import { isRuntimeSessionRequest, parseRuntimeSessionOperation, type RuntimeSessionRequest, type RuntimeSessionResult } from "./session-controls.js"
import { parseSubmissionReceipt } from "./submission-receipt.js"
import { parseTuple } from "./types.js"

import type { RuntimeHumanRequest, RuntimeHumanResult } from "./human-controls.js"
import { parsePermissionRef, parsePermissionReceipt, parsePermissionSnapshot } from "../agent/permission-types.js"

export const AGENT_PROTOCOL = "agency-agent/3" as const
export type AgentRequest = { protocol: typeof AGENT_PROTOCOL; requestId: string; handlerGeneration: string } & (
  | RuntimeHumanRequest
  | RuntimeSessionRequest
)
export type AgentReply = { protocol: typeof AGENT_PROTOCOL; requestId: string; handlerGeneration: string | null; commandId?: string } & ({ ok: true; result: CommandView | AgentPage | RuntimeHumanResult | RuntimeSessionResult } | { ok: false; error: AgentFailure })
function invalid(): never { throw new AgentError("INVALID_PROTOCOL") }
export const commandIdFor = (request: AgentRequest): string | undefined => request.op === "agent_session_command" ? request.commandId : request.op === "agent_session_start" || request.op === "agent_stop" ? request.input.commandId : undefined
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
export function parseAgentView(input: unknown, generation: string | null): AgentView | LegacyAgentView {
  const v = object(input), current = object(v.record)
  keys(v, current.version === 1 ? ["record", "launch", "live", "cleanup"] : ["record", "launch", "live", "cleanup", "unavailable", ...(Object.hasOwn(v, "display") ? ["display"] : [])])
  const recordValue = object(v.record), launch = v.launch === null ? null : launchRecord(v.launch)
  if (recordValue.version === 1) {
    const record = parseLegacyAgentRecord(v.record)
    if (v.live !== false || v.cleanup !== "unknown" && v.cleanup !== "verified" || launch && (launch.version !== 1 || launch.agentId !== record.spec.agentId || launch.launchAttemptId !== record.spec.launchAttemptId)) invalid()
    return { record, launch, live: false, cleanup: v.cleanup as LegacyAgentView["cleanup"] }
  }
  let display: AgentView["display"]
  if (Object.hasOwn(v, "display")) {
    const value = object(v.display); keys(value, ["title", "activity"])
    if (value.activity !== "working" && value.activity !== "idle") invalid()
    display = { title: value.title === null ? null : agentText(value.title, 1024), activity: value.activity }
  }
  const displayFields = display ? { display } : {}
  const record = parseAgentRecordV3(v.record)
  const unavailable = v.unavailable === null ? null : stateIssue(v.unavailable)
  if (!record.launch) {
    if (launch !== null || v.live !== false || v.cleanup !== "not_launched") invalid()
    return { ...displayFields, record, launch: null, live: false, cleanup: "not_launched", unavailable }
  }
  if (typeof v.live !== "boolean" || !["not_launched", "verified", "unverified", "unknown"].includes(String(v.cleanup))) invalid()
  if (launch && (launch.version !== 2 || launch.owner.kind !== "agent" || launch.owner.agentId !== record.definition.agentId || launch.owner.providerGeneration !== record.launch.providerGeneration || launch.launchAttemptId !== record.launch!.launchAttemptId || launch.handlerGeneration !== record.launch.handlerGeneration)) {
    if (!unavailable || v.live !== false || !unavailable.path.endsWith("/" + record.launch!.launchAttemptId + ".json")) invalid()
    return { ...displayFields, record, launch: null, live: false, cleanup: "unknown", unavailable }
  }
  if (v.cleanup === "verified" && launch?.phase !== "cleanup_verified" || v.cleanup === "not_launched" && launch !== null) invalid()
  if (v.live && (record.launch.handlerGeneration !== generation || !["starting", "ready", "recoverable", "restoring", "stopping"].includes(record.phase) || !launch && !["starting", "restoring"].includes(record.phase) || launch?.phase === "cleanup_verified" || launch?.phase === "quarantined")) invalid()
  return { ...displayFields, record, launch, live: v.live as boolean, cleanup: v.cleanup as AgentView["cleanup"], unavailable }
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
    if (typeof v.op === "string" && isRuntimeSessionRequest({ op: v.op })) {
      const { protocol, requestId, handlerGeneration, ...operation } = v
      const parsed = parseRuntimeSessionOperation(operation)
      const expected = "target" in parsed ? parsed.target.handlerGeneration : "input" in parsed ? parsed.input.handlerGeneration : common.handlerGeneration
      if (expected !== common.handlerGeneration) invalid()
      return { ...common, ...parsed }
    }
    if (v.op === "agent_roster") { keys(v, ["protocol", "requestId", "handlerGeneration", "op", "input"]); return { ...common, op: v.op, input: parsePageInput(v.input) } }
    if (v.op === "agent_permissions") { keys(v, ["protocol", "requestId", "handlerGeneration", "op"]); return { ...common, op: v.op } }
    if (v.op === "agent_excerpt") {
      keys(v, ["protocol", "requestId", "handlerGeneration", "op", "input"])
      const input = object(v.input); keys(input, ["agentId", "turns"])
      if (typeof input.turns !== "number" || !Number.isInteger(input.turns) || input.turns < 1 || input.turns > 8) invalid()
      return { ...common, op: "agent_excerpt", input: { agentId: id(input.agentId), turns: input.turns } }
    }
    if (v.op === "agent_permission_inspect") { keys(v, ["protocol", "requestId", "handlerGeneration", "op", "commandId"]); return { ...common, op: v.op, commandId: id(v.commandId) } }
    if (v.op === "agent_permission_decide") {
      keys(v, ["protocol", "requestId", "handlerGeneration", "op", "commandId", "ref", "optionId"])
      const ref = parsePermissionRef(v.ref)
      if (ref.target.handlerGeneration !== common.handlerGeneration) invalid()
      return { ...common, op: v.op, commandId: id(v.commandId), ref, optionId: text(v.optionId) }
    }
    return invalid()
  } catch (error) { if (error instanceof AgentError && error.code === "INPUT_TOO_LARGE") throw error; return invalid() }
}
export function parseCommandView(input: unknown): CommandView {
  const r = object(input)
  keys(r, ["state", "command", "durability"])
  if (r.state !== "command" || r.durability !== "verified" && r.durability !== "unverified") invalid()
  const command = object(r.command).version === 3 ? parseAgentCommandV3(r.command) : parseAgentCommand(r.command)
  return { state: "command", command, durability: r.durability }
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
      const result = parseCommandView(r)
      if (common.commandId !== result.command.commandId) invalid()
      return { ...common, ok: true, result }
    }
    if (r.state === "session_command") {
      keys(r, ["state", "commandId", "commandGeneration", "receipt"])
      const commandId = id(r.commandId), commandGeneration = id(r.commandGeneration), receipt = r.receipt === null ? null : parseCommandView(r.receipt)
      if (common.commandId !== commandId || receipt && (receipt.command.commandId !== commandId || receipt.command.handlerGeneration !== commandGeneration)) invalid()
      return { ...common, ok: true, result: { state: "session_command", commandId, commandGeneration, receipt } }
    }
    if (common.commandId) invalid()
    if (r.state === "session") {
      keys(r, ["state", "agentId", "agent"])
      const agentId = id(r.agentId), agent = r.agent === null ? null : parseAgentView(r.agent, common.handlerGeneration)
      if (agent && (agent.record.version !== 3 || agent.record.definition.agentId !== agentId)) invalid()
      return { ...common, ok: true, result: { state: "session", agentId, agent: agent as AgentView | null } }
    }
    if (r.state === "submission") {
      keys(r, ["state", "target", "submissionId", "receipt"])
      const target = parseTuple(r.target), submissionId = id(r.submissionId), receipt = r.receipt === null ? null : parseSubmissionReceipt(r.receipt)
      if (target.handlerGeneration !== common.handlerGeneration || receipt && receipt.submissionId !== submissionId) invalid()
      return { ...common, ok: true, result: { state: "submission", target, submissionId, receipt } }
    }
    if (r.state === "permissions") {
      keys(r, ["state", "snapshot"])
      const snapshot = parsePermissionSnapshot(r.snapshot)
      if (snapshot.handlerGeneration !== common.handlerGeneration) invalid()
      return { ...common, ok: true, result: { state: "permissions", snapshot } }
    }
    if (r.state === "excerpt") {
      keys(r, ["state", "source", "turns", "reason"])
      if (!["live", "history", "none"].includes(String(r.source)) || !Array.isArray(r.turns) || r.turns.length > 8 || !(r.reason === null || typeof r.reason === "string")) invalid()
      const turns = (r.turns as unknown[]).map(value => {
        const turn = object(value); keys(turn, ["role", "text"])
        if (turn.role !== "user" && turn.role !== "agent" || typeof turn.text !== "string" || turn.text.length > 4096) invalid()
        return { role: turn.role as "user" | "agent", text: turn.text as string }
      })
      return { ...common, ok: true, result: { state: "excerpt", source: r.source as "live" | "history" | "none", turns, reason: r.reason as string | null } }
    }
    if (r.state === "permission") {
      keys(r, ["state", "receipt"])
      return { ...common, ok: true, result: { state: "permission", receipt: r.receipt === null ? null : parsePermissionReceipt(r.receipt) } }
    }
    if (r.state === "page") {
      keys(r, ["state", "revision", "agents", "issues", "nextCursor"])
      if (!Array.isArray(r.agents) || !Array.isArray(r.issues) || r.agents.length + r.issues.length > 100 || Buffer.byteLength(JSON.stringify(r)) > QUERY_BYTES) invalid()
      if (r.nextCursor !== null && (typeof r.nextCursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(r.nextCursor) || r.nextCursor.length > CURSOR_BYTES)) invalid()
      const agents = r.agents.map(a => parseAgentView(a, common.handlerGeneration)), ids = agents.map(a => a.record.version === 3 ? a.record.definition.agentId : a.record.spec.agentId)
      if (new Set(ids).size !== ids.length || ids.some((value, index) => index > 0 && ids[index - 1]! >= value)) invalid()
      return { ...common, ok: true, result: { state: "page", revision: id(r.revision), agents, issues: r.issues.map(stateIssue), nextCursor: r.nextCursor as string | null } }
    }
    return invalid()
  } catch { return invalid() }
}
export function validateAgentReply(reply: AgentReply, request: AgentRequest): void {
  if (reply.requestId !== request.requestId || reply.commandId !== commandIdFor(request)) invalid()
  if (reply.handlerGeneration !== request.handlerGeneration) throw new AgentError("STALE_HANDLER")
  if (!reply.ok) return
  const result = reply.result
  if (request.op === "agent_session_inspect") { if (result.state !== "session" || result.agentId !== request.agentId) invalid(); return }
  if (request.op === "agent_session_command") { if (result.state !== "session_command" || result.commandId !== request.commandId || result.commandGeneration !== request.commandGeneration) invalid(); return }
  if (request.op === "agent_session_submit" || request.op === "agent_session_submission" || request.op === "agent_session_cancel") {
    if (result.state !== "submission" || !isDeepStrictEqual(result.target, request.target) || result.submissionId !== request.submissionId || request.op !== "agent_session_submission" && !result.receipt) invalid()
    return
  }
  if (request.op === "agent_session_start") {
    if (result.state !== "command" || result.command.version !== 3 || result.command.op !== "start" || result.command.handlerGeneration !== request.handlerGeneration || result.command.input.cwd !== request.input.cwd || result.command.input.backendId !== request.input.backendId) invalid()
    return
  }
  if (request.op === "agent_roster") {
    if (result.state !== "page" || result.agents.length + result.issues.length > request.input.limit) invalid()
    if (request.input.cwd && result.agents.some(a => (a.record.version === 3 ? a.record.definition.cwd : a.record.spec.checkout.root.path) !== request.input.cwd)) invalid()
    if ( result.agents.some(a => a.record.version !== 3 || a.record.launch?.handlerGeneration !== request.handlerGeneration || !["starting", "ready", "restoring", "stopping"].includes(a.record.phase))) invalid()
    return
  }
  if (request.op === "agent_permissions") { if (result.state !== "permissions") invalid(); return }
  if (request.op === "agent_excerpt") { if (result.state !== "excerpt") invalid(); return }
  if (request.op === "agent_permission_decide") {
    if (result.state !== "permission" || !result.receipt || result.receipt.commandId !== request.commandId || result.receipt.optionId !== request.optionId || !isDeepStrictEqual(result.receipt.ref, request.ref)) invalid()
    return
  }
  if (request.op === "agent_permission_inspect") {
    if (result.state !== "permission" || result.receipt && result.receipt.commandId !== request.commandId) invalid()
    return
  }
  if (request.op !== "agent_stop" || result.state !== "command" || result.command.op !== "stop") return invalid()
  if (result.command.version === 2) { if (!isDeepStrictEqual(result.command.input, request.input)) invalid(); return }
  if (!isDeepStrictEqual(result.command.input, { target: { agentId: request.input.agentId, handlerGeneration: request.input.handlerGeneration, providerGeneration: request.input.providerGeneration } })) invalid()
}
export function agentErrorReply(request: AgentRequest | Pick<AgentReply, "requestId" | "handlerGeneration" | "commandId">, error: unknown): AgentReply {
  const commandId = "op" in request ? commandIdFor(request) : request.commandId
  if (error instanceof ControlError) error = new AgentError(error.code === "ACTIVE_AGENTS" ? "INCOMPLETE" : error.code)
  return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, ...(commandId ? { commandId } : {}), ok: false, error: agentFailure(error) }
}
export async function exchangeAgent(socket: Socket, request: AgentRequest, timeoutMs = 5000): Promise<AgentReply> {
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