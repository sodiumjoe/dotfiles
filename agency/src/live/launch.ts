import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { backendFingerprint, mergeBackendEnvironment, readBackendConfig } from "../agent/backend-config.js"
import { namedSettings } from "../agent/backend-selection.js"
import { configureLaunchContract, parseLaunchContract, type LaunchContract } from "../agent/contracts.js"
import { startEditorRouting } from "../agent/editor-routing.js"
import type { LaunchEnvironment } from "../agent/environment.js"
import type { createAgentProcess } from "../agent/process.js"
import { parseRequestedSettings, type JsonObject, type RequestedSettings } from "../agent/session-config.js"
import type { DroppedUpdate } from "../agent/acp.js"
import type { AcpObservation } from "../agent/session-events.js"
import { sessionInputs } from "../agent/session-inputs.js"
import { createTurnCoordinator, type AcpSubmissionRequest } from "../agent/turns.js"
import { AGENT_LIMITS, AgentError, ownedRecord, parseAgentRecordV3 } from "../agent/types.js"
import { digest, readProfiles } from "../catalog/config.js"
import type { ConfigEvidence, ProviderId, ProviderProfile } from "../catalog/types.js"
import type { LiveContext } from "./context.js"
import { RequestError } from "./errors.js"
import type { LiveAgent } from "./state.js"

export type LaunchRequest = { backendId?: ProviderId; cwd: string; settings?: RequestedSettings; model?: string; mode?: string; environment: LaunchEnvironment; nativeParams?: JsonObject; restore?: { nativeSessionId: string } }
export type LaunchHooks = {
  update(agent: LiveAgent, event: AcpObservation): void
  request(agent: LiveAgent, message: JsonObject): void
  dropped(agent: LiveAgent, value: DroppedUpdate): void
  validate(agent: LiveAgent): Promise<void>
  invoke(agent: LiveAgent, params: JsonObject): Promise<JsonObject>
  accepted(agent: LiveAgent, request: AcpSubmissionRequest): void
  settled(agent: LiveAgent, submissionId: string): void
  cancel(agent: LiveAgent): Promise<void>
  fault(agent: LiveAgent, error: AgentError): void
}
export type Launcher = { context: LiveContext; contracts: readonly LaunchContract[]; processFactory: typeof createAgentProcess; hooks: LaunchHooks }

async function packageVersion(path: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!value || typeof value !== "object" || typeof (value as { version?: unknown }).version !== "string") throw new RequestError("UNAVAILABLE", "the adapter package at " + path + " has no version")
  return (value as { version: string }).version
}

export async function providerConfiguration(profile: ProviderProfile): Promise<ConfigEvidence> {
  try {
    const adapterVersion = await packageVersion(profile.adapterPackageJson), sdkVersion = profile.sdkPackageJson === null ? null : await packageVersion(profile.sdkPackageJson)
    return { fingerprint: digest(JSON.stringify([profile.id, profile.executable, adapterVersion, sdkVersion])), scope: "declared-config-v1", providerId: profile.id, adapterVersion, sdkVersion }
  } catch (error) {
    if (error instanceof RequestError) throw error
    throw new RequestError("UNAVAILABLE", "backend " + profile.id + " has an unreadable adapter package: " + (error instanceof Error ? error.message : String(error)))
  }
}

function mergeSettings(initial: RequestedSettings, selected: RequestedSettings, contract: LaunchContract): RequestedSettings {
  const merged = parseRequestedSettings({ ...initial, ...selected, ...(initial.configValues || selected.configValues ? { configValues: { ...initial.configValues, ...selected.configValues } } : {}) })
  for (const [field, option] of [["modelId", contract.modelOption], ["modeId", contract.modeOption]] as const) {
    if (!option) continue
    if (selected.configValues?.[option] !== undefined && selected[field] === undefined) delete merged[field]
    if (selected[field] !== undefined && selected.configValues?.[option] === undefined && merged.configValues) delete merged.configValues[option]
  }
  return merged
}

export async function launchAgent(agent: LiveAgent, request: LaunchRequest, launcher: Launcher): Promise<void> {
  const { context, hooks } = launcher, root = context.paths.persistentRoot
  const abandoned = (): void => { if (agent.controller.signal.aborted) throw new RequestError("FAILED", "agent " + agent.agentId + " was stopped before it was ready") }
  const config = await readBackendConfig(root)
  const backendId = request.backendId ?? config.defaultBackendId
  const backend = config.backends.find(value => value.id === backendId), profile = (await readProfiles(root)).find(value => value.id === backendId && value.enabled)
  if (!backend || !profile) throw new RequestError("UNAVAILABLE", "backend " + backendId + " is not configured on this host")
  const candidates = launcher.contracts.filter(value => value.providerId === backendId && value.id === backend.compatibilityId)
  if (candidates.length !== 1) throw new RequestError("UNAVAILABLE", "backend " + backendId + " has no qualified adapter for " + backend.compatibilityId)
  const declaration = parseLaunchContract(candidates[0])
  if (request.restore && !declaration.sessionLoad) throw new RequestError("UNAVAILABLE", "backend " + backendId + " cannot restore sessions")
  const configuration = await providerConfiguration(profile)
  const contract = await configureLaunchContract(declaration, profile, configuration)
  const settings = request.restore ? {} : mergeSettings(backend.initial, parseRequestedSettings({ ...namedSettings(declaration, request.model, request.mode), ...request.settings }), declaration)
  const { params, names } = sessionInputs(request.cwd, request.nativeParams)
  abandoned()
  agent.backendId = backendId; agent.cwd = request.cwd; agent.backend = backend; agent.contract = contract
  agent.record = ownedRecord(parseAgentRecordV3({ version: 3,
    definition: { hostId: context.paths.hostKey, agentId: agent.agentId, createdCommandId: randomUUID(), cwd: request.cwd, backendId, origin: agent.origin },
    launch: { handlerGeneration: agent.tuple.handlerGeneration, providerGeneration: agent.tuple.providerGeneration, launchAttemptId: randomUUID(), commandId: randomUUID(), configuration, backendFingerprint: backendFingerprint(backend, contract), compatibilityId: declaration.id, containment: "direct-process-group-v1", authority: "normal-user", limits: AGENT_LIMITS },
    phase: request.restore ? "restoring" : "starting", session: request.restore ? { sessionId: request.restore.nativeSessionId, protocolVersion: 1 } : null, failure: null,
    settings, inputRequirements: { mcpServerNames: names }, configurationState: { verification: { kind: "unknown" }, nonRestorableOptionIds: [] } }))
  agent.conversation.append({ kind: "lifecycle", phase: agent.record.phase, cwd: request.cwd, session: agent.record.session })
  const editor = await startEditorRouting(context.paths.runtimeRoot)
  agent.editor = editor
  abandoned()
  const environment = { ...mergeBackendEnvironment(request.environment, backend.environmentDefaults), NVIM: editor.path, NVIM_SOCKET_PATH: editor.path, AGENCY_AGENT_ID: agent.agentId }
  const owner = launcher.processFactory({ context, spec: { agentId: agent.agentId, handlerGeneration: agent.tuple.handlerGeneration, providerGeneration: agent.tuple.providerGeneration, launchAttemptId: agent.record.launch.launchAttemptId, cwd: request.cwd, limits: AGENT_LIMITS },
    agentRecord: agent.record, args: backend.args, session: request.restore ? { kind: "load", sessionId: request.restore.nativeSessionId, params } : { kind: "new", params }, environment, contract,
    deadline: performance.now() + AGENT_LIMITS.startupMs, isReady: () => agent.phase === "ready", onUpdate: event => hooks.update(agent, event), onRequest: message => hooks.request(agent, message), onDropped: value => hooks.dropped(agent, value),
    revalidate: async () => abandoned(), awaitExitOnStartupFault: true })
  agent.owner = owner
  void owner.fault.then(failure => hooks.fault(agent, new AgentError(failure.code, failure.diagnostic)))
  const session = await owner.initialize(agent.controller.signal)
  abandoned()
  agent.session = session
  owner.markActive()
  agent.turns = createTurnCoordinator({ target: agent.tuple, conversation: agent.conversation, validate: () => hooks.validate(agent), invokeAcp: params => hooks.invoke(agent, params), onAccepted: request => hooks.accepted(agent, request), cancel: () => hooks.cancel(agent), onSettled: submissionId => hooks.settled(agent, submissionId) })
  abandoned()
  agent.phase = "ready"
  agent.conversation.append({ kind: "lifecycle", phase: "ready", session: { sessionId: session.sessionId, protocolVersion: 1 } })
}