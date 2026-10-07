import type { Readable, Writable } from "node:stream"
import { object } from "../catalog/types.js"
import type { ConfiguredLaunchContract } from "./contracts.js"
import { configurationSnapshot, projectRestorableSettings, validateConfiguration, validateMetadata, type JsonObject, type SessionConfiguration } from "./session-config.js"
import { normalizeAgentRecord, AgentError, agentFailure, agentText, type AgentRecord, type AgentRecordV3, type SessionStart, type AgentFailure, type AgentLimits, type PromptResult } from "./types.js"
import { validateTurnInput, validateStructuredContent, validateNativeUpdate, validateNativePromptResponse, LEGACY_TURN_LIMITS, type AcpObservation, type TurnOptions } from "./session-events.js"

export type ProviderSession = { sessionId: string; protocolVersion: 1; result: JsonObject; capabilities: JsonObject; configuration: SessionConfiguration }
export type AcpConnection = {
  initialize(record: AgentRecord | AgentRecordV3, contract: ConfiguredLaunchContract, session: SessionStart, signal: AbortSignal): Promise<ProviderSession>
  request(method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject>
  notify(method: string, params: JsonObject): void
  respond(id: string | number, result: JsonObject): void
  snapshot(): SessionConfiguration
  prompt(text: string, signal: AbortSignal, limits?: TurnOptions): Promise<PromptResult>
  cancelPrompt(): Promise<void>
  close(): void
  fault: Promise<AgentFailure>
}
type Pending = { method: string; params: JsonObject; resolve(value: JsonObject): void; reject(error: Error): void; timer?: NodeJS.Timeout; dispose(): void }
export function withoutAgencyMetadata(params: JsonObject): JsonObject {
  const routed = structuredClone(params)
  if (Object.hasOwn(routed, "_meta")) { const meta = object(routed._meta) as JsonObject; delete meta.agency; routed._meta = meta }
  return routed
}
export function withNativeSession(params: JsonObject, nativeSessionId: string): JsonObject { return { ...withoutAgencyMetadata(params), sessionId: nativeSessionId } }

export function createAcpConnection(input: { readable: Readable; writable: Writable; limits: AgentLimits; now?: () => number; deadline?: number; overallDeadline?: number; onUpdate?(event: AcpObservation): void; onRequest?(message: JsonObject): void }): AcpConnection {
  const { readable, writable, limits } = input, now = input.now ?? (() => performance.now()), decoder = new TextDecoder("utf-8", { fatal: true })
  const pending = new Map<number, Pending>(), providerRequests = new Set<string | number>(), writes = new Set<(error?: Error | null) => void>()
  let nextId = 0, buffer = "", frameBytes = 0, queuedBytes = 0, closed = false, failure: AgentError | null = null
  let sessionId: string | null = null, loading = false, ready = false, promptActive = false, cancellation: Promise<void> | undefined
  let configuration = configurationSnapshot({}), capabilities: JsonObject = {}, initialization: Promise<ProviderSession> | undefined
  let startupDeadline = Math.min(input.deadline ?? Infinity, input.overallDeadline ?? Infinity), initializationTimer: NodeJS.Timeout | undefined
  let promptText = "", promptTextLimit = 0, cancelTimer: NodeJS.Timeout | undefined
  const faultDeferred = Promise.withResolvers<AgentFailure>()
  const fail = (error: unknown): void => {
    if (failure) return
    failure = error instanceof AgentError ? error : new AgentError("INVALID_PROTOCOL")
    clearTimeout(initializationTimer); clearTimeout(cancelTimer)
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.dispose(); waiter.reject(failure) }
    pending.clear(); providerRequests.clear(); buffer = ""
    for (const finish of [...writes]) finish(failure)
    faultDeferred.resolve(agentFailure(failure))
  }
  const check = () => {
    if (failure) throw failure
    if (closed) throw new AgentError("STARTUP_FAILED")
    if (!ready && now() >= startupDeadline) throw new AgentError("STARTUP_TIMEOUT")
  }
  const write = (frame: JsonObject): Promise<void> => new Promise((resolve, reject) => {
    let bytes: Buffer
    try {
      check(); bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n")
      if (bytes.length > limits.frameBytes || Math.max(queuedBytes, writable.writableLength) + bytes.length > limits.writeQueueBytes || !writable.writable) throw new AgentError("ACP_FRAME_LIMIT")
    } catch (error) { reject(error); return }
    queuedBytes += bytes.length
    let settled = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true; clearTimeout(timer); queuedBytes -= bytes.length; writes.delete(finish)
      if (error) reject(error); else resolve()
    }
    const timer = setTimeout(() => finish(new AgentError("STARTUP_TIMEOUT")), limits.rpcMs)
    writes.add(finish)
    try { writable.write(bytes, finish) } catch (error) { finish(error as Error) }
  })
  const request = (method: string, raw: JsonObject, signal?: AbortSignal): Promise<JsonObject> => {
    let params: JsonObject
    try { check(); if (pending.size >= 128) throw new AgentError("INVALID_PROTOCOL"); params = withoutAgencyMetadata(raw) } catch (error) { return Promise.reject(error) }
    const id = ++nextId
    if (method === "session/prompt") {
      if (!ready || promptActive || params.sessionId !== sessionId || !Array.isArray(params.prompt)) return Promise.reject(new AgentError("NOT_READY"))
      try { params.prompt.forEach(validateStructuredContent) } catch { return Promise.reject(new AgentError("INVALID_PROTOCOL")) }
      promptActive = true; cancellation = undefined; promptText = ""
    }
    const result = new Promise<JsonObject>((resolve, reject) => {
      const abort = () => fail(new AgentError("STARTUP_FAILED"))
      const waiter: Pending = { method, params, resolve, reject, dispose: () => signal?.removeEventListener("abort", abort) }
      if (method !== "session/prompt") waiter.timer = setTimeout(() => fail(new AgentError("STARTUP_TIMEOUT")), Math.max(1, Math.min(["initialize", "session/new", "session/load"].includes(method) ? 30000 : limits.rpcMs, startupDeadline - now())))
      pending.set(id, waiter)
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      if (!failure) void write({ id, method, params }).catch(fail)
    })
    return method === "session/prompt" ? result.finally(() => { promptActive = false; clearTimeout(cancelTimer); cancelTimer = undefined }) : result
  }
  const applyResult = (result: JsonObject, method: string) => {
    validateConfiguration(result)
    if (Object.hasOwn(result, "availableCommands")) validateNativeUpdate({ sessionUpdate: "available_commands_update", availableCommands: result.availableCommands })
    if (method === "session/new" || method === "session/load") configuration = configurationSnapshot(result, configuration.revision + 1)
    else if (Array.isArray(result.configOptions) || result.models || result.modes) configuration = configurationSnapshot({ ...configuration, ...result }, configuration.revision + 1)
  }
  function receive(raw: unknown): void {
    const frame = object(raw) as JsonObject
    if (frame.jsonrpc !== "2.0") throw new AgentError("INVALID_PROTOCOL")
    if (Object.hasOwn(frame, "_meta")) object(frame._meta)
    if (typeof frame.method === "string") {
      if (frame.result !== undefined || frame.error !== undefined) throw new AgentError("INVALID_PROTOCOL")
      const params = object(frame.params) as JsonObject
      if (Object.hasOwn(params, "_meta")) object(params._meta)
      if (Object.hasOwn(frame, "id")) {
        if (typeof frame.id !== "string" && (typeof frame.id !== "number" || !Number.isSafeInteger(frame.id))) throw new AgentError("INVALID_PROTOCOL")
        const id = frame.id as string | number
        if (providerRequests.has(id)) throw new AgentError("INVALID_PROTOCOL")
        if (frame.method !== "session/request_permission") { void write({ id, error: { code: -32601, message: "Client RPC is not supported" } }).catch(fail); return }
        if (params.sessionId !== sessionId || !sessionId || !Array.isArray(params.options) || !params.options.length || params.options.length > 32) throw new AgentError("INVALID_PROTOCOL")
        const toolCall = object(params.toolCall)
        validateNativeUpdate({ ...toolCall, sessionUpdate: "tool_call_update" })
        const optionIds = params.options.map(raw => {
          const option = object(raw)
          validateMetadata(option)
          if (typeof option.kind !== "string" || !["allow_once", "allow_always", "reject_once", "reject_always"].includes(option.kind) || typeof option.name !== "string") throw new AgentError("INVALID_PROTOCOL")
          return agentText(option.optionId, 1024)
        })
        if (new Set(optionIds).size !== optionIds.length) throw new AgentError("INVALID_PROTOCOL")
        providerRequests.add(id); input.onRequest?.(structuredClone(frame)); return
      }
      if (frame.method !== "session/update" || params.sessionId !== sessionId || !sessionId) throw new AgentError("INVALID_PROTOCOL")
      validateMetadata(params)
      const update = validateNativeUpdate(params.update) as JsonObject
      if (update.sessionUpdate === "config_option_update") applyResult({ configOptions: update.configOptions! }, "update")
      if (update.sessionUpdate === "available_commands_update") configuration.availableCommands = (update.availableCommands ?? []) as JsonObject[]
      if (update.sessionUpdate === "current_mode_update" && configuration.modes) configuration.modes.currentModeId = update.currentModeId!
      if (update.sessionUpdate === "agent_message_chunk" && promptActive && promptTextLimit > 0) {
        const content = object(update.content)
        if (content.type === "text" && typeof content.text === "string" && Buffer.byteLength(promptText) < promptTextLimit) {
          const bytes = Buffer.from(content.text)
          let end = Math.min(bytes.length, promptTextLimit - Buffer.byteLength(promptText))
          while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
          promptText += bytes.subarray(0, end).toString("utf8")
        }
      }
      const extra = Object.fromEntries(Object.entries(params).filter(([key]) => key !== "sessionId" && key !== "update")) as JsonObject
      try { input.onUpdate?.({ update: { ...update, sessionUpdate: String(update.sessionUpdate) }, replay: loading, ...(Object.keys(extra).length ? { params: structuredClone(extra) } : {}), ...(frame._meta ? { meta: structuredClone(frame._meta) as JsonObject } : {}) }) } catch {}
      return
    }
    if (typeof frame.id !== "number" || !pending.has(frame.id) || Object.hasOwn(frame, "result") === Object.hasOwn(frame, "error")) throw new AgentError("INVALID_PROTOCOL")
    const waiter = pending.get(frame.id)!
    if (Object.hasOwn(frame, "error")) {
      const error = object(frame.error)
      if (!Number.isSafeInteger(error.code) || typeof error.message !== "string" || !error.message.length) throw new AgentError("INVALID_PROTOCOL")
      pending.delete(frame.id); clearTimeout(waiter.timer); waiter.dispose()
      const code = ["session/new", "session/load"].includes(waiter.method) && error.code === -32000 && error.message === "Authentication required" ? "AUTH_REQUIRED" : waiter.method === "session/load" && error.code === -32602 && error.message === "Session not found" ? "SESSION_UNAVAILABLE" : "STARTUP_FAILED"
      waiter.reject(Object.assign(new AgentError(code), { providerCode: error.code, noMutation: error.code === -32602 || error.code === -32601 })); return
    }
    const result = object(frame.result) as JsonObject
    if (waiter.method === "initialize") {
      if (result.protocolVersion !== 1) throw new AgentError("INVALID_PROTOCOL")
      capabilities = structuredClone(object(result.agentCapabilities)) as JsonObject
      if (capabilities.loadSession !== undefined && typeof capabilities.loadSession !== "boolean") throw new AgentError("INVALID_PROTOCOL")
    }
    if (waiter.method === "session/new") sessionId = agentText(result.sessionId, 1024)
    if (waiter.method === "session/load" && result.sessionId !== undefined && result.sessionId !== sessionId) throw new AgentError("INVALID_PROTOCOL")
    if (waiter.method === "session/prompt") validateNativePromptResponse(result)
    if (waiter.method === "session/prompt") { promptActive = false; clearTimeout(cancelTimer); cancelTimer = undefined; providerRequests.clear() }
    applyResult(result, waiter.method)
    if (waiter.method === "session/set_model" && configuration.models && !result.models) { configuration.models.currentModelId = waiter.params.modelId!; configuration.revision++ }
    if (waiter.method === "session/set_mode" && configuration.modes && !result.modes) { configuration.modes.currentModeId = waiter.params.modeId!; configuration.revision++ }
    pending.delete(frame.id); clearTimeout(waiter.timer); waiter.dispose(); waiter.resolve(structuredClone(result))
  }
  const data = (chunk: Buffer) => {
    if (closed || failure) return
    try {
      check()
      for (const byte of chunk) { if (byte === 10) frameBytes = 0; else if (++frameBytes > limits.frameBytes) throw new AgentError("ACP_FRAME_LIMIT") }
      buffer += decoder.decode(chunk, { stream: true })
      let at: number
      while (!failure && (at = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); receive(JSON.parse(line)) }
    } catch (error) { fail(error instanceof AgentError && error.code === "INVALID_AGENT_STATE" ? new AgentError("INVALID_PROTOCOL") : error) }
  }
  const ended = () => { try { decoder.decode(); fail(new AgentError("STARTUP_FAILED")) } catch (error) { fail(error) } }
  readable.on("data", data); readable.on("end", ended); readable.on("close", ended); readable.on("error", fail); writable.on("error", fail); writable.on("close", ended)
  return {
    fault: faultDeferred.promise, request,
    notify(method, params) { void write({ method, params: withoutAgencyMetadata(params) }).catch(fail) },
    respond(id, result) { if (!providerRequests.delete(id)) throw new AgentError("INVALID_PROTOCOL"); void write({ id, result }).catch(fail) },
    snapshot: () => structuredClone(configuration),
    initialize(raw, contract, session, signal) {
      return initialization ??= (async () => {
        const record = normalizeAgentRecord(raw)
        startupDeadline = Math.min(startupDeadline, now() + limits.startupMs)
        initializationTimer = setTimeout(() => fail(new AgentError("STARTUP_TIMEOUT")), Math.max(1, startupDeadline - now()))
        try {
          await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, signal)
          const params = withoutAgencyMetadata({ cwd: record.definition.cwd, mcpServers: [], ...session.params })
          if (params.cwd !== record.definition.cwd || !Array.isArray(params.mcpServers)) throw new AgentError("INVALID_AGENT_STATE")
          let result: JsonObject
          if (session.kind === "load") {
            if (capabilities.loadSession !== true) throw new AgentError("RESTORE_UNSUPPORTED")
            sessionId = agentText(session.sessionId, 1024); loading = true
            result = await request("session/load", { ...params, sessionId }, signal); loading = false
          } else {
            result = await request("session/new", params, signal)
            const selected = { ...(!configuration.models && record.settings.modelId ? { [contract.modelOption]: record.settings.modelId } : {}), ...record.settings.configValues, ...(!configuration.modes && record.settings.modeId && contract.modeOption ? { [contract.modeOption]: record.settings.modeId } : {}) }
            const legacySelections: { method: string; field: string; value: string }[] = []
            for (const [field, method, choices, key] of [["modelId", "session/set_model", "availableModels", "modelId"], ["modeId", "session/set_mode", "availableModes", "id"]] as const) {
              const value = record.settings[field], state = field === "modelId" ? configuration.models : configuration.modes
              if (!value) continue
              if (state) {
                if (!Array.isArray(state[choices]) || !(state[choices] as JsonObject[]).some(choice => choice[key] === value)) throw new AgentError("SELECTION_UNSUPPORTED")
                legacySelections.push({ method, field, value })
              } else {
                const optionId = field === "modelId" ? contract.modelOption : contract.modeOption
                if (!optionId) throw new AgentError("SELECTION_UNSUPPORTED")
                selected[optionId] = value
              }
            }
            for (const { method, field, value } of legacySelections) await request(method, { sessionId, [field]: value }, signal)
            const acknowledged: Record<string, string | boolean> = {}
            const choices = Object.entries(selected).sort(([a], [b]) => a === contract.modelOption ? -1 : b === contract.modelOption ? 1 : 0)
            for (const [configId, value] of choices) {
              const option = configuration.configOptions.find(option => option.id === configId)
              if (!option) throw new AgentError("SELECTION_UNSUPPORTED")
              if (projectRestorableSettings({ configOptions: [{ ...option, currentValue: value }] }).configValues?.[configId] !== value) throw new AgentError("SELECTION_UNSUPPORTED")
              if (option.currentValue !== value) {
                const response = await request("session/set_config_option", { sessionId, configId, value }, signal)
                const values = projectRestorableSettings(response).configValues ?? {}
                if (Object.entries({ ...acknowledged, [configId]: value }).some(([id, requested]) => values[id] !== requested)) throw new AgentError("SELECTION_UNSUPPORTED")
              }
              if (configuration.configOptions.find(option => option.id === configId)?.currentValue !== value) throw new AgentError("SELECTION_UNSUPPORTED")
              acknowledged[configId] = value
            }
            if (Object.entries(selected).some(([id, value]) => configuration.configOptions.find(option => option.id === id)?.currentValue !== value) || record.settings.modelId && configuration.models && configuration.models.currentModelId !== record.settings.modelId || record.settings.modeId && configuration.modes && configuration.modes.currentModeId !== record.settings.modeId) throw new AgentError("SELECTION_UNSUPPORTED")
          }
          check(); ready = true; startupDeadline = Infinity
          return { sessionId: sessionId!, protocolVersion: 1, result: structuredClone(result), capabilities: structuredClone(capabilities), configuration: structuredClone(configuration) }
        } catch (error) { fail(error); throw failure! }
        finally { clearTimeout(initializationTimer) }
      })()
    },
    async prompt(text, signal, turnLimits = LEGACY_TURN_LIMITS) {
      validateTurnInput(text, turnLimits); promptTextLimit = turnLimits.outputBytes
      const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, signal)
      return { stopReason: result.stopReason as PromptResult["stopReason"], text: promptText }
    },
    cancelPrompt() { if (!promptActive) return Promise.resolve(); cancelTimer ??= setTimeout(() => fail(new AgentError("STARTUP_TIMEOUT")), 5000); return cancellation ??= write({ method: "session/cancel", params: { sessionId } }) },
    close() {
      if (closed) return
      closed = true; fail(new AgentError("STARTUP_FAILED"))
      readable.off("data", data); readable.off("end", ended); readable.off("close", ended); readable.off("error", fail); writable.off("error", fail); writable.off("close", ended)
    },
  }
}