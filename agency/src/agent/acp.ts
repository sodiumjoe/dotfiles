import { randomUUID } from "node:crypto"
import type { Readable, Writable } from "node:stream"
import { object } from "../catalog/types.js"
import { parseLaunchContract, type LaunchContract } from "./contracts.js"
import { AgentError, agentFailure, agentText, parseLaunchSpec, type AgentFailure, type AgentLimits, type LaunchSpec, type SessionEvidence } from "./types.js"

export type AcpConnection = { initialize(spec: LaunchSpec, contract: LaunchContract, signal: AbortSignal): Promise<SessionEvidence>; fault: Promise<AgentFailure>; close(): void }
type ConfigOption = { id: string; currentValue: string; values: string[] }
type Pending = { method: string; prefix: number; deadline: number; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
function invalid(): never { throw new AgentError("INVALID_PROTOCOL") }
function parseOptions(value: unknown): ConfigOption[] {
  if (!Array.isArray(value) || value.length > 128 || Buffer.byteLength(JSON.stringify(value)) > 1048576) invalid()
  const result = value.map(raw => {
    const v = object(raw)
    if (v.type !== "select" || !Array.isArray(v.options) || v.options.length > 256) invalid()
    const values: string[] = []
    for (const rawOption of v.options) {
      const option = object(rawOption)
      if (Object.hasOwn(option, "options")) {
        agentText(option.group)
        if (!Array.isArray(option.options) || option.options.length > 256) invalid()
        for (const item of option.options) { const choice = object(item); if (Object.hasOwn(choice, "options")) invalid(); values.push(agentText(choice.value)) }
      } else values.push(agentText(option.value))
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

export function createAcpConnection(input: { readable: Readable; writable: Writable; limits: AgentLimits; now?: () => number; deadline?: number }): AcpConnection {
  const { readable, writable, limits } = input, now = input.now ?? (() => performance.now())
  const decoder = new TextDecoder("utf-8", { fatal: true }), pending = new Map<number, Pending>()
  const writes = new Set<(error?: Error | null) => void>()
  const windows = new Map<number, { bytes: number; frames: number }>()
  let buffer = "", frameBytes = 0, startupBytes = 0, nextId = 0, queuedBytes = 0, closed = false, ready = false
  let failure: AgentError | null = null, sessionId: string | null = null, options: ConfigOption[] = [], deadline = Infinity
  let violation: AgentError | null = null, denial: Promise<void> | undefined
  let spec: LaunchSpec | undefined, contract: LaunchContract | undefined, initialization: Promise<SessionEvidence> | undefined
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
    if (!ready && now() >= deadline) throw new AgentError("STARTUP_TIMEOUT")
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
      const phaseMs = phases ? method === "initialize" ? phases.initializeMs : method === "session/new" ? phases.sessionMs : phases.optionMs : limits.rpcMs
      const requestDeadline = Math.min(deadline, now() + phaseMs)
      const timer = setTimeout(() => fail(new AgentError("STARTUP_TIMEOUT")), Math.max(1, requestDeadline - now()))
      pending.set(id, { method, prefix, deadline: requestDeadline, resolve, reject, timer })
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
        if (typeof v.id === "string") agentText(v.id)
        else if (typeof v.id !== "number" || !Number.isSafeInteger(v.id)) invalid()
        const params = object(v.params)
        let response: object
        if (method === "session/request_permission") {
          if (sessionId === null || params.sessionId !== sessionId || !Array.isArray(params.options) || params.options.length > 32) invalid()
          const toolCall = object(params.toolCall); agentText(toolCall.toolCallId)
          for (const rawOption of params.options) {
            const option = object(rawOption); agentText(option.optionId); agentText(option.name)
            if (!["allow_once", "allow_always", "reject_once", "reject_always"].includes(String(option.kind))) invalid()
          }
          response = { jsonrpc: "2.0", id: v.id, result: { outcome: { outcome: "cancelled" } } }
        } else response = { jsonrpc: "2.0", id: v.id, error: { code: -32601, message: "Unsupported client method" } }
        if (violation) invalid()
        denial = write(response)
        violation = new AgentError("PERMISSION_UNSUPPORTED")
        void denial.then(() => fail(violation), fail)
        return
      }
      if (method !== "session/update") return
      const params = object(v.params)
      if (sessionId === null || params.sessionId !== sessionId) invalid()
      const update = object(params.update), kind = agentText(update.sessionUpdate)
      if (kind === "config_option_update") options = parseOptions(update.configOptions)
      else if (kind === "current_mode_update") {
        if (!contract?.modeOption) throw new AgentError("SELECTION_UNSUPPORTED")
        const option = options.find(option => option.id === contract!.modeOption)
        if (!option) invalid()
        option.currentValue = agentText(update.currentModeId)
      } else if (!["available_commands_update", "usage_update", "session_info_update"].includes(kind)) invalid()
      if (ready) exact(options, spec!, contract!)
      return
    }
    if (Object.hasOwn(v, "method") || typeof v.id !== "number" || !pending.has(v.id) || Object.hasOwn(v, "result") === Object.hasOwn(v, "error")) invalid()
    if (Object.keys(v).some(key => !["jsonrpc", "id", "result", "error"].includes(key))) invalid()
    const waiter = pending.get(v.id)!
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
          deadline = Math.min(input.deadline ?? Infinity, now() + (contract.qualification?.deadlines.overallMs ?? limits.startupMs))
          timer = setTimeout(() => fail(new AgentError("STARTUP_TIMEOUT")), Math.max(1, deadline - now()))
          signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort()
          check()
          await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
          check()
          await request("session/new", { cwd: spec.checkout.root.path, mcpServers: [] })
          const desired = desiredOptions(spec, contract)
          for (const [index, [configId, value]] of desired.entries()) {
            check()
            if (!options.find(option => option.id === configId)?.values.includes(value)) throw new AgentError("SELECTION_UNSUPPORTED")
            await request("session/set_config_option", { sessionId, configId, value }, index + 1)
            exactPrefix(options, desired, index + 1)
          }
          check(); exact(options, spec, contract); ready = true
          return { sessionId: sessionId!, sessionGeneration: randomUUID(), protocolVersion: 1 as const, modelId: spec.selection.modelId, reasoning: structuredClone(spec.selection.reasoning), mode: spec.selection.mode, permissionProfile: spec.selection.permissionProfile, permissionEvidence: contract.permissionEvidence }
        } catch (error) { await denial?.catch(() => undefined); fail(error); throw failure! }
        finally { clearTimeout(timer); signal.removeEventListener("abort", abort) }
      })()
      return initialization
    },
    close() {
      if (closed) return
      closed = true; fail(new AgentError("STARTUP_FAILED"))
      readable.off("data", data); readable.off("end", ended); readable.off("close", ended); readable.off("error", streamError); writable.off("error", streamError); writable.off("close", ended)
    },
  }
}