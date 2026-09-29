import { isDeepStrictEqual } from "node:util"
import { absolutePath, hash, id, keys, object, parseProviderSnapshot, providerId, text, type ConfigEvidence, type ProviderId, type ProviderSnapshot } from "../catalog/types.js"
import type { CheckoutIdentity } from "../checkout/identity.js"
import { parseAdmissionRecord } from "../checkout/records.js"
import type { LaunchRecord } from "../platform/types.js"

export type Reasoning = { kind: "none" } | { kind: "value"; value: string }
export type PermissionEvidence = "fixture-contract-v1" | "agency-deny-all-v1"
export type StartSelection = { providerId: ProviderId; modelId: string; reasoning: Reasoning; mode: string | null; permissionProfile: string }
export type AgentTuple = { agentId: string; handlerGeneration: string; providerGeneration: string }
export type AgentIds = AgentTuple & { hostId: string; leaseId: string; launchAttemptId: string; startCommandId: string }
export type AgentLimits = { startupMs: 30000; rpcMs: 5000; frameBytes: 1048576; startupBytes: 8388608; writeQueueBytes: 1048576; stderrBytes: 8192 }
export const AGENT_LIMITS: Readonly<AgentLimits> = Object.freeze({ startupMs: 30000, rpcMs: 5000, frameBytes: 1048576, startupBytes: 8388608, writeQueueBytes: 1048576, stderrBytes: 8192 })
export type LaunchSpec = AgentIds & {
  version: 1; selection: StartSelection & { mode: string }; modelIdentity: "advertised"; resolvedModelId: null
  checkout: CheckoutIdentity; catalogSnapshotId: string; catalogEvidence: ProviderSnapshot; configuration: ConfigEvidence
  contractId: string; contractFingerprint: string; containment: "direct-process-group-v1"; authority: "normal-user"; limits: AgentLimits
}
export type SessionEvidence = { sessionId: string; sessionGeneration: string; protocolVersion: 1; modelId: string; reasoning: Reasoning; mode: string; permissionProfile: string; permissionEvidence: PermissionEvidence }
export type AgentPhase = "starting" | "ready" | "stopping" | "stopped" | "failed" | "interrupted"
export type AgentRecord = { version: 1; spec: LaunchSpec; phase: AgentPhase; session: SessionEvidence | null; failure: AgentFailure | null }
export type StartInput = { commandId: string; handlerGeneration: string; cwd: string; selection: StartSelection }
export type StopInput = AgentTuple & { commandId: string }
export type AgentCommand = { version: 1; hostId: string; commandId: string; handlerGeneration: string; input: StartInput | StopInput; op: "start" | "stop"; target: AgentTuple | null; state: "pending" | "completed" | "interrupted"; result: CommandResult | null }
export type CommandResult = { outcome: "started" | "stopped" | "failed" | "interrupted"; target: AgentTuple | null; failure: AgentFailure | null; session: SessionEvidence | null }
export type AgentView = { record: AgentRecord; launch: LaunchRecord | null; live: boolean; cleanup: "not_reserved" | "unverified" | "verified" | "unknown" }
export type CommandView = { state: "command"; command: AgentCommand; durability: "verified" | "unverified" }
export type AgentList = { state: "agents"; agents: AgentView[]; unavailable: AgentFailure | null }
export type CurrentAgent = { state: "current"; checkout: CheckoutIdentity; agent: AgentView | null; blockers: string[]; unavailable: AgentFailure | null }
export const AGENT_CODES = ["USAGE", "INVALID_PROTOCOL", "INVALID_AGENT_STATE", "STALE_HANDLER", "STALE_PROVIDER", "COMMAND_CONFLICT", "ADAPTER_UNQUALIFIED", "MODEL_UNAVAILABLE", "SELECTION_UNSUPPORTED", "CONFIG_CHANGED", "CHECKOUT_BUSY", "CHECKOUT_QUARANTINED", "ADMISSION_UNAVAILABLE", "NOT_READY", "STARTUP_FAILED", "STARTUP_TIMEOUT", "AUTH_REQUIRED", "PERMISSION_UNSUPPORTED", "CLEANUP_UNVERIFIED", "INCOMPLETE", "UNAVAILABLE", "INTERNAL"] as const
export type AgentErrorCode = typeof AGENT_CODES[number]
export type AgentFailure = { code: AgentErrorCode; message: string }
export class AgentError extends Error { constructor(readonly code: AgentErrorCode) { super(code.replaceAll("_", " ").toLowerCase()) } }
export function invalidAgent(): never { throw new AgentError("INVALID_AGENT_STATE") }
export function parsePermissionEvidence(value: unknown): PermissionEvidence {
  if (value !== "fixture-contract-v1" && value !== "agency-deny-all-v1") invalidAgent()
  return value
}
export function agentFailure(error: unknown): AgentFailure {
  const code = error instanceof AgentError ? error.code : "INTERNAL"
  return { code, message: new AgentError(code).message }
}
function checked<T>(operation: () => T): T { try { return operation() } catch { return invalidAgent() } }
export function agentText(value: unknown, max = 256): string {
  return checked(() => { const result = text(value, max); if (!result.trim()) invalidAgent(); return result })
}
export function parseReasoning(input: unknown): Reasoning {
  return checked(() => {
    const v = object(input)
    if (v.kind === "none") { keys(v, ["kind"]); return { kind: "none" } }
    keys(v, ["kind", "value"])
    if (v.kind !== "value") invalidAgent()
    return { kind: "value", value: agentText(v.value) }
  })
}
export function parseSelection(input: unknown): StartSelection {
  return checked(() => {
    const v = object(input); keys(v, ["providerId", "modelId", "reasoning", "mode", "permissionProfile"])
    return { providerId: providerId(v.providerId), modelId: agentText(v.modelId), reasoning: parseReasoning(v.reasoning), mode: v.mode === null ? null : agentText(v.mode), permissionProfile: agentText(v.permissionProfile) }
  })
}
export function parseTuple(input: unknown): AgentTuple {
  return checked(() => { const v = object(input); keys(v, ["agentId", "handlerGeneration", "providerGeneration"]); return { agentId: id(v.agentId), handlerGeneration: id(v.handlerGeneration), providerGeneration: id(v.providerGeneration) } })
}
export function tupleOf(spec: AgentIds): AgentTuple { return { agentId: spec.agentId, handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration } }
export function parseStartInput(input: unknown): StartInput {
  return checked(() => { const v = object(input); keys(v, ["commandId", "handlerGeneration", "cwd", "selection"]); return { commandId: id(v.commandId), handlerGeneration: id(v.handlerGeneration), cwd: absolutePath(v.cwd), selection: parseSelection(v.selection) } })
}
export function parseStopInput(input: unknown): StopInput {
  return checked(() => { const v = object(input); keys(v, ["commandId", "handlerGeneration", "agentId", "providerGeneration"]); return { commandId: id(v.commandId), ...parseTuple({ agentId: v.agentId, handlerGeneration: v.handlerGeneration, providerGeneration: v.providerGeneration }) } })
}
export function parseAgentFailure(input: unknown): AgentFailure {
  return checked(() => {
    const v = object(input); keys(v, ["code", "message"])
    if (!AGENT_CODES.some(code => code === v.code)) invalidAgent()
    const code = v.code as AgentErrorCode
    if (v.message !== new AgentError(code).message) invalidAgent()
    return { code, message: new AgentError(code).message }
  })
}
export function parseSession(input: unknown): SessionEvidence {
  return checked(() => {
    const v = object(input); keys(v, ["sessionId", "sessionGeneration", "protocolVersion", "modelId", "reasoning", "mode", "permissionProfile", "permissionEvidence"])
    if (v.protocolVersion !== 1) invalidAgent()
    return { sessionId: agentText(v.sessionId, 1024), sessionGeneration: id(v.sessionGeneration), protocolVersion: 1, modelId: agentText(v.modelId), reasoning: parseReasoning(v.reasoning), mode: agentText(v.mode), permissionProfile: agentText(v.permissionProfile), permissionEvidence: parsePermissionEvidence(v.permissionEvidence) }
  })
}
function sessionMatches(session: SessionEvidence, selection: StartSelection): boolean {
  return session.modelId === selection.modelId && isDeepStrictEqual(session.reasoning, selection.reasoning) && (selection.mode === null || session.mode === selection.mode) && session.permissionProfile === selection.permissionProfile
}
export function parseLaunchSpec(input: unknown): LaunchSpec {
  return checked(() => {
    const v = object(input)
    keys(v, ["version", "hostId", "agentId", "handlerGeneration", "providerGeneration", "leaseId", "launchAttemptId", "startCommandId", "selection", "modelIdentity", "resolvedModelId", "checkout", "catalogSnapshotId", "catalogEvidence", "configuration", "contractId", "contractFingerprint", "containment", "authority", "limits"])
    if (v.version !== 1 || v.modelIdentity !== "advertised" || v.resolvedModelId !== null || v.containment !== "direct-process-group-v1" || v.authority !== "normal-user" || !isDeepStrictEqual(v.limits, AGENT_LIMITS)) invalidAgent()
    const ids: AgentIds = { agentId: id(v.agentId), handlerGeneration: id(v.handlerGeneration), providerGeneration: id(v.providerGeneration), hostId: hash(v.hostId), leaseId: id(v.leaseId), launchAttemptId: id(v.launchAttemptId), startCommandId: id(v.startCommandId) }
    if (new Set([ids.agentId, ids.handlerGeneration, ids.providerGeneration, ids.leaseId, ids.launchAttemptId, ids.startCommandId]).size !== 6) invalidAgent()
    const checkout = parseAdmissionRecord({ version: 1, checkout: v.checkout, agentId: ids.agentId, handlerGeneration: ids.handlerGeneration, leaseId: ids.leaseId, launchAttemptId: ids.launchAttemptId }).checkout
    if (checkout.hostId !== ids.hostId) invalidAgent()
    const selection = parseSelection(v.selection)
    if (selection.mode === null) invalidAgent()
    const c = object(v.configuration); keys(c, ["fingerprint", "scope", "providerId", "adapterVersion", "sdkVersion"])
    if (c.scope !== "declared-config-v1") invalidAgent()
    const configuration: ConfigEvidence = { fingerprint: hash(c.fingerprint), scope: "declared-config-v1", providerId: providerId(c.providerId), adapterVersion: agentText(c.adapterVersion), sdkVersion: c.sdkVersion === null ? null : agentText(c.sdkVersion) }
    const catalogEvidence = parseProviderSnapshot(v.catalogEvidence)
    if (catalogEvidence.error !== null || catalogEvidence.verifiedAt === null || catalogEvidence.verifiedHandlerGeneration !== ids.handlerGeneration || catalogEvidence.providerId !== selection.providerId || configuration.providerId !== selection.providerId || configuration.fingerprint !== catalogEvidence.fingerprint || configuration.adapterVersion !== catalogEvidence.adapterVersion || configuration.sdkVersion !== catalogEvidence.sdkVersion) invalidAgent()
    const model = catalogEvidence.models.find(model => model.modelId === selection.modelId)
    if (!model || (selection.reasoning.kind === "none" ? model.reasoning.state !== "none" : model.reasoning.state !== "values" || !model.reasoning.values.includes(selection.reasoning.value))) invalidAgent()
    if (model.modes.state === "values" && !model.modes.values.includes(selection.mode)) invalidAgent()
    return { ...ids, version: 1, selection: { ...selection, mode: selection.mode }, checkout, modelIdentity: "advertised", resolvedModelId: null, catalogSnapshotId: id(v.catalogSnapshotId), catalogEvidence, configuration, contractId: agentText(v.contractId), contractFingerprint: hash(v.contractFingerprint), containment: "direct-process-group-v1", authority: "normal-user", limits: { ...AGENT_LIMITS } }
  })
}
export function parseAgentRecord(input: unknown): AgentRecord {
  return checked(() => {
    const v = object(input); keys(v, ["version", "spec", "phase", "session", "failure"])
    if (v.version !== 1 || !["starting", "ready", "stopping", "stopped", "failed", "interrupted"].includes(String(v.phase))) invalidAgent()
    const spec = parseLaunchSpec(v.spec), session = v.session === null ? null : parseSession(v.session), failure = v.failure === null ? null : parseAgentFailure(v.failure)
    if (v.phase === "ready" && session === null || v.phase === "starting" && session !== null) invalidAgent()
    if ((v.phase === "failed" || v.phase === "interrupted") !== (failure !== null)) invalidAgent()
    if (session && (!sessionMatches(session, spec.selection) || [spec.agentId, spec.providerGeneration, spec.handlerGeneration, spec.leaseId, spec.launchAttemptId, spec.startCommandId].includes(session.sessionGeneration))) invalidAgent()
    return { version: 1, spec, phase: v.phase as AgentPhase, session, failure }
  })
}
export function parseAgentCommand(input: unknown): AgentCommand {
  return checked(() => {
    const v = object(input); keys(v, ["version", "hostId", "commandId", "handlerGeneration", "input", "op", "target", "state", "result"])
    if (v.version !== 1 || (v.op !== "start" && v.op !== "stop") || !["pending", "completed", "interrupted"].includes(String(v.state))) invalidAgent()
    const commandId = id(v.commandId), handlerGeneration = id(v.handlerGeneration), request = v.op === "start" ? parseStartInput(v.input) : parseStopInput(v.input), target = v.target === null ? null : parseTuple(v.target)
    if (commandId !== request.commandId || handlerGeneration !== request.handlerGeneration || target !== null && target.handlerGeneration !== handlerGeneration) invalidAgent()
    if (v.op === "stop" && !isDeepStrictEqual(target, { agentId: (request as StopInput).agentId, handlerGeneration, providerGeneration: (request as StopInput).providerGeneration })) invalidAgent()
    let result: CommandResult | null = null
    if (v.result !== null) {
      const r = object(v.result); keys(r, ["outcome", "target", "failure", "session"])
      if (!["started", "stopped", "failed", "interrupted"].includes(String(r.outcome))) invalidAgent()
      result = { outcome: r.outcome as CommandResult["outcome"], target: r.target === null ? null : parseTuple(r.target), failure: r.failure === null ? null : parseAgentFailure(r.failure), session: r.session === null ? null : parseSession(r.session) }
      if (!isDeepStrictEqual(result.target, target) || (result.outcome === "failed" || result.outcome === "interrupted") !== (result.failure !== null)) invalidAgent()
      if (result.outcome === "started" && (v.op !== "start" || result.session === null || target === null)) invalidAgent()
      if (result.outcome === "stopped" && (v.op !== "stop" || target === null)) invalidAgent()
      if (v.op === "start" && result.session && !sessionMatches(result.session, (request as StartInput).selection)) invalidAgent()
    }
    if ((v.state === "pending") !== (result === null) || (v.state === "interrupted") !== (result?.outcome === "interrupted") || v.state === "pending" && target === null) invalidAgent()
    return { version: 1, hostId: hash(v.hostId), commandId, handlerGeneration, input: request, op: v.op, target, state: v.state as AgentCommand["state"], result }
  })
}