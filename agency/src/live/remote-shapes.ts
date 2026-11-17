import { randomUUID } from "node:crypto"
import { destinationEnvironment, launchEnvironmentDigest, type LaunchEnvironment } from "../agent/environment.js"
import { isRuntimeHumanRequest, dispatchRuntimeHuman } from "../agent/human-controls.js"
import { AGENT_PROTOCOL, agentErrorReply, commandIdFor, type AgentReply, type AgentRequest } from "../agent/protocol.js"
import { inventoryPage, type PageInput } from "../agent/queries.js"
import type { AgentService, CreateSessionInput } from "../agent/service.js"
import { nonRestorableOptionIds, projectRestorableSettings } from "../agent/session-config.js"
import { dispatchRuntimeSession, isRuntimeSessionRequest } from "../agent/session-controls.js"
import { EDITOR_TURN_LIMITS } from "../agent/session-events.js"
import { sessionInputs } from "../agent/session-inputs.js"
import { AgentError, agentFailure, parseAgentRecordV3, requestedSettingsDigest, type AgentCommandV3, type AgentErrorCode, type AgentTuple, type AgentView, type CommandView, type StopInput } from "../agent/types.js"
import { digest } from "../catalog/config.js"
import type { LiveCore } from "./core.js"
import { RequestError } from "./errors.js"
import type { LiveAgent } from "./state.js"

export type RemoteShapes = Pick<AgentService, "roster" | "permissions" | "excerpt" | "beginSession" | "sessionRecord" | "commandReceipt" | "submit" | "submission" | "cancel" | "stop">

const legacyCodes: Record<RequestError["code"], AgentErrorCode> = { NOT_FOUND: "UNAVAILABLE", BUSY: "BUSY", INVALID: "INVALID_PROTOCOL", UNAVAILABLE: "UNAVAILABLE", FAILED: "STARTUP_FAILED" }
export const legacyError = (error: unknown): unknown => error instanceof RequestError ? new AgentError(legacyCodes[error.code]) : error

export function agentView(agent: LiveAgent): AgentView | null {
  if (!agent.record) return null
  const launch = agent.owner ? agent.owner.record() : null
  if (launch && ["cleanup_verified", "quarantined"].includes(launch.phase) || !launch && agent.phase !== "starting") return null
  let snapshot
  try { snapshot = agent.session && agent.owner ? agent.owner.snapshot() : null } catch { snapshot = null }
  const display = agent.conversation.display()
  const record = parseAgentRecordV3({ ...agent.record, phase: agent.phase === "ready" ? "ready" : agent.phase === "stopping" ? "stopping" : agent.record.phase,
    session: agent.session ? { sessionId: agent.session.sessionId, protocolVersion: 1 } : agent.record.session, settings: snapshot ? projectRestorableSettings(snapshot) : agent.record.settings,
    configurationState: { verification: { kind: snapshot ? "verified" : "unknown" }, nonRestorableOptionIds: snapshot ? nonRestorableOptionIds(snapshot) : [] },
    ...(agent.lastActivityAt ? { lastActivityAt: agent.lastActivityAt } : {}), ...(display.title ? { title: display.title } : {}) })
  return { display, record, launch, live: true, cleanup: launch ? "unverified" : "not_launched", unavailable: null }
}

