import { hash, id, keys, object, text, timestamp } from "../catalog/types.js"
import { canonicalDigest, parseExecutionRef, type ExecutionRef } from "../orchestration/types.js"

export const BRIDGE_PROTOCOL = "agency-bridge/1"
export const BRIDGE_FRAME_BYTES = 1024 * 1024
export type BridgeHello = { protocol: typeof BRIDGE_PROTOCOL; hostId: string; handlerGeneration: string; connectionId: string; sourceRevision: string; nodeVersion: string; capabilities: string[]; outboxCursor: number }
export type Admission = { execution: ExecutionRef; submissionId: string; digest: string }
type Base = { protocol: typeof BRIDGE_PROTOCOL; connectionId: string }
export type BridgeEvent = Base & { type: "event"; channel: string; streamId: string; runId: string; hostId: string; eventId: string; seq: number; digest: string; payload: unknown }
export type BridgeAck = Omit<BridgeEvent, "type" | "payload"> & { type: "ack"; cursor: number }
export type BridgeFrame = (BridgeHello & { type: "hello" }) | BridgeEvent | BridgeAck | (Base & (
  { type: "request_cancel"; requestId: string } |
  { type: "request"; requestId: string; channel: string; payload: unknown } |
  { type: "reply"; requestId: string; ok: true; payload: unknown } |
  { type: "reply"; requestId: string; ok: false; error: string } |
  ({ type: "admission_prepare"; requestId: string } & Admission) |
  ({ type: "admission_result"; requestId: string; ok: boolean; error: string | null } & Admission)
))
export function bridgeError(code: string): never { throw new Error(code) }
export function parseAdmission(raw: unknown): Admission {
  const v = object(raw); keys(v, ["execution", "submissionId", "digest"])
  return { execution: parseExecutionRef(v.execution), submissionId: id(v.submissionId), digest: hash(v.digest) }
}
export function parseBridgeFrame(raw: unknown): BridgeFrame {
  try {
    const v = object(raw)
    if (v.protocol !== BRIDGE_PROTOCOL) bridgeError("UNSUPPORTED_BRIDGE_PROTOCOL")
    const base: Base = { protocol: BRIDGE_PROTOCOL, connectionId: id(v.connectionId) }
    const exact = (...fields: string[]) => keys(v, ["protocol", "connectionId", "type", ...fields])
    switch (v.type) {
      case "hello": {
        exact("hostId", "handlerGeneration", "sourceRevision", "nodeVersion", "capabilities", "outboxCursor")
        const revision = text(v.sourceRevision)
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) || !Array.isArray(v.capabilities) || v.capabilities.length > 64) bridgeError("INVALID_BRIDGE_HELLO")
        const capabilities = v.capabilities.map(value => text(value))
        if (new Set(capabilities).size !== capabilities.length) bridgeError("INVALID_BRIDGE_HELLO")
        return { ...base, type: "hello", hostId: hash(v.hostId), handlerGeneration: id(v.handlerGeneration), sourceRevision: revision, nodeVersion: text(v.nodeVersion), capabilities, outboxCursor: timestamp(v.outboxCursor) }
      }
      case "request_cancel": exact("requestId"); return { ...base, type: "request_cancel", requestId: id(v.requestId) }
      case "request": exact("requestId", "channel", "payload"); return { ...base, type: "request", requestId: id(v.requestId), channel: text(v.channel), payload: v.payload }
      case "reply":
        if (typeof v.ok !== "boolean") bridgeError("INVALID_BRIDGE_REPLY")
        exact("requestId", "ok", v.ok ? "payload" : "error")
        return v.ok ? { ...base, type: "reply", requestId: id(v.requestId), ok: true, payload: v.payload } : { ...base, type: "reply", requestId: id(v.requestId), ok: false, error: text(v.error, 2048) }
      case "admission_prepare": case "admission_result": {
        exact("requestId", "execution", "submissionId", "digest", ...(v.type === "admission_result" ? ["ok", "error"] : []))
        const admission = parseAdmission({ execution: v.execution, submissionId: v.submissionId, digest: v.digest }), requestId = id(v.requestId)
        if (v.type === "admission_prepare") return { ...base, type: v.type, requestId, ...admission }
        if (typeof v.ok !== "boolean" || (v.ok ? v.error !== null : typeof v.error !== "string")) bridgeError("INVALID_ADMISSION")
        return { ...base, type: v.type, requestId, ...admission, ok: v.ok, error: v.error === null ? null : text(v.error, 2048) }
      }
      case "event": case "ack": {
        exact("channel", "streamId", "runId", "hostId", "eventId", "seq", "digest", v.type === "event" ? "payload" : "cursor")
        const seq = timestamp(v.seq)
        if (seq === 0) bridgeError("INVALID_BRIDGE_SEQUENCE")
        const event = { ...base, channel: text(v.channel), streamId: id(v.streamId), runId: id(v.runId), hostId: hash(v.hostId), eventId: id(v.eventId), seq, digest: hash(v.digest) }
        if (v.type === "ack") {
          const cursor = timestamp(v.cursor)
          return { ...event, type: "ack", cursor }
        }
        if (canonicalDigest(v.payload) !== event.digest) bridgeError("INVALID_BRIDGE_DIGEST")
        return { ...event, type: "event", payload: v.payload }
      }
      default: return bridgeError("INVALID_BRIDGE_FRAME")
    }
  } catch (error) {
    if (error instanceof Error && /BRIDGE|ADMISSION/.test(error.message)) throw error
    return bridgeError("INVALID_BRIDGE_FRAME")
  }
}
export function encodeBridgeFrame(value: unknown): Buffer {
  const frame = parseBridgeFrame(value), json = JSON.stringify(frame)
  if (Buffer.byteLength(json) > BRIDGE_FRAME_BYTES) bridgeError("FRAME_TOO_LARGE")
  return Buffer.from(json + "\n")
}