import { isDeepStrictEqual } from "node:util"
import { absolutePath, hash, id, keys, object, parseProviderSnapshot, providerId, text, type ConfigEvidence, type ProviderId, type ProviderSnapshot } from "../catalog/types.js"
import type { LaunchRecord } from "../platform/types.js"
import { launchEnvironmentDigest, parseLaunchEnvironment, type LaunchEnvironment } from "./environment.js"
import type { AgentStateIssue } from "./store.js"
import { digest } from "../catalog/config.js"
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
export type AgentRecordV3 = { version: 3; definition: AgentDefinitionV3; launch: AgentLaunchV3 | null; phase: AgentPhase; session: NativeSessionIdentity | null; inputRequirements: { mcpServerNames: string[] }; settings: RestorableSettings; configurationState: ConfigurationState; failure: AgentFailure | null }
export type NativeCommandResult = { outcome: "started" | "restored" | "stopped" | "imported" | "configured" | "failed" | "interrupted"; target: AgentTuple | null; failure: AgentFailure | null; session: NativeSessionIdentity | null }
export type AgentCommandV3 = { version: 3; hostId: string; commandId: string; handlerGeneration: string; op: "start" | "restore" | "stop" | "import" | "configure"; input: JsonObject; agentId: string; target: AgentTuple | null; state: "pending" | "completed" | "interrupted"; result: NativeCommandResult | null }
export type RuntimeLaunchSpec = AgentDefinitionV3 & AgentLaunchV3 & { settings: RestorableSettings }
export type OwnedAgentRecord = AgentRecordV3 & { launch: AgentLaunchV3 }
export function ownedRecord(input: AgentRecordV3): OwnedAgentRecord { if (!input.launch) throw new AgentError("NOT_READY"); return input as OwnedAgentRecord }
export function runtimeSpec(input: AgentRecordV3): RuntimeLaunchSpec { const record = ownedRecord(input); return { ...record.definition, ...record.launch, settings: structuredClone(record.settings) } }
export type LegacyAgentRecord = { version: 1; spec: { agentId: string; handlerGeneration: string; providerGeneration: string; launchAttemptId: string; checkout: { root: { path: string } }; [key: string]: unknown }; phase: string; session: unknown; failure: unknown }
export type StartRequest = { commandId: string; handlerGeneration: string; cwd: string; selection: StartSelection; environment: LaunchEnvironment }
export type StartInput = StartRequest
export type StartCommandInput = Omit<StartRequest, "environment"> & { environmentDigest: string }
export type SessionStart = { kind: "new"; params: JsonObject } | { kind: "load"; sessionId: string; params: JsonObject }
export type RestoreRequest = { commandId: string; handlerGeneration: string; agentId: string; environment: LaunchEnvironment; nativeParams?: JsonObject }
export type RestoreCommandInput = Omit<RestoreRequest, "environment" | "nativeParams"> & { environmentDigest: string }
export type StopInput = AgentTuple & { commandId: string }
export type ImportInput = { commandId: string; handlerGeneration: string; backendId: ProviderId; nativeSessionId: string; cwd: string }
export function parseImportInput(input: unknown): ImportInput { return checked(() => { const v = object(input); keys(v, ["commandId", "handlerGeneration", "backendId", "nativeSessionId", "cwd"]); const nativeSessionId = agentText(v.nativeSessionId, 1024); if (nativeSessionId.startsWith("agency:")) invalidAgent(); return { commandId: id(v.commandId), handlerGeneration: id(v.handlerGeneration), backendId: providerId(v.backendId), nativeSessionId, cwd: absolutePath(v.cwd) } }) }
export type PromptInput = AgentTuple & { text: string }
export type PromptView = { state: "prompt"; target: AgentTuple; stopReason: "end_turn"; text: string }
export type AgentCommand = { version: 2; hostId: string; commandId: string; handlerGeneration: string; input: StartCommandInput | RestoreCommandInput | StopInput; op: "start" | "restore" | "stop"; target: AgentTuple | null; state: "pending" | "completed" | "interrupted"; result: CommandResult | null }
export type CommandResult = { outcome: "started" | "restored" | "stopped" | "failed" | "interrupted"; target: AgentTuple | null; failure: AgentFailure | null; session: SessionEvidence | null }
export type AgentView = { record: AgentRecordV3; launch: LaunchRecord | null; live: boolean; cleanup: "not_launched" | "unverified" | "verified" | "unknown"; unavailable: AgentStateIssue | null }
export type LegacyAgentView = { record: LegacyAgentRecord; launch: LaunchRecord | null; live: false; cleanup: "unknown" | "verified" }
export type CommandView = { state: "command"; command: AgentCommand | AgentCommandV3; durability: "verified" | "unverified" }
export type AgentList = { state: "agents"; agents: Array<AgentView | LegacyAgentView>; issues: AgentStateIssue[] }
export type CurrentAgents = { state: "current"; cwd: string; agents: AgentView[] }
export const AGENT_CODES = ["STALE_ATTACHMENT", "BUSY", "UNSUPPORTED_SESSION_FEATURE", "SESSION_INPUT_REQUIRED", "RESYNC_REQUIRED", "USAGE", "INVALID_PROTOCOL", "INVALID_AGENT_STATE", "STALE_HANDLER", "STALE_PROVIDER", "COMMAND_CONFLICT", "ADAPTER_UNQUALIFIED", "MODEL_UNAVAILABLE", "SELECTION_UNSUPPORTED", "CONFIG_CHANGED", "NOT_READY", "STARTUP_FAILED", "STARTUP_TIMEOUT", "AUTH_REQUIRED", "PERMISSION_UNSUPPORTED", "RESTORE_UNSUPPORTED", "SESSION_UNAVAILABLE", "CLEANUP_UNVERIFIED", "INCOMPLETE", "UNAVAILABLE", "INTERNAL", "INPUT_TOO_LARGE", "OUTPUT_TOO_LARGE", "ACP_FRAME_LIMIT", "ACP_HISTORY_LIMIT"] as const
export type AgentErrorCode = typeof AGENT_CODES[number]
export type AgentFailure = { code: AgentErrorCode; message: string }
export class AgentError extends Error { constructor(readonly code: AgentErrorCode) { super(code.replaceAll("_", " ").toLowerCase()) } }
export function invalidAgent(): never { throw new AgentError("INVALID_AGENT_STATE") }
export function parsePermissionEvidence(value: unknown): PermissionEvidence { if (value !== "fixture-contract-v1" && value !== "agency-deny-all-v1") invalidAgent(); return value }
export function agentFailure(error: unknown): AgentFailure { const code = error instanceof AgentError ? error.code : "INTERNAL"; return { code, message: new AgentError(code).message } }
function checked<T>(operation: () => T): T { try { return operation() } catch { return invalidAgent() } }
export function agentText(value: unknown, max = 256): string { return checked(() => { const result = text(value, max); if (!result.trim()) invalidAgent(); return result }) }
export function parseReasoning(input: unknown): Reasoning { return checked(() => { const v = object(input); if (v.kind === "none") { keys(v, ["kind"]); return { kind: "none" } } keys(v, ["kind", "value"]); if (v.kind !== "value") invalidAgent(); return { kind: "value", value: agentText(v.value) } }) }
export function parseSelection(input: unknown): StartSelection { return checked(() => { const v = object(input); keys(v, ["providerId", "modelId", "reasoning", "mode", "permissionProfile"]); return { providerId: providerId(v.providerId), modelId: agentText(v.modelId), reasoning: parseReasoning(v.reasoning), mode: v.mode === null ? null : agentText(v.mode), permissionProfile: agentText(v.permissionProfile) } }) }
export function startSelectionDigest(input: unknown): string { return digest(canonicalJson(parseSelection(input))) }
export function requestedSettingsDigest(input: unknown): string { return digest(canonicalJson(parseRequestedSettings(input))) }
export function parseTuple(input: unknown): AgentTuple { return checked(() => { const v = object(input); keys(v, ["agentId", "handlerGeneration", "providerGeneration"]); return { agentId: id(v.agentId), handlerGeneration: id(v.handlerGeneration), providerGeneration: id(v.providerGeneration) } }) }
export function tupleOf(spec: LaunchSpec): AgentTuple { return { agentId: spec.agentId, handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration } }
export function tupleOfRecord(record: AgentRecord): AgentTuple
export function tupleOfRecord(record: AgentRecordV3): AgentTuple | null
export function tupleOfRecord(record: AgentRecord | AgentRecordV3): AgentTuple | null { return record.launch === null ? null : { agentId: record.definition.agentId, handlerGeneration: record.launch.handlerGeneration, providerGeneration: record.launch.providerGeneration } }
export function parseStartInput(input: unknown): StartRequest { return checked(() => { const v = object(input); keys(v, ["commandId", "handlerGeneration", "cwd", "selection", "environment"]); return { commandId: id(v.commandId), handlerGeneration: id(v.handlerGeneration), cwd: absolutePath(v.cwd), selection: parseSelection(v.selection), environment: parseLaunchEnvironment(v.environment) } }) }
export function projectStartInput(request: StartRequest): StartCommandInput { const value = parseStartInput(request); return { commandId: value.commandId, handlerGeneration: value.handlerGeneration, cwd: value.cwd, selection: value.selection, environmentDigest: launchEnvironmentDigest(value.environment) } }
export function parseStartCommandInput(input: unknown): StartCommandInput { return checked(() => { const v = object(input); keys(v, ["commandId", "handlerGeneration", "cwd", "selection", "environmentDigest"]); return { commandId: id(v.commandId), handlerGeneration: id(v.handlerGeneration), cwd: absolutePath(v.cwd), selection: parseSelection(v.selection), environmentDigest: hash(v.environmentDigest) } }) }
export function startCommand(request: StartRequest, target: AgentTuple, hostId: string): AgentCommand { const input = projectStartInput(request), tuple = parseTuple(target); if (tuple.handlerGeneration !== input.handlerGeneration) invalidAgent(); return { version: 2, hostId: hash(hostId), commandId: input.commandId, handlerGeneration: input.handlerGeneration, op: "start", input, target: tuple, state: "pending", result: null } }
export function parseRestoreRequest(input: unknown): RestoreRequest { return checked(() => { const v = object(input); keys(v, ["commandId", "handlerGeneration", "agentId", "environment", ...(v.nativeParams !== undefined ? ["nativeParams"] : [])]); return { commandId: id(v.commandId), handlerGeneration: id(v.handlerGeneration), agentId: id(v.agentId), environment: parseLaunchEnvironment(v.environment), ...(v.nativeParams !== undefined ? { nativeParams: JSON.parse(canonicalJson(object(v.nativeParams))) as JsonObject } : {}) } }) }
export function projectRestoreInput(request: RestoreRequest): RestoreCommandInput { const value = parseRestoreRequest(request); return { commandId: value.commandId, handlerGeneration: value.handlerGeneration, agentId: value.agentId, environmentDigest: launchEnvironmentDigest(value.environment) } }
export function parseRestoreCommandInput(input: unknown): RestoreCommandInput { return checked(() => { const v = object(input); keys(v, ["commandId", "handlerGeneration", "agentId", "environmentDigest"]); return { commandId: id(v.commandId), handlerGeneration: id(v.handlerGeneration), agentId: id(v.agentId), environmentDigest: hash(v.environmentDigest) } }) }
export function parseStopInput(input: unknown): StopInput { return checked(() => { const v = object(input); keys(v, ["commandId", "handlerGeneration", "agentId", "providerGeneration"]); return { commandId: id(v.commandId), ...parseTuple({ agentId: v.agentId, handlerGeneration: v.handlerGeneration, providerGeneration: v.providerGeneration }) } }) }
function promptText(value: unknown): string { if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4096 || !value.isWellFormed()) invalidAgent(); return value }
export function parsePromptInput(input: unknown): PromptInput { return checked(() => { const v = object(input); keys(v, ["agentId", "handlerGeneration", "providerGeneration", "text"]); return { ...parseTuple({ agentId: v.agentId, handlerGeneration: v.handlerGeneration, providerGeneration: v.providerGeneration }), text: promptText(v.text) } }) }
export function parsePromptView(input: unknown): PromptView { return checked(() => { const v = object(input); keys(v, ["state", "target", "stopReason", "text"]); if (v.state !== "prompt" || v.stopReason !== "end_turn") invalidAgent(); return { state: "prompt", target: parseTuple(v.target), stopReason: "end_turn", text: promptText(v.text) } }) }
export function parseAgentFailure(input: unknown): AgentFailure { return checked(() => { const v = object(input); keys(v, ["code", "message"]); if (!AGENT_CODES.some(code => code === v.code)) invalidAgent(); const code = v.code as AgentErrorCode; if (v.message !== new AgentError(code).message) invalidAgent(); return { code, message: new AgentError(code).message } }) }
export function parseSession(input: unknown): SessionEvidence { return checked(() => { const v = object(input); keys(v, ["sessionId", "sessionGeneration", "protocolVersion", "modelId", "reasoning", "mode", "permissionProfile", "permissionEvidence"]); if (v.protocolVersion !== 1) invalidAgent(); return { sessionId: agentText(v.sessionId, 1024), sessionGeneration: id(v.sessionGeneration), protocolVersion: 1, modelId: agentText(v.modelId), reasoning: parseReasoning(v.reasoning), mode: agentText(v.mode), permissionProfile: agentText(v.permissionProfile), permissionEvidence: parsePermissionEvidence(v.permissionEvidence) } }) }
function sessionMatches(session: SessionEvidence, selection: StartSelection): boolean { return session.modelId === selection.modelId && isDeepStrictEqual(session.reasoning, selection.reasoning) && (selection.mode === null || session.mode === selection.mode) && session.permissionProfile === selection.permissionProfile }
export function parseNativeIdentity(input: unknown): NativeSessionIdentity { return checked(() => { const v = object(input); keys(v, ["sessionId", "protocolVersion"]); if (v.protocolVersion !== 1) invalidAgent(); return { sessionId: agentText(v.sessionId, 1024), protocolVersion: 1 } }) }
function uniqueStrings(input: unknown): string[] { if (!Array.isArray(input) || input.length > 128) invalidAgent(); const values = input.map(value => agentText(value, 1024)); if (new Set(values).size !== values.length) invalidAgent(); return values }
export function parseAgentRecordV3(input: unknown): AgentRecordV3 { return checked(() => {
  const v = object(input)
  keys(v, ["version", "definition", "launch", "phase", "session", "inputRequirements", "settings", "configurationState", "failure"])
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
  return { version: 3, definition, launch, phase: v.phase as AgentPhase, session, failure, inputRequirements: { mcpServerNames: uniqueStrings(inputs.mcpServerNames) }, settings: parseRequestedSettings(v.settings), configurationState: { verification: verified, nonRestorableOptionIds: uniqueStrings(state.nonRestorableOptionIds) } }
}) }
export function normalizeAgentRecord(input: AgentRecord | AgentRecordV3): AgentRecordV3 {
  if (input.version === 3) return parseAgentRecordV3(input)
  const old = parseAgentRecord(input), { definition: d, launch: l } = old
  const configValues = d.selection.reasoning.kind === "value" ? { [l.contractId === "codex-acp-1.7" ? "reasoning_effort" : "reasoning"]: d.selection.reasoning.value } : undefined
  return parseAgentRecordV3({ version: 3,
    definition: { hostId: d.hostId, agentId: d.agentId, createdCommandId: d.createdCommandId, cwd: d.cwd, backendId: d.selection.providerId, origin: "new" },
    launch: { handlerGeneration: l.handlerGeneration, providerGeneration: l.providerGeneration, launchAttemptId: l.launchAttemptId, commandId: l.commandId, configuration: l.configuration, backendFingerprint: digest(canonicalJson([l.configuration, l.contractFingerprint])), compatibilityId: l.contractId, containment: l.containment, authority: l.authority, limits: l.limits },
    phase: old.phase, session: old.session === null ? null : { sessionId: old.session.sessionId, protocolVersion: 1 }, failure: old.failure,
    settings: { modelId: d.selection.modelId, modeId: d.selection.mode, ...(configValues ? { configValues } : {}) }, inputRequirements: { mcpServerNames: [] }, configurationState: { verification: { kind: "verified" }, nonRestorableOptionIds: [] },
  })
}
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
export function normalizeAgentCommand(input: AgentCommand | AgentCommandV3): AgentCommandV3 {
  if (input.version === 3) return parseAgentCommandV3(input)
  const old = parseAgentCommand(input)
  if (!old.target) invalidAgent()
  const selection = old.op === "start" ? (old.input as StartCommandInput).selection : null
  const request = old.op === "start" ? { cwd: (old.input as StartCommandInput).cwd, backendId: selection!.providerId, selectionDigest: startSelectionDigest(selection), environmentDigest: (old.input as StartCommandInput).environmentDigest, mcpServerNames: [] } : old.op === "restore" ? { agentId: old.target.agentId, environmentDigest: (old.input as RestoreCommandInput).environmentDigest, mcpServerNames: [] } : { target: old.target }
  return parseAgentCommandV3({ version: 3, hostId: old.hostId, commandId: old.commandId, handlerGeneration: old.handlerGeneration, op: old.op, input: request, agentId: old.target.agentId, target: old.target, state: old.state, result: old.result ? { ...old.result, session: old.result.session ? { sessionId: old.result.session.sessionId, protocolVersion: 1 } : null } : null })
}
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
export function splitLaunchSpec(spec: LaunchSpec): { definition: AgentDefinition; launch: AgentLaunch } { const v = parseLaunchSpec(spec); return { definition: { hostId: v.hostId, agentId: v.agentId, createdCommandId: v.createdCommandId, cwd: v.cwd, selection: v.selection }, launch: { handlerGeneration: v.handlerGeneration, providerGeneration: v.providerGeneration, launchAttemptId: v.launchAttemptId, commandId: v.commandId, catalogSnapshotId: v.catalogSnapshotId, catalogEvidence: v.catalogEvidence, configuration: v.configuration, contractId: v.contractId, contractFingerprint: v.contractFingerprint, containment: v.containment, authority: v.authority, limits: v.limits } } }
export function specOf(record: AgentRecord): LaunchSpec { return parseLaunchSpec({ ...record.definition, ...record.launch }) }
export function parseAgentRecord(input: unknown): AgentRecord { return checked(() => {
  const v = object(input); keys(v, ["version", "definition", "launch", "phase", "session", "failure"])
  if (v.version !== 2 || !["starting", "ready", "recoverable", "restoring", "stopping", "stopped", "failed", "interrupted"].includes(String(v.phase))) invalidAgent()
  const definition = object(v.definition), launch = object(v.launch), pieces = splitLaunchSpec(parseLaunchSpec({ ...definition, ...launch }))
  if (!isDeepStrictEqual(definition, pieces.definition) || !isDeepStrictEqual(launch, pieces.launch)) invalidAgent()
  const session = v.session === null ? null : parseSession(v.session), failure = v.failure === null ? null : parseAgentFailure(v.failure)
  if (["ready", "recoverable", "restoring"].includes(String(v.phase)) && session === null || v.phase === "starting" && session !== null || ["failed", "interrupted"].includes(String(v.phase)) && failure === null || failure !== null && !["failed", "interrupted", "recoverable"].includes(String(v.phase))) invalidAgent()
  if (session && (!sessionMatches(session, pieces.definition.selection) || [pieces.definition.agentId, pieces.launch.providerGeneration, pieces.launch.handlerGeneration, pieces.launch.launchAttemptId, pieces.launch.commandId].includes(session.sessionGeneration))) invalidAgent()
  return { version: 2, ...pieces, phase: v.phase as AgentPhase, session, failure }
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