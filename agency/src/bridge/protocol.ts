import { hash, id, keys, object, text } from "../catalog/types.js"

export const BRIDGE_PROTOCOL = "agency-bridge/2"
export const BRIDGE_FRAME_BYTES = 1024 * 1024
export type BridgeHello = { protocol: typeof BRIDGE_PROTOCOL; hostId: string; handlerGeneration: string; connectionId: string; sourceRevision: string; nodeVersion: string; capabilities: string[] }
type Base = { protocol: typeof BRIDGE_PROTOCOL; connectionId: string }
export type BridgeFrame = (BridgeHello & { type: "hello" }) | (Base & (
  { type: "request_cancel"; requestId: string } |
  { type: "request"; requestId: string; channel: string; payload: unknown } |
  { type: "reply"; requestId: string; ok: true; payload: unknown } |
  { type: "reply"; requestId: string; ok: false; error: string }
))
export function bridgeError(code: string): never { throw new Error(code) }
export function parseBridgeFrame(raw: unknown): BridgeFrame {
  try {
    const v = object(raw)
    if (v.protocol !== BRIDGE_PROTOCOL) bridgeError("UNSUPPORTED_BRIDGE_PROTOCOL")
    const base: Base = { protocol: BRIDGE_PROTOCOL, connectionId: id(v.connectionId) }
    const exact = (...fields: string[]) => keys(v, ["protocol", "connectionId", "type", ...fields])
    switch (v.type) {
      case "hello": {
        exact("hostId", "handlerGeneration", "sourceRevision", "nodeVersion", "capabilities")
        const revision = text(v.sourceRevision)
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) || !Array.isArray(v.capabilities) || v.capabilities.length > 64) bridgeError("INVALID_BRIDGE_HELLO")
        const capabilities = v.capabilities.map(value => text(value))
        if (new Set(capabilities).size !== capabilities.length) bridgeError("INVALID_BRIDGE_HELLO")
        return { ...base, type: "hello", hostId: hash(v.hostId), handlerGeneration: id(v.handlerGeneration), sourceRevision: revision, nodeVersion: text(v.nodeVersion), capabilities }
      }
      case "request_cancel": exact("requestId"); return { ...base, type: "request_cancel", requestId: id(v.requestId) }
      case "request": exact("requestId", "channel", "payload"); return { ...base, type: "request", requestId: id(v.requestId), channel: text(v.channel), payload: v.payload }
      case "reply":
        if (typeof v.ok !== "boolean") bridgeError("INVALID_BRIDGE_REPLY")
        exact("requestId", "ok", v.ok ? "payload" : "error")
        return v.ok ? { ...base, type: "reply", requestId: id(v.requestId), ok: true, payload: v.payload } : { ...base, type: "reply", requestId: id(v.requestId), ok: false, error: text(v.error, 2048) }
      default: return bridgeError("INVALID_BRIDGE_FRAME")
    }
  } catch (error) {
    if (error instanceof Error && /BRIDGE/.test(error.message)) throw error
    return bridgeError("INVALID_BRIDGE_FRAME")
  }
}
export function encodeBridgeFrame(value: unknown): Buffer {
  const frame = parseBridgeFrame(value), json = JSON.stringify(frame)
  if (Buffer.byteLength(json) > BRIDGE_FRAME_BYTES) bridgeError("FRAME_TOO_LARGE")
  return Buffer.from(json + "\n")
}