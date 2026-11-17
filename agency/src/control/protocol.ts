import type { LaunchRecord } from "../platform/types.js"
import type { HandlerInspection } from "../platform/types.js"
import type { PlatformPaths } from "../platform/paths.js"

export const PROTOCOL = "agency-control/2" as const
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export type ControlRequest = { protocol: typeof PROTOCOL; requestId: string; handlerGeneration: string } & (
  | { op: "status" }
  | { op: "shutdown"; commandId: string; stopAgents: boolean; requireIdle?: true }
)
export type ControlErrorCode = "USAGE" | "INVALID_PROTOCOL" | "STALE_HANDLER" | "UNAVAILABLE" | "INTERNAL" | "INCOMPLETE" | "ACTIVE_AGENTS" | "COMMAND_CONFLICT" | "BUSY"
export type LaunchSummary = { launchAttemptId: string; owner: { kind: "agent"; id: string; generation: string } | { kind: "legacy-agent"; id: string; handlerGeneration: string } | { kind: "catalog-probe"; id: string; providerId: "claude-agent-acp" | "codex-acp" }; phase: LaunchRecord["phase"]; reason: string | null }
export type StatusIssue = { path: string; launchAttemptId: string | null; message: string }
export type HandlerStatus = {
  hostId: string
  handlerGeneration: string
  phase: "starting" | "reconciling" | "ready" | "draining"
  reconciliation: { classified: number; total: number; uncertain: number }
  launches: LaunchSummary[]
  issues?: StatusIssue[]
  distDigest?: string | null
  capabilities: ["status", "doctor", "shutdown"]
}
export type DoctorDiagnostic = {
  runtimeIssues?: StatusIssue[]
  node: string
  platform: "darwin" | "linux"
  hostId: string
  paths: PlatformPaths
  handler: HandlerInspection | null
  catalog: { commands: Array<{ id: string; state: string }>; issues: string[] }
  issues: Array<{ source: "catalog"; path: string; message: string }>
}
export type ControlResult = HandlerStatus | { state: "shutdown_accepted"; commandId: string; handlerGeneration: string }
export type ControlReply = { protocol: typeof PROTOCOL; requestId: string; handlerGeneration: string } & (
  | { ok: true; result: ControlResult }
  | { ok: false; error: { code: ControlErrorCode; message: string } }
)

const codes: Record<ControlErrorCode, number> = { USAGE: 64, INVALID_PROTOCOL: 65, STALE_HANDLER: 69, UNAVAILABLE: 69, INTERNAL: 70, INCOMPLETE: 75, ACTIVE_AGENTS: 75, COMMAND_CONFLICT: 75, BUSY: 75 }

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
  const requireIdle = Object.hasOwn(v, "requireIdle")
  if (requireIdle && (v.requireIdle !== true || v.stopAgents !== true)) return invalid()
  exactKeys(v, ["protocol", "requestId", "handlerGeneration", "op", "commandId", "stopAgents", ...(requireIdle ? ["requireIdle"] : [])])
  return { ...common, op: "shutdown", commandId: uuid(v.commandId), stopAgents: v.stopAgents, ...(requireIdle ? { requireIdle: true as const } : {}) }
}

function result(value: unknown): ControlResult {
  const v = object(value), generation = uuid(v.handlerGeneration)
  if (v.state === "shutdown_accepted") {
    exactKeys(v, ["state", "commandId", "handlerGeneration"])
    return { state: "shutdown_accepted", commandId: uuid(v.commandId), handlerGeneration: generation }
  }
  exactKeys(v, ["hostId", "handlerGeneration", "phase", "capabilities", ...(Object.hasOwn(v, "reconciliation") ? ["reconciliation"] : []), ...(Object.hasOwn(v, "launches") ? ["launches"] : []), ...(Object.hasOwn(v, "issues") ? ["issues"] : []), ...(Object.hasOwn(v, "distDigest") ? ["distDigest"] : [])])
  if (!(v.phase === "starting" || v.phase === "reconciling" || v.phase === "ready" || v.phase === "draining")) return invalid()
  const r = Object.hasOwn(v, "reconciliation") ? object(v.reconciliation) : { classified: 0, total: 0, uncertain: 0 }
  exactKeys(r, ["classified", "total", "uncertain"])
  const reconciliation = { classified: integer(r.classified), total: integer(r.total), uncertain: integer(r.uncertain) }
  if (reconciliation.classified > reconciliation.total || reconciliation.uncertain > reconciliation.classified) invalid()
  if (v.phase === "ready" && reconciliation.classified !== reconciliation.total) invalid()
  if (Object.hasOwn(v, "launches") && !Array.isArray(v.launches) || !Array.isArray(v.capabilities) || v.capabilities.length !== 3 || v.capabilities.join(",") !== "status,doctor,shutdown") return invalid()
  const issues = Object.hasOwn(v, "issues") ? (Array.isArray(v.issues) && v.issues.length <= 4096 ? v.issues.map(value => { const issue = object(value); exactKeys(issue, ["path", "launchAttemptId", "message"]); if (typeof issue.path !== "string" || !issue.path.startsWith("/") || issue.launchAttemptId !== null && !UUID.test(String(issue.launchAttemptId)) || typeof issue.message !== "string") invalid(); return { path: issue.path, launchAttemptId: issue.launchAttemptId as string | null, message: issue.message } }) : invalid()) : undefined
  const distDigest = !Object.hasOwn(v, "distDigest") ? undefined : v.distDigest === null ? null : typeof v.distDigest === "string" && /^[0-9a-f]{64}$/.test(v.distDigest) ? v.distDigest : invalid()
  return { hostId: hostId(v.hostId), handlerGeneration: generation, phase: v.phase, reconciliation, launches: [], ...(issues === undefined ? {} : { issues }), ...(distDigest === undefined ? {} : { distDigest }), capabilities: ["status", "doctor", "shutdown"] }
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