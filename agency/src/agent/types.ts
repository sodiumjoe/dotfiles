import { parseFailureDiagnostic, type FailureDiagnostic } from "./failure-diagnostics.js"
import { isDeepStrictEqual } from "node:util"
import { absolutePath, hash, id, keys, object, providerId, text, type ProviderId } from "../config/validate.js"
import { parseProviderSnapshot, type ProviderSnapshot } from "../config/models.js"
import { type ConfigEvidence } from "../config/providers.js"
import type { LaunchRecord } from "../platform/types.js"
import type { LaunchEnvironment } from "./environment.js"
import { digest } from "../config/providers.js"
import { canonicalJson, parseRequestedSettings, type JsonObject, type RestorableSettings } from "./session-config.js"
export type { JsonObject, JsonValue, RequestedSettings, RestorableSettings, SessionConfiguration } from "./session-config.js"

export type Reasoning = { kind: "none" } | { kind: "value"; value: string }
export type PermissionEvidence = "fixture-contract-v1" | "agency-deny-all-v1"
export type StartSelection = { providerId: ProviderId; modelId: string; reasoning: Reasoning; mode: string | null; permissionProfile: string }
export type AgentTuple = { agentId: string; handlerGeneration: string; providerGeneration: string }
export type AgentIds = AgentTuple & { hostId: string; launchAttemptId: string; commandId: string }
export type AgentLimits = { startupMs: 30000; rpcMs: 5000; frameBytes: 1048576; startupBytes: 8388608; writeQueueBytes: 1048576; stderrBytes: 8192 }
export const AGENT_LIMITS: Readonly<AgentLimits> = Object.freeze({ startupMs: 30000, rpcMs: 5000, frameBytes: 1048576, startupBytes: 8388608, writeQueueBytes: 1048576, stderrBytes: 8192 })
export type AgentDefinition = { hostId: string; agentId: string; createdCommandId: string; cwd: string; selection: StartSelection & { mode: string } }
export type AgentLaunch = { handlerGeneration: string; providerGeneration: string; launchAttemptId: string; commandId: string; catalogSnapshotId: string; catalogEvidence: ProviderSnapshot; configuration: ConfigEvidence; contractId: string; contractFingerprint: string; containment: "direct-process-group-v1"; authority: "normal-user"; limits: AgentLimits }
export type LaunchSpec = AgentDefinition & AgentLaunch
export type SessionEvidence = { sessionId: string; sessionGeneration: string; protocolVersion: 1; modelId: string; reasoning: Reasoning; mode: string; permissionProfile: string; permissionEvidence: PermissionEvidence }
export type PromptResult = import("./session-events.js").TurnResult
export type AgentPhase = "starting" | "ready" | "recoverable" | "restoring" | "stopping" | "stopped" | "failed" | "interrupted"
export type AgentRecord = { version: 2; definition: AgentDefinition; launch: AgentLaunch; phase: AgentPhase; session: SessionEvidence | null; failure: AgentFailure | null }
export type AgentDefinitionV3 = { hostId: string; agentId: string; createdCommandId: string; cwd: string; backendId: ProviderId; origin: "new" | "import" }
export type AgentLaunchV3 = { handlerGeneration: string; providerGeneration: string; launchAttemptId: string; commandId: string; configuration: ConfigEvidence; backendFingerprint: string; compatibilityId: string; containment: "direct-process-group-v1"; authority: "normal-user"; limits: AgentLimits }
export type ConfigurationState = { verification: { kind: "verified" } | { kind: "pending"; commandId: string } | { kind: "unknown" }; nonRestorableOptionIds: string[] }
export type NativeSessionIdentity = { sessionId: string; protocolVersion: 1 }
export type AgentRecordV3 = { version: 3; definition: AgentDefinitionV3; launch: AgentLaunchV3 | null; phase: AgentPhase; session: NativeSessionIdentity | null; inputRequirements: { mcpServerNames: string[] }; settings: RestorableSettings; configurationState: ConfigurationState; failure: AgentFailure | null; lastActivityAt?: string; title?: string }
export type NativeCommandResult = { outcome: "started" | "restored" | "stopped" | "imported" | "configured" | "failed" | "interrupted"; target: AgentTuple | null; failure: AgentFailure | null; session: NativeSessionIdentity | null }
export type AgentCommandV3 = { version: 3; hostId: string; commandId: string; handlerGeneration: string; op: "start" | "restore" | "stop" | "import" | "configure"; input: JsonObject; agentId: string; target: AgentTuple | null; state: "pending" | "completed" | "interrupted"; result: NativeCommandResult | null }
export type OwnedAgentRecord = AgentRecordV3 & { launch: AgentLaunchV3 }
export function ownedRecord(input: AgentRecordV3): OwnedAgentRecord { if (!input.launch) throw new AgentError("NOT_READY"); return input as OwnedAgentRecord }
export type LegacyAgentRecord = { version: 1; spec: { agentId: string; handlerGeneration: string; providerGeneration: string; launchAttemptId: string; checkout: { root: { path: string } }; [key: string]: unknown }; phase: string; session: unknown; failure: unknown }
export type StartRequest = { commandId: string; handlerGeneration: string; cwd: string; selection: StartSelection; environment: LaunchEnvironment }
export type StartInput = StartRequest
export type StartCommandInput = Omit<StartRequest, "environment"> & { environmentDigest: string }
export type SessionStart = { kind: "new"; params: JsonObject } | { kind: "load"; sessionId: string; params: JsonObject }
export type RestoreRequest = { commandId: string; handlerGeneration: string; agentId: string; environment: LaunchEnvironment; nativeParams?: JsonObject }
export type RestoreCommandInput = Omit<RestoreRequest, "environment" | "nativeParams"> & { environmentDigest: string }
export type StopInput = AgentTuple & { commandId: string }
export type AgentCommand = { version: 2; hostId: string; commandId: string; handlerGeneration: string; input: StartCommandInput | RestoreCommandInput | StopInput; op: "start" | "restore" | "stop"; target: AgentTuple | null; state: "pending" | "completed" | "interrupted"; result: CommandResult | null }
export type CommandResult = { outcome: "started" | "restored" | "stopped" | "failed" | "interrupted"; target: AgentTuple | null; failure: AgentFailure | null; session: SessionEvidence | null }
export type AgentView = { display?: import("./conversation.js").ConversationDisplay; record: AgentRecordV3; launch: LaunchRecord | null; live: boolean; cleanup: "not_launched" | "unverified" | "verified" | "unknown"; unavailable: AgentStateIssue | null }
export type LegacyAgentView = { record: LegacyAgentRecord; launch: LaunchRecord | null; live: false; cleanup: "unknown" | "verified" }
export type CommandView = { state: "command"; command: AgentCommand | AgentCommandV3; durability: "verified" | "unverified" }
export const AGENT_CODES = ["STALE_ATTACHMENT", "BUSY", "UNSUPPORTED_SESSION_FEATURE", "SESSION_INPUT_REQUIRED", "RESYNC_REQUIRED", "USAGE", "INVALID_PROTOCOL", "INVALID_AGENT_STATE", "STALE_HANDLER", "STALE_PROVIDER", "COMMAND_CONFLICT", "ADAPTER_UNQUALIFIED", "MODEL_UNAVAILABLE", "SELECTION_UNSUPPORTED", "CONFIG_CHANGED", "NOT_READY", "STARTUP_FAILED", "STARTUP_TIMEOUT", "AUTH_REQUIRED", "PERMISSION_UNSUPPORTED", "RESTORE_UNSUPPORTED", "SESSION_UNAVAILABLE", "CLEANUP_UNVERIFIED", "INCOMPLETE", "UNAVAILABLE", "INTERNAL", "INPUT_TOO_LARGE", "OUTPUT_TOO_LARGE", "ACP_FRAME_LIMIT", "ACP_HISTORY_LIMIT"] as const
export type AgentErrorCode = typeof AGENT_CODES[number]
export type AgentStateIssue = { kind: "agent" | "command" | "unknown"; id: string | null; path: string; message: string }
export type AgentFailure = { code: AgentErrorCode; message: string; diagnostic?: FailureDiagnostic }
export class AgentError extends Error {
  readonly diagnostic?: FailureDiagnostic
  constructor(readonly code: AgentErrorCode, diagnostic?: FailureDiagnostic) {
    super(code.replaceAll("_", " ").toLowerCase())
    if (diagnostic !== undefined) this.diagnostic = parseFailureDiagnostic(diagnostic)
  }
}
export function invalidAgent(): never { throw new AgentError("INVALID_AGENT_STATE") }
export function parsePermissionEvidence(value: unknown): PermissionEvidence { if (value !== "fixture-contract-v1" && value !== "agency-deny-all-v1") invalidAgent(); return value }
export class ProviderRequestError extends AgentError {
  constructor(readonly providerError: JsonObject) { super("STARTUP_FAILED") }
}
export function agentFailure(error: unknown): AgentFailure { const code = error instanceof AgentError ? error.code : "INTERNAL"; return { code, message: new AgentError(code).message, ...(error instanceof AgentError && error.diagnostic !== undefined ? { diagnostic: parseFailureDiagnostic(error.diagnostic) } : {}) } }
function checked<T>(operation: () => T): T { try { return operation() } catch { return invalidAgent() } }
export function agentText(value: unknown, max = 256): string { return checked(() => { const result = text(value, max); if (!result.trim()) invalidAgent(); return result }) }
export function parseReasoning(input: unknown): Reasoning { return checked(() => { const v = object(input); if (v.kind === "none") { keys(v, ["kind"]); return { kind: "none" } } keys(v, ["kind", "value"]); if (v.kind !== "value") invalidAgent(); return { kind: "value", value: agentText(v.value) } }) }
export function parseSelection(input: unknown): StartSelection { return checked(() => { const v = object(input); keys(v, ["providerId", "modelId", "reasoning", "mode", "permissionProfile"]); return { providerId: providerId(v.providerId), modelId: agentText(v.modelId), reasoning: parseReasoning(v.reasoning), mode: v.mode === null ? null : agentText(v.mode), permissionProfile: agentText(v.permissionProfile) } }) }
export function requestedSettingsDigest(input: unknown): string { return digest(canonicalJson(parseRequestedSettings(input))) }
export function parseTuple(input: unknown): AgentTuple { return checked(() => { const v = object(input); keys(v, ["agentId", "handlerGeneration", "providerGeneration"]); return { agentId: id(v.agentId), handlerGeneration: id(v.handlerGeneration), providerGeneration: id(v.providerGeneration) } }) }
export function parseStartCommandInput(input: unknown): StartCommandInput { return checked(() => { const v = object(input); keys(v, ["commandId", "handlerGeneration", "cwd", "selection", "environmentDigest"]); return { commandId: id(v.commandId), handlerGeneration: id(v.handlerGeneration), cwd: absolutePath(v.cwd), selection: parseSelection(v.selection), environmentDigest: hash(v.environmentDigest) } }) }
export function parseRestoreCommandInput(input: unknown): RestoreCommandInput { return checked(() => { const v = object(input); keys(v, ["commandId", "handlerGeneration", "agentId", "environmentDigest"]); return { commandId: id(v.commandId), handlerGeneration: id(v.handlerGeneration), agentId: id(v.agentId), environmentDigest: hash(v.environmentDigest) } }) }
export function parseStopInput(input: unknown): StopInput { return checked(() => { const v = object(input); keys(v, ["commandId", "handlerGeneration", "agentId", "providerGeneration"]); return { commandId: id(v.commandId), ...parseTuple({ agentId: v.agentId, handlerGeneration: v.handlerGeneration, providerGeneration: v.providerGeneration }) } }) }
export function parseAgentFailure(input: unknown): AgentFailure { return checked(() => { const v = object(input); keys(v, ["code", "message", ...(Object.hasOwn(v, "diagnostic") ? ["diagnostic"] : [])]); if (!AGENT_CODES.some(code => code === v.code)) invalidAgent(); const code = v.code as AgentErrorCode; if (v.message !== new AgentError(code).message) invalidAgent(); return { code, message: new AgentError(code).message, ...(Object.hasOwn(v, "diagnostic") ? { diagnostic: parseFailureDiagnostic(v.diagnostic) } : {}) } }) }
export function parseSession(input: unknown): SessionEvidence { return checked(() => { const v = object(input); keys(v, ["sessionId", "sessionGeneration", "protocolVersion", "modelId", "reasoning", "mode", "permissionProfile", "permissionEvidence"]); if (v.protocolVersion !== 1) invalidAgent(); return { sessionId: agentText(v.sessionId, 1024), sessionGeneration: id(v.sessionGeneration), protocolVersion: 1, modelId: agentText(v.modelId), reasoning: parseReasoning(v.reasoning), mode: agentText(v.mode), permissionProfile: agentText(v.permissionProfile), permissionEvidence: parsePermissionEvidence(v.permissionEvidence) } }) }
function sessionMatches(session: SessionEvidence, selection: StartSelection): boolean { return session.modelId === selection.modelId && isDeepStrictEqual(session.reasoning, selection.reasoning) && (selection.mode === null || session.mode === selection.mode) && session.permissionProfile === selection.permissionProfile }
export function parseNativeIdentity(input: unknown): NativeSessionIdentity { return checked(() => { const v = object(input); keys(v, ["sessionId", "protocolVersion"]); if (v.protocolVersion !== 1) invalidAgent(); return { sessionId: agentText(v.sessionId, 1024), protocolVersion: 1 } }) }
function uniqueStrings(input: unknown): string[] { if (!Array.isArray(input) || input.length > 128) invalidAgent(); const values = input.map(value => agentText(value, 1024)); if (new Set(values).size !== values.length) invalidAgent(); return values }
export function parseAgentRecordV3(input: unknown): AgentRecordV3 { return checked(() => {
  const v = object(input)
  keys(v, ["version", "definition", "launch", "phase", "session", "inputRequirements", "settings", "configurationState", "failure", ...(Object.hasOwn(v, "lastActivityAt") ? ["lastActivityAt"] : []), ...(Object.hasOwn(v, "title") ? ["title"] : [])])
  if (v.version !== 3 || !["starting", "ready", "recoverable", "restoring", "stopping", "stopped", "failed", "interrupted"].includes(String(v.phase))) invalidAgent()
  const d = object(v.definition)
  keys(d, ["hostId", "agentId", "createdCommandId", "cwd", "backendId", "origin"])
  if (d.origin !== "new" && d.origin !== "import") invalidAgent()
  const definition: AgentDefinitionV3 = { hostId: hash(d.hostId), agentId: id(d.agentId), createdCommandId: id(d.createdCommandId), cwd: absolutePath(d.cwd), backendId: providerId(d.backendId), origin: d.origin }
  if (definition.agentId === definition.createdCommandId) invalidAgent()
  const session = v.session === null ? null : parseNativeIdentity(v.session), failure = v.failure === null ? null : parseAgentFailure(v.failure)
  let launch: AgentLaunchV3 | null = null
  if (v.launch !== null) {
    const l = object(v.launch)
    keys(l, ["handlerGeneration", "providerGeneration", "launchAttemptId", "commandId", "configuration", "backendFingerprint", "compatibilityId", "containment", "authority", "limits"])
    if (l.containment !== "direct-process-group-v1" || l.authority !== "normal-user" || !isDeepStrictEqual(l.limits, AGENT_LIMITS)) invalidAgent()
    const c = object(l.configuration)
    keys(c, ["fingerprint", "scope", "providerId", "adapterVersion", "sdkVersion"])
    if (c.scope !== "declared-config-v1" || c.providerId !== definition.backendId) invalidAgent()
    const configuration: ConfigEvidence = { fingerprint: hash(c.fingerprint), scope: "declared-config-v1", providerId: providerId(c.providerId), adapterVersion: agentText(c.adapterVersion), sdkVersion: c.sdkVersion === null ? null : agentText(c.sdkVersion) }
    launch = { handlerGeneration: id(l.handlerGeneration), providerGeneration: id(l.providerGeneration), launchAttemptId: id(l.launchAttemptId), commandId: id(l.commandId), configuration, backendFingerprint: hash(l.backendFingerprint), compatibilityId: agentText(l.compatibilityId), containment: "direct-process-group-v1", authority: "normal-user", limits: { ...AGENT_LIMITS } }
    if (new Set([definition.agentId, launch.handlerGeneration, launch.providerGeneration, launch.launchAttemptId, launch.commandId]).size !== 5 || [definition.agentId, launch.handlerGeneration, launch.providerGeneration, launch.launchAttemptId].includes(definition.createdCommandId)) invalidAgent()
  } else if (definition.origin !== "import" || session === null || !["stopped", "interrupted"].includes(String(v.phase))) invalidAgent()
  if (["ready", "recoverable", "restoring"].includes(String(v.phase)) && session === null || v.phase === "starting" && session !== null || ["failed", "interrupted"].includes(String(v.phase)) && failure === null || failure !== null && !["failed", "interrupted", "recoverable"].includes(String(v.phase))) invalidAgent()
  const inputs = object(v.inputRequirements), state = object(v.configurationState)
  keys(inputs, ["mcpServerNames"]); keys(state, ["verification", "nonRestorableOptionIds"])
  const verification = object(state.verification)
  let verified: ConfigurationState["verification"]
  if (verification.kind === "pending") { keys(verification, ["kind", "commandId"]); verified = { kind: "pending", commandId: id(verification.commandId) } }
  else { keys(verification, ["kind"]); if (verification.kind !== "verified" && verification.kind !== "unknown") invalidAgent(); verified = { kind: verification.kind } }
  const lastActivityAt = Object.hasOwn(v, "lastActivityAt") ? text(v.lastActivityAt, 64) : undefined
  if (lastActivityAt !== undefined && !Number.isFinite(Date.parse(lastActivityAt))) invalidAgent()
  const title = Object.hasOwn(v, "title") ? text(v.title, 1024) : undefined
  return { version: 3, definition, launch, phase: v.phase as AgentPhase, session, failure, inputRequirements: { mcpServerNames: uniqueStrings(inputs.mcpServerNames) }, settings: parseRequestedSettings(v.settings), configurationState: { verification: verified, nonRestorableOptionIds: uniqueStrings(state.nonRestorableOptionIds) }, ...(lastActivityAt === undefined ? {} : { lastActivityAt }), ...(title === undefined ? {} : { title }) }
}) }
export function parseAgentCommandV3(input: unknown): AgentCommandV3 { return checked(() => {
  const v = object(input)
  keys(v, ["version", "hostId", "commandId", "handlerGeneration", "op", "input", "agentId", "target", "state", "result"])
  if (v.version !== 3 || !["start", "restore", "stop", "import", "configure"].includes(String(v.op)) || !["pending", "completed", "interrupted"].includes(String(v.state))) invalidAgent()
  const agentId = id(v.agentId), commandId = id(v.commandId), handlerGeneration = id(v.handlerGeneration), target = v.target === null ? null : parseTuple(v.target), request = object(v.input)
  if (target && (target.agentId !== agentId || target.handlerGeneration !== handlerGeneration)) invalidAgent()
  if ((v.op === "import") !== (target === null)) invalidAgent()
  if (v.op === "start") {
    keys(request, ["cwd", "backendId", "selectionDigest", "environmentDigest", "mcpServerNames"])
    absolutePath(request.cwd); providerId(request.backendId); hash(request.selectionDigest); hash(request.environmentDigest); uniqueStrings(request.mcpServerNames)
  } else if (v.op === "restore") {
    keys(request, ["agentId", "environmentDigest", "mcpServerNames"])
    if (id(request.agentId) !== agentId) invalidAgent()
    hash(request.environmentDigest); uniqueStrings(request.mcpServerNames)
  } else if (v.op === "stop") { keys(request, ["target"]); if (!isDeepStrictEqual(parseTuple(request.target), target)) invalidAgent() }
  else if (v.op === "import") { keys(request, ["backendId", "nativeSessionId", "cwd"]); providerId(request.backendId); agentText(request.nativeSessionId, 1024); absolutePath(request.cwd) }
  else {
    keys(request, ["target", "method", "optionIds", "prior", "desired", "priorNonRestorableOptionIds"])
    if (!isDeepStrictEqual(parseTuple(request.target), target) || !["session/set_config_option", "session/set_model", "session/set_mode"].includes(String(request.method))) invalidAgent()
    uniqueStrings(request.optionIds); uniqueStrings(request.priorNonRestorableOptionIds); parseRequestedSettings(request.prior); parseRequestedSettings(request.desired)
  }
  const result = v.result === null ? null : object(v.result) as JsonObject
  if ((v.state === "pending") !== (result === null)) invalidAgent()
  if (result) {
    keys(result, ["outcome", "target", "failure", "session"])
    if (!["started", "restored", "stopped", "imported", "configured", "failed", "interrupted"].includes(String(result.outcome)) || !isDeepStrictEqual(result.target, target)) invalidAgent()
    if (result.failure !== null) parseAgentFailure(result.failure)
    if (result.session !== null) parseNativeIdentity(result.session)
    if ((result.outcome === "failed" || result.outcome === "interrupted") !== (result.failure !== null) || (v.state === "interrupted") !== (result.outcome === "interrupted")) invalidAgent()
    const expected = { start: "started", restore: "restored", stop: "stopped", import: "imported", configure: "configured" }[v.op as AgentCommandV3["op"]]
    if (!["failed", "interrupted", expected].includes(String(result.outcome))) invalidAgent()
    if (["started", "restored", "imported"].includes(String(result.outcome)) && result.session === null) invalidAgent()
  }
  return { version: 3, hostId: hash(v.hostId), commandId, handlerGeneration, op: v.op as AgentCommandV3["op"], input: structuredClone(request) as JsonObject, agentId, target, state: v.state as AgentCommandV3["state"], result: result === null ? null : structuredClone(result) as NativeCommandResult }
}) }
export function parseLaunchSpec(input: unknown): LaunchSpec { return checked(() => {
  const v = object(input); keys(v, ["hostId", "agentId", "createdCommandId", "cwd", "selection", "handlerGeneration", "providerGeneration", "launchAttemptId", "commandId", "catalogSnapshotId", "catalogEvidence", "configuration", "contractId", "contractFingerprint", "containment", "authority", "limits"])
  if (v.containment !== "direct-process-group-v1" || v.authority !== "normal-user" || !isDeepStrictEqual(v.limits, AGENT_LIMITS)) invalidAgent()
  const ids = { hostId: hash(v.hostId), agentId: id(v.agentId), createdCommandId: id(v.createdCommandId), handlerGeneration: id(v.handlerGeneration), providerGeneration: id(v.providerGeneration), launchAttemptId: id(v.launchAttemptId), commandId: id(v.commandId) }
  if (new Set([ids.agentId, ids.handlerGeneration, ids.providerGeneration, ids.launchAttemptId, ids.commandId]).size !== 5 || [ids.agentId, ids.handlerGeneration, ids.providerGeneration, ids.launchAttemptId].includes(ids.createdCommandId)) invalidAgent()
  const selection = parseSelection(v.selection); if (selection.mode === null) invalidAgent()
  const c = object(v.configuration); keys(c, ["fingerprint", "scope", "providerId", "adapterVersion", "sdkVersion"]); if (c.scope !== "declared-config-v1") invalidAgent()
  const configuration: ConfigEvidence = { fingerprint: hash(c.fingerprint), scope: "declared-config-v1", providerId: providerId(c.providerId), adapterVersion: agentText(c.adapterVersion), sdkVersion: c.sdkVersion === null ? null : agentText(c.sdkVersion) }
  const catalogEvidence = parseProviderSnapshot(v.catalogEvidence)
  if (catalogEvidence.error !== null || catalogEvidence.verifiedAt === null || catalogEvidence.verifiedHandlerGeneration !== ids.handlerGeneration || catalogEvidence.providerId !== selection.providerId || configuration.providerId !== selection.providerId || configuration.fingerprint !== catalogEvidence.fingerprint || configuration.adapterVersion !== catalogEvidence.adapterVersion || configuration.sdkVersion !== catalogEvidence.sdkVersion) invalidAgent()
  const model = catalogEvidence.models.find(model => model.modelId === selection.modelId)
  if (!model || (selection.reasoning.kind === "none" ? model.reasoning.state !== "none" : model.reasoning.state !== "values" || !model.reasoning.values.includes(selection.reasoning.value))) invalidAgent()
  if (model.modes.state === "values" && !model.modes.values.includes(selection.mode)) invalidAgent()
  return { ...ids, cwd: absolutePath(v.cwd), selection: { ...selection, mode: selection.mode }, catalogSnapshotId: id(v.catalogSnapshotId), catalogEvidence, configuration, contractId: agentText(v.contractId), contractFingerprint: hash(v.contractFingerprint), containment: "direct-process-group-v1", authority: "normal-user", limits: { ...AGENT_LIMITS } }
}) }
export function parseLegacyAgentRecord(input: unknown): LegacyAgentRecord { return checked(() => { const v = object(input), spec = object(v.spec), checkout = object(spec.checkout), root = object(checkout.root); if (v.version !== 1 || !["starting", "ready", "stopping", "stopped", "failed", "interrupted"].includes(String(v.phase))) invalidAgent(); return { version: 1, spec: { ...spec, agentId: id(spec.agentId), handlerGeneration: id(spec.handlerGeneration), providerGeneration: id(spec.providerGeneration), launchAttemptId: id(spec.launchAttemptId), checkout: { ...checkout, root: { ...root, path: absolutePath(root.path) } } }, phase: v.phase as string, session: v.session, failure: v.failure } }) }
export function parseAgentCommand(input: unknown): AgentCommand { return checked(() => {
  const v = object(input); keys(v, ["version", "hostId", "commandId", "handlerGeneration", "input", "op", "target", "state", "result"])
  if (v.version !== 2 || (v.op !== "start" && v.op !== "restore" && v.op !== "stop") || !["pending", "completed", "interrupted"].includes(String(v.state))) invalidAgent()
  const commandId = id(v.commandId), handlerGeneration = id(v.handlerGeneration), request = v.op === "start" ? parseStartCommandInput(v.input) : v.op === "restore" ? parseRestoreCommandInput(v.input) : parseStopInput(v.input), target = v.target === null ? null : parseTuple(v.target)
  if (commandId !== request.commandId || handlerGeneration !== request.handlerGeneration || target !== null && target.handlerGeneration !== handlerGeneration) invalidAgent()
  if (v.op === "stop" && !isDeepStrictEqual(target, { agentId: (request as StopInput).agentId, handlerGeneration, providerGeneration: (request as StopInput).providerGeneration })) invalidAgent()
  if (v.op === "restore" && target?.agentId !== (request as RestoreCommandInput).agentId) invalidAgent()
  let result: CommandResult | null = null
  if (v.result !== null) { const r = object(v.result); keys(r, ["outcome", "target", "failure", "session"]); if (!["started", "restored", "stopped", "failed", "interrupted"].includes(String(r.outcome))) invalidAgent(); result = { outcome: r.outcome as CommandResult["outcome"], target: r.target === null ? null : parseTuple(r.target), failure: r.failure === null ? null : parseAgentFailure(r.failure), session: r.session === null ? null : parseSession(r.session) }; if (!isDeepStrictEqual(result.target, target) || (result.outcome === "failed" || result.outcome === "interrupted") !== (result.failure !== null)) invalidAgent(); if (result.outcome === "started" && (v.op !== "start" || result.session === null || target === null)) invalidAgent(); if (result.outcome === "restored" && (v.op !== "restore" || result.session === null || target === null)) invalidAgent(); if (result.outcome === "stopped" && (v.op !== "stop" || target === null)) invalidAgent(); if (v.op === "start" && result.session && !sessionMatches(result.session, (request as StartCommandInput).selection)) invalidAgent() }
  if ((v.state === "pending") !== (result === null) || (v.state === "interrupted") !== (result?.outcome === "interrupted") || v.state === "pending" && target === null) invalidAgent()
  return { version: 2, hostId: hash(v.hostId), commandId, handlerGeneration, input: request, op: v.op, target, state: v.state as AgentCommand["state"], result }
}) }