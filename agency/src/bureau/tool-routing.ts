import { isDeepStrictEqual } from "node:util"
import { hash, id, keys, object, text } from "../catalog/types.js"
import { destinationEnvironment } from "../bridge/invocation.js"
import { createToolBindings } from "../orchestration/tool-bindings.js"
import { canonicalDigest, fail, parseExecutionRef, parseReportInput, parseEventRef, type ExecutionRef } from "../orchestration/types.js"
import { parseOriginLaunch } from "../orchestration/receipts.js"
import { createStorage, defaultFileSystem, storageQueue, type StorageFileSystem } from "../orchestration/storage.js"
import { toolResult, type ToolResult } from "../orchestration/mcp.js"
import type { JsonObject } from "../agent/session-config.js"
import type { JournalPool } from "../orchestration/journal.js"
import type { OrchestrationHost } from "./host.js"
import type { BureauService } from "./service.js"
import type { OriginSource } from "./origins.js"

export type RoutedToolCall = { kind: "call"; execution: ExecutionRef; runId: string; bindingEpoch: string; name: string; args: Record<string, unknown>; nativeParams: JsonObject }
function parseCall(raw: unknown): RoutedToolCall {
  const v = object(raw); keys(v, ["kind", "execution", "runId", "bindingEpoch", "name", "args", "nativeParams"])
  if (v.kind !== "call") fail("INVALID_TOOL_INPUT")
  return { kind: "call", execution: parseExecutionRef(v.execution), runId: id(v.runId), bindingEpoch: id(v.bindingEpoch), name: text(v.name), args: object(v.args), nativeParams: object(v.nativeParams) as JsonObject }
}
export type RoutedWaitCancel = { kind: "cancel"; execution: ExecutionRef; runId: string; bindingEpoch: string; waitId: string }
export function parseToolResult(raw: unknown): ToolResult {
  try {
    const v = object(raw); keys(v, ["content", "isError"])
    if (typeof v.isError !== "boolean" || !Array.isArray(v.content) || !v.content.length) fail("INVALID_TOOL_RESULT")
    const content = v.content.map(raw => { const entry = object(raw); keys(entry, ["type", "text"]); if (entry.type !== "text" || typeof entry.text !== "string") fail("INVALID_TOOL_RESULT"); return { type: "text" as const, text: entry.text } })
    return { content, isError: v.isError }
  } catch { return fail("INVALID_TOOL_RESULT") }
}
function parseCancel(raw: unknown): RoutedWaitCancel {
  const v = object(raw); keys(v, ["kind", "execution", "runId", "bindingEpoch", "waitId"])
  if (v.kind !== "cancel") fail("INVALID_TOOL_INPUT")
  return { kind: "cancel", execution: parseExecutionRef(v.execution), runId: id(v.runId), bindingEpoch: id(v.bindingEpoch), waitId: id(v.waitId) }
}
export function createRoutedToolOutbox(input: { root: string; filesystem?: StorageFileSystem; send(request: RoutedToolCall | RoutedWaitCancel, signal?: AbortSignal): Promise<unknown> }) {
  const storage = createStorage(input.root, "orchestration", input.filesystem ?? defaultFileSystem), queue = storageQueue(input.root), pending = new Map<string, RoutedToolCall | RoutedWaitCancel>(), sending = new Map<string, Promise<ToolResult>>()
  const terminal = new Set(["STALE_EXECUTION", "STALE_BINDING", "INVALID_CREDENTIAL", "STALE_HANDLER", "STALE_PROVIDER", "FORGOTTEN"])
  async function deliver(request: RoutedToolCall | RoutedWaitCancel, signal?: AbortSignal): Promise<ToolResult> {
    const commandId = request.kind === "cancel" ? request.waitId : id(request.args.commandId)
    const saved = await storage.read(`routed-tool-results/${commandId}.json`)
    if (saved !== null) { pending.delete(commandId); return parseToolResult(saved) }
    let result: ToolResult
    try { result = parseToolResult(await input.send(request, signal)) }
    catch (error) {
      if (!(error instanceof Error)) throw error
      if (/BRIDGE_|HOST_UNAVAILABLE|BUREAU_UNAVAILABLE/.test(error.message)) return toolResult({ commandId, state: "pending" })
      const code = String((error as { code?: unknown }).code ?? error.message)
      if (!terminal.has(code)) throw error
      result = toolResult({ error: code }, true)
    }
    let code: unknown
    if (result.isError) { try { code = object(JSON.parse(result.content[0]!.text)).error } catch {} }
    if (!result.isError || typeof code === "string" && terminal.has(code)) { await queue.run(() => storage.publish(`routed-tool-results/${commandId}.json`, result, null, true)); pending.delete(commandId) }
    return result
  }
  async function call(raw: RoutedToolCall | RoutedWaitCancel, signal?: AbortSignal): Promise<ToolResult> {
    const request = raw.kind === "cancel" ? parseCancel(raw) : parseCall(raw)
    if (request.kind === "call" && !["agency_delegate", "agency_stop"].includes(request.name)) return parseToolResult(await input.send(request, signal))
    const commandId = request.kind === "cancel" ? request.waitId : id(request.args.commandId)
    const intent = request.kind === "cancel" ? request : (() => { const { nativeParams, ...authority } = request; return { ...authority, nativeParamsDigest: canonicalDigest(nativeParams) } })()
    await queue.run(() => storage.publish(`routed-tools/${commandId}.json`, intent, null, true))
    pending.set(commandId, request)
    let delivery = sending.get(commandId)
    if (!delivery) { delivery = deliver(request, signal).finally(() => sending.delete(commandId)); sending.set(commandId, delivery) }
    return delivery
  }
  return { call, async replay() { const failures = []; for (const request of [...pending.values()]) { try { await call(request) } catch (error) { failures.push(error) } }; if (failures.length) throw new AggregateError(failures, "ROUTED_REPLAY_FAILED") } }
}
export function createToolRouter(input: { root: string; bureau: BureauService; hosts: OrchestrationHost[]; origins: OriginSource[]; journals: JournalPool; environment?: NodeJS.ProcessEnv }) {
  async function authorize(request: RoutedToolCall | RoutedWaitCancel) {
      const { execution, runId, bindingEpoch } = request
      let adapter: OrchestrationHost | undefined
      for (const host of input.hosts) {
        if (host.hostId && host.hostId !== execution.hostId) continue
        const snapshot = await host.snapshot()
        if (snapshot.hostId !== execution.hostId) continue
        if (!snapshot.agents.some(agent => agent.phase === "ready" && isDeepStrictEqual(agent.execution, execution))) fail("STALE_EXECUTION")
        adapter = host; break
      }
      if (!adapter) fail("HOST_UNAVAILABLE")
      await input.bureau.assertBinding(runId, bindingEpoch, { hostId: execution.hostId, agentId: execution.agentId })
      const source = input.origins.find(source => source.hostId === execution.hostId)
      if (!source) fail("INVALID_CREDENTIAL")
      let launch: ReturnType<typeof parseOriginLaunch> | undefined
      for (const key of await source.list()) {
        let after = 0
        while (true) {
          const page = await source.read(key, after, 256)
          for (const entry of page.entries) if (entry.kind === "origin-launch") {
            const prepared = parseOriginLaunch(entry.payload)
            if (isDeepStrictEqual(prepared.execution, execution)) { await source.verify(key, entry, entry.kind, entry.payload); launch = prepared }
          }
          if (page.nextCursor >= page.lastSeq) break
          if (page.nextCursor <= after) fail("MISSING_ORIGIN")
          after = page.nextCursor
        }
      }
      if (!launch) fail("INVALID_CREDENTIAL")
      return { adapter, launch }
  }
  async function withTools<T>(request: RoutedToolCall | RoutedWaitCancel, apply: (tools: ReturnType<typeof createToolBindings>, token: string) => Promise<T>): Promise<T> {
      const { adapter: host, launch } = await authorize(request), execution = request.execution
      const tools = createToolBindings({ socketPath: input.root + "/routed-tools.sock", journals: input.journals, bureau: () => input.bureau, host: () => ({ snapshot: () => host.snapshot(), stop: (commandId, target) => host.stop(commandId, target), report: () => Promise.reject(new Error("INVALID_TOOL_INPUT")) }) })
      try {
        tools.definition(execution, launch, { environment: destinationEnvironment(input.environment ?? process.env), nativeParams: request.kind === "call" ? request.nativeParams : {} })
        tools.activate(execution)
        return await apply(tools, tools.tokenFor(execution)!)
      } finally { tools.close() }
  }
  async function call(raw: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const request = parseCall(raw)
    return withTools(request, (tools, token) => tools.call(token, request.name, request.args, signal))
  }
  return { call, async dispatch(raw: unknown, signal?: AbortSignal, originHostId?: string): Promise<unknown> {
    const v = object(raw)
    if (v.kind === "report") {
      keys(v, ["kind", "envelope"])
      const envelope = object(v.envelope); keys(envelope, ["input", "origin"])
      const report = parseReportInput(envelope.input), origin = parseEventRef(envelope.origin)
      if (originHostId !== undefined && report.execution.hostId !== hash(originHostId)) fail("INVALID_ORIGIN")
      const adapter = input.hosts.find(host => host.hostId === report.execution.hostId)
      if (adapter) await adapter.snapshot()
      return input.bureau.acceptReport({ input: report, origin })
    }
    const execution = parseExecutionRef(v.execution)
    if (originHostId !== undefined && execution.hostId !== hash(originHostId)) fail("INVALID_CREDENTIAL")
    if (v.kind === "cancel") {
      const request = parseCancel(v)
      return withTools(request, async (tools, token) => { await tools.cancel(token, request.waitId); return toolResult({ waitId: request.waitId, cancelled: true }) })
    }
    return call(v, signal)
  } }
}