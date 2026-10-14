import type { Readable, Writable } from "node:stream"
import { keys, object } from "../catalog/types.js"
const RECORD_BYTES = 1024 * 1024, QUEUE_BYTES = 2 * RECORD_BYTES
function fail(code: string): never { throw new Error(code) }
export type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean }
export const toolResult = (value: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError })
export async function serveMcp(input: { input: Readable; output: Writable; call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>; schemas: readonly unknown[]; serverInfo: { name: string; version: string }; onCancel?(name: string, args: Record<string, unknown>): Promise<void> }): Promise<void> {
  let initialized = false, ready = false, buffer = Buffer.alloc(0), queued = 0, inFlightBytes = 0, writing = Promise.resolve()
  const active = new Map<string | number, { controller: AbortController; name: string; args: Record<string, unknown> }>(), jobs = new Set<Promise<void>>()
  const send = async (value: unknown) => {
    let bytes = Buffer.from(JSON.stringify(value) + "\n")
    if (bytes.length > RECORD_BYTES + 1) bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: object(value).id ?? null, error: { code: -32000, message: "RESPONSE_TOO_LARGE" } }) + "\n")
    queued += bytes.length
    if (queued > QUEUE_BYTES) fail("QUEUE_TOO_LARGE")
    const next = writing.then(() => new Promise<void>((resolve, reject) => input.output.write(bytes, error => error ? reject(error) : resolve()))).finally(() => { queued -= bytes.length })
    writing = next.catch(() => undefined)
    await next
  }
  async function dispatch(raw: unknown): Promise<void> {
    let rpcId: string | number | null = null, notification = false
    try {
      const v = object(raw)
      if (typeof v.id === "string" || typeof v.id === "number" && Number.isSafeInteger(v.id)) rpcId = v.id
      keys(v, ["jsonrpc", "method", ...(Object.hasOwn(v, "id") ? ["id"] : []), ...(Object.hasOwn(v, "params") ? ["params"] : [])])
      if (v.jsonrpc !== "2.0" || typeof v.method !== "string" || Object.hasOwn(v, "id") && rpcId === null) fail("INVALID_REQUEST")
      notification = !Object.hasOwn(v, "id")
      const params = v.params === undefined ? {} : object(v.params)
      if (!Object.hasOwn(v, "id")) {
        if (v.method === "notifications/initialized") { if (initialized) ready = true; return }
        if (v.method === "notifications/cancelled") {
          const target = active.get(params.requestId as string | number)
          if (target) { try { await input.onCancel?.(target.name, target.args) } finally { target.controller.abort() } }
        }
        return
      }
      if (active.has(rpcId!)) fail("DUPLICATE_REQUEST")
      let result: unknown
      if (v.method === "initialize") {
        if (initialized || !["2024-11-05", "2025-03-26", "2025-06-18"].includes(params.protocolVersion as string)) fail("UNSUPPORTED_PROTOCOL_VERSION")
        initialized = true
        result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: input.serverInfo }
      } else {
        if (!ready) fail("NOT_INITIALIZED")
        if (v.method === "ping") result = {}
        else if (v.method === "tools/list") result = { tools: input.schemas }
        else if (v.method === "tools/call") {
          keys(params, ["name", ...["arguments", "_meta"].filter(key => Object.hasOwn(params, key))])
          if (params._meta !== undefined) object(params._meta)
          if (typeof params.name !== "string") fail("INVALID_PARAMS")
          const args = params.arguments === undefined ? {} : object(params.arguments), controller = new AbortController(), entry = { controller, name: params.name, args }
          active.set(rpcId!, entry)
          try { result = await input.call(params.name, args, controller.signal) } finally { active.delete(rpcId!) }
        } else { await send({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "METHOD_NOT_FOUND" } }); return }
      }
      await send({ jsonrpc: "2.0", id: rpcId, result })
    } catch (error) { if (notification) return; await send({ jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: error instanceof Error ? error.message : "INVALID_REQUEST" } }) }
  }
  try {
    for await (const raw of input.input) {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      buffer = Buffer.concat([buffer, bytes])
      let newline: number
      while ((newline = buffer.indexOf(10)) !== -1) {
        if (newline > RECORD_BYTES) fail("FRAME_TOO_LARGE")
        let value: unknown
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline))) } catch { fail("INVALID_PROTOCOL") }
        const retainedBytes = newline + 1
        if (inFlightBytes + retainedBytes > QUEUE_BYTES) fail("QUEUE_TOO_LARGE")
        inFlightBytes += retainedBytes
        buffer = buffer.subarray(retainedBytes)
        const job = dispatch(value).finally(() => { inFlightBytes -= retainedBytes })
        jobs.add(job); void job.finally(() => jobs.delete(job)).catch(() => undefined)
      }
      if (buffer.length > RECORD_BYTES) fail("FRAME_TOO_LARGE")
    }
    if (buffer.length) fail("INVALID_PROTOCOL")
  } finally { for (const entry of active.values()) entry.controller.abort(); await Promise.allSettled(jobs); await writing }
}