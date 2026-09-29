import type { Socket } from "node:net"
import { isDeepStrictEqual } from "node:util"
import { absolutePath, id, keys, object } from "../catalog/types.js"
import { parseAdmissionRecord } from "../checkout/records.js"
import { CheckoutResolutionError } from "../checkout/identity.js"
import { ControlError } from "../control/protocol.js"
import { encodeFrame, receiveFrame } from "../control/wire.js"
import type { LaunchRecord, ProcessIdentity } from "../platform/types.js"
import { AgentError, agentFailure, agentText, parseAgentCommand, parseAgentFailure, parseAgentRecord, parsePromptInput, parsePromptView, parseStartInput, parseStopInput, type AgentFailure, type AgentList, type AgentView, type CommandView, type CurrentAgent, type PromptInput, type PromptView, type StartInput, type StopInput } from "./types.js"

export const AGENT_PROTOCOL = "agency-agent/1" as const
export type AgentRequest = { protocol: typeof AGENT_PROTOCOL; requestId: string; handlerGeneration: string } & (
  | { op: "agent_start"; input: StartInput } | { op: "agent_stop"; input: StopInput } | { op: "agent_prompt"; input: PromptInput } | { op: "agent_current"; cwd: string } | { op: "agent_list" } | { op: "agent_command"; commandId: string; commandGeneration: string }
)
export type AgentReply = { protocol: typeof AGENT_PROTOCOL; requestId: string; handlerGeneration: string | null; commandId?: string } & ({ ok: true; result: CommandView | AgentList | CurrentAgent | PromptView } | { ok: false; error: AgentFailure })
function invalid(): never { throw new AgentError("INVALID_PROTOCOL") }
const commandIdFor = (request: AgentRequest): string | undefined => request.op === "agent_command" ? request.commandId : request.op === "agent_start" || request.op === "agent_stop" ? request.input.commandId : undefined
function identity(input: unknown): ProcessIdentity {
  const v = object(input)
  keys(v, ["bootId", "pid", "birth", "parentPid", "processGroupId", "sessionId", "uid", "gid"])
  for (const key of ["pid", "parentPid", "processGroupId", "sessionId", "uid", "gid"]) if (!Number.isSafeInteger(v[key]) || (v[key] as number) < (key === "uid" || key === "gid" || key === "parentPid" ? 0 : 1)) invalid()
  return { bootId: agentText(v.bootId), birth: agentText(v.birth, 1024), pid: v.pid as number, parentPid: v.parentPid as number, processGroupId: v.processGroupId as number, sessionId: v.sessionId as number, uid: v.uid as number, gid: v.gid as number }
}
function launchRecord(input: unknown): LaunchRecord {
  const v = object(input)
  keys(v, ["version", "checkoutId", "leaseId", "agentId", "handlerGeneration", "launchAttemptId", "launchBootId", "launchAttempted", "phase", "provider", "reason"])
  if (v.version !== 1 || typeof v.launchAttempted !== "boolean" || !["launch_pending", "readiness", "active", "exited_unverified", "cleanup_pending", "cleanup_verified", "quarantined"].includes(String(v.phase))) invalid()
  let provider: LaunchRecord["provider"] = null
  if (v.provider !== null) {
    const p = object(v.provider); keys(p, ["kind", "group"])
    const group = object(p.group); keys(group, ["leader", "observed"])
    if (p.kind !== "process-group" || !Array.isArray(group.observed) || group.observed.length > 4096) invalid()
    provider = { kind: "process-group", group: { leader: identity(group.leader), observed: (group.observed as unknown[]).map(identity) } }
  }
  return { version: 1, checkoutId: agentText(v.checkoutId), agentId: id(v.agentId), leaseId: id(v.leaseId), handlerGeneration: id(v.handlerGeneration), launchAttemptId: id(v.launchAttemptId), launchBootId: agentText(v.launchBootId), launchAttempted: v.launchAttempted as boolean, phase: v.phase as LaunchRecord["phase"], provider, reason: v.reason === null ? null : agentText(v.reason, 2048) }
}
function agentView(input: unknown, generation: string | null): AgentView {
  const v = object(input); keys(v, ["record", "launch", "live", "cleanup"])
  const record = parseAgentRecord(v.record), launch = v.launch === null ? null : launchRecord(v.launch)
  if (typeof v.live !== "boolean" || !["not_reserved", "verified", "unverified", "unknown"].includes(String(v.cleanup))) invalid()
  if (launch && (launch.agentId !== record.spec.agentId || launch.launchAttemptId !== record.spec.launchAttemptId || launch.leaseId !== record.spec.leaseId || launch.handlerGeneration !== record.spec.handlerGeneration || launch.checkoutId !== record.spec.checkout.checkoutId)) invalid()
  if (v.cleanup === "verified" && launch?.phase !== "cleanup_verified" || v.cleanup === "not_reserved" && launch !== null) invalid()
  if (v.live && (record.spec.handlerGeneration !== generation || !["starting", "ready", "stopping"].includes(record.phase) || !launch || launch.phase === "cleanup_verified" || launch.phase === "quarantined")) invalid()
  return { record, launch, live: v.live as boolean, cleanup: v.cleanup as AgentView["cleanup"] }
}
export function parseAgentRequest(input: unknown): AgentRequest {
  try {
    const v = object(input)
    if (v.protocol !== AGENT_PROTOCOL) invalid()
    const common = { protocol: AGENT_PROTOCOL, requestId: id(v.requestId), handlerGeneration: id(v.handlerGeneration) }
    if (v.op === "agent_list") { keys(v, ["protocol", "requestId", "handlerGeneration", "op"]); return { ...common, op: "agent_list" } }
    if (v.op === "agent_current") { keys(v, ["protocol", "requestId", "handlerGeneration", "op", "cwd"]); return { ...common, op: "agent_current", cwd: absolutePath(v.cwd) } }
    if (v.op === "agent_command") { keys(v, ["protocol", "requestId", "handlerGeneration", "op", "commandId", "commandGeneration"]); return { ...common, op: "agent_command", commandId: id(v.commandId), commandGeneration: id(v.commandGeneration) } }
    keys(v, ["protocol", "requestId", "handlerGeneration", "op", "input"])
    if (v.op === "agent_start") { const input = parseStartInput(v.input); if (input.handlerGeneration !== common.handlerGeneration) invalid(); return { ...common, op: "agent_start", input } }
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
      const command = parseAgentCommand(r.command)
      if (common.commandId !== command.commandId || r.durability !== "verified" && r.durability !== "unverified") invalid()
      return { ...common, ok: true, result: { state: "command", command, durability: r.durability as CommandView["durability"] } }
    }
    if (common.commandId) invalid()
    if (r.state === "prompt") return { ...common, ok: true, result: parsePromptView(r) }
    const unavailable = r.unavailable === null ? null : parseAgentFailure(r.unavailable)
    if (r.state === "agents") {
      keys(r, ["state", "agents", "unavailable"])
      if (!Array.isArray(r.agents) || r.agents.length > 4096) invalid()
      const agents = (r.agents as unknown[]).map(a => agentView(a, common.handlerGeneration))
      if (new Set(agents.map(a => a.record.spec.agentId)).size !== agents.length || unavailable && agents.some(a => a.live)) invalid()
      return { ...common, ok: true, result: { state: "agents", agents, unavailable } }
    }
    if (r.state !== "current") invalid()
    keys(r, ["state", "checkout", "agent", "blockers", "unavailable"])
    const checkout = parseAdmissionRecord({ version: 1, checkout: r.checkout, agentId: common.requestId, leaseId: common.requestId, launchAttemptId: common.requestId, handlerGeneration: common.requestId }).checkout
    if (!Array.isArray(r.blockers) || r.blockers.length > 4096) invalid()
    const blockers = (r.blockers as unknown[]).map(id)
    if (new Set(blockers).size !== blockers.length) invalid()
    return { ...common, ok: true, result: { state: "current", checkout, agent: r.agent === null ? null : agentView(r.agent, common.handlerGeneration), blockers, unavailable } }
  } catch { return invalid() }
}
export function validateAgentReply(reply: AgentReply, request: AgentRequest): void {
  if (reply.requestId !== request.requestId || reply.commandId !== commandIdFor(request)) invalid()
  if (reply.handlerGeneration !== request.handlerGeneration) throw new AgentError("STALE_HANDLER")
  if (!reply.ok) return
  const result = reply.result
  if (request.op === "agent_list") { if (result.state !== "agents") invalid(); return }
  if (request.op === "agent_current") { if (result.state !== "current") invalid(); return }
  if (request.op === "agent_prompt") { if (result.state !== "prompt" || !isDeepStrictEqual(result.target, { agentId: request.input.agentId, handlerGeneration: request.input.handlerGeneration, providerGeneration: request.input.providerGeneration })) invalid(); return }
  if (result.state !== "command") return invalid()
  if (request.op === "agent_command") { if (result.command.handlerGeneration !== request.commandGeneration) invalid(); return }
  if (result.command.op !== (request.op === "agent_start" ? "start" : "stop") || !isDeepStrictEqual(result.command.input, request.input)) invalid()
}
export function agentErrorReply(request: AgentRequest | Pick<AgentReply, "requestId" | "handlerGeneration" | "commandId">, error: unknown): AgentReply {
  const commandId = "op" in request ? commandIdFor(request) : request.commandId
  if (error instanceof ControlError) error = new AgentError(error.code === "ACTIVE_AGENTS" ? "INCOMPLETE" : error.code)
  if (error instanceof CheckoutResolutionError) error = new AgentError("ADMISSION_UNAVAILABLE")
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