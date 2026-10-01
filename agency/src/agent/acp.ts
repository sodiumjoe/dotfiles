import { randomUUID } from "node:crypto"
import type { Readable, Writable } from "node:stream"
import { object } from "../catalog/types.js"
import { parseLaunchContract, type LaunchContract } from "./contracts.js"
import { AgentError, agentFailure, agentText, parseLaunchSpec, type AgentFailure, type AgentLimits, type LaunchSpec, type PromptResult, type SessionEvidence } from "./types.js"

export type AcpConnection = { initialize(spec: LaunchSpec, contract: LaunchContract, signal: AbortSignal): Promise<SessionEvidence>; prompt(text: string, signal: AbortSignal): Promise<PromptResult>; fault: Promise<AgentFailure>; close(): void }
type ConfigOption = { id: string; currentValue: string; values: string[] }
type Pending = { method: string; prefix: number; deadline: number; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
type PromptState = { requestId: number; text: string; bytes: number; chunks: number; responseReceived: boolean }
function invalid(): never { throw new AgentError("INVALID_PROTOCOL") }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid()
}
function knownKeys(value: Record<string, unknown>, required: readonly string[], allowed: readonly string[]): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.includes(key))) invalid()
}
function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || !value.isWellFormed()) invalid()
  return value
}
function metadata(value: unknown, max = 16384): void {
  if (value === null) return
  const v = object(value)
  if (Object.keys(v).length > 128) invalid()
  try { if (Buffer.byteLength(JSON.stringify(v)) > max) invalid() } catch { invalid() }
}
function jsonValue(value: unknown, max = 16384): void {
  try { if (Buffer.byteLength(JSON.stringify(value)) > max) invalid() } catch { invalid() }
}
function permissionToolCall(value: unknown): void {
  const toolCall = object(value)
  knownKeys(toolCall, ["toolCallId"], ["toolCallId", "kind", "status", "title", "name", "content", "locations", "rawInput", "rawOutput", "_meta"])
  agentText(toolCall.toolCallId)
  if (Object.hasOwn(toolCall, "kind") && toolCall.kind !== null && (typeof toolCall.kind !== "string" || !["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"].includes(toolCall.kind))) invalid()
  if (Object.hasOwn(toolCall, "status") && toolCall.status !== null && (typeof toolCall.status !== "string" || !["pending", "in_progress", "completed", "failed"].includes(toolCall.status))) invalid()
  for (const name of ["title", "name"] as const) if (Object.hasOwn(toolCall, name) && toolCall[name] !== null) boundedText(toolCall[name], 1024)
  if (Object.hasOwn(toolCall, "content") && toolCall.content !== null) {
    if (!Array.isArray(toolCall.content) || toolCall.content.length > 32) invalid()
    jsonValue(toolCall.content, 65536)
  }
  if (Object.hasOwn(toolCall, "locations") && toolCall.locations !== null) {
    if (!Array.isArray(toolCall.locations) || toolCall.locations.length > 128) invalid()
    for (const raw of toolCall.locations) {
      const location = object(raw); knownKeys(location, ["path"], ["path", "line", "_meta"]); boundedText(location.path, 4096)
      if (Object.hasOwn(location, "line") && location.line !== null && (!Number.isSafeInteger(location.line) || Number(location.line) < 1)) invalid()
      if (Object.hasOwn(location, "_meta")) metadata(location._meta)
    }
  }
  for (const name of ["rawInput", "rawOutput"] as const) if (Object.hasOwn(toolCall, name)) jsonValue(toolCall[name], 65536)
  if (Object.hasOwn(toolCall, "_meta")) metadata(toolCall._meta)
}
function annotations(value: unknown): void {
  if (value === null) return
  const v = object(value); knownKeys(v, [], ["audience", "lastModified", "priority", "_meta"])
  if (Object.hasOwn(v, "audience") && v.audience !== null && (!Array.isArray(v.audience) || v.audience.length > 2 || v.audience.some(role => role !== "assistant" && role !== "user"))) invalid()
  if (Object.hasOwn(v, "lastModified") && v.lastModified !== null) boundedText(v.lastModified, 64)
  if (Object.hasOwn(v, "priority") && v.priority !== null && (typeof v.priority !== "number" || !Number.isFinite(v.priority))) invalid()
  if (Object.hasOwn(v, "_meta")) metadata(v._meta)
}
function contentText(value: unknown): string {
  const content = object(value); knownKeys(content, ["type", "text"], ["type", "text", "annotations", "_meta"])
  if (content.type !== "text") invalid()
  if (Object.hasOwn(content, "annotations")) annotations(content.annotations)
  if (Object.hasOwn(content, "_meta")) metadata(content._meta)
  return boundedText(content.text, 4096)
}
function contentChunk(update: Record<string, unknown>): string {
  knownKeys(update, ["sessionUpdate", "content"], ["sessionUpdate", "content", "messageId", "_meta"])
  if (Object.hasOwn(update, "messageId") && update.messageId !== null) agentText(update.messageId, 1024)
  if (Object.hasOwn(update, "_meta")) metadata(update._meta)
  return contentText(update.content)
}
function informational(update: Record<string, unknown>, kind: string): boolean {
  if (kind === "agent_thought_chunk") { contentChunk(update); return true }
  if (kind === "plan") {
    knownKeys(update, ["sessionUpdate", "entries"], ["sessionUpdate", "entries", "_meta"])
    if (Object.hasOwn(update, "_meta")) metadata(update._meta)
    if (!Array.isArray(update.entries) || update.entries.length > 32 || Buffer.byteLength(JSON.stringify(update.entries)) > 65536) invalid()
    for (const raw of update.entries) {
      const entry = object(raw); knownKeys(entry, ["content", "priority", "status"], ["content", "priority", "status", "_meta"]); boundedText(entry.content, 4096)
      if (typeof entry.priority !== "string" || !["high", "medium", "low"].includes(entry.priority) || typeof entry.status !== "string" || !["pending", "in_progress", "completed"].includes(entry.status)) invalid()
      if (Object.hasOwn(entry, "_meta")) metadata(entry._meta)
    }
    return true
  }
  if (kind === "session_info_update") {
    const names = Object.keys(update)
    if (names.length < 2 || names.length > 4 || names.some(key => !["sessionUpdate", "title", "updatedAt", "_meta"].includes(key))) invalid()
    if (Object.hasOwn(update, "title") && update.title !== null) boundedText(update.title, 1024)
    if (Object.hasOwn(update, "updatedAt") && update.updatedAt !== null) {
      const timestamp = boundedText(update.updatedAt, 64)
      if (new Date(timestamp).toISOString() !== timestamp) invalid()
    }
    if (Object.hasOwn(update, "_meta")) metadata(update._meta, 65536)
    return true
  }
  if (kind === "usage_update") {
    const names = Object.keys(update)
    if (names.length < 3 || names.length > 5 || names.some(key => !["sessionUpdate", "used", "size", "cost", "_meta"].includes(key))) invalid()
    if (!Number.isSafeInteger(update.used) || !Number.isSafeInteger(update.size) || Number(update.used) < 0 || Number(update.size) < 0 || Number(update.used) > Number(update.size)) invalid()
    if (Object.hasOwn(update, "cost") && update.cost !== null) {
      const cost = object(update.cost); knownKeys(cost, ["amount", "currency"], ["amount", "currency", "_meta"])
      if (typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0 || typeof cost.currency !== "string" || !/^[A-Z]{3}$/.test(cost.currency)) invalid()
      if (Object.hasOwn(cost, "_meta")) metadata(cost._meta)
    }
    if (Object.hasOwn(update, "_meta")) metadata(update._meta)
    return true
  }
  return false
}
function promptResponse(value: Record<string, unknown>): void {
  knownKeys(value, ["stopReason"], ["stopReason", "usage", "_meta"])
  if (value.stopReason !== "end_turn") invalid()
  if (Object.hasOwn(value, "usage") && value.usage !== null) {
    const usage = object(value.usage)
    knownKeys(usage, ["totalTokens", "inputTokens", "outputTokens"], ["totalTokens", "inputTokens", "outputTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens", "_meta"])
    for (const name of ["totalTokens", "inputTokens", "outputTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens"] as const) {
      const amount = usage[name]
      if (amount !== undefined && amount !== null && (!Number.isSafeInteger(amount) || Number(amount) < 0)) invalid()
    }
    if (Object.hasOwn(usage, "_meta")) metadata(usage._meta)
  }
  if (Object.hasOwn(value, "_meta")) metadata(value._meta, 65536)
}
function parseOptions(value: unknown): ConfigOption[] {
  if (!Array.isArray(value) || value.length > 128 || Buffer.byteLength(JSON.stringify(value)) > 1048576) invalid()
  const result = value.map(raw => {
    const v = object(raw)
    knownKeys(v, ["id", "type", "currentValue", "options"], ["id", "type", "name", "description", "category", "currentValue", "options", "_meta"])
    if (v.type !== "select" || !Array.isArray(v.options) || v.options.length > 256) invalid()
    if (Object.hasOwn(v, "name")) agentText(v.name, 1024)
    if (Object.hasOwn(v, "description") && v.description !== null) boundedText(v.description, 4096)
    if (Object.hasOwn(v, "category") && v.category !== null) agentText(v.category)
    if (Object.hasOwn(v, "_meta")) metadata(v._meta)
    const values: string[] = []
    for (const rawOption of v.options) {
      const option = object(rawOption)
      if (Object.hasOwn(option, "options")) {
        knownKeys(option, ["group", "options"], ["group", "name", "options", "_meta"])
        agentText(option.group)
        if (Object.hasOwn(option, "name")) agentText(option.name, 1024)
        if (Object.hasOwn(option, "_meta")) metadata(option._meta)
        if (!Array.isArray(option.options) || option.options.length > 256) invalid()
        for (const item of option.options) {
          const choice = object(item); knownKeys(choice, ["value"], ["value", "name", "description", "_meta"])
          if (Object.hasOwn(choice, "name")) agentText(choice.name, 1024)
          if (Object.hasOwn(choice, "description") && choice.description !== null) boundedText(choice.description, 4096)
          if (Object.hasOwn(choice, "_meta")) metadata(choice._meta)
          values.push(agentText(choice.value))
        }
      } else {
        knownKeys(option, ["value"], ["value", "name", "description", "_meta"])
        if (Object.hasOwn(option, "name")) agentText(option.name, 1024)
        if (Object.hasOwn(option, "description") && option.description !== null) boundedText(option.description, 4096)
        if (Object.hasOwn(option, "_meta")) metadata(option._meta)
        values.push(agentText(option.value))
      }
      if (values.length > 256) invalid()
    }
    if (new Set(values).size !== values.length) invalid()
    return { id: agentText(v.id), currentValue: agentText(v.currentValue), values }
  })
  if (new Set(result.map(option => option.id)).size !== result.length) invalid()
  return result
}
function desiredOptions(spec: LaunchSpec, contract: LaunchContract): Array<[string, string]> {
  const result: Array<[string, string]> = [[contract.modelOption, spec.selection.modelId]]
  if (contract.reasoningOption && spec.selection.reasoning.kind === "value") result.push([contract.reasoningOption, spec.selection.reasoning.value])
  if (contract.modeOption) result.push([contract.modeOption, spec.selection.mode])
  return result
}
function exact(options: ConfigOption[], spec: LaunchSpec, contract: LaunchContract): void {
  const desired = desiredOptions(spec, contract)
  exactPrefix(options, desired, desired.length)
  if (contract.reasoningOption === null && options.some(option => ["reasoning", "reasoning_effort", "effort"].includes(option.id))) throw new AgentError("SELECTION_UNSUPPORTED")
  if (contract.modeOption === null && options.some(option => option.id === "mode")) throw new AgentError("SELECTION_UNSUPPORTED")
}