export function createRemoteShapes(core: LiveCore, hostId: string): RemoteShapes {
  const generation = core.handlerGeneration, commands = new Map<string, AgentCommandV3>()
  let revision = randomUUID(), fingerprint = ""
  const view = (command: AgentCommandV3): CommandView => ({ state: "command", command: structuredClone(command), durability: "verified" })
  const agentFor = (target: AgentTuple): LiveAgent => {
    if (target.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
    const agent = core.liveAgents().find(value => value.agentId === target.agentId)
    if (!agent) throw new AgentError("UNAVAILABLE")
    if (agent.tuple.providerGeneration !== target.providerGeneration) throw new AgentError("STALE_PROVIDER")
    if (agent.phase !== "ready") throw new AgentError("NOT_READY")
    return agent
  }
  const settle = (command: AgentCommandV3, outcome: Promise<{ session: string | null }>, success: "started" | "stopped"): void => {
    void outcome.then(({ session }) => { commands.set(command.commandId, { ...command, state: "completed", result: { outcome: success, target: command.target, failure: null, session: session ? { sessionId: session, protocolVersion: 1 } : null } }) },
      error => { commands.set(command.commandId, { ...command, state: "completed", result: { outcome: "failed", target: command.target, failure: agentFailure(legacyError(error)), session: null } }) })
  }
  return {
    permissions: core.permissions,
    async roster(input: PageInput) {
      const agents = core.liveAgents().flatMap(agent => { const value = agentView(agent); return value ? [value] : [] })
      const next = digest(JSON.stringify(agents))
      if (next !== fingerprint) { fingerprint = next; revision = randomUUID() }
      return inventoryPage({ revision, agents, issues: [] }, { ...input, activeOnly: true })
    },
    async excerpt(input) { try { return await core.excerpt(input.agentId, input.turns) } catch (error) { throw legacyError(error) } },
    async beginSession(input: CreateSessionInput) {
      const existing = commands.get(input.commandId)
      if (existing) return view(existing)
      const { names } = sessionInputs(input.cwd, input.nativeParams)
      let agent: LiveAgent
      try { agent = await core.launch({ agentId: randomUUID(), cwd: input.cwd, ...(input.backendId ? { backendId: input.backendId } : {}), ...(input.selection ? { settings: input.selection } : {}), environment: input.environment, nativeParams: input.nativeParams }) }
      catch (error) { throw legacyError(error) }
      const command: AgentCommandV3 = { version: 3, hostId, commandId: input.commandId, handlerGeneration: generation, op: "start", input: { cwd: input.cwd, backendId: agent.backendId, selectionDigest: requestedSettingsDigest(input.selection ?? {}), environmentDigest: launchEnvironmentDigest(input.environment), mcpServerNames: names }, agentId: agent.agentId, target: agent.tuple, state: "pending", result: null }
      commands.set(command.commandId, command)
      settle(command, agent.ready.then(ready => ({ session: ready.session?.sessionId ?? null })), "started")
      return view(command)
    },
    async sessionRecord(agentId) { const agent = core.liveAgents().find(value => value.agentId === agentId); return agent ? agentView(agent) : null },
    async commandReceipt(commandId, expectedGeneration) {
      const command = commands.get(commandId)
      if (!command) return null
      if (command.handlerGeneration !== expectedGeneration) throw new AgentError("COMMAND_CONFLICT")
      return view(command)
    },
    async submit(target, request) { return agentFor(target).turns!.submit({ ...request, limits: EDITOR_TURN_LIMITS }) },
    async submission(target, submissionId) { return agentFor(target).turns!.inspect(submissionId) },
    async cancel(target, submissionId) { return agentFor(target).turns!.cancel(submissionId) },
    async stop(input: StopInput) {
      const existing = commands.get(input.commandId)
      if (existing) return view(existing)
      const target = { agentId: input.agentId, handlerGeneration: input.handlerGeneration, providerGeneration: input.providerGeneration }
      const agent = agentFor(target), session = agent.session?.sessionId ?? null
      const command: AgentCommandV3 = { version: 3, hostId, commandId: input.commandId, handlerGeneration: generation, op: "stop", input: { target }, agentId: input.agentId, target, state: "pending", result: null }
      commands.set(command.commandId, command)
      settle(command, core.stop(input.agentId).then(() => ({ session })), "stopped")
      return view(command)
    },
  }
}

export async function dispatchRemoteRequest(input: { shapes: RemoteShapes; generation: string; ready(): boolean; environment?(): LaunchEnvironment; failed?(op: string, agentId: string | undefined, error: unknown): void }, request: AgentRequest): Promise<AgentReply> {
  const bound = { ...request, handlerGeneration: input.generation }
  if (request.handlerGeneration !== input.generation) return agentErrorReply(bound, new AgentError("STALE_HANDLER"))
  if (!input.ready()) return agentErrorReply(bound, new AgentError("NOT_READY"))
  try {
    if (!isRuntimeHumanRequest(request) && !isRuntimeSessionRequest(request)) throw new AgentError("INVALID_PROTOCOL")
    const result = isRuntimeHumanRequest(request) ? await dispatchRuntimeHuman(input.shapes, request) : await dispatchRuntimeSession(input.shapes, request, input.environment ?? (() => destinationEnvironment(process.env)))
    const commandId = commandIdFor(request)
    return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: input.generation, ...(commandId ? { commandId } : {}), ok: true, result }
  } catch (error) {
    const target = "target" in request ? request.target.agentId : "input" in request && "agentId" in request.input ? request.input.agentId : "agentId" in request ? request.agentId : undefined
    input.failed?.("remote " + request.op, typeof target === "string" ? target : undefined, error)
    return agentErrorReply(bound, legacyError(error))
  }
}