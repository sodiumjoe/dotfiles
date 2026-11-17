import type { Socket } from "node:net"
import { parseLaunchEnvironment, type LaunchEnvironment } from "../agent/environment.js"
import { parseRequestedSettings, type RequestedSettings } from "../agent/session-config.js"
import { absolutePath, id, keys, object, providerId, type ProviderId } from "../catalog/types.js"
import { ControlError } from "../control/protocol.js"
import { encodeFrame, receiveFrame } from "../control/wire.js"
import type { PromptResult } from "./core.js"
import { parseRequestFailure, RequestError, requestFailure, type RequestFailure } from "./errors.js"
import type { RosterRow } from "./roster.js"

export const REQUEST_PROTOCOL = "agency-request/1" as const
export type LiveOperation =
  | { op: "start"; agentId: string; backendId?: ProviderId; cwd: string; model?: string; mode?: string; settings?: RequestedSettings; environment: LaunchEnvironment }
  | { op: "stop" | "cancel"; agentId: string }
  | { op: "prompt"; agentId: string; text: string; environment: LaunchEnvironment; submissionId?: string }
  | { op: "agents" }
export type LiveRequest = { protocol: typeof REQUEST_PROTOCOL; requestId: string } & LiveOperation
export type LiveResult = { state: "agent"; agent: RosterRow } | PromptResult | { state: "agents"; handlerGeneration: string; agents: RosterRow[] }
export type LiveReply = { protocol: typeof REQUEST_PROTOCOL; requestId: string } & ({ ok: true; result: LiveResult } | { ok: false; error: RequestFailure })

const PROMPT_BYTES = 262144
function invalid(message: string): never { throw new RequestError("INVALID", message) }
function name(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim() || value.length > 1024) invalid(label + " must be a non-empty string"); return value }
const optional = <T>(v: Record<string, unknown>, key: string, parse: (value: unknown) => T): { [key: string]: T } => Object.hasOwn(v, key) ? { [key]: parse(v[key]) } : {}

export function parseLiveRequest(raw: unknown): LiveRequest {
  let v: Record<string, unknown>, requestId: string
  try { v = object(raw); requestId = id(v.requestId) } catch { return invalid("malformed request") }
  if (v.protocol !== REQUEST_PROTOCOL) invalid("unsupported request protocol")
  const fields = (required: string[], optional: string[] = []) => { try { keys(v, ["protocol", "requestId", "op", ...required, ...optional.filter(key => Object.hasOwn(v, key))]) } catch { invalid("unexpected or missing fields for " + String(v.op)) } }
  const agent = (): string => { try { return id(v.agentId) } catch { return invalid("agentId must be a canonical UUID") } }
  const base = { protocol: REQUEST_PROTOCOL, requestId }
  try {
    if (v.op === "start") {
      fields(["agentId", "cwd", "environment"], ["backendId", "model", "mode", "settings"])
      return { ...base, op: "start", agentId: agent(), cwd: absolutePath(v.cwd), environment: parseLaunchEnvironment(v.environment), ...optional(v, "backendId", providerId), ...optional(v, "model", value => name(value, "model")), ...optional(v, "mode", value => name(value, "mode")), ...optional(v, "settings", parseRequestedSettings) } as LiveRequest
    }
    if (v.op === "stop" || v.op === "cancel") { fields(["agentId"]); return { ...base, op: v.op, agentId: agent() } }
    if (v.op === "prompt") {
      fields(["agentId", "text", "environment"], ["submissionId"])
      if (typeof v.text !== "string" || !v.text.length || Buffer.byteLength(v.text) > PROMPT_BYTES || !v.text.isWellFormed()) invalid("prompt text must be 1 to " + PROMPT_BYTES + " bytes of well-formed text")
      return { ...base, op: "prompt", agentId: agent(), text: v.text, environment: parseLaunchEnvironment(v.environment), ...optional(v, "submissionId", id) }
    }
    if (v.op === "agents") { fields([]); return { ...base, op: "agents" } }
  } catch (error) { if (error instanceof RequestError) throw error; invalid("invalid " + String(v.op) + " request") }
  return invalid("unknown operation " + String(v.op).slice(0, 64))
}

export function liveErrorReply(request: { requestId: string }, error: unknown): LiveReply {
  return { protocol: REQUEST_PROTOCOL, requestId: request.requestId, ok: false, error: requestFailure(error) }
}

export function parseLiveReply(raw: unknown, request: LiveRequest): LiveReply {
  const v = object(raw)
  if (v.protocol !== REQUEST_PROTOCOL || v.requestId !== request.requestId || typeof v.ok !== "boolean") throw new RequestError("FAILED", "the Handler sent a malformed reply")
  if (!v.ok) return { protocol: REQUEST_PROTOCOL, requestId: request.requestId, ok: false, error: parseRequestFailure(v.error) }
  return { protocol: REQUEST_PROTOCOL, requestId: request.requestId, ok: true, result: object(v.result) as LiveResult }
}

export function liveTimeout(op: LiveOperation["op"]): number { return op === "prompt" ? 0 : ["agents", "permissions", "excerpt", "transcript"].includes(op) ? 10000 : 300000 }

export async function exchangeLive(socket: Socket, request: LiveRequest, timeoutMs = liveTimeout(request.op)): Promise<LiveReply> {
  try {
    const frame = encodeFrame(request), incoming = receiveFrame(socket, timeoutMs)
    socket.end(frame)
    return parseLiveReply(await incoming, request)
  } catch (error) {
    if (error instanceof ControlError) throw new RequestError(error.code === "INCOMPLETE" ? "FAILED" : "UNAVAILABLE", "the Handler did not answer: " + error.message)
    throw error
  } finally { socket.destroy() }
}