function exactPrefix(options: ConfigOption[], desired: readonly [string, string][], count: number): void {
  for (const [id, value] of desired.slice(0, count)) {
    const option = options.find(candidate => candidate.id === id)
    if (!option || option.currentValue !== value || !option.values.includes(value)) throw new AgentError("SELECTION_UNSUPPORTED")
  }
}

export function createAcpConnection(input: { readable: Readable; writable: Writable; limits: AgentLimits; now?: () => number; deadline?: number; overallDeadline?: number }): AcpConnection {
  const { readable, writable, limits } = input, now = input.now ?? (() => performance.now())
  const decoder = new TextDecoder("utf-8", { fatal: true }), pending = new Map<number, Pending>()
  const writes = new Set<(error?: Error | null) => void>()
  const windows = new Map<number, { bytes: number; frames: number }>()
  let buffer = "", frameBytes = 0, startupBytes = 0, nextId = 0, queuedBytes = 0, closed = false, ready = false
  let failure: AgentError | null = null, sessionId: string | null = null, options: ConfigOption[] = [], deadline = Infinity
  let violation: AgentError | null = null, denial: Promise<void> | undefined
  let spec: LaunchSpec | undefined, contract: LaunchContract | undefined, initialization: Promise<SessionEvidence> | undefined, promptState: PromptState | null = null, promptUsed = false
  let resolveFault!: (value: AgentFailure) => void
  const fault = new Promise<AgentFailure>(resolve => { resolveFault = resolve })
  const fail = (error: unknown): void => {
    if (failure) return
    failure = error instanceof AgentError && error.code !== "INVALID_AGENT_STATE" ? error : new AgentError("INVALID_PROTOCOL")
    for (const finish of writes) finish(failure)
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure) }
    pending.clear(); buffer = ""; options = []; windows.clear()
    resolveFault(agentFailure(failure))
  }
  const check = (receiving = false): void => {
    if (failure) throw failure
    if (!receiving && violation) throw violation
    if (closed) throw new AgentError("STARTUP_FAILED")
    if (now() >= deadline) throw new AgentError("STARTUP_TIMEOUT")
  }
  const budget = (bytes: number, frames: number): void => {
    if (!ready) { startupBytes += bytes; if (startupBytes > limits.startupBytes) invalid(); return }
    const time = Math.floor(now())
    for (const stamp of windows.keys()) if (stamp <= time - 1000) windows.delete(stamp)
    const bucket = windows.get(time) ?? { bytes: 0, frames: 0 }
    bucket.bytes += bytes; bucket.frames += frames; windows.set(time, bucket)
    let totalBytes = 0, totalFrames = 0
    for (const bucket of windows.values()) { totalBytes += bucket.bytes; totalFrames += bucket.frames }
    if (totalBytes > 1048576 || totalFrames > 256) invalid()
  }
  const write = (value: unknown): Promise<void> => new Promise((resolve, reject) => {
    let bytes: Buffer
    try {
      check(); bytes = Buffer.from(JSON.stringify(value) + "\n")
      if (bytes.length > limits.frameBytes || Math.max(queuedBytes, writable.writableLength) + bytes.length > limits.writeQueueBytes || !writable.writable) invalid()
    } catch (error) { reject(error); return }
    queuedBytes += bytes.length
    let settled = false
    const finish = (error?: Error | null): void => {
      if (settled) return
      settled = true; clearTimeout(timer); writes.delete(finish); queuedBytes -= bytes.length
      if (error) reject(error); else resolve()
    }
    const timer = setTimeout(() => finish(new AgentError("STARTUP_TIMEOUT")), limits.rpcMs)
    writes.add(finish)
    try { writable.write(bytes, finish) } catch (error) { finish(error as Error) }
  })
  const request = (method: string, params: unknown, prefix = 0): Promise<unknown> => {
    try { check(); if (pending.size >= 8) invalid() } catch (error) { return Promise.reject(error) }
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const phases = contract?.qualification?.deadlines
      const phaseMs = method === "session/prompt" ? phases?.promptMs ?? 90000 : phases ? method === "initialize" ? phases.initializeMs : method === "session/new" ? phases.sessionMs : phases.optionMs : limits.rpcMs
      const requestDeadline = Math.min(deadline, now() + phaseMs)
      const timer = setTimeout(() => fail(new AgentError("STARTUP_TIMEOUT")), Math.max(1, requestDeadline - now()))
      pending.set(id, { method, prefix, deadline: requestDeadline, resolve, reject, timer })
      if (method === "session/prompt" && promptState) promptState.requestId = id
      void write({ jsonrpc: "2.0", id, method, params }).catch(fail)
    })
  }
  function receive(raw: unknown): void {
    const v = object(raw)
    if (v.jsonrpc !== "2.0") invalid()
    if (typeof v.method === "string") {
      if (Object.hasOwn(v, "result") || Object.hasOwn(v, "error")) invalid()
      const method = agentText(v.method)
      if (Object.hasOwn(v, "id")) {
        exactKeys(v, ["jsonrpc", "id", "method", "params"])
        if (typeof v.id === "string") agentText(v.id)
        else if (typeof v.id !== "number" || !Number.isSafeInteger(v.id)) invalid()
        const params = object(v.params)
        if (method !== "session/request_permission") invalid()
        knownKeys(params, ["sessionId", "toolCall", "options"], ["sessionId", "toolCall", "options", "_meta"])
        if (sessionId === null || params.sessionId !== sessionId || !Array.isArray(params.options) || params.options.length > 32) invalid()
        permissionToolCall(params.toolCall)
        const optionIds: string[] = []
        for (const rawOption of params.options) {
          const option = object(rawOption); knownKeys(option, ["optionId", "name", "kind"], ["optionId", "name", "kind", "_meta"])
          optionIds.push(agentText(option.optionId)); agentText(option.name, 1024)
          if (typeof option.kind !== "string" || !["allow_once", "allow_always", "reject_once", "reject_always"].includes(option.kind)) invalid()
          if (Object.hasOwn(option, "_meta")) metadata(option._meta)
        }
        if (new Set(optionIds).size !== optionIds.length) invalid()
        if (Object.hasOwn(params, "_meta")) metadata(params._meta)
        const response = { jsonrpc: "2.0", id: v.id, result: { outcome: { outcome: "cancelled" } } }
        if (violation) invalid()
        denial = write(response)
        violation = new AgentError("PERMISSION_UNSUPPORTED")
        void denial.then(() => fail(violation), fail)
        return
      }
      exactKeys(v, ["jsonrpc", "method", "params"])
      if (method !== "session/update") invalid()
      const params = object(v.params)
      knownKeys(params, ["sessionId", "update"], ["sessionId", "update", "_meta"])
      if (Object.hasOwn(params, "_meta")) metadata(params._meta)
      if (sessionId === null || params.sessionId !== sessionId) invalid()
      const update = object(params.update), kind = agentText(update.sessionUpdate)
      if (promptState?.responseReceived) invalid()
      if (kind === "agent_message_chunk") {
        if (!ready || !promptState) invalid()
        const text = contentChunk(update)
        promptState.chunks++
        promptState.bytes += Buffer.byteLength(text)
        if (promptState.bytes > 4096) invalid()
        promptState.text += text
      } else if (kind === "config_option_update") {
        knownKeys(update, ["sessionUpdate", "configOptions"], ["sessionUpdate", "configOptions", "_meta"])
        if (Object.hasOwn(update, "_meta")) metadata(update._meta)
        options = parseOptions(update.configOptions)
      }
      else if (kind === "current_mode_update") {
        knownKeys(update, ["sessionUpdate", "currentModeId"], ["sessionUpdate", "currentModeId", "_meta"])
        if (Object.hasOwn(update, "_meta")) metadata(update._meta)
        if (!contract?.modeOption) throw new AgentError("SELECTION_UNSUPPORTED")
        const option = options.find(option => option.id === contract!.modeOption)
        if (!option) invalid()
        option.currentValue = agentText(update.currentModeId)
      } else if (ready && promptState ? !informational(update, kind) : !["available_commands_update", "usage_update", "session_info_update"].includes(kind)) invalid()
      if (ready) exact(options, spec!, contract!)
      return
    }
    if (Object.hasOwn(v, "method") || typeof v.id !== "number" || !pending.has(v.id) || Object.hasOwn(v, "result") === Object.hasOwn(v, "error")) invalid()
    if (Object.keys(v).some(key => !["jsonrpc", "id", "result", "error"].includes(key))) invalid()
    const waiter = pending.get(v.id)!
    if (waiter.method === "session/prompt" && promptState?.responseReceived) invalid()
    if (now() >= waiter.deadline) throw new AgentError("STARTUP_TIMEOUT")
    if (Object.hasOwn(v, "error")) {
      const error = object(v.error)
      if (Object.keys(error).length !== 2 || !Object.hasOwn(error, "code") || !Object.hasOwn(error, "message") || !Number.isSafeInteger(error.code)) invalid()
      const message = agentText(error.message)
      if (waiter.method === "session/new" && error.code === -32000 && message === "Authentication required") throw new AgentError("AUTH_REQUIRED")
      throw new AgentError("STARTUP_FAILED")
    }
    const response = object(v.result)
    if (waiter.method === "initialize") { if (response.protocolVersion !== 1) invalid() }
    else if (waiter.method === "session/new") { sessionId = agentText(response.sessionId, 1024); options = parseOptions(response.configOptions) }
    else if (waiter.method === "session/prompt") {
      if (!promptState || promptState.requestId !== v.id) invalid()
      promptResponse(response)
      if (promptState.chunks === 0) invalid()
      promptState.responseReceived = true
      const id = v.id
      queueMicrotask(() => {
        if (failure || !pending.has(id)) return
        clearTimeout(waiter.timer); pending.delete(id); waiter.resolve(v.result)
      })
      return
    }
    else {
      options = parseOptions(response.configOptions)
      exactPrefix(options, desiredOptions(spec!, contract!), waiter.prefix)
    }
    clearTimeout(waiter.timer); pending.delete(v.id); waiter.resolve(v.result)
  }
  const data = (chunk: Buffer): void => {
    if (failure || closed) return
    try {
      check(true); budget(chunk.length, 0)
      for (const byte of chunk) { if (byte === 10) frameBytes = 0; else if (++frameBytes > limits.frameBytes) invalid() }
      buffer += decoder.decode(chunk, { stream: true })
      let at: number
      while (!failure && (at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
        budget(0, 1); receive(JSON.parse(line))
      }
    } catch (error) { fail(error) }
  }
  const ended = (): void => { try { decoder.decode(); fail(new AgentError("STARTUP_FAILED")) } catch (error) { fail(error) } }
  const streamError = (): void => fail(new AgentError("STARTUP_FAILED"))
  readable.on("data", data); readable.on("end", ended); readable.on("close", ended); readable.on("error", streamError); writable.on("error", streamError); writable.on("close", ended)
  return {
    fault,
    initialize(inputSpec, inputContract, signal) {
      if (initialization) return initialization
      initialization = (async () => {
        const abort = (): void => fail(new AgentError("STARTUP_FAILED"))
        let timer: NodeJS.Timeout | undefined
        try {
          spec = parseLaunchSpec(inputSpec); contract = parseLaunchContract(inputContract)
          deadline = Math.min(input.deadline ?? Infinity, input.overallDeadline ?? Infinity, now() + (contract.qualification?.deadlines.overallMs ?? limits.startupMs))
          timer = setTimeout(() => fail(new AgentError("STARTUP_TIMEOUT")), Math.max(1, deadline - now()))
          signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort()
          check()
          await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
          check()
          await request("session/new", { cwd: spec.cwd, mcpServers: [] })
          const desired = desiredOptions(spec, contract)
          for (const [index, [configId, value]] of desired.entries()) {
            check()
            if (!options.find(option => option.id === configId)?.values.includes(value)) throw new AgentError("SELECTION_UNSUPPORTED")
            await request("session/set_config_option", { sessionId, configId, value }, index + 1)
            exactPrefix(options, desired, index + 1)
          }
          check(); exact(options, spec, contract); ready = true
          deadline = input.overallDeadline ?? Infinity
          return { sessionId: sessionId!, sessionGeneration: randomUUID(), protocolVersion: 1 as const, modelId: spec.selection.modelId, reasoning: structuredClone(spec.selection.reasoning), mode: spec.selection.mode, permissionProfile: spec.selection.permissionProfile, permissionEvidence: contract.permissionEvidence }
        } catch (error) { await denial?.catch(() => undefined); fail(error); throw failure! }
        finally { clearTimeout(timer); signal.removeEventListener("abort", abort) }
      })()
      return initialization
    },
    async prompt(text, signal) {
      if (promptUsed) throw new AgentError("INVALID_AGENT_STATE")
      check()
      if (!ready || promptState || typeof text !== "string" || text.length === 0 || Buffer.byteLength(text) > 4096 || !text.isWellFormed()) throw new AgentError("INVALID_AGENT_STATE")
      const abort = (): void => fail(new AgentError("STARTUP_FAILED"))
      promptUsed = true
      promptState = { requestId: 0, text: "", bytes: 0, chunks: 0, responseReceived: false }
      try {
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort()
        await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] })
        check()
        return { stopReason: "end_turn", text: promptState.text }
      } catch (error) { fail(error); throw failure! }
      finally { signal.removeEventListener("abort", abort); promptState = null }
    },
    close() {
      if (closed) return
      closed = true; fail(new AgentError("STARTUP_FAILED"))
      readable.off("data", data); readable.off("end", ended); readable.off("close", ended); readable.off("error", streamError); writable.off("error", streamError); writable.off("close", ended)
    },
  }
}