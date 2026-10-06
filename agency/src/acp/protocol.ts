import { id, keys, object } from "../catalog/types.js"
import type { JsonObject } from "../agent/session-config.js"
import { AgentError, agentFailure } from "../agent/types.js"

export const ACP_FRAME_BYTES = 1048576
export const ACP_QUEUE_BYTES = 33554432
export type RpcId = string | number
export class AcpError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

export function parseAcpFrame(value: unknown): JsonObject {
  try {
    const frame = object(value) as JsonObject
    if (frame.jsonrpc !== "2.0") throw new Error()
    if (Object.hasOwn(frame, "id") && !(typeof frame.id === "string" && frame.id.length > 0 && frame.id.length <= 1024 || typeof frame.id === "number" && Number.isSafeInteger(frame.id))) throw new Error()
    if (Object.hasOwn(frame, "method")) {
      if (typeof frame.method !== "string" || !frame.method.length || frame.method.length > 1024 || Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")) throw new Error()
    } else if (!Object.hasOwn(frame, "id") || Object.hasOwn(frame, "result") === Object.hasOwn(frame, "error")) throw new Error()
    return frame
  } catch { throw new AcpError(-32600, "Invalid request") }
}

export function parseLogicalSessionId(value: unknown): string {
  try { if (typeof value !== "string" || !value.startsWith("agency:")) throw new Error(); return id(value.slice(7)) }
  catch { throw new AcpError(-32602, "Invalid session ID") }
}

export function parseAgencyMeta(params: JsonObject, allowed: readonly string[]): JsonObject {
  try {
    if (params._meta === undefined) return {}
    const meta = object(params._meta)
    if (!Object.hasOwn(meta, "agency")) return {}
    const agency = object(meta.agency)
    keys(agency, ["version", ...allowed.filter(key => Object.hasOwn(agency, key))])
    if (agency.version !== 1) throw new Error()
    return agency as JsonObject
  } catch { throw new AcpError(-32602, "Invalid Agency metadata") }
}

export function acpError(requestId: RpcId | null, error: unknown): { jsonrpc: string; id: RpcId | null; error: { code: number; message: string; data?: JsonObject } } {
  if (error instanceof AcpError) return { jsonrpc: "2.0", id: requestId, error: { code: error.code, message: error.message } }
  const failure = agentFailure(error)
  return { jsonrpc: "2.0", id: requestId, error: { code: -32000, message: failure.message, data: { agency: { code: failure.code } } } }
}

export function createAcpDecoder(receive: (frame: JsonObject) => void, fail: (error: unknown) => void): { feed(bytes: Buffer): void; end(): void } {
  let buffer = Buffer.alloc(0), failed = false
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const fault = (error: unknown) => { if (!failed) { failed = true; buffer = Buffer.alloc(0); fail(error) } }
  return {
    feed(bytes) {
      if (failed) return
      try {
        let start = 0, index: number
        while ((index = bytes.indexOf(10, start)) !== -1) {
          if (buffer.length + index - start > ACP_FRAME_BYTES) throw new AgentError("ACP_FRAME_LIMIT")
          const line = Buffer.concat([buffer, bytes.subarray(start, index)])
          buffer = Buffer.alloc(0); start = index + 1
          receive(parseAcpFrame(JSON.parse(decoder.decode(line))))
        }
        if (buffer.length + bytes.length - start > ACP_FRAME_BYTES) throw new AgentError("ACP_FRAME_LIMIT")
        buffer = Buffer.concat([buffer, bytes.subarray(start)])
      } catch (error) { fault(error) }
    },
    end() { if (buffer.length) fault(new AcpError(-32700, "Incomplete frame")) },
  }
}