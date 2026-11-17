import { randomUUID } from "node:crypto"
import { createPermissionBroker } from "../acp/permissions.js"
import { withNativeSession } from "../agent/acp.js"
import type { AgentIndex } from "../agent/agent-index.js"
import { readBackendConfig } from "../agent/backend-config.js"
import type { LaunchContract } from "../agent/contracts.js"
import { createConversation } from "../agent/conversation.js"
import type { LaunchEnvironment } from "../agent/environment.js"
import type { ConversationExcerpt, SessionHomes } from "../agent/excerpt.js"
import { underlyingFailureCode } from "../agent/failure-diagnostics.js"
import { createPermissionArbiter, type PermissionArbiter } from "../agent/permission-arbiter.js"
import { createAgentProcess } from "../agent/process.js"
import type { JsonObject, RequestedSettings } from "../agent/session-config.js"
import { EDITOR_TURN_LIMITS, type StopReason } from "../agent/session-events.js"
import { AgentError, agentFailure } from "../agent/types.js"
import { id, type ProviderId } from "../catalog/types.js"
import { ControlError } from "../control/protocol.js"
import type { EventLog } from "../handler/event-log.js"
import type { LaunchContext } from "../handler/launch-transitions.js"
import { RequestError, requestFailure } from "./errors.js"
import { launchAgent, type LaunchHooks, type LaunchRequest } from "./launch.js"
import { createRoster, liveRow, type RosterRow, type Transcript } from "./roster.js"
import { createLiveTable, type LiveAgent } from "./state.js"
import { stopAgent } from "./stop.js"

export type StartRequest = { agentId: string; backendId?: ProviderId; cwd: string; settings?: RequestedSettings; model?: string; mode?: string; environment: LaunchEnvironment; nativeParams?: JsonObject }
export type PromptResult = { state: "prompt"; agentId: string; submissionId: string; stopReason: StopReason; text: string }
export type LiveCoreInput = { context: LaunchContext; contracts: readonly LaunchContract[]; index: AgentIndex; homes: SessionHomes; events?: EventLog }
export type LiveCoreDependencies = { processFactory?: typeof createAgentProcess }
export type LiveCore = {
  readonly handlerGeneration: string
  readonly permissions: PermissionArbiter
  initialize(): Promise<void>
  start(request: StartRequest): Promise<RosterRow>
  restore(agentId: string, environment: LaunchEnvironment, nativeParams?: JsonObject): Promise<RosterRow>
  stop(agentId: string): Promise<RosterRow>
  prompt(agentId: string, text: string, environment: LaunchEnvironment, submissionId?: string): Promise<PromptResult>
  cancel(agentId: string): Promise<RosterRow>
  forget(agentId: string): Promise<{ state: "forgotten"; agentId: string }>
  agents(): Promise<RosterRow[]>
  excerpt(agentId: string, turns: number): Promise<ConversationExcerpt>
  transcript(agentId: string): Promise<Transcript>
  failed(op: string, agentId: string | undefined, error: unknown): void
  assertOrdinaryShutdownSafe(): void
  freezeIfIdle(): Promise<void>
  freezeAndDrain(stopAgents: boolean): Promise<void>
  resume(): void
  verifyDischarged(): Promise<void>
  close(): void
}

