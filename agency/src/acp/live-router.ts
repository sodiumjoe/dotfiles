import { randomUUID } from "node:crypto"
import { cloneWireJson } from "./wire-json.js"
import { absolutePath, id, object, providerId } from "../config/validate.js"
import { parseLaunchEnvironment, type LaunchEnvironment } from "../agent/environment.js"
import { parseRequestedSettings, type JsonObject, type SessionConfiguration } from "../agent/session-config.js"
import { validateStructuredContent } from "../agent/session-events.js"
import type { ConversationNotification, RetainedEvent } from "../agent/conversation.js"
import { sessionInputs } from "../agent/session-inputs.js"
import { AgentError, ProviderRequestError, type AgentTuple } from "../agent/types.js"
import type { LiveCore, LiveObservation } from "../live/core.js"
import type { RemoteHost } from "../hosts/remote-rosters.js"
import { RequestError, requestFailure } from "../live/errors.js"
import { AcpError, parseAcpFrame, parseAgencyMeta, parseLogicalSessionId, type RpcId } from "./protocol.js"

type Binding = { attachment: string; target: AgentTuple; invalid: boolean; turnId: string | null; configuration: SessionConfiguration; observation?: LiveObservation }
const checked = <T>(read: () => T): T => { try { return read() } catch (error) { if (error instanceof AcpError) throw error; throw new AcpError(-32602, "Invalid parameters") } }
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject

export function liveAcpError(requestId: RpcId | null, error: unknown): JsonObject {
  if (error instanceof ProviderRequestError) return { jsonrpc: "2.0", id: requestId, error: structuredClone(error.providerError) }
  if (error instanceof AcpError) return { jsonrpc: "2.0", id: requestId, error: { code: error.code, message: error.message } }
  const failure = requestFailure(error)
  return { jsonrpc: "2.0", id: requestId, error: { code: -32000, message: failure.message, data: { agency: failure } } }
}

export function createLiveRouter(input: { core: LiveCore; remotes?: () => RemoteHost[]; connectionId: string; send(frame: JsonObject): void; environment?: LaunchEnvironment }): { receive(frame: JsonObject): Promise<void>; close(): void } {
  const { core } = input, bindings = new Map<string, Binding>(), pending = new Map<RpcId, symbol>(), loads = new Map<string, symbol>()
  let initialized = false, closed = false
  const send = (frame: JsonObject): void => { if (!closed) input.send(frame) }
  const notify = (method: string, params: JsonObject, meta?: JsonObject): void => send({ jsonrpc: "2.0", method, params, ...(meta ? { _meta: meta } : {}) })
  const state = (sessionId: string, binding: Binding, configuration = false, submission?: { submissionId: string; state: string }): void => notify("agency/session_state", json({ sessionId, binding: binding.target, turnId: binding.turnId, state: binding.invalid ? "unavailable" : binding.turnId ? "running" : "idle", ...(submission ? { submissionId: submission.submissionId, submissionState: submission.state } : {}), ...(configuration ? { configuration: binding.configuration } : {}) }))
  const current = (sessionId: string, binding: Binding): boolean => !closed && bindings.get(sessionId) === binding && !binding.invalid
  const checkBinding = (sessionId: string, binding: Binding): void => { if (!current(sessionId, binding)) throw new AgentError("STALE_ATTACHMENT") }
  const detach = (binding: Binding): void => {
    binding.invalid = true
    binding.observation?.close()
    core.detachEditor(input.connectionId, binding.target, binding.attachment)
    core.detachPermissions(input.connectionId, binding.target)
  }
  const editorAddress = (meta: JsonObject): string | null | undefined => checked(() => {
    if (!Object.hasOwn(meta, "editor")) return undefined
    if (meta.editor === null || meta.editor === "") return null
    const address = absolutePath(meta.editor)
    if (address.includes("\0")) throw new Error()
    return address
  })
  const invalidate = (sessionId: string, binding: Binding): void => { if (!binding.invalid) { detach(binding); if (bindings.get(sessionId) === binding) state(sessionId, binding) } }
  const event = (sessionId: string, binding: Binding, value: RetainedEvent, replay: boolean): void => {
    if (value.kind === "submitted") {
      binding.turnId = value.submissionId
      for (const content of value.prompt ?? [{ type: "text", text: value.text }]) notify("session/update", { sessionId, update: { sessionUpdate: "user_message_chunk", content }, _meta: { ...value.meta, agency: { version: 1, seq: value.seq, replay, submissionId: value.submissionId, ...(value.originConnectionId ? { originConnectionId: value.originConnectionId } : {}) } } })
    } else if (value.kind === "update") {
      const meta = cloneWireJson(object(value.params?._meta ?? {})) as JsonObject
      notify("session/update", { ...value.params, sessionId, update: value.update as JsonObject, _meta: { ...meta, agency: { version: 1, seq: value.seq, replay } } }, value.meta)
    } else if (value.kind === "turn") {
      if (!replay) state(sessionId, binding, false, value)
    } else if (value.kind === "lifecycle" && value.phase !== "ready" && !replay) invalidate(sessionId, binding)
  }
  const requireBinding = (sessionId: unknown): [string, Binding] => {
    const logical = "agency:" + parseLogicalSessionId(sessionId), binding = bindings.get(logical)
    if (!binding || binding.invalid) throw new AgentError("STALE_ATTACHMENT")
    return [logical, binding]
  }
  const live = (sessionId: string, binding: Binding): void => {
    if (!core.isLive(binding.target)) { invalidate(sessionId, binding); throw new AgentError("STALE_ATTACHMENT") }
    checkBinding(sessionId, binding)
  }
  const attach = async (sessionId: string, target: AgentTuple, address: string | null): Promise<JsonObject> => {
    const buffered: Array<ConversationNotification | SessionConfiguration> = [], binding: Binding = { attachment: randomUUID(), target, invalid: false, turnId: null, configuration: { configOptions: [], models: null, modes: null, availableCommands: [], revision: 0 } }
    const previous = bindings.get(sessionId)
    if (previous) detach(previous)
    if (closed) throw new RequestError("UNAVAILABLE", "the editor connection closed")
    bindings.set(sessionId, binding)
    let replaying = true
    const deliver = (value: ConversationNotification): void => {
      if (!current(sessionId, binding)) return
      if (value.kind === "closed") invalidate(sessionId, binding)
      else {
        if (value.event.kind === "turn") binding.turnId = value.currentTurn && ["accepted", "running"].includes(value.currentTurn.state) ? value.currentTurn.submissionId : null
        event(sessionId, binding, value.event, false)
      }
    }
    const configuration = (snapshot: SessionConfiguration): void => { if (current(sessionId, binding)) { binding.configuration = snapshot; state(sessionId, binding, true) } }
    try {
      const observed = await core.observe(target, value => { if (replaying) buffered.push(value); else deliver(value) }, snapshot => { if (replaying) buffered.push(snapshot); else configuration(snapshot) })
      binding.observation = observed
      checkBinding(sessionId, binding)
      core.attachEditor(target, input.connectionId, address, binding.attachment)
      binding.configuration = observed.native.configuration
      const snapshot = observed.snapshot
      for (const value of snapshot.events) event(sessionId, binding, value, true)
      binding.turnId = snapshot.currentTurn && ["accepted", "running"].includes(snapshot.currentTurn.state) ? snapshot.currentTurn.submissionId : null
      state(sessionId, binding, true)
      replaying = false
      for (const value of buffered) {
        if ("kind" in value) { if (value.kind === "closed" || value.event.seq > snapshot.lastSeq) deliver(value) }
        else configuration(value)
      }
      checkBinding(sessionId, binding)
      await core.attachPermissions(target, { connectionId: input.connectionId, send }, () => current(sessionId, binding))
      checkBinding(sessionId, binding)
      const native = observed.native, result = { ...native.result }
      delete result.configOptions; delete result.models; delete result.modes; delete result.availableCommands
      const config = binding.configuration
      return { ...result, sessionId, configOptions: config.configOptions, ...(config.models ? { models: config.models } : {}), ...(config.modes ? { modes: config.modes } : {}), availableCommands: config.availableCommands, _meta: { ...object(result._meta ?? {}), agency: json({ version: 1, binding: target, backendId: observed.backendId, capabilities: native.capabilities, configuration: config, firstSeq: snapshot.firstSeq, lastSeq: snapshot.lastSeq, historyTruncated: snapshot.historyTruncated, turnId: binding.turnId, connectionId: input.connectionId }) } }
    } catch (error) {
      binding.invalid = true; binding.observation?.close()
      core.detachEditor(input.connectionId, target, binding.attachment)
      if (bindings.get(sessionId) === binding) core.detachPermissions(input.connectionId, target)
      throw error
    }
  }
  async function dispatch(method: string, params: JsonObject, pinnedCancel: string | null): Promise<JsonObject> {
    if (method === "initialize") {
      if (initialized) throw new AcpError(-32600, "Already initialized")
      checked(() => { if (params.protocolVersion !== 1) throw new Error(); object(params.clientCapabilities ?? {}) })
      const capabilities = await core.acpCapabilities()
      initialized = true
      return { protocolVersion: 1, agentCapabilities: capabilities, authMethods: [], agentInfo: { name: "agency", version: "1" } }
    }
    if (!initialized) throw new AcpError(-32600, "Initialize required")
    if (method === "authenticate") throw new RequestError("INVALID", "Agency sessions do not authenticate")
    if (method === "agency/roster") {
      const cwd = params.cwd === undefined ? undefined : checked(() => absolutePath(params.cwd))
      return json({ state: "agents", handlerGeneration: core.handlerGeneration, agents: (await core.agents()).filter(row => !cwd || row.cwd === cwd) })
    }
    if (method === "agency/backends") return core.backendChoices()
    if (method === "agency/remotes") return json({ hosts: input.remotes?.() ?? [] })
    if (method === "agency/excerpt") {
      const agentId = checked(() => id(params.agentId)), turns = params.turns ?? 4
      if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 1 || turns > 8) throw new RequestError("INVALID", "turns must be an integer from 1 to 8")
      return json(await core.excerpt(agentId, turns))
    }
    if (method === "agency/stop") return json({ state: "agent", agent: await core.stop(checked(() => id(params.agentId))) })
    if (method === "agency/detach") {
      const sessionId = "agency:" + parseLogicalSessionId(params.sessionId), binding = bindings.get(sessionId)
      loads.delete(sessionId)
      if (binding) { detach(binding); bindings.delete(sessionId) }
      return {}
    }
    if (method === "session/list") {
      const cwd = params.cwd === undefined ? undefined : checked(() => absolutePath(params.cwd))
      return { sessions: (await core.agents()).filter(row => !cwd || row.cwd === cwd).map<JsonObject>(row => ({ sessionId: "agency:" + row.agentId, cwd: row.cwd, ...(row.lastActivityAt ? { updatedAt: row.lastActivityAt } : {}), title: row.title ?? "New conversation",
        _meta: { agency: { version: 1, recordVersion: 3, backendId: row.backendId, model: row.live?.model ?? null, phase: row.live ? "ready" : "stopped", nativeSessionId: null, unavailable: false } } })) }
    }
    if (method === "session/new") {
      const cwd = checked(() => absolutePath(params.cwd)), meta = parseAgencyMeta(params, ["commandId", "backendId", "inheritSessionId", "selection", "environment", "editor"])
      const address = editorAddress(meta) ?? null
      if (!Array.isArray(params.mcpServers)) throw new AcpError(-32602, "MCP server list required")
      checked(() => sessionInputs(cwd, params))
      if (meta.backendId !== undefined && meta.inheritSessionId !== undefined) throw new AcpError(-32602, "Ambiguous backend selection")
      let backendId = meta.backendId === undefined ? undefined : checked(() => providerId(meta.backendId))
      if (meta.inheritSessionId !== undefined) {
        const [logical, binding] = requireBinding(meta.inheritSessionId)
        live(logical, binding); backendId = binding.observation!.backendId
      }
      const settings = meta.selection === undefined ? undefined : checked(() => parseRequestedSettings(meta.selection))
      const environment = checked(() => parseLaunchEnvironment(meta.environment ?? input.environment ?? {}))
      const target = await core.create({ cwd, ...(backendId ? { backendId } : {}), ...(settings ? { settings } : {}), environment, nativeParams: params })
      return attach("agency:" + target.agentId, target, address)
    }
    if (method === "session/load") {
      const agentId = parseLogicalSessionId(params.sessionId), cwd = checked(() => absolutePath(params.cwd)), meta = parseAgencyMeta(params, ["editor"]), address = editorAddress(meta) ?? null
      if (!Array.isArray(params.mcpServers)) throw new AcpError(-32602, "MCP server list required")
      checked(() => sessionInputs(cwd, params))
      const logical = "agency:" + agentId, intent = Symbol()
      loads.set(logical, intent)
      const row = (await core.agents()).find(value => value.agentId === agentId)
      if (!row) throw new RequestError("NOT_FOUND", "agent " + agentId + " is not known on this host")
      if (row.cwd !== cwd) throw new AcpError(-32602, "Session directory mismatch")
      const restored = await core.restore(agentId, input.environment ?? {}, params)
      if (closed || loads.get(logical) !== intent) throw new AgentError("STALE_ATTACHMENT")
      return attach(logical, { agentId, handlerGeneration: restored.live!.handlerGeneration, providerGeneration: restored.live!.providerGeneration }, address)
    }
    if (!["session/prompt", "session/cancel", "session/set_model", "session/set_mode", "session/set_config_option"].includes(method)) throw new AcpError(-32601, "Method not found")
    const [logical, binding] = requireBinding(params.sessionId)
    const attachment = binding.attachment
    const promptMeta = method === "session/prompt" ? parseAgencyMeta(params, ["submissionId", "editor"]) : undefined
    const address = promptMeta ? editorAddress(promptMeta) : undefined
    live(logical, binding)
    if (method === "session/cancel") { if (pinnedCancel) await core.cancelTurn(binding.target, pinnedCancel); return {} }
    if (method === "session/prompt") {
      const meta = promptMeta!
      checked(() => { if (!Array.isArray(params.prompt) || !params.prompt.length) throw new Error(); params.prompt.forEach(validateStructuredContent) })
      const prompt = params.prompt as JsonObject[], capabilities = binding.observation!.native.capabilities.promptCapabilities as JsonObject | undefined
      for (const content of prompt) if (content.type === "image" && capabilities?.image !== true || content.type === "audio" && capabilities?.audio !== true || ["resource", "resource_link"].includes(String(content.type)) && capabilities?.embeddedContext !== true) throw new RequestError("INVALID", "the provider does not accept " + String(content.type) + " content")
      const submissionId = meta.submissionId === undefined ? randomUUID() : checked(() => id(meta.submissionId))
      await core.submitAcp(binding.target, { submissionId, prompt, ...(params._meta ? { meta: params._meta as JsonObject } : {}), originConnectionId: input.connectionId, originAttachment: attachment, ...(address === undefined ? {} : { editorAddress: address }) })
      return core.settledAcp(binding.target, submissionId)
    }
    checked(() => {
      if (method === "session/set_model" && typeof params.modelId !== "string" || method === "session/set_mode" && typeof params.modeId !== "string" || method === "session/set_config_option" && (typeof params.configId !== "string" || !Object.hasOwn(params, "value"))) throw new Error()
    })
    return core.setNative(binding.target, method, params)
  }
  return {
    async receive(raw) {
      if (closed) return
      let requestId: RpcId | undefined, method: string | undefined, sessionId: unknown
      const token = Symbol()
      let admitted = false
      try {
        const frame = parseAcpFrame(raw)
        if (typeof frame.method !== "string") {
          if (initialized && Object.hasOwn(frame, "result")) await core.permissionDecision(input.connectionId, frame.id as RpcId, frame.result as JsonObject)
          return
        }
        requestId = frame.id as RpcId | undefined; method = frame.method
        if (requestId !== undefined && pending.has(requestId)) { pending.delete(requestId); throw new AcpError(-32600, "Duplicate pending request ID") }
        if (pending.size >= 64) throw new AcpError(-32600, "Too many pending requests")
        const params = checked(() => object(frame.params ?? {}) as JsonObject)
        sessionId = params.sessionId
        let pinnedCancel: string | null = null
        if (frame.method === "session/cancel") {
          const meta = parseAgencyMeta(params, ["turnId"]), [, binding] = requireBinding(params.sessionId)
          pinnedCancel = meta.turnId === undefined ? binding.turnId : checked(() => id(meta.turnId))
        }
        if (requestId !== undefined) pending.set(requestId, token)
        admitted = true
        const result = await dispatch(frame.method, params, pinnedCancel)
        if (requestId !== undefined && pending.get(requestId) === token) send({ jsonrpc: "2.0", id: requestId, result })
      } catch (error) {
        core.failed("acp " + (method ?? "frame"), typeof sessionId === "string" && sessionId.startsWith("agency:") ? sessionId.slice(7) : undefined, error)
        if (requestId !== undefined && (!admitted || pending.get(requestId) === token)) send(json(liveAcpError(requestId, error)))
      }
      finally { if (requestId !== undefined && pending.get(requestId) === token) pending.delete(requestId) }
    },
    close() { if (closed) return; closed = true; for (const binding of bindings.values()) detach(binding); core.detachEditor(input.connectionId); core.detachPermissions(input.connectionId); bindings.clear(); loads.clear(); pending.clear() },
  }
}