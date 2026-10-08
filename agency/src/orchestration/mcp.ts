import type { Readable, Writable } from "node:stream"
import { id, keys, object } from "../catalog/types.js"
import { fail, QUEUE_BYTES, RECORD_BYTES } from "./types.js"

export type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean }
export const toolResult = (value: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError })
const uuid = { type: "string", format: "uuid" }, string = { type: "string" }, scope = { runId: uuid, bindingEpoch: uuid }, command = { ...scope, commandId: uuid }
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false })
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [{ type: "null" }, schema] })
const gitInput = closed({ remote: string, repository: string, baseOid: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" } })
const git = nullable(gitInput)
const gitReport = nullable(closed({ ...gitInput.properties, branch: string, resultOid: gitInput.properties.baseOid, published: { const: false } }))
const agent = closed({ hostId: { type: "string", pattern: "^[a-f0-9]{64}$" }, agentId: uuid })
const overrides = closed({ modeId: string, configValues: { type: "object", additionalProperties: { type: ["string", "boolean"] } } }, [])
const report = closed({ status: { enum: ["completed", "blocked", "failed"] }, summary: string, issues: { type: "array", items: string, maxItems: 128 }, validation: { type: "array", items: closed({ argv: { type: "array", items: string }, cwd: string, exitCode: { type: "integer" }, result: string }), maxItems: 128 }, git: gitReport })
export const agencyToolSchemas = [
  { name: "agency_context", description: "Discover the current execution, run epoch, report attempt and effective settings.", inputSchema: closed({}) },
  { name: "agency_inspect", description: "Inspect the current run or a descendant assignment. Continue pages using the returned cursor.", inputSchema: closed({ runId: uuid, assignmentId: uuid, attemptId: uuid, after: uuid, reportAfter: { type: "integer", minimum: 0 } }, ["runId"]) },
  { name: "agency_delegate", description: "Delegate an assignment to an enrolled host. Retain commandId before calling; reuse it only for an exact retry. Backend/model are explicit; overrides can be empty for configured defaults.", inputSchema: closed({ ...command, description: string, hostId: string, cwd: string, backendId: { enum: ["codex-acp", "claude-agent-acp"] }, modelId: string, overrides, git }) },
  { name: "agency_wait", description: "Wait for descendant reports. Retain waitId for reconnect and exact retry; cancellation ends this route. Large results contain summaries and assignment/attempt references for paged inspection.", inputSchema: closed({ ...scope, waitId: uuid, assignmentIds: { type: "array", items: uuid, minItems: 1, maxItems: 128 }, after: { type: "integer", minimum: 0 }, timeoutMs: { type: "integer", minimum: 0, maximum: 2147483647 } }) },
  { name: "agency_report", description: "Retain one terminal report for this execution's assigned attempt using a stable commandId. Unpublished code results must be blocked; transport grants no publication authority.", inputSchema: closed({ ...command, assignmentId: uuid, attemptId: uuid, report }) },
  { name: "agency_stop", description: "Gracefully stop a same-run descendant using a stable commandId. This cannot stop an ancestor or unrelated agent.", inputSchema: { ...closed({ ...command, agent, agentId: uuid }, Object.keys(command)), oneOf: [{ required: ["agent"], not: { required: ["agentId"] } }, { required: ["agentId"], not: { required: ["agent"] } }] } }
]
export async function serveMcp(input: { input: Readable; output: Writable; call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>; cancel(waitId: string): Promise<void> }): Promise<void> {
  let initialized = false, ready = false, buffer = Buffer.alloc(0), queued = 0, inFlightBytes = 0, writing = Promise.resolve()
  const active = new Map<string | number, { controller: AbortController; waitId?: string }>(), jobs = new Set<Promise<void>>()
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
          if (target) { if (target.waitId) await input.cancel(id(target.waitId)); target.controller.abort() }
        }
        return
      }
      if (active.has(rpcId!)) fail("DUPLICATE_REQUEST")
      let result: unknown
      if (v.method === "initialize") {
        if (initialized || !["2024-11-05", "2025-03-26", "2025-06-18"].includes(params.protocolVersion as string)) fail("UNSUPPORTED_PROTOCOL_VERSION")
        initialized = true
        result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "agency", version: "1.0.0" } }
      } else {
        if (!ready) fail("NOT_INITIALIZED")
        if (v.method === "ping") result = {}
        else if (v.method === "tools/list") result = { tools: agencyToolSchemas }
        else if (v.method === "tools/call") {
          keys(params, ["name", ...["arguments", "_meta"].filter(key => Object.hasOwn(params, key))])
          if (params._meta !== undefined) object(params._meta)
          if (typeof params.name !== "string") fail("INVALID_PARAMS")
          const args = params.arguments === undefined ? {} : object(params.arguments), controller = new AbortController(), entry = { controller, ...(params.name === "agency_wait" && typeof args.waitId === "string" ? { waitId: args.waitId } : {}) }
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