export function createLiveCore(input: LiveCoreInput, dependencies: LiveCoreDependencies = {}): LiveCore {
  const { context, events } = input, root = context.paths.persistentRoot, generation = context.state.handlerGeneration
  const table = createLiveTable(), admissions = new Map<string, Promise<void>>(), roster = createRoster({ index: input.index, homes: input.homes })
  const permissions = createPermissionArbiter({ hostId: context.paths.hostKey, handlerGeneration: generation })
  const broker = createPermissionBroker({ routing: permissions, cwd: target => table.get(target.agentId)?.cwd ?? "/", respond(target, requestId, result) {
    const agent = table.get(target.agentId)
    if (!agent?.owner || agent.phase !== "ready" || agent.tuple.providerGeneration !== target.providerGeneration) throw new AgentError("STALE_ATTACHMENT")
    return agent.owner.respond(requestId, result)
  } })
  let frozen = false, closed = false

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
  const stopping = (agent: LiveAgent, reason: "request" | "failure" | "shutdown"): Promise<void> => {
    if (agent.session) roster.changed(agent.session.sessionId)
    return stopAgent(agent, { table, permissions: broker, reason, ...(events ? { events } : {}) })
  }
  async function exclusive<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    const current = (admissions.get(agentId) ?? Promise.resolve()).then(run), tail = current.then(() => undefined, () => undefined)
    admissions.set(agentId, tail)
    void tail.then(() => { if (admissions.get(agentId) === tail) admissions.delete(agentId) })
    return current
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
    update(agent, event) { agent.conversation.append({ kind: "update", ...event }) },
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
      const call = agent.owner!.request("session/prompt", withNativeSession(params, agent.session!.sessionId), agent.controller.signal)
      agent.prompts.add(call)
      return call.finally(() => { agent.prompts.delete(call) })
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
    fault(agent, error) {
      if (agent.phase !== "ready") return
      events?.append({ type: "agent_failed", agentId: agent.agentId, ...requestFailure(error) })
      agent.conversation.append({ kind: "lifecycle", phase: "failed", failure: agentFailure(error) })
      void stopping(agent, "failure").catch(() => undefined)
    },
  }
  const launcher = { context, contracts: input.contracts, processFactory: dependencies.processFactory ?? createAgentProcess, hooks }

  function admit(agentId: string, identity: { backendId: ProviderId; cwd: string; origin: "new" | "import"; createdAt: string; indexed: boolean }, request: LaunchRequest, kind: "started" | "restored"): LiveAgent {
    const tuple = { agentId, handlerGeneration: generation, providerGeneration: randomUUID() }
    const agent: LiveAgent = { agentId, ...identity, tuple, phase: "starting", launched: Promise.resolve(), ready: Promise.resolve(undefined as never), controller: new AbortController(), conversation: createConversation(tuple), running: new Set(), prompts: new Set(), configuring: 0, listeners: new Set(), lastActivityAt: null }
    agent.launched = launchAgent(agent, request, launcher)
    agent.ready = agent.launched.then(() => {
      events?.append({ type: "agent_" + kind, agentId, backendId: agent.backendId, cwd: agent.cwd })
      return agent
    }, async error => {
      const failure = agent.controller.signal.aborted && !(error instanceof RequestError) ? new RequestError("FAILED", "agent " + agentId + " was stopped before it was ready") : error
      await stopping(agent, "failure").catch(() => undefined)
      throw failure
    })
    void agent.ready.catch(() => undefined)
    table.add(agent)
    return agent
  }
  async function revive(agentId: string, environment: LaunchEnvironment, nativeParams?: JsonObject): Promise<LiveAgent> {
    const agent = await exclusive(id(agentId), async () => {
      available()
      const current = table.get(agentId)
      if (current && current.phase !== "stopping") return current
      await current?.stopped?.catch(() => undefined)
      const entry = await roster.entry(agentId)
      if (!entry) throw missing(agentId)
      if (!await roster.sessionPath(entry)) throw new RequestError("NOT_FOUND", "agent " + agentId + " cannot be restored: its " + entry.backendId + " session file is missing")
      return admit(agentId, { backendId: entry.backendId, cwd: entry.cwd, origin: entry.origin, createdAt: entry.createdAt, indexed: true }, { backendId: entry.backendId, cwd: entry.cwd, environment, ...(nativeParams ? { nativeParams } : {}), restore: { nativeSessionId: entry.nativeSessionId } }, "restored")
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
      const entry = await roster.entry(request.agentId)
      if (entry && (request.backendId && entry.backendId !== request.backendId || entry.cwd !== request.cwd)) throw new RequestError("INVALID", "agent " + entry.agentId + " already exists with backend " + entry.backendId + " in " + entry.cwd)
      if (entry) return admit(entry.agentId, { backendId: entry.backendId, cwd: entry.cwd, origin: entry.origin, createdAt: entry.createdAt, indexed: true }, { backendId: entry.backendId, cwd: entry.cwd, environment: request.environment, restore: { nativeSessionId: entry.nativeSessionId } }, "restored")
      const backendId = request.backendId ?? (await readBackendConfig(root)).defaultBackendId
      return admit(request.agentId, { backendId, cwd: request.cwd, origin: "new", createdAt: new Date().toISOString(), indexed: false }, { ...request, backendId }, "started")
    })
  }
  async function start(request: StartRequest): Promise<RosterRow> {
    const agent = await (await launch(request)).ready
    if (request.backendId && agent.backendId !== request.backendId || agent.cwd !== request.cwd) throw new RequestError("INVALID", "agent " + agent.agentId + " already exists with backend " + agent.backendId + " in " + agent.cwd)
    return row(agent)
  }
  function ordinary(): void { if (table.all().length || admissions.size) throw new ControlError("ACTIVE_AGENTS", "agents are live: " + table.all().map(agent => agent.agentId).join(", ")) }

  return {
    handlerGeneration: generation, permissions, start,
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
      } catch (error) { throw await faultOf(agent) ?? error }
    },
    async cancel(agentId) {
      const agent = await ready(agentId)
      for (const submissionId of agent.running) await agent.turns!.cancel(submissionId)
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
    resume() { if (!closed) frozen = false },
    async verifyDischarged() { if (table.all().length || admissions.size) throw new AgentError("INCOMPLETE") },
    close() {
      closed = frozen = true
      permissions.close()
      for (const agent of table.all()) { agent.controller.abort(); agent.editor?.close(); agent.turns?.close(null); agent.owner?.dispose(); agent.conversation.close() }
    },
  }
}