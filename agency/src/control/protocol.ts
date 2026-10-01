import type { LaunchRecord } from "../platform/types.js"

export const PROTOCOL = "agency-control/2" as const
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export type ControlRequest = { protocol: typeof PROTOCOL; requestId: string; handlerGeneration: string } & (
  | { op: "status" }
  | { op: "shutdown"; commandId: string; stopAgents: boolean }
)
export type ControlErrorCode = "USAGE" | "INVALID_PROTOCOL" | "STALE_HANDLER" | "UNAVAILABLE" | "INTERNAL" | "INCOMPLETE" | "ACTIVE_AGENTS" | "COMMAND_CONFLICT"
export type LaunchSummary = { launchAttemptId: string; owner: { kind: "agent"; id: string; generation: string } | { kind: "legacy-agent"; id: string; handlerGeneration: string } | { kind: "catalog-probe"; id: string; providerId: "claude-agent-acp" | "codex-acp" }; phase: LaunchRecord["phase"]; reason: string | null }
export type StatusIssue = { path: string; launchAttemptId: string | null; message: string }
export type HandlerStatus = {
  hostId: string
  handlerGeneration: string
  phase: "starting" | "reconciling" | "ready" | "draining"
  reconciliation: { classified: number; total: number; uncertain: number }
  launches: LaunchSummary[]
  issues?: StatusIssue[]
  capabilities: ["status", "doctor", "shutdown"]
}
export type ControlResult = HandlerStatus | { state: "shutdown_accepted"; commandId: string; handlerGeneration: string }
export type ControlReply = { protocol: typeof PROTOCOL; requestId: string; handlerGeneration: string } & (
  | { ok: true; result: ControlResult }
  | { ok: false; error: { code: ControlErrorCode; message: string } }
)

const codes: Record<ControlErrorCode, number> = { USAGE: 64, INVALID_PROTOCOL: 65, STALE_HANDLER: 69, UNAVAILABLE: 69, INTERNAL: 70, INCOMPLETE: 75, ACTIVE_AGENTS: 75, COMMAND_CONFLICT: 75 }
const phases = new Set(["launch_pending", "readiness", "active", "exited_unverified", "cleanup_pending", "cleanup_verified", "quarantined"])

export class ControlError extends Error {
  constructor(readonly code: ControlErrorCode, message: string = code) { super(`${code}: ${message}`) }
}

export function controlError(error: unknown, fallback: ControlErrorCode = "INTERNAL"): ControlError {
  return error instanceof ControlError ? error : new ControlError(fallback, error instanceof Error ? error.message : String(error))
}

export function exitCode(code: ControlErrorCode): number { return codes[code] }

function invalid(): never { throw new ControlError("INVALID_PROTOCOL") }

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
}

export function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return invalid()
  return value
}

export function uuid(value: unknown): string {
  const result = string(value)
  if (!UUID.test(result)) invalid()
  return result
}

export function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) return invalid()
  return value
}

export function hostId(value: unknown): string {
  const result = string(value)
  if (!/^[0-9a-f]{64}$/.test(result)) invalid()
  return result
}

function header(value: Record<string, unknown>): { protocol: typeof PROTOCOL; requestId: string; handlerGeneration: string } {
  if (value.protocol !== PROTOCOL) invalid()
  return { protocol: PROTOCOL, requestId: uuid(value.requestId), handlerGeneration: uuid(value.handlerGeneration) }
}

export function parseRequest(value: unknown): ControlRequest {
  const v = object(value), common = header(v)
  if (v.op === "status") { exactKeys(v, ["protocol", "requestId", "handlerGeneration", "op"]); return { ...common, op: "status" } }
  if (v.op !== "shutdown" || typeof v.stopAgents !== "boolean") return invalid()
  exactKeys(v, ["protocol", "requestId", "handlerGeneration", "op", "commandId", "stopAgents"])
  return { ...common, op: "shutdown", commandId: uuid(v.commandId), stopAgents: v.stopAgents }
}

function summary(value: unknown): LaunchSummary {
  const v = object(value)
  exactKeys(v, ["launchAttemptId", "owner", "phase", "reason"])
  if (typeof v.phase !== "string" || !phases.has(v.phase) || !(v.reason === null || typeof v.reason === "string")) return invalid()
  const owner = object(v.owner)
  if (owner.kind === "catalog-probe") {
    exactKeys(owner, ["kind", "id", "providerId"])
    if (owner.providerId !== "claude-agent-acp" && owner.providerId !== "codex-acp") invalid()
    return { launchAttemptId: string(v.launchAttemptId), owner: { kind: "catalog-probe", id: string(owner.id), providerId: owner.providerId }, phase: v.phase as LaunchRecord["phase"], reason: v.reason }
  }
  if (owner.kind === "legacy-agent") {
    exactKeys(owner, ["kind", "id", "handlerGeneration"])
    return { launchAttemptId: string(v.launchAttemptId), owner: { kind: "legacy-agent", id: string(owner.id), handlerGeneration: string(owner.handlerGeneration) }, phase: v.phase as LaunchRecord["phase"], reason: v.reason }
  }
  exactKeys(owner, ["kind", "id", "generation"])
  if (owner.kind !== "agent") invalid()
  return { launchAttemptId: string(v.launchAttemptId), owner: { kind: "agent", id: string(owner.id), generation: string(owner.generation) }, phase: v.phase as LaunchRecord["phase"], reason: v.reason }
}

function result(value: unknown): ControlResult {
  const v = object(value), generation = uuid(v.handlerGeneration)
  if (v.state === "shutdown_accepted") {
    exactKeys(v, ["state", "commandId", "handlerGeneration"])
    return { state: "shutdown_accepted", commandId: uuid(v.commandId), handlerGeneration: generation }
  }
  exactKeys(v, ["hostId", "handlerGeneration", "phase", "reconciliation", "launches", "capabilities", ...(Object.hasOwn(v, "issues") ? ["issues"] : [])])
  if (!(v.phase === "starting" || v.phase === "reconciling" || v.phase === "ready" || v.phase === "draining")) return invalid()
  const r = object(v.reconciliation)
  exactKeys(r, ["classified", "total", "uncertain"])
  const reconciliation = { classified: integer(r.classified), total: integer(r.total), uncertain: integer(r.uncertain) }
  if (reconciliation.classified > reconciliation.total || reconciliation.uncertain > reconciliation.classified) invalid()
  if (v.phase === "ready" && reconciliation.classified !== reconciliation.total) invalid()
  if (!Array.isArray(v.launches) || !Array.isArray(v.capabilities) || v.capabilities.length !== 3 || v.capabilities.join(",") !== "status,doctor,shutdown") return invalid()
  const issues = Object.hasOwn(v, "issues") ? (Array.isArray(v.issues) && v.issues.length <= 4096 ? v.issues.map(value => { const issue = object(value); exactKeys(issue, ["path", "launchAttemptId", "message"]); if (typeof issue.path !== "string" || !issue.path.startsWith("/") || issue.launchAttemptId !== null && !UUID.test(String(issue.launchAttemptId)) || typeof issue.message !== "string") invalid(); return { path: issue.path, launchAttemptId: issue.launchAttemptId as string | null, message: issue.message } }) : invalid()) : undefined
  return { hostId: hostId(v.hostId), handlerGeneration: generation, phase: v.phase, reconciliation, launches: v.launches.map(summary), ...(issues === undefined ? {} : { issues }), capabilities: ["status", "doctor", "shutdown"] }
}

export function parseReply(value: unknown): ControlReply {
  const v = object(value), common = header(v)
  if (v.ok === true) { exactKeys(v, ["protocol", "requestId", "handlerGeneration", "ok", "result"]); return { ...common, ok: true, result: result(v.result) } }
  if (v.ok !== false) return invalid()
  exactKeys(v, ["protocol", "requestId", "handlerGeneration", "ok", "error"])
  const e = object(v.error)
  exactKeys(e, ["code", "message"])
  if (typeof e.code !== "string" || !Object.hasOwn(codes, e.code) || typeof e.message !== "string" || Buffer.byteLength(e.message) > 8192) return invalid()
  return { ...common, ok: false, error: { code: e.code as ControlErrorCode, message: e.message } }
}

export function validateReplyForRequest(reply: ControlReply, request: ControlRequest): void {
  if (reply.handlerGeneration !== request.handlerGeneration || (reply.ok && reply.result.handlerGeneration !== request.handlerGeneration)) throw new ControlError("STALE_HANDLER")
  if (reply.requestId !== request.requestId) invalid()
  if (!reply.ok) return
  if (request.op === "status" && !("capabilities" in reply.result)) invalid()
  if (request.op === "shutdown" && (!("state" in reply.result) || reply.result.commandId !== request.commandId)) invalid()
}

export function errorReply(request: Pick<ControlRequest, "requestId" | "handlerGeneration">, error: unknown): ControlReply {
  const e = controlError(error)
  return { protocol: PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, ok: false, error: { code: e.code, message: e.message.slice(0, 2048) } }
}