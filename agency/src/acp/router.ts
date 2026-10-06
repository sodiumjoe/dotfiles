import { randomUUID } from "node:crypto"
import { absolutePath, id, object, providerId } from "../catalog/types.js"
import { agentTuple } from "../agent/recovery.js"
import { parseLaunchEnvironment, type LaunchEnvironment } from "../agent/environment.js"
import { parseRequestedSettings, type JsonObject, type SessionConfiguration } from "../agent/session-config.js"
import { validateStructuredContent } from "../agent/session-events.js"
import type { ConversationNotification, RetainedEvent } from "../agent/conversation.js"
import { sessionInputs, type AgentService, type AcpSessionObservation } from "../agent/service.js"
import { AgentError, type AgentTuple } from "../agent/types.js"
import { parsePageInput } from "../agent/queries.js"
import { AcpError, acpError, parseAcpFrame, parseAgencyMeta, parseLogicalSessionId, type RpcId } from "./protocol.js"

type Binding = { target: AgentTuple; invalid: boolean; turnId: string | null; configuration: SessionConfiguration; observation?: AcpSessionObservation }
const checked = <T>(read: () => T): T => { try { return read() } catch (error) { if (error instanceof AcpError) throw error; throw new AcpError(-32602, "Invalid parameters") } }
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject

export function createAcpRouter(input: { service: AgentService; connectionId: string; send(frame: JsonObject): void; environment?: LaunchEnvironment }): { receive(frame: JsonObject): Promise<void>; close(): void } {
  const { service } = input, bindings = new Map<string, Binding>(), pending = new Map<RpcId, symbol>()
  let initialized = false, closed = false
  const send = (frame: JsonObject): void => { if (!closed) input.send(frame) }
  const notify = (method: string, params: JsonObject, meta?: JsonObject): void => send({ jsonrpc: "2.0", method, params, ...(meta ? { _meta: meta } : {}) })
  const state = (sessionId: string, binding: Binding, configuration = false): void => notify("agency/session_state", json({ sessionId, binding: binding.target, turnId: binding.turnId, state: binding.invalid ? "unavailable" : binding.turnId ? "running" : "idle", ...(configuration ? { configuration: binding.configuration } : {}) }))
  const invalidate = (sessionId: string, binding: Binding): void => { if (!binding.invalid) { binding.invalid = true; state(sessionId, binding); binding.observation?.close() } }
  const event = (sessionId: string, binding: Binding, value: RetainedEvent, replay: boolean): void => {
    if (value.kind === "submitted") {
      binding.turnId = value.submissionId
      for (const content of value.prompt ?? [{ type: "text", text: value.text }]) notify("session/update", { sessionId, update: { sessionUpdate: "user_message_chunk", content }, _meta: { ...value.meta, agency: { version: 1, seq: value.seq, replay, submissionId: value.submissionId, ...(value.originConnectionId ? { originConnectionId: value.originConnectionId } : {}) } } })
    } else if (value.kind === "update") {
      const meta = object(value.params?._meta ?? {}) as JsonObject
      notify("session/update", { ...value.params, sessionId, update: value.update as JsonObject, _meta: { ...meta, agency: { version: 1, seq: value.seq, replay } } }, value.meta)
    } else if (value.kind === "turn") {
      binding.turnId = value.state === "accepted" || value.state === "running" ? value.submissionId : null
      if (!replay) state(sessionId, binding)
    } else if (value.kind === "lifecycle" && value.phase !== "ready" && !replay) invalidate(sessionId, binding)
  }
  const requireBinding = (sessionId: unknown): [string, Binding] => {
    const logical = "agency:" + parseLogicalSessionId(sessionId), binding = bindings.get(logical)
    if (!binding || binding.invalid) throw new AgentError("STALE_ATTACHMENT")
    return [logical, binding]
  }
  const live = async (sessionId: string, binding: Binding): Promise<void> => {
    try { await service.sessionSnapshot(binding.target) }
    catch (error) {
      if (error instanceof AgentError && ["STALE_HANDLER", "STALE_PROVIDER", "NOT_READY", "UNAVAILABLE", "CLEANUP_UNVERIFIED"].includes(error.code)) { invalidate(sessionId, binding); throw new AgentError("STALE_ATTACHMENT") }
      throw error
    }
  }
  const attach = async (sessionId: string, target: AgentTuple): Promise<JsonObject> => {
    const buffered: Array<ConversationNotification | SessionConfiguration> = [], binding: Binding = { target, invalid: false, turnId: null, configuration: { configOptions: [], models: null, modes: null, availableCommands: [], revision: 0 } }
    let replaying = true
    const deliver = (value: ConversationNotification): void => {
      if (value.kind === "closed") invalidate(sessionId, binding)
      else event(sessionId, binding, value.event, false)
    }
    const configuration = (snapshot: SessionConfiguration): void => { binding.configuration = snapshot; state(sessionId, binding, true) }
    const observed = await service.observeSession(target, value => { if (replaying) buffered.push(value); else deliver(value) }, snapshot => { if (replaying) buffered.push(snapshot); else configuration(snapshot) })
    if (closed) { observed.close(); throw new AgentError("UNAVAILABLE") }
    bindings.get(sessionId)?.observation?.close()
    bindings.set(sessionId, binding); binding.observation = observed; binding.configuration = observed.native.configuration
    const snapshot = observed.snapshot
    for (const value of snapshot.events) event(sessionId, binding, value, true)
    binding.turnId = snapshot.currentTurn && ["accepted", "running"].includes(snapshot.currentTurn.state) ? snapshot.currentTurn.submissionId : null
    state(sessionId, binding, true)
    replaying = false
    for (const value of buffered) {
      if ("kind" in value) { if (value.kind === "closed" || value.event.seq > snapshot.lastSeq) deliver(value) }
      else configuration(value)
    }
    if (binding.invalid) throw new AgentError("STALE_ATTACHMENT")
    const native = observed.native, result = { ...native.result }
    delete result.configOptions; delete result.models; delete result.modes; delete result.availableCommands
    const config = binding.configuration
    return { ...result, sessionId, configOptions: config.configOptions, ...(config.models ? { models: config.models } : {}), ...(config.modes ? { modes: config.modes } : {}), availableCommands: config.availableCommands, _meta: { ...object(result._meta ?? {}), agency: json({ version: 1, binding: target, backendId: observed.backendId, capabilities: native.capabilities, configuration: config, firstSeq: snapshot.firstSeq, lastSeq: snapshot.lastSeq, historyTruncated: snapshot.historyTruncated, turnId: binding.turnId, connectionId: input.connectionId }) } }
  }
  async function dispatch(method: string, params: JsonObject, pinnedCancel: string | null): Promise<JsonObject> {
    if (method === "initialize") {
      if (initialized) throw new AcpError(-32600, "Already initialized")
      checked(() => { if (params.protocolVersion !== 1) throw new Error(); object(params.clientCapabilities ?? {}) })
      const capabilities = await service.acpCapabilities()
      initialized = true
      return { protocolVersion: 1, agentCapabilities: capabilities, authMethods: [], agentInfo: { name: "agency", version: "1" } }
    }
    if (!initialized) throw new AcpError(-32600, "Initialize required")
    if (method === "authenticate") throw new AgentError("UNSUPPORTED_SESSION_FEATURE")
    if (method === "session/list") {
      const options = checked(() => parsePageInput({ limit: 100, ...(params.cwd === undefined ? {} : { cwd: params.cwd }), ...(params.cursor === undefined ? {} : { cursor: params.cursor }) }))
      let inventory
      try { inventory = await service.page(options) }
      catch (error) { if (error instanceof AgentError && error.code === "INVALID_PROTOCOL") throw new AcpError(-32602, "Invalid cursor"); throw error }
      return { sessions: inventory.agents.flatMap(view => {
        if (view.record.version !== 3) return []
        return [{ sessionId: "agency:" + view.record.definition.agentId, cwd: view.record.definition.cwd, title: view.record.definition.backendId, _meta: { agency: { version: 1, backendId: view.record.definition.backendId, phase: view.record.phase } } }]
      }), ...(inventory.nextCursor ? { nextCursor: inventory.nextCursor } : {}) }
    }
    if (method === "session/new") {
      const cwd = checked(() => absolutePath(params.cwd)), meta = parseAgencyMeta(params, ["commandId", "backendId", "inheritSessionId", "selection", "environment"])
      if (!Array.isArray(params.mcpServers)) throw new AcpError(-32602, "MCP server list required")
      checked(() => sessionInputs(cwd, params))
      if (meta.backendId !== undefined && meta.inheritSessionId !== undefined) throw new AcpError(-32602, "Ambiguous backend selection")
      let backendId = meta.backendId === undefined ? undefined : checked(() => providerId(meta.backendId))
      if (meta.inheritSessionId !== undefined) {
        const [logical, binding] = requireBinding(meta.inheritSessionId)
        await live(logical, binding); backendId = binding.observation!.backendId
      }
      const selection = meta.selection === undefined ? undefined : checked(() => parseRequestedSettings(meta.selection))
      const environment = checked(() => parseLaunchEnvironment(meta.environment ?? input.environment ?? {}))
      const commandId = meta.commandId === undefined ? randomUUID() : checked(() => id(meta.commandId))
      const record = await service.createSession({ cwd, commandId, ...(backendId ? { backendId } : {}), ...(selection ? { selection } : {}), environment, nativeParams: params })
      return attach("agency:" + record.definition.agentId, agentTuple(record)!)
    }
    if (method === "session/load") {
      const agentId = parseLogicalSessionId(params.sessionId), cwd = checked(() => absolutePath(params.cwd))
      if (!Array.isArray(params.mcpServers)) throw new AcpError(-32602, "MCP server list required")
      checked(() => sessionInputs(cwd, params))
      const view = await service.sessionRecord(agentId)
      if (!view || view.record.version !== 3) throw new AgentError("UNAVAILABLE")
      if (view.record.definition.cwd !== cwd) throw new AcpError(-32602, "Session directory mismatch")
      if (!view.live || !view.record.launch) throw new AgentError("NOT_READY")
      return attach("agency:" + agentId, agentTuple(view.record)!)
    }
    if (!["session/prompt", "session/cancel", "session/set_model", "session/set_mode", "session/set_config_option"].includes(method)) throw new AcpError(-32601, "Method not found")
    const [logical, binding] = requireBinding(params.sessionId)
    await live(logical, binding)
    if (method === "session/cancel") { if (pinnedCancel) await service.cancel(binding.target, pinnedCancel); return {} }
    if (method === "session/prompt") {
      const meta = parseAgencyMeta(params, ["submissionId"])
      checked(() => { if (!Array.isArray(params.prompt) || !params.prompt.length) throw new Error(); params.prompt.forEach(validateStructuredContent) })
      const prompt = params.prompt as JsonObject[], capabilities = binding.observation!.native.capabilities.promptCapabilities as JsonObject | undefined
      for (const content of prompt) if (content.type === "image" && capabilities?.image !== true || content.type === "audio" && capabilities?.audio !== true || ["resource", "resource_link"].includes(String(content.type)) && capabilities?.embeddedContext !== true) throw new AgentError("UNSUPPORTED_SESSION_FEATURE")
      const submissionId = meta.submissionId === undefined ? randomUUID() : checked(() => id(meta.submissionId))
      await service.submitAcp(binding.target, { submissionId, prompt, ...(params._meta ? { meta: params._meta as JsonObject } : {}), originConnectionId: input.connectionId })
      return service.settledAcp(binding.target, submissionId)
    }
    checked(() => {
      if (method === "session/set_model" && typeof params.modelId !== "string" || method === "session/set_mode" && typeof params.modeId !== "string" || method === "session/set_config_option" && (typeof params.configId !== "string" || !Object.hasOwn(params, "value"))) throw new Error()
    })
    return service.setSession(binding.target, method, params)
  }
  return {
    async receive(raw) {
      if (closed) return
      let requestId: RpcId | undefined
      const token = Symbol()
      let admitted = false
      try {
        const frame = parseAcpFrame(raw)
        if (typeof frame.method !== "string") return
        requestId = frame.id as RpcId | undefined
        if (requestId !== undefined && pending.has(requestId)) { pending.delete(requestId); throw new AcpError(-32600, "Duplicate pending request ID") }
        if (pending.size >= 64) throw new AcpError(-32600, "Too many pending requests")
        const params = checked(() => object(frame.params ?? {}) as JsonObject)
        let pinnedCancel: string | null = null
        if (frame.method === "session/cancel") {
          const meta = parseAgencyMeta(params, ["turnId"]), [, binding] = requireBinding(params.sessionId)
          pinnedCancel = meta.turnId === undefined ? binding.turnId : checked(() => id(meta.turnId))
        }
        if (requestId !== undefined) pending.set(requestId, token)
        admitted = true
        const result = await dispatch(frame.method, params, pinnedCancel)
        if (requestId !== undefined && pending.get(requestId) === token) send({ jsonrpc: "2.0", id: requestId, result })
      } catch (error) { if (requestId !== undefined && (!admitted || pending.get(requestId) === token)) send(json(acpError(requestId, error))) }
      finally { if (requestId !== undefined && pending.get(requestId) === token) pending.delete(requestId) }
    },
    close() { if (closed) return; closed = true; for (const binding of bindings.values()) binding.observation?.close(); bindings.clear(); pending.clear() },
  }
}