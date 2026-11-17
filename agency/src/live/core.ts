import { randomUUID } from "node:crypto"
import { createPermissionBroker, type PermissionClient } from "../acp/permissions.js"
import { withNativeSession, withoutAgencyMetadata, type ProviderSession } from "../agent/acp.js"
import type { AgentIndex, IndexEntry } from "../agent/agent-index.js"
import { readBackendConfig } from "../agent/backend-config.js"
import { backendChoice } from "../agent/backend-selection.js"
import type { LaunchContract } from "../agent/contracts.js"
import { createConversation, type ConversationListener, type ConversationObservation } from "../agent/conversation.js"
import type { LaunchEnvironment } from "../agent/environment.js"
import type { ConversationExcerpt, RecordedSettings, SessionHomes } from "../agent/excerpt.js"
import { underlyingFailureCode } from "../agent/failure-diagnostics.js"
import { createPermissionArbiter, type PermissionArbiter } from "../agent/permission-arbiter.js"
import { createAgentProcess } from "../agent/process.js"
import type { JsonObject, RequestedSettings, SessionConfiguration } from "../agent/session-config.js"
import { EDITOR_TURN_LIMITS, type AcpObservation, type StopReason } from "../agent/session-events.js"
import type { AcpSubmissionRequest, SubmissionReceipt } from "../agent/turns.js"
import { AgentError, agentFailure, ProviderRequestError, type AgentTuple } from "../agent/types.js"
import { readProfiles } from "../config/providers.js"
import { id, type ProviderId } from "../config/validate.js"
import { ControlError } from "../control/protocol.js"
import type { EventLog } from "../handler/event-log.js"
import type { LiveContext } from "./context.js"
import { configure, settingRequest, unchanged, type SettingRequest } from "./configure.js"
import { createEchoFilter } from "./echo.js"
import { RequestError, requestFailure, type RequestFailure } from "./errors.js"
import { parseHandoffAgent, readHandoff, removeHandoff, staleness, writeHandoff, type HandoffAgent } from "./handoff.js"
import { launchAgent, type LaunchHooks, type LaunchRequest } from "./launch.js"
import { createModelCache, type ModelListing, type ModelSource } from "./models.js"
import { createRoster, currentSettings, liveRow, type RosterRow, type Transcript } from "./roster.js"
import { createLiveTable, type LiveAgent } from "./state.js"
import { stopAgent } from "./stop.js"

export type StartRequest = { agentId: string; backendId?: ProviderId; cwd: string; settings?: RequestedSettings; model?: string; mode?: string; environment: LaunchEnvironment; nativeParams?: JsonObject }
export type PromptResult = { state: "prompt"; agentId: string; submissionId: string; stopReason: StopReason; text: string }
export type LiveObservation = ConversationObservation & { native: ProviderSession; backendId: ProviderId }
export type LiveCoreInput = { context: LiveContext; contracts: readonly LaunchContract[]; index: AgentIndex; homes: SessionHomes; events?: EventLog }
export type HandoffStatus = { fromGeneration: string; agents: string[]; pending: string[]; failed: Array<{ agentId: string } & RequestFailure> }
export type LiveCoreDependencies = { processFactory?: typeof createAgentProcess; modelSource?: ModelSource }
export type LiveCore = {
  readonly handlerGeneration: string
  readonly permissions: PermissionArbiter
  initialize(): Promise<void>
  start(request: StartRequest): Promise<RosterRow>
  launch(request: StartRequest): Promise<LiveAgent>
  liveAgents(): LiveAgent[]
  restore(agentId: string, environment: LaunchEnvironment, nativeParams?: JsonObject): Promise<RosterRow>
  stop(agentId: string): Promise<RosterRow>
  prompt(agentId: string, text: string, environment: LaunchEnvironment, submissionId?: string): Promise<PromptResult>
  cancel(agentId: string): Promise<RosterRow>
  set(agentId: string, setting: string, value: string | boolean): Promise<RosterRow>
  forget(agentId: string): Promise<{ state: "forgotten"; agentId: string }>
  agents(): Promise<RosterRow[]>
  excerpt(agentId: string, turns: number): Promise<ConversationExcerpt>
  transcript(agentId: string): Promise<Transcript>
  models(): Promise<{ state: "models"; defaultBackendId: ProviderId; backends: ModelListing[] }>
  backendChoices(): Promise<JsonObject>
  acpCapabilities(): Promise<JsonObject>
  create(request: Omit<StartRequest, "agentId">): Promise<AgentTuple>
  isLive(target: AgentTuple): boolean
  observe(target: AgentTuple, listener: ConversationListener, configuration: (snapshot: SessionConfiguration) => void): Promise<LiveObservation>
  attachEditor(target: AgentTuple, connectionId: string, address: string | null, token: string): void
  detachEditor(connectionId: string, target?: AgentTuple, token?: string): void
  attachPermissions(target: AgentTuple, client: PermissionClient, current?: () => boolean): Promise<void>
  detachPermissions(connectionId: string, target?: AgentTuple): void
  permissionDecision(connectionId: string, requestId: string | number, result: JsonObject): Promise<boolean>
  submitAcp(target: AgentTuple, request: AcpSubmissionRequest, beforeAccepted?: () => Promise<void>): Promise<SubmissionReceipt>
  settledAcp(target: AgentTuple, submissionId: string): Promise<JsonObject>
  cancelTurn(target: AgentTuple, submissionId: string): Promise<SubmissionReceipt>
  setNative(target: AgentTuple, method: string, params: JsonObject): Promise<JsonObject>
  failed(op: string, agentId: string | undefined, error: unknown): void
  assertOrdinaryShutdownSafe(): void
  freezeIfIdle(): Promise<void>
  freezeAndDrain(stopAgents: boolean): Promise<void>
  prepareHandoff(): Promise<void>
  loadHandoff(): Promise<void>
  resumeHandoff(environment: LaunchEnvironment): Promise<void>
  handoffStatus(): HandoffStatus | null
  resume(): void
  verifyDischarged(): Promise<void>
  close(): void
}

const DROPPED_UPDATES_LOGGED = 20

export function createLiveCore(input: LiveCoreInput, dependencies: LiveCoreDependencies = {}): LiveCore {
  const droppedUpdates = new WeakMap<LiveAgent, number>()
  const { context, events } = input, root = context.paths.persistentRoot, generation = context.state.handlerGeneration
  const table = createLiveTable(), admissions = new Map<string, Promise<void>>(), unverified = new Set<string>(), roster = createRoster({ index: input.index, homes: input.homes })
  const models = createModelCache({ root, ...(dependencies.modelSource ? { source: dependencies.modelSource } : {}) })
  const permissions = createPermissionArbiter({ hostId: context.paths.hostKey, handlerGeneration: generation })
  const broker = createPermissionBroker({ routing: permissions, cwd: target => table.get(target.agentId)?.cwd ?? "/", respond(target, requestId, result) {
    const agent = table.get(target.agentId)
    if (!agent?.owner || agent.phase !== "ready" || agent.tuple.providerGeneration !== target.providerGeneration) throw new AgentError("STALE_ATTACHMENT")
    return agent.owner.respond(requestId, result)
  } })
  permissions.subscribe(event => { if (event.kind === "receipt" && event.receipt.state === "applied") events?.append({ type: "permission_decided", agentId: event.receipt.ref.target.agentId, optionId: event.receipt.optionId }) })
  let frozen = false, closed = false, handingOff = false, handoff: { fromGeneration: string; agents: HandoffAgent[]; pending: Set<string>; failed: Map<string, RequestFailure> } | undefined

  const missing = (agentId: string): RequestError => new RequestError("NOT_FOUND", "agent " + agentId + " is not known on this host")
  const available = (): void => {
    if (closed || frozen || context.shutdownPending()) throw new RequestError("UNAVAILABLE", "the Handler is shutting down")
    if (context.state.phase !== "ready") throw new RequestError("UNAVAILABLE", "the Handler is not ready")
  }
  const known = (agentId: string): LiveAgent => {
    const agent = table.get(id(agentId))
    if (!agent) throw missing(agentId)
    return agent
  }
  const ready = async (agentId: string): Promise<LiveAgent> => {
    const agent = await known(agentId).ready
    if (agent.phase !== "ready") throw new RequestError("UNAVAILABLE", "agent " + agentId + " is stopping")
    return agent
  }
  const bound = (target: AgentTuple): LiveAgent => {
    const agent = table.get(target.agentId)
    if (!agent || agent.phase !== "ready" || target.handlerGeneration !== generation || agent.tuple.providerGeneration !== target.providerGeneration) throw new AgentError("STALE_ATTACHMENT")
    return agent
  }
  const stopping = (agent: LiveAgent, reason: "request" | "failure" | "shutdown"): Promise<void> => {
    if (agent.session) roster.changed(agent.session.sessionId)
    const stopped = stopAgent(agent, { table, permissions: broker, reason, ...(events ? { events } : {}) })
    stopped.catch(() => unverified.add(agent.agentId))
    return stopped
  }
  const verifiedStopped = (agentId: string): void => { if (unverified.has(agentId)) throw new RequestError("UNAVAILABLE", "agent " + agentId + " did not stop cleanly and its provider may still be running; restart the Handler to use it again") }
  async function exclusive<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    const current = (admissions.get(agentId) ?? Promise.resolve()).then(run), tail = current.then(() => undefined, () => undefined)
    admissions.set(agentId, tail)
    void tail.then(() => { if (admissions.get(agentId) === tail) admissions.delete(agentId) })
    return current
  }
  function publish(agent: LiveAgent): void {
    if (agent.phase !== "ready" || !agent.owner) return
    for (const listener of agent.listeners) { try { listener(agent.owner.snapshot()) } catch {} }
  }
  function retain(agent: LiveAgent, event: AcpObservation): void {
    agent.conversation.append({ kind: "update", ...event })
    if (["config_option_update", "current_mode_update"].includes(event.update.sessionUpdate)) publish(agent)
  }
  function indexAgent(agent: LiveAgent): void {
    const sessionId = agent.session?.sessionId
    if (agent.indexed || !sessionId) return
    agent.indexed = true
    void input.index.ensure({ version: 1, agentId: agent.agentId, backendId: agent.backendId, nativeSessionId: sessionId, cwd: agent.cwd, createdAt: agent.createdAt, origin: agent.origin })
      .then(written => { if (written) events?.append({ type: "agent_indexed", agentId: agent.agentId, backendId: agent.backendId }) })
      .catch(error => { agent.indexed = false; events?.append({ type: "agent_index_failed", agentId: agent.agentId, message: String(error).slice(0, 512) }) })
  }
  async function faultOf(agent: LiveAgent): Promise<RequestError | null> {
    const failure = await Promise.race([agent.owner?.fault ?? new Promise<never>(() => {}), new Promise<null>(resolve => setTimeout(() => resolve(null), 250))])
    return failure ? new RequestError("FAILED", "agent " + agent.agentId + " failed" + requestFailure(new AgentError(failure.code, failure.diagnostic)).message.replace(/^[^:]*/, "")) : null
  }

  const hooks: LaunchHooks = {
    update(agent, event) { for (const value of agent.echo.filter(event, agent.phase === "ready")) retain(agent, value) },
    request(agent, message) {
      const params = message.params as JsonObject, toolCall = params.toolCall as JsonObject | undefined
      void Promise.resolve().then(async () => {
        if (agent.phase !== "ready") throw new AgentError("NOT_READY")
        await broker.open(agent.tuple, message.id as string | number, params)
        events?.append({ type: "permission_requested", agentId: agent.agentId, toolCallId: String(toolCall?.toolCallId ?? ""), title: String(toolCall?.title ?? "").slice(0, 256) })
      }).catch(error => hooks.fault(agent, new AgentError(error instanceof AgentError ? error.code : "INTERNAL", { boundary: "permission_request", causeCode: underlyingFailureCode(error) })))
    },
    async validate(agent) {
      available()
      if (agent.phase !== "ready") throw new RequestError("UNAVAILABLE", "agent " + agent.agentId + " is not ready")
      if (agent.configuring) throw new RequestError("BUSY", "agent " + agent.agentId + " is changing a setting")
    },
    invoke(agent, params) {
      const echo = agent.echo.expect(params.prompt as JsonObject[])
      const call = agent.owner!.request("session/prompt", withNativeSession(params, agent.session!.sessionId), agent.controller.signal)
      agent.prompts.add(call)
      return call.finally(() => { agent.prompts.delete(call); for (const event of agent.echo.settle(echo)) retain(agent, event) })
    },
    accepted(agent, request) {
      if (request.originConnectionId && !request.originAttachment) throw new AgentError("STALE_ATTACHMENT")
      agent.editor!.begin(request.submissionId, request.originConnectionId ? { connectionId: request.originConnectionId, attachment: request.originAttachment!, ...(request.editorAddress === undefined ? {} : { address: request.editorAddress }) } : undefined)
      agent.running.add(request.submissionId)
      agent.lastActivityAt = new Date().toISOString()
      indexAgent(agent)
      events?.append({ type: "turn_submitted", agentId: agent.agentId, submissionId: request.submissionId })
    },
    settled(agent, submissionId) {
      agent.editor?.end(submissionId)
      agent.running.delete(submissionId)
      if (!agent.turns?.busy()) broker.invalidate(agent.tuple)
      agent.lastActivityAt = new Date().toISOString()
      const receipt = agent.turns?.inspect(submissionId)
      events?.append({ type: "turn_finished", agentId: agent.agentId, submissionId, stopReason: receipt?.stopReason ?? null, ...(receipt?.failure ? { failure: receipt.failure.code } : {}) })
    },
    cancel(agent) { agent.editor?.revoke(); broker.invalidate(agent.tuple); return agent.owner!.cancelPrompt() },
    dropped(agent, value) {
      const count = (droppedUpdates.get(agent) ?? 0) + 1
      droppedUpdates.set(agent, count)
      if (count <= DROPPED_UPDATES_LOGGED) events?.append({ type: "provider_update_dropped", agentId: agent.agentId, ...value, ...(count === DROPPED_UPDATES_LOGGED ? { further: "suppressed" } : {}) })
    },
    fault(agent, error) {
      if (agent.phase !== "ready") return
      events?.append({ type: "agent_failed", agentId: agent.agentId, ...requestFailure(error) })
      agent.conversation.append({ kind: "lifecycle", phase: "failed", failure: agentFailure(error) })
      void stopping(agent, "failure").catch(() => undefined)
    },
  }
  const launcher = { context, contracts: input.contracts, processFactory: dependencies.processFactory ?? createAgentProcess, hooks }

  const recorded = (entry: IndexEntry): Promise<RecordedSettings> => roster.recorded(entry).catch(() => ({ model: null, mode: null }))
  async function resolvedAlias(agent: LiveAgent, recorded: string): Promise<string | null> {
    const matches = (await models.list(agent.backendId)).models.filter(model => model.resolvedModelId === recorded && model.modelId !== recorded)
    return (matches.find(model => model.modelId !== "default") ?? matches[0])?.modelId ?? null
  }
  async function reapply(agent: LiveAgent, wanted: RecordedSettings): Promise<void> {
    const apply = async (setting: "model" | "mode", value: string): Promise<void> => {
      const request = settingRequest(agent, setting, value)
      if (!unchanged(agent, request)) await configure(agent, request, { publish, ...(events ? { events } : {}) })
    }
    for (const setting of ["model", "mode"] as const) {
      const value = wanted[setting]
      if (value === null) continue
      try {
        try { await apply(setting, value) }
        catch (error) {
          const alias = setting === "model" && error instanceof RequestError && error.code === "INVALID" ? await resolvedAlias(agent, value) : null
          if (alias === null) throw error
          await apply(setting, alias)
        }
      } catch (error) { events?.append({ type: "setting_not_restored", agentId: agent.agentId, setting, value, ...requestFailure(error) }) }
    }
  }
  function admit(agentId: string, identity: { backendId: ProviderId; cwd: string; origin: "new" | "import"; createdAt: string; indexed: boolean; title: string | null; lastActivityAt: string | null }, request: LaunchRequest, kind: "started" | "restored", wanted?: Promise<RecordedSettings>): LiveAgent {
    const tuple = { agentId, handlerGeneration: generation, providerGeneration: randomUUID() }
    const agent: LiveAgent = { agentId, ...identity, tuple, phase: "starting", launched: Promise.resolve(), ready: Promise.resolve(undefined as never), controller: new AbortController(), conversation: createConversation(tuple), echo: createEchoFilter(), running: new Set(), prompts: new Set(), configuring: 0, listeners: new Set() }
    agent.launched = launchAgent(agent, request, launcher)
    agent.ready = agent.launched.then(async () => {
      if (wanted) await reapply(agent, await wanted)
      if (agent.controller.signal.aborted) throw new RequestError("FAILED", "agent " + agentId + " was stopped before it was ready")
      models.observe(agent.backendId, agent.contract!.modelOption, agent.session!.configuration)
      events?.append({ type: "agent_" + kind, agentId, backendId: agent.backendId, cwd: agent.cwd })
      return agent
    }).catch(async error => {
      const failure = agent.controller.signal.aborted && !(error instanceof RequestError) ? new RequestError("FAILED", "agent " + agentId + " was stopped before it was ready") : error
      await stopping(agent, "failure").catch(() => undefined)
      throw failure
    })
    void agent.ready.catch(() => undefined)
    table.add(agent)
    return agent
  }
  async function revive(agentId: string, environment: LaunchEnvironment, nativeParams?: JsonObject, wanted?: RecordedSettings): Promise<LiveAgent> {
    const agent = await exclusive(id(agentId), async () => {
      available()
      const current = table.get(agentId)
      if (current && current.phase !== "stopping") return current
      await current?.stopped?.catch(() => undefined)
      verifiedStopped(agentId)
      const entry = await roster.entry(agentId)
      if (!entry) throw missing(agentId)
      if (!await roster.sessionPath(entry)) throw new RequestError("NOT_FOUND", "agent " + agentId + " cannot be restored: its " + entry.backendId + " session file is missing")
      return admit(agentId, { backendId: entry.backendId, cwd: entry.cwd, origin: entry.origin, createdAt: entry.createdAt, indexed: true, ...await roster.history(entry) }, { backendId: entry.backendId, cwd: entry.cwd, environment, ...(nativeParams ? { nativeParams } : {}), restore: { nativeSessionId: entry.nativeSessionId } }, "restored", wanted ? Promise.resolve(wanted) : recorded(entry))
    })
    return agent.ready
  }
  const row = async (agent: LiveAgent): Promise<RosterRow> => await roster.row(table, agent.agentId) ?? liveRow(table, agent)
  function launch(request: StartRequest): Promise<LiveAgent> {
    return exclusive(id(request.agentId), async () => {
      available()
      const current = table.get(request.agentId)
      if (current && current.phase !== "stopping") return current
      await current?.stopped?.catch(() => undefined)
      verifiedStopped(request.agentId)
      const entry = await roster.entry(request.agentId)
      if (entry && (request.backendId && entry.backendId !== request.backendId || entry.cwd !== request.cwd)) throw new RequestError("INVALID", "agent " + entry.agentId + " already exists with backend " + entry.backendId + " in " + entry.cwd)
      if (entry) return admit(entry.agentId, { backendId: entry.backendId, cwd: entry.cwd, origin: entry.origin, createdAt: entry.createdAt, indexed: true, ...await roster.history(entry) }, { backendId: entry.backendId, cwd: entry.cwd, environment: request.environment, restore: { nativeSessionId: entry.nativeSessionId } }, "restored", recorded(entry))
      const backendId = request.backendId ?? (await readBackendConfig(root)).defaultBackendId
      return admit(request.agentId, { backendId, cwd: request.cwd, origin: "new", createdAt: new Date().toISOString(), indexed: false, title: null, lastActivityAt: null }, { ...request, backendId }, "started")
    })
  }
  async function start(request: StartRequest): Promise<RosterRow> {
    const agent = await (await launch(request)).ready
    if (request.backendId && agent.backendId !== request.backendId || agent.cwd !== request.cwd) throw new RequestError("INVALID", "agent " + agent.agentId + " already exists with backend " + agent.backendId + " in " + agent.cwd)
    return row(agent)
  }
  async function enabled() {
    const config = await readBackendConfig(root), profiles = await readProfiles(root)
    return { config, backends: config.backends.flatMap(backend => {
      const contract = input.contracts.find(value => value.id === backend.compatibilityId && value.providerId === backend.id)
      return contract && profiles.some(profile => profile.id === backend.id && profile.enabled) ? [{ backend, contract }] : []
    }) }
  }
  function ordinary(): void { if (table.all().length || admissions.size) throw new ControlError("ACTIVE_AGENTS", "agents are live: " + table.all().map(agent => agent.agentId).join(", ")) }

  return {
    handlerGeneration: generation, permissions, start, launch,
    liveAgents: () => table.all(),
    async initialize() { void roster.rows(table).catch(() => undefined) },
    async restore(agentId, environment, nativeParams) { return row(await revive(agentId, environment, nativeParams)) },
    async stop(agentId) {
      const agent = table.get(id(agentId))
      if (agent) await stopping(agent, "request")
      const stopped = await roster.row(table, agentId)
      if (stopped) return stopped
      if (agent) return { ...liveRow(table, agent), live: null }
      throw missing(agentId)
    },
    async prompt(agentId, text, environment, submissionId = randomUUID()) {
      const current = table.get(id(agentId))
      const agent = current && current.phase !== "stopping" ? await ready(agentId) : await revive(agentId, environment)
      await agent.turns!.submit({ submissionId: id(submissionId), text, limits: EDITOR_TURN_LIMITS })
      try {
        const result = await agent.turns!.settled(submissionId)
        return { state: "prompt", agentId, submissionId, stopReason: result.stopReason, text: result.text }
      } catch (error) {
        const refusal = await agent.turns!.settledAcp(submissionId).then(() => null, native => native instanceof ProviderRequestError ? native : null)
        throw refusal ?? await faultOf(agent) ?? error
      }
    },
    async cancel(agentId) {
      const agent = await ready(agentId)
      for (const submissionId of agent.running) await agent.turns!.cancel(submissionId)
      return row(agent)
    },
    async set(agentId, setting, value) {
      const agent = await ready(agentId), request = settingRequest(agent, setting, value)
      if (!unchanged(agent, request)) await configure(agent, request, { publish, ...(events ? { events } : {}) })
      return row(agent)
    },
    forget(agentId) {
      return exclusive(id(agentId), async () => {
        if (table.get(agentId)) throw new RequestError("INVALID", "agent " + agentId + " is live; stop it before forgetting it")
        if (!await roster.entry(agentId)) throw missing(agentId)
        await input.index.remove(agentId)
        events?.append({ type: "agent_forgotten", agentId })
        return { state: "forgotten" as const, agentId }
      })
    },
    agents: () => roster.rows(table),
    async excerpt(agentId, turns) { const excerpt = await roster.excerpt(table, id(agentId), turns); if (!excerpt) throw missing(agentId); return excerpt },
    async transcript(agentId) { const transcript = await roster.transcript(id(agentId)); if (!transcript) throw missing(agentId); return transcript },
    async models() {
      const { config, backends } = await enabled()
      return { state: "models", defaultBackendId: config.defaultBackendId, backends: await Promise.all(backends.map(({ backend }) => models.list(backend.id))) }
    },
    async backendChoices() {
      const { config, backends } = await enabled()
      return { defaultBackendId: config.defaultBackendId, backends: await Promise.all(backends.map(async ({ backend, contract }) => backendChoice(backend, contract, await models.list(backend.id)))) }
    },
    async acpCapabilities() {
      const capabilities = { image: false, audio: false, embeddedContext: false }
      try { for (const { contract } of (await enabled()).backends) for (const key of ["image", "audio", "embeddedContext"] as const) capabilities[key] ||= contract.promptCapabilities?.[key] === true } catch {}
      return { loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: capabilities }
    },
    async create(request) {
      const created = await start({ ...request, agentId: randomUUID() })
      return { agentId: created.agentId, handlerGeneration: created.live!.handlerGeneration, providerGeneration: created.live!.providerGeneration }
    },
    isLive(target) { try { bound(target); return true } catch { return false } },
    async observe(target, listener, configuration) {
      const agent = bound(target), observation = agent.conversation.observe(listener)
      agent.listeners.add(configuration)
      return { ...observation, native: { ...structuredClone(agent.session!), configuration: agent.owner!.snapshot() }, backendId: agent.backendId, close() { observation.close(); agent.listeners.delete(configuration) } }
    },
    attachEditor(target, connectionId, address, token) { bound(target).editor!.attach(connectionId, address, token) },
    detachEditor(connectionId, target, token) { for (const agent of table.all()) if (!target || agent.agentId === target.agentId && agent.tuple.providerGeneration === target.providerGeneration) agent.editor?.detach(connectionId, token) },
    async attachPermissions(target, client, current) { bound(target); if (current && !current()) throw new AgentError("STALE_ATTACHMENT"); broker.attach(target, client) },
    detachPermissions: (connectionId, target) => broker.detach(connectionId, target),
    permissionDecision: (connectionId, requestId, result) => broker.decision(connectionId, requestId, result),
    async submitAcp(target, request, beforeAccepted) { return bound(target).turns!.submitAcp(request, beforeAccepted) },
    async settledAcp(target, submissionId) { const agent = bound(target); try { return await agent.turns!.settledAcp(submissionId) } catch (error) { throw await faultOf(agent) ?? error } },
    async cancelTurn(target, submissionId) { return bound(target).turns!.cancel(submissionId) },
    async setNative(target, method, params) {
      if (!["session/set_config_option", "session/set_model", "session/set_mode"].includes(method)) throw new RequestError("INVALID", "unsupported setting method " + method)
      return configure(bound(target), { method: method as SettingRequest["method"], params: withoutAgencyMetadata(params) }, { publish, ...(events ? { events } : {}) })
    },
    failed(op, agentId, error) { events?.append({ type: "request_failed", op, ...(agentId ? { agentId } : {}), ...requestFailure(error) }) },
    assertOrdinaryShutdownSafe: ordinary,
    async freezeIfIdle() {
      const busy = table.busy()
      if (busy.length || admissions.size) throw new ControlError("BUSY", busy.length ? "agents still working: " + busy.join(", ") : "an agent is starting")
      frozen = true
    },
    async freezeAndDrain(stopAgents) {
      if (!stopAgents) { ordinary(); frozen = true; return }
      frozen = true
      await Promise.all([...admissions.values()])
      await Promise.allSettled(table.all().map(agent => stopping(agent, "shutdown")))
      if (table.all().length) throw new AgentError("INCOMPLETE")
    },
    async prepareHandoff() {
      const bootId = await context.adapter.bootId(), agents: HandoffAgent[] = []
      for (const agent of table.all().filter(value => value.phase === "ready" && value.indexed)) {
        try { agents.push(parseHandoffAgent({ agentId: agent.agentId, backendId: agent.backendId, nativeSessionId: agent.session?.sessionId, cwd: agent.cwd, createdAt: agent.createdAt, origin: agent.origin, ...currentSettings(agent) })) }
        catch (error) { events?.append({ type: "handoff_entry_skipped", agentId: agent.agentId, reason: error instanceof Error ? error.message : String(error) }) }
      }
      await writeHandoff(root, { version: 1, handlerGeneration: generation, bootId, writtenAt: new Date().toISOString(), agents })
      handingOff = true
      events?.append({ type: "handoff_written", agents: agents.map(agent => agent.agentId) })
    },
    async loadHandoff() {
      let read
      try { read = await readHandoff(root) } catch (error) {
        events?.append({ type: "handoff_unreadable", message: String(error).slice(0, 512) })
        await removeHandoff(root)
        return
      }
      if (!read) return
      await removeHandoff(root)
      const stale = staleness(read.handoff, await context.adapter.bootId(), Date.now())
      if (stale) { events?.append({ type: "handoff_ignored", fromGeneration: read.handoff.handlerGeneration, reason: stale }); return }
      for (const item of read.dropped) events?.append({ type: "handoff_entry_dropped", index: item.index, reason: item.reason })
      for (const agent of read.handoff.agents) {
        try { await input.index.ensure({ version: 1, agentId: agent.agentId, backendId: agent.backendId, nativeSessionId: agent.nativeSessionId, cwd: agent.cwd, createdAt: agent.createdAt, origin: agent.origin }) }
        catch (error) { events?.append({ type: "handoff_index_failed", agentId: agent.agentId, message: String(error).slice(0, 512) }) }
      }
      handoff = { fromGeneration: read.handoff.handlerGeneration, agents: read.handoff.agents, pending: new Set(read.handoff.agents.map(agent => agent.agentId)), failed: new Map() }
    },
    async resumeHandoff(environment) {
      const current = handoff
      if (!current) return
      await Promise.all(current.agents.map(async item => {
        try {
          await revive(item.agentId, environment, undefined, { model: item.model, mode: item.mode })
          events?.append({ type: "handoff_restored", agentId: item.agentId, fromGeneration: current.fromGeneration })
        } catch (error) {
          current.failed.set(item.agentId, requestFailure(error))
          events?.append({ type: "handoff_restore_failed", agentId: item.agentId, ...requestFailure(error) })
        } finally { current.pending.delete(item.agentId) }
      }))
    },
    handoffStatus() {
      if (!handoff) return null
      return { fromGeneration: handoff.fromGeneration, agents: handoff.agents.map(agent => agent.agentId), pending: [...handoff.pending], failed: [...handoff.failed].map(([agentId, failure]) => ({ agentId, ...failure })) }
    },
    resume() {
      if (closed) return
      frozen = false
      if (!handingOff) return
      handingOff = false
      void removeHandoff(root).catch(() => undefined)
    },
    async verifyDischarged() { if (table.all().length || admissions.size) throw new AgentError("INCOMPLETE") },
    close() {
      closed = frozen = true
      permissions.close()
      for (const agent of table.all()) { agent.controller.abort(); agent.editor?.close(); agent.turns?.close(null); agent.owner?.dispose(); agent.conversation.close() }
    },
  }
}