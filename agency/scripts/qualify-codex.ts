import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize } from "node:path"
import { createConnection, type Socket } from "node:net"
import { execFile } from "node:child_process"
import { isDeepStrictEqual, promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { observeArtifact, parseCodexQualificationManifest, qualificationFingerprint, renderQualifiedContractSource, verifyCodexQualification, type ArtifactPin, type CodexQualificationCandidate, type CodexQualificationManifest, type CodexQualificationObservation } from "../src/agent/qualification.js"
import { AGENT_CODES, AgentError, parseAgentCommand, parseAgentRecord, parseSession, tupleOf, type AgentCommand, type AgentRecord, type AgentTuple, type SessionEvidence } from "../src/agent/types.js"
import { AGENT_PROTOCOL, exchangeAgent, parseAgentReply, type AgentRequest } from "../src/agent/protocol.js"
import { createAgentStore } from "../src/agent/store.js"
import { providerStatePath } from "../src/agent/state.js"
import { inventoryAdmissions, parseAdmissionRecord, readAdmission, type AdmissionRecord } from "../src/checkout/records.js"
import { admissionInventoryIssues } from "../src/checkout/admission.js"
import { inventoryLaunches } from "../src/handler/inventory.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import { readHandlerRecord, readLaunchRecordForReconciliation, assertPrivateDirectory } from "../src/platform/private-state.js"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { readHostId } from "../src/platform/host-id.js"
import { startOrConnect, type HandlerCommand } from "../src/platform/singleton.js"
import { processBirthStart, sameProcess, sameProcessGeneration, type HandlerGenerationRecord, type LaunchRecord, type PlatformAdapter, type ProcessGroupIdentity, type ProcessIdentity } from "../src/platform/types.js"
import { PROTOCOL, uuid } from "../src/control/protocol.js"
import { exchange } from "../src/control/wire.js"
import type { PlatformPaths } from "../src/platform/paths.js"
import { observeQualificationDescriptors, QualificationObservationError, verifyQualificationAbsence, type DescriptorCommand, type DescriptorObservation, type ParentAbsence } from "./qualification-observation.js"

const METHODS = ["initialize", "session/new", "session/set_config_option:model", "session/set_config_option:reasoning_effort", "session/set_config_option:mode", "session/prompt"] as const
const PHASES = ["commandStart", "reservation", "spawn", "initialize", "session", "model", "reasoning", "mode", "prompt", "transportClose", "processTerminate", "absence", "overall"] as const
const FAILURES = [...AGENT_CODES, "EVIDENCE_PUBLICATION_FAILED", "EVIDENCE_MISSING", "OWNERSHIP_INVALID", "HANDLER_STARTUP_FAILED", "HANDLER_TERMINATED", "COMMAND_START_TIMEOUT", "OVERALL_TIMEOUT", "NORMAL_STATE_UNAVAILABLE", "USER_STATE_UNAVAILABLE", "NORMAL_STATE_CHANGED", "DESCRIPTOR_LEAK", "DESCRIPTOR_UNAVAILABLE", "ABSENCE_TIMEOUT", "ABSENCE_UNAVAILABLE", "PROCESS_SURVIVED", "REPORT_INVALID"] as const
type Failure = typeof FAILURES[number]
type Phase = typeof PHASES[number]
type Outcome = "completed" | "timed_out" | "failed" | "not_reached"
export type TreeObservation = { state: "absent" | "present"; digest: string; entries: number; bytes: number }
export type QualifiedOwnership = {
  handlerGeneration: string | null; agentId: string | null; providerGeneration: string | null; leaseId: string | null; launchAttemptId: string | null; sessionId: string | null
  handlers: readonly { generation: string; launchAttemptId: string; process: ProcessIdentity }[]
  providerProcessGroup: ProcessGroupIdentity | null
}
export type QualificationReceipt = {
  version: 1; handlerGeneration: string; launchAttemptId: string; methods: string[]; durations: Partial<Record<Phase, number>>
  prompt: PromptAttempt
  terminal: boolean; transportClosed: boolean; handlesClosed: boolean; failure: Failure | null
}
type PromptStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
export type PromptAttempt =
  | { state: "not_started"; challenge: null; prompt: null; answer: null; normalizedAnswer: null; stopReason: null; durationMs: null }
  | { state: "in_flight_failed"; challenge: string; prompt: string; answer: string; normalizedAnswer: string | null; stopReason: PromptStopReason | null; durationMs: number }
  | { state: "completed"; challenge: string; prompt: string; answer: string; normalizedAnswer: string; stopReason: PromptStopReason; durationMs: number }
type Retained = { command: AgentCommand | null; agent: AgentRecord | null; admission: AdmissionRecord | null; launch: LaunchRecord | null; handlers: HandlerGenerationRecord[]; recovery: { command: AgentCommand | null; agent: AgentRecord | null; launch: LaunchRecord | null; admission: AdmissionRecord | null; consistent: boolean } | null }
export type QualificationObservation = {
  candidate: CodexQualificationCandidate; verification: CodexQualificationObservation | null
  retained: Retained; receipt: QualificationReceipt | null; descriptors: DescriptorObservation | null; absence: ParentAbsence | null
  normalAgencyState: { before: TreeObservation[]; after: TreeObservation[] }
}
export type CodexQualificationReport = {
  version: 3; manifestFingerprint: string; branch: "moon/agency-agent-lifecycle"; commit: string; startedAt: string; endedAt: string; qualified: boolean; failure: Failure | null
  observation: QualificationObservation; protocol: { methods: readonly string[]; protocolVersion: 1 }
  prompt: PromptAttempt
  selection: { modelId: "gpt-5.6-sol"; reasoning: "high"; mode: "read-only" }; session: SessionEvidence | null
  authentication: "ambient_accepted" | "auth_required" | "failed" | "unknown"; ownership: QualifiedOwnership
  deadlines: Record<Phase, { limitMs: number; outcome: Outcome }>
  postconditions: {
    transport: "closed" | "open" | "unknown"; directChild: "terminal" | "live" | "unknown"; processGroup: "absent" | "present" | "unknown"
    reservation: "released" | "retained" | "unknown"; providerState: "absent" | "present" | "unknown"; qualificationCwd: "absent" | "present" | "unknown"
    executionRoot: "absent" | "present" | "unknown"; lifecycleOperation: "terminal" | "in_flight" | "unknown"; ownedHandles: "closed" | "open" | "unknown"
    handler: "absent" | "present" | "unknown"; catalogProfile: "absent" | "present" | "unknown"; normalAgencyState: "unchanged" | "changed" | "unknown"
  }
}
export type CodexQualificationOfflineReport = {
  version: 3; stage: "offline"; qualified: false
  candidate: CodexQualificationCandidate; verification: CodexQualificationObservation
}
export type OfflineCandidateDependencies = {
  observeArtifact?: typeof observeArtifact; verify?: typeof verifyCodexQualification
}
export type ReviewedRevision = { reviewedBranch: string; reviewedCommit: string }
export type QualificationRequest = ReviewedRevision & { candidatePath: string; evidenceParent: string; reportPath?: string }
export type QualificationResult = { report: CodexQualificationReport; reportPath: string | null; reportSha256: string | null }
export type QualificationDependencies = {
  adapter: PlatformAdapter; hostKey: string; verify: typeof verifyCodexQualification
  handler(candidatePath: string, executionRoot: string): HandlerCommand
  normalStatePaths: readonly string[]; createExecutionRoot(): Promise<string>
  publish?: typeof durableQualificationWrite; start?: typeof startOrConnect
  currentRevision?: typeof observeCurrentRevision; exchangeAgent?: typeof exchangeAgent
  descriptorCommand?: DescriptorCommand
  absenceAdapter?: Pick<PlatformAdapter, "readProcess" | "readGroup">
  beforeCleanup?: (root: string, report: CodexQualificationReport) => Promise<void>
}
class QualificationError extends Error { constructor(readonly code: Failure) { super(code) } }
function fail(code: Failure): never { throw new QualificationError(code) }
const classify = (error: unknown, fallback: Failure): Failure => error instanceof QualificationError || error instanceof AgentError || error instanceof QualificationObservationError ? error.code : fallback
const equal = (left: unknown, right: unknown, code: Failure = "OWNERSHIP_INVALID"): void => { if (!isDeepStrictEqual(left, right)) fail(code) }
function reviewedRevision(value: { reviewedBranch: unknown; reviewedCommit: unknown } | undefined): { branch: "moon/agency-agent-lifecycle"; commit: string } {
  if (value?.reviewedBranch !== "moon/agency-agent-lifecycle" || typeof value.reviewedCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.reviewedCommit) || value.reviewedCommit === "0".repeat(40)) fail("ADAPTER_UNQUALIFIED")
  return { branch: "moon/agency-agent-lifecycle", commit: value.reviewedCommit }
}
type RevisionCommand = (file: string, args: readonly string[], options: { cwd: string; encoding: "utf8"; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>
export async function observeCurrentRevision(execute: RevisionCommand = promisify(execFile) as RevisionCommand): Promise<{ branch: string; commit: string }> {
  const options = { cwd: "/Users/moon/.dotfiles/.worktrees/agency-agent-lifecycle", encoding: "utf8" as const, timeout: 5000, maxBuffer: 4096, env: { HOME: "/var/empty", LC_ALL: "C", PATH: "/usr/bin:/bin" } }
  const branchResult = await execute("/usr/bin/git", ["branch", "--show-current"], options)
  const commitResult = await execute("/usr/bin/git", ["rev-parse", "--verify", "HEAD"], options)
  if (branchResult.stderr !== "" || commitResult.stderr !== "" || !/^[^\0\r\n]+\n$/.test(branchResult.stdout) || !/^[0-9a-f]{40}\n$/.test(commitResult.stdout) || commitResult.stdout === "0".repeat(40) + "\n") fail("ADAPTER_UNQUALIFIED")
  return { branch: branchResult.stdout.slice(0, -1), commit: commitResult.stdout.slice(0, -1) }
}
async function requireCurrentRevision(deps: QualificationDependencies, reviewed: { branch: "moon/agency-agent-lifecycle"; commit: string }): Promise<void> {
  try { equal(await (deps.currentRevision ?? observeCurrentRevision)(), reviewed, "ADAPTER_UNQUALIFIED") }
  catch { fail("ADAPTER_UNQUALIFIED") }
}
function object(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) fail("REPORT_INVALID")
  return value as Record<string, unknown>
}
function text(value: unknown, max = 1024): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > max || !value.isWellFormed() || /[\x00-\x1f\x7f]/u.test(value)) fail("REPORT_INVALID")
  return value as string
}
function canonical(path: string): string { if (!isAbsolute(path) || normalize(path) !== path || path.endsWith("/")) fail("REPORT_INVALID"); return text(path, 4096) }
function identity(value: unknown): ProcessIdentity {
  const p = object(value, ["bootId", "pid", "birth", "parentPid", "processGroupId", "sessionId", "uid", "gid"])
  for (const key of ["pid", "parentPid", "processGroupId", "sessionId", "uid", "gid"]) if (!Number.isSafeInteger(p[key]) || (p[key] as number) < (["pid", "processGroupId", "sessionId"].includes(key) ? 2 : 0)) fail("OWNERSHIP_INVALID")
  text(p.bootId); if (processBirthStart(text(p.birth)) === null) fail("OWNERSHIP_INVALID")
  return structuredClone(p) as ProcessIdentity
}
export function validateQualifiedOwnership(value: unknown): QualifiedOwnership {
  const p = object(value, ["handlerGeneration", "agentId", "providerGeneration", "leaseId", "launchAttemptId", "sessionId", "handlers", "providerProcessGroup"])
  const ids = ["handlerGeneration", "agentId", "providerGeneration", "leaseId", "launchAttemptId"] as const
  for (const name of ids) if (p[name] !== null) uuid(p[name])
  const present = ids.map(name => p[name]).filter(v => v !== null)
  if (new Set(present).size !== present.length) fail("OWNERSHIP_INVALID")
  if (p.sessionId !== null) text(p.sessionId)
  if (!Array.isArray(p.handlers) || p.handlers.length > 2) fail("OWNERSHIP_INVALID")
  const handlers = (p.handlers as unknown[]).map(raw => {
    const h = object(raw, ["generation", "launchAttemptId", "process"]), process = identity(h.process)
    const generation = uuid(h.generation), launchAttemptId = uuid(h.launchAttemptId)
    if (process.pid !== process.processGroupId || process.pid !== process.sessionId || process.birth.slice(process.birth.indexOf(":") + 1) !== `agy-handler:${launchAttemptId}`) fail("OWNERSHIP_INVALID")
    return { generation, launchAttemptId, process }
  })
  if (new Set(handlers.map(h => h.generation)).size !== handlers.length || new Set(handlers.map(h => h.launchAttemptId)).size !== handlers.length || new Set(handlers.map(h => h.process.birth)).size !== handlers.length) fail("OWNERSHIP_INVALID")
  const generationIds = [...present, ...handlers.map(h => h.launchAttemptId), ...handlers.slice(1).map(h => h.generation)]
  if (new Set(generationIds).size !== generationIds.length) fail("OWNERSHIP_INVALID")
  if (p.handlerGeneration !== null && handlers[0]?.generation !== p.handlerGeneration) fail("OWNERSHIP_INVALID")
  let providerProcessGroup: ProcessGroupIdentity | null = null
  if (p.providerProcessGroup !== null) {
    const group = object(p.providerProcessGroup, ["leader", "observed"]), leader = identity(group.leader)
    if (!Array.isArray(group.observed) || group.observed.length === 0 || group.observed.length > 4096) fail("OWNERSHIP_INVALID")
    const observed = (group.observed as unknown[]).map(identity)
    if (!handlers[0] || leader.parentPid !== handlers[0].process.pid || leader.pid !== leader.processGroupId || leader.pid !== leader.sessionId || leader.birth.slice(leader.birth.indexOf(":") + 1) !== `agy-provider:${p.launchAttemptId}` || new Set(observed.map(p => p.pid)).size !== observed.length || !observed.some(p => isDeepStrictEqual(p, leader))) fail("OWNERSHIP_INVALID")
    if (leader.bootId !== handlers[0].process.bootId || leader.uid !== handlers[0].process.uid || leader.gid !== handlers[0].process.gid) fail("OWNERSHIP_INVALID")
    for (const p of observed) if (p.bootId !== leader.bootId || p.processGroupId !== leader.pid || p.sessionId !== leader.pid || p.uid !== leader.uid || p.gid !== leader.gid) fail("OWNERSHIP_INVALID")
    providerProcessGroup = { leader, observed }
  }
  return { handlerGeneration: p.handlerGeneration as string | null, agentId: p.agentId as string | null, providerGeneration: p.providerGeneration as string | null, leaseId: p.leaseId as string | null, launchAttemptId: p.launchAttemptId as string | null, sessionId: p.sessionId as string | null, handlers, providerProcessGroup }
}
export function parseQualificationCandidate(value: unknown): CodexQualificationCandidate {
  const v = object(value, ["version", "manifest", "fingerprint"]), manifest = parseCodexQualificationManifest(v.manifest)
  if (v.version !== 3 || v.fingerprint !== qualificationFingerprint(manifest)) fail("ADAPTER_UNQUALIFIED")
  return { version: 3, manifest, fingerprint: v.fingerprint as string }
}
const limits = (m: CodexQualificationManifest): Record<Phase, number> => ({ commandStart: m.deadlines.commandMs, reservation: m.deadlines.reservationMs, spawn: m.deadlines.spawnMs, initialize: m.deadlines.initializeMs, session: m.deadlines.sessionMs, model: m.deadlines.optionMs, reasoning: m.deadlines.optionMs, mode: m.deadlines.optionMs, prompt: m.deadlines.promptMs, transportClose: m.deadlines.transportCloseMs, processTerminate: m.deadlines.processTerminateMs, absence: m.deadlines.absenceMs, overall: m.deadlines.overallMs })
const success = { transport: "closed", directChild: "terminal", processGroup: "absent", reservation: "released", providerState: "absent", qualificationCwd: "absent", executionRoot: "absent", lifecycleOperation: "terminal", ownedHandles: "closed", handler: "absent", catalogProfile: "absent", normalAgencyState: "unchanged" } as const
function correlate(report: CodexQualificationReport): void {
  const { ownership: own, session, observation: { retained: e } } = report
  if (!e.command || !e.agent || !e.admission || !e.launch || !session) fail("OWNERSHIP_INVALID")
  const c = parseAgentCommand(e.command!), a = parseAgentRecord(e.agent!), d = parseAdmissionRecord(e.admission!), s = a.spec, l = e.launch!
  const selected = { providerId: "codex-acp", modelId: "gpt-5.6-sol", reasoning: { kind: "value", value: "high" }, mode: "read-only", permissionProfile: "deny-all" }
  equal(s.selection, selected); equal(c.input, { commandId: s.startCommandId, handlerGeneration: s.handlerGeneration, cwd: s.checkout.root.path, selection: selected })
  if (a.phase !== "ready" || c.state !== "completed" || c.result?.outcome !== "started" || c.commandId !== s.startCommandId || c.hostId !== s.hostId) fail("OWNERSHIP_INVALID")
  equal(c.target, tupleOf(s)); equal(c.result!.target, tupleOf(s)); equal(c.result!.session, session); equal(a.session, session)
  equal(d, { version: 1, checkout: s.checkout, agentId: s.agentId, handlerGeneration: s.handlerGeneration, leaseId: s.leaseId, launchAttemptId: s.launchAttemptId })
  for (const key of ["agentId", "handlerGeneration", "leaseId", "launchAttemptId"] as const) if (own[key] !== s[key] || l[key] !== s[key]) fail("OWNERSHIP_INVALID")
  if (own.providerGeneration !== s.providerGeneration || own.sessionId !== session!.sessionId || l.checkoutId !== s.checkout.checkoutId || !l.launchAttempted || l.phase !== "active") fail("OWNERSHIP_INVALID")
  equal(own.providerProcessGroup, l.provider?.group)
  equal(own.handlers, e.handlers.map(h => ({ generation: h.generation, launchAttemptId: h.launchAttemptId, process: h.process })))
  if (l.launchBootId !== own.providerProcessGroup?.leader.bootId || e.handlers.some(h => h.hostId !== s.hostId || h.launchBootId !== h.process?.bootId)) fail("OWNERSHIP_INVALID")
  if (s.contractFingerprint !== report.manifestFingerprint || s.contractId !== report.observation.candidate.manifest.contractId) fail("OWNERSHIP_INVALID")
}
function parseTree(value: unknown): TreeObservation {
  const t = object(value, ["state", "digest", "entries", "bytes"])
  if (!["absent", "present"].includes(String(t.state)) || !/^[a-f0-9]{64}$/.test(String(t.digest)) || !Number.isSafeInteger(t.entries) || (t.entries as number) < 0 || (t.entries as number) > 8192 || !Number.isSafeInteger(t.bytes) || (t.bytes as number) < 0 || (t.bytes as number) > 268435456) fail("REPORT_INVALID")
  return t as TreeObservation
}
export function parseQualificationReceipt(value: unknown, manifest: CodexQualificationManifest): QualificationReceipt {
  const r = object(value, ["version", "handlerGeneration", "launchAttemptId", "methods", "durations", "prompt", "terminal", "transportClosed", "handlesClosed", "failure"])
  if (r.version !== 1 || !Array.isArray(r.methods) || r.methods.length > 6 || r.methods.some((m, i) => m !== METHODS[i])) fail("REPORT_INVALID")
  uuid(r.handlerGeneration); uuid(r.launchAttemptId)
  for (const name of ["terminal", "transportClosed", "handlesClosed"]) if (typeof r[name] !== "boolean") fail("REPORT_INVALID")
  if (!r.durations || typeof r.durations !== "object" || Array.isArray(r.durations) || Object.entries(r.durations).some(([key, value]) => !PHASES.includes(key as Phase) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > (key === "overall" ? manifest.deadlines.overallMs : key === "prompt" ? manifest.deadlines.promptMs : 120000))) fail("REPORT_INVALID")
  parsePromptAttempt(r.prompt, manifest)
  if (r.failure !== null && !FAILURES.includes(r.failure as Failure)) fail("REPORT_INVALID")
  return structuredClone(r) as QualificationReceipt
}
function validateVerification(value: unknown, candidate: CodexQualificationCandidate): void {
  const observed = object(value, ["version", "manifest", "fingerprint", "nodeVersion", "selection", "artifacts"])
  equal(observed, { ...candidate, nodeVersion: candidate.manifest.nodeVersion, selection: candidate.manifest.selection, artifacts: { adapterPackageJson: candidate.manifest.adapterPackageJson, adapterEntrypoint: candidate.manifest.adapterEntrypoint, codexExecutable: candidate.manifest.codexExecutable, nodeExecutable: candidate.manifest.nodeExecutable } }, "REPORT_INVALID")
}
function promptText(value: unknown, max: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || !value.isWellFormed() || value.includes("\0")) fail("REPORT_INVALID")
  return value
}
function parsePromptAttempt(value: unknown, manifest: CodexQualificationManifest): PromptAttempt {
  const p = object(value, ["state", "challenge", "prompt", "answer", "normalizedAnswer", "stopReason", "durationMs"])
  if (p.state === "not_started") {
    if ([p.challenge, p.prompt, p.answer, p.normalizedAnswer, p.stopReason, p.durationMs].some(value => value !== null)) fail("REPORT_INVALID")
    return structuredClone(p) as PromptAttempt
  }
  if (p.state !== "in_flight_failed" && p.state !== "completed") fail("REPORT_INVALID")
  if (typeof p.challenge !== "string" || !/^AGENCY_CODEX_SMOKE_[0-9a-f]{32}$/.test(p.challenge)) fail("REPORT_INVALID")
  const expectedPrompt = `Return exactly this token and no other text:\n${p.challenge}\n\nDo not inspect files or use tools.`
  if (p.prompt !== expectedPrompt) fail("REPORT_INVALID")
  const answer = promptText(p.answer, manifest.prompt.answerBytes)
  if (typeof p.durationMs !== "number" || !Number.isFinite(p.durationMs) || p.durationMs < 0 || p.durationMs > manifest.deadlines.overallMs) fail("REPORT_INVALID")
  const reasons = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]
  if (p.state === "in_flight_failed") {
    if (p.normalizedAnswer !== null || p.stopReason !== null) fail("REPORT_INVALID")
  } else {
    if (p.normalizedAnswer !== answer.trim() || !reasons.includes(String(p.stopReason))) fail("REPORT_INVALID")
  }
  return structuredClone(p) as PromptAttempt
}
function promptDeadlineOutcome(prompt: PromptAttempt, limitMs: number): Outcome {
  if (prompt.state === "not_started") return "not_reached"
  if (prompt.durationMs >= limitMs) return "timed_out"
  return prompt.state === "completed" ? "completed" : "failed"
}
export function parseCodexQualificationReport(value: unknown): CodexQualificationReport {
  if (Buffer.byteLength(JSON.stringify(value)) > 1048576) fail("REPORT_INVALID")
  const r = object(value, ["version", "manifestFingerprint", "branch", "commit", "startedAt", "endedAt", "qualified", "failure", "observation", "protocol", "prompt", "selection", "session", "authentication", "ownership", "deadlines", "postconditions"])
  if (r.version !== 3 || r.branch !== "moon/agency-agent-lifecycle" || !/^[0-9a-f]{40}$/.test(String(r.commit)) || typeof r.qualified !== "boolean" || (r.failure !== null && (!FAILURES.includes(r.failure as Failure) || r.failure === "USER_STATE_UNAVAILABLE"))) fail("REPORT_INVALID")
  for (const key of ["startedAt", "endedAt"]) if (new Date(text(r[key])).toISOString() !== r[key]) fail("REPORT_INVALID")
  if (String(r.endedAt) < String(r.startedAt)) fail("REPORT_INVALID")
  const o = object(r.observation, ["candidate", "verification", "retained", "receipt", "descriptors", "absence", "normalAgencyState"])
  const candidate = parseQualificationCandidate(o.candidate)
  if (r.manifestFingerprint !== candidate.fingerprint) fail("REPORT_INVALID")
  if (o.verification !== null) validateVerification(o.verification, candidate)
  const retained = object(o.retained, ["command", "agent", "admission", "launch", "handlers", "recovery"])
  if (retained.command !== null) parseAgentCommand(retained.command)
  if (retained.agent !== null) parseAgentRecord(retained.agent)
  if (retained.admission !== null) parseAdmissionRecord(retained.admission)
  if (!Array.isArray(retained.handlers) || retained.handlers.length > 2) fail("REPORT_INVALID")
  for (const raw of retained.handlers as unknown[]) {
    const h = object(raw, ["version", "hostId", "launchBootId", "generation", "launchAttemptId", "launchAttempted", "phase", "process", "socketPath", "writer", "reconciliation", "reason"])
    if (h.version !== 1 || !/^[0-9a-f]{64}$/.test(String(h.hostId)) || typeof h.launchAttempted !== "boolean" || !["launch_pending", "identity_published", "socket_bound", "reconciling", "ready", "exited_unverified"].includes(String(h.phase)) || !["launcher", "handler", "reconciler"].includes(String(h.writer))) fail("REPORT_INVALID")
    uuid(h.generation); uuid(h.launchAttemptId); text(h.launchBootId); canonical(text(h.socketPath)); if (h.process !== null) identity(h.process)
    if (h.reason !== null) text(h.reason, 512)
    if (h.reconciliation !== null) { const counts = object(h.reconciliation, ["classified", "total", "quarantined"]); if (Object.values(counts).some(n => !Number.isSafeInteger(n) || (n as number) < 0) || (counts.classified as number) > (counts.total as number) || (counts.quarantined as number) > (counts.classified as number)) fail("REPORT_INVALID") }
  }
  if (retained.launch !== null) {
    if (retained.agent === null) fail("REPORT_INVALID")
    const agent = parseAgentRecord(retained.agent)
    parseAgentReply({ protocol: AGENT_PROTOCOL, requestId: agent.spec.startCommandId, handlerGeneration: agent.spec.handlerGeneration, ok: true, result: { state: "agents", agents: [{ record: agent, launch: retained.launch, live: false, cleanup: "unverified" }], unavailable: null } })
  }
  if (retained.recovery !== null) {
    const recovery = object(retained.recovery, ["command", "agent", "launch", "admission", "consistent"])
    if (typeof recovery.consistent !== "boolean") fail("REPORT_INVALID")
    if (recovery.command !== null) parseAgentCommand(recovery.command)
    if (recovery.agent !== null) parseAgentRecord(recovery.agent)
    if (recovery.admission !== null) parseAdmissionRecord(recovery.admission)
    if (recovery.launch !== null) {
      if (recovery.agent === null) fail("REPORT_INVALID")
      const agent = parseAgentRecord(recovery.agent)
      parseAgentReply({ protocol: AGENT_PROTOCOL, requestId: agent.spec.startCommandId, handlerGeneration: agent.spec.handlerGeneration, ok: true, result: { state: "agents", agents: [{ record: agent, launch: recovery.launch, live: false, cleanup: "unverified" }], unavailable: null } })
    }
  }
  const receipt = o.receipt === null ? null : parseQualificationReceipt(o.receipt, candidate.manifest)
  for (const key of ["normalAgencyState"]) {
    const pair = object(o[key], ["before", "after"])
    for (const side of ["before", "after"]) { if (!Array.isArray(pair[side]) || (pair[side] as unknown[]).length > 2) fail("REPORT_INVALID"); (pair[side] as unknown[]).forEach(parseTree) }
  }
  const protocol = object(r.protocol, ["methods", "protocolVersion"])
  if (protocol.protocolVersion !== 1 || !Array.isArray(protocol.methods) || protocol.methods.length > 6 || protocol.methods.some((m, i) => m !== METHODS[i])) fail("REPORT_INVALID")
  const prompt = parsePromptAttempt(r.prompt, candidate.manifest)
  const promptAttempted = prompt.state !== "not_started", protocolPrompt = protocol.methods.at(-1) === "session/prompt"
  if (promptAttempted !== protocolPrompt) fail("REPORT_INVALID")
  if (receipt === null) {
    if (protocol.methods.length !== 0 || promptAttempted) fail("REPORT_INVALID")
  } else {
    equal(receipt.methods, protocol.methods, "REPORT_INVALID")
    equal(receipt.prompt, prompt, "REPORT_INVALID")
    const receiptPrompt = receipt.methods.at(-1) === "session/prompt"
    if (receiptPrompt !== promptAttempted) fail("REPORT_INVALID")
    if (prompt.state === "completed") {
      if (receipt.durations.prompt !== prompt.durationMs) fail("REPORT_INVALID")
    } else if (prompt.state === "in_flight_failed") {
      if (receipt.durations.prompt !== undefined && receipt.durations.prompt !== prompt.durationMs) fail("REPORT_INVALID")
    } else if (Object.hasOwn(receipt.durations, "prompt")) fail("REPORT_INVALID")
  }
  equal(r.selection, { modelId: "gpt-5.6-sol", reasoning: "high", mode: "read-only" }, "REPORT_INVALID")
  const session = r.session === null ? null : parseSession(r.session), ownership = validateQualifiedOwnership(r.ownership)
  if (o.descriptors !== null) validateDescriptorObservation(o.descriptors, ownership, candidate.manifest.deadlines.commandMs)
  if (o.absence !== null) validateAbsenceObservation(o.absence, candidate.manifest.deadlines.absenceMs)
  if (!["ambient_accepted", "auth_required", "failed", "unknown"].includes(String(r.authentication))) fail("REPORT_INVALID")
  const deadlines = object(r.deadlines, PHASES), expectedLimits = limits(candidate.manifest)
  for (const name of PHASES) { const d = object(deadlines[name], ["limitMs", "outcome"]); if (d.limitMs !== expectedLimits[name] || !["completed", "timed_out", "failed", "not_reached"].includes(String(d.outcome))) fail("REPORT_INVALID") }
  if ((deadlines.prompt as { outcome: unknown }).outcome !== promptDeadlineOutcome(receipt?.prompt ?? prompt, expectedLimits.prompt)) fail("REPORT_INVALID")
  const post = object(r.postconditions, Object.keys(success))
  const opposites = { transport: "open", directChild: "live", processGroup: "present", reservation: "retained", providerState: "present", qualificationCwd: "present", executionRoot: "present", lifecycleOperation: "in_flight", ownedHandles: "open", handler: "present", catalogProfile: "present", normalAgencyState: "changed" }
  for (const key of Object.keys(success) as Array<keyof typeof success>) if (![success[key], opposites[key], "unknown"].includes(String(post[key]))) fail("REPORT_INVALID")
  const report = structuredClone({ ...r, ownership, session, prompt }) as CodexQualificationReport
  if (report.qualified) {
    if (report.observation.verification === null) fail("REPORT_INVALID")
    if (report.failure !== null || report.authentication !== "ambient_accepted" || session === null || ownership.handlers.length !== 1 || ownership.providerProcessGroup === null || retained.recovery !== null || Object.entries(ownership).some(([, v]) => v === null)) fail("REPORT_INVALID")
    if (prompt.state !== "completed" || prompt.stopReason !== "end_turn" || prompt.durationMs >= candidate.manifest.deadlines.promptMs || prompt.normalizedAnswer !== prompt.challenge) fail("REPORT_INVALID")
    equal({ modelId: session!.modelId, reasoning: session!.reasoning, mode: session!.mode, permissionProfile: session!.permissionProfile, permissionEvidence: session!.permissionEvidence }, { modelId: "gpt-5.6-sol", reasoning: { kind: "value", value: "high" }, mode: "read-only", permissionProfile: "deny-all", permissionEvidence: "agency-deny-all-v1" }, "REPORT_INVALID")
    equal(post, success, "REPORT_INVALID"); equal(protocol.methods, METHODS, "REPORT_INVALID")
    if (PHASES.some(name => report.deadlines[name].outcome !== "completed")) fail("REPORT_INVALID")
    const receipt = report.observation.receipt
    if (!receipt || !receipt.terminal || !receipt.transportClosed || !receipt.handlesClosed || receipt.failure !== null || receipt.handlerGeneration !== ownership.handlerGeneration || receipt.launchAttemptId !== ownership.launchAttemptId) fail("REPORT_INVALID")
    equal(receipt.methods, METHODS, "REPORT_INVALID")
    for (const name of PHASES.filter(name => name !== "absence")) if (receipt.durations[name] === undefined || receipt.durations[name]! >= expectedLimits[name]) fail("REPORT_INVALID")
    const descriptors = report.observation.descriptors, absence = report.observation.absence
    if (!descriptors || descriptors.outcome !== "verified" || !absence || absence.outcome !== "completed" || absence.passes !== 2 || absence.handler !== "absent" || absence.provider !== "absent" || absence.durationMs >= expectedLimits.absence) fail("REPORT_INVALID")
    const targets = [...ownership.handlers.map(h => h.process), ...ownership.providerProcessGroup!.observed].sort((a, b) => a.pid - b.pid)
    equal([...absence.targets].sort((a, b) => a.pid - b.pid), targets, "REPORT_INVALID")
    const normal = report.observation.normalAgencyState
    if (!normal.before.length) fail("REPORT_INVALID")
    equal(normal.before, normal.after, "REPORT_INVALID")
    correlate(report)
  } else if (report.failure === null) fail("REPORT_INVALID")
  return report
}
function validateDescriptorObservation(value: unknown, ownership: QualifiedOwnership, limitMs: number): void {
  const d = object(value, ["outcome", "durationMs", "processes"])
  if (!["verified", "leaked"].includes(String(d.outcome)) || typeof d.durationMs !== "number" || !Number.isFinite(d.durationMs) || d.durationMs < 0 || d.durationMs >= limitMs || !Array.isArray(d.processes) || d.processes.length < 3 || d.processes.length > 4098) fail("REPORT_INVALID")
  const processes = d.processes.map(raw => {
    const p = object(raw, ["process", "role", "descriptors"]), process = identity(p.process)
    if (!["handler", "adapter", "child"].includes(String(p.role)) || !Array.isArray(p.descriptors) || p.descriptors.length < 3 || p.descriptors.length > 256) fail("REPORT_INVALID")
    const descriptors = p.descriptors.map(raw => {
      const fd = object(raw, ["fd", "type", "allowed"])
      if (!Number.isSafeInteger(fd.fd) || (fd.fd as number) < 0 || (fd.fd as number) > 999999 || !["REG", "DIR", "PIPE", "unix", "CHR", "KQUEUE", "IPv4", "IPv6", "PSXSEM", "PSXSHM"].includes(String(fd.type)) || typeof fd.allowed !== "boolean") fail("REPORT_INVALID")
      if (fd.allowed && !((fd.fd as number) <= 2 && (["PIPE", "unix"].includes(String(fd.type)) || p.role === "handler" && fd.type === "CHR") || p.role === "handler" && (fd.fd as number) <= 4 && ["PIPE", "unix"].includes(String(fd.type)))) fail("REPORT_INVALID")
      return fd
    })
    if (new Set(descriptors.map(d => d.fd)).size !== descriptors.length || [0, 1, 2].some(fd => !descriptors.some(d => d.fd === fd))) fail("REPORT_INVALID")
    if (p.role === "handler") { if (!ownership.handlers.some(h => isDeepStrictEqual(h.process, process))) fail("REPORT_INVALID") }
    else {
      const group = ownership.providerProcessGroup
      if (!group || process.bootId !== group.leader.bootId || process.processGroupId !== group.leader.pid || process.sessionId !== group.leader.pid || process.uid !== group.leader.uid || process.gid !== group.leader.gid || p.role === "adapter" && !isDeepStrictEqual(process, group.leader) || p.role === "child" && process.pid === group.leader.pid) fail("REPORT_INVALID")
    }
    return { process, role: p.role, descriptors }
  })
  if (new Set(processes.map(p => p.process.pid)).size !== processes.length || processes.filter(p => p.role === "handler").length !== ownership.handlers.length || processes.filter(p => p.role === "adapter").length !== 1 || !processes.some(p => p.role === "child")) fail("REPORT_INVALID")
  const retained = [...ownership.handlers.map(h => h.process), ...ownership.providerProcessGroup!.observed]
  equal(processes.map(p => p.process).sort((a, b) => a.pid - b.pid), retained.sort((a, b) => a.pid - b.pid), "REPORT_INVALID")
  for (const child of processes.filter(p => p.role === "child")) { let current = child, visited = new Set<number>(); while (current.role !== "adapter") { if (visited.has(current.process.pid)) fail("REPORT_INVALID"); visited.add(current.process.pid); const parent = processes.find(p => p.process.pid === current.process.parentPid && p.role !== "handler"); if (!parent) fail("REPORT_INVALID"); current = parent } }
  if ((d.outcome === "verified") !== processes.every(p => p.descriptors.every(fd => fd.allowed))) fail("REPORT_INVALID")
}
function validateAbsenceObservation(value: unknown, limitMs: number): void {
  const a = object(value, ["limitMs", "durationMs", "outcome", "passes", "targets", "groups", "handler", "provider"])
  if (a.limitMs !== limitMs || typeof a.durationMs !== "number" || !Number.isFinite(a.durationMs) || a.durationMs < 0 || !["completed", "timed_out", "failed"].includes(String(a.outcome)) || !Number.isSafeInteger(a.passes) || (a.passes as number) < 0 || (a.passes as number) > 2 || !Array.isArray(a.targets) || a.targets.length > 4100 || !Array.isArray(a.groups) || a.groups.length > 3 || !["absent", "present", "unknown"].includes(String(a.handler)) || !["absent", "present", "unknown"].includes(String(a.provider))) fail("REPORT_INVALID")
  const targets = a.targets.map(identity)
  if (new Set(targets.map(p => p.pid)).size !== targets.length) fail("REPORT_INVALID")
  equal(a.groups, [...new Set(targets.map(p => p.processGroupId))].sort((a, b) => a - b), "REPORT_INVALID")
  if (a.outcome === "completed" && (a.passes !== 2 || a.durationMs >= limitMs || a.handler !== "absent" || a.provider !== "absent")) fail("REPORT_INVALID")
}
export function renderPublishedQualificationSource(candidate: CodexQualificationCandidate, value: unknown, suppliedReportSha256: string, observedReportSha256: string, revision: ReviewedRevision): string {
  const reviewed = reviewedRevision(revision)
  const report = parseCodexQualificationReport(value)
  equal({ branch: report.branch, commit: report.commit }, reviewed, "ADAPTER_UNQUALIFIED")
  if (!report.qualified) fail("ADAPTER_UNQUALIFIED")
  equal(report.observation.candidate, candidate, "ADAPTER_UNQUALIFIED")
  if (!/^[0-9a-f]{64}$/.test(suppliedReportSha256) || !/^[0-9a-f]{64}$/.test(observedReportSha256) || !timingSafeEqual(Buffer.from(suppliedReportSha256, "hex"), Buffer.from(observedReportSha256, "hex"))) fail("EVIDENCE_PUBLICATION_FAILED")
  return renderQualifiedContractSource(candidate, { qualified: true, manifestFingerprint: report.manifestFingerprint })
}
export function qualificationPaths(root: string, hostKey: string): PlatformPaths {
  canonical(root); if (!/^[a-f0-9]{64}$/.test(hostKey)) fail("REPORT_INVALID")
  const paths = { hostKey, persistentRoot: join(root, "state"), runtimeRoot: join(root, "runtime"), handlerSocketPath: join(root, "runtime/handler.sock") }
  if (Buffer.byteLength(paths.handlerSocketPath) >= 100) fail("REPORT_INVALID")
  return paths
}
async function syncDirectory(path: string): Promise<void> { const f = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await f.sync() } finally { await f.close() } }
export async function durableQualificationWrite(path: string, value: unknown, io: { open: typeof open } = { open }): Promise<void> {
  canonical(path); await assertPrivateDirectory(dirname(path))
  const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > 1048576) fail("EVIDENCE_PUBLICATION_FAILED")
  const f = await io.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await f.writeFile(bytes); await f.sync() } finally { await f.close() }
  const parent = await io.open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await parent.sync() } finally { await parent.close() }
  equal(await readPrivateJson(path), value, "EVIDENCE_PUBLICATION_FAILED")
}
export async function readPrivateJson(path: string): Promise<unknown> {
  return (await readPrivateJsonWithDigest(path, 1048576)).value
}
export async function readPrivateJsonWithDigest(path: string, maxBytes: number): Promise<{ value: unknown; sha256: string }> {
  canonical(path)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) fail("EVIDENCE_MISSING")
  if (await realpath(path) !== path) fail("EVIDENCE_MISSING")
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes: Buffer | undefined
  try {
    const before = await f.stat({ bigint: true })
    if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o777n) !== 0o600n || before.nlink !== 1n || before.size > BigInt(maxBytes)) fail("EVIDENCE_MISSING")
    bytes = Buffer.alloc(Number(before.size))
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await f.read(bytes, length, bytes.length - length, length)
      if (bytesRead <= 0 || bytesRead > bytes.length - length) fail("EVIDENCE_MISSING")
      length += bytesRead
    }
    equal(statIdentity(await f.stat({ bigint: true })), statIdentity(before), "EVIDENCE_MISSING")
    equal(statIdentity(await lstat(path, { bigint: true })), statIdentity(before), "EVIDENCE_MISSING")
    if (await realpath(path) !== path) fail("EVIDENCE_MISSING")
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), sha256: createHash("sha256").update(bytes).digest("hex") }
  } finally { bytes?.fill(0); await f.close() }
}
const statIdentity = (s: BigIntStats): ArtifactPin["identity"] => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.gid, s.nlink].map(String) as unknown as ArtifactPin["identity"]
export async function snapshotTree(path: string, allowSockets = false): Promise<TreeObservation> {
  canonical(path)
  let initial: BigIntStats
  try { initial = await lstat(path, { bigint: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", digest: createHash("sha256").update("absent").digest("hex"), entries: 0, bytes: 0 }; fail("USER_STATE_UNAVAILABLE") }
  let entries = 0, bytes = 0
  const hash = createHash("sha256")
  async function visit(current: string, relative: string, before: BigIntStats): Promise<void> {
    if (++entries > 8192 || before.isSymbolicLink() || !before.isFile() && !before.isDirectory() && !(allowSockets && before.isSocket()) || await realpath(current) !== current) fail("USER_STATE_UNAVAILABLE")
    hash.update(JSON.stringify([relative, statIdentity(before)]))
    if (before.isDirectory()) {
      const names = (await readdir(current)).sort()
      if (entries + names.length > 8192) fail("USER_STATE_UNAVAILABLE")
      for (const name of names) await visit(join(current, name), relative + "/" + name, await lstat(join(current, name), { bigint: true }))
      equal(names, (await readdir(current)).sort(), "USER_STATE_UNAVAILABLE")
    } else if (before.isFile()) {
      if (before.nlink !== 1n || before.size > BigInt(268435456 - bytes)) fail("USER_STATE_UNAVAILABLE")
      const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        equal(statIdentity(await file.stat({ bigint: true })), statIdentity(before), "USER_STATE_UNAVAILABLE")
        let read = 0
        for await (const chunk of file.createReadStream({ autoClose: false })) { bytes += chunk.length; read += chunk.length; if (bytes > 268435456) fail("USER_STATE_UNAVAILABLE"); hash.update(chunk) }
        if (BigInt(read) !== before.size) fail("USER_STATE_UNAVAILABLE")
        equal(statIdentity(await file.stat({ bigint: true })), statIdentity(before), "USER_STATE_UNAVAILABLE")
      } finally { await file.close() }
    }
    equal(statIdentity(await lstat(current, { bigint: true })), statIdentity(before), "USER_STATE_UNAVAILABLE")
  }
  try { await visit(path, "", initial) } catch { fail("USER_STATE_UNAVAILABLE") }
  return { state: "present", digest: hash.digest("hex"), entries, bytes }
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error } }
async function within<T>(operation: Promise<T>, ms: number, code: Failure): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new QualificationError(code)), Math.max(1, ms)) })]) } finally { clearTimeout(timer) }
}
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 25))
async function observe<T>(operation: () => Promise<T>): Promise<T> {
  const end = performance.now() + 1000
  while (true) { try { return await operation() } catch (error) { if (!(error instanceof Error) || !error.name.endsWith("ObservationUnavailable") || performance.now() >= end) throw error; await delay() } }
}
async function terminal(adapter: PlatformAdapter, p: ProcessIdentity): Promise<boolean> { const actual = await observe(() => adapter.readProcess(p.pid)); return actual === null || !sameProcessGeneration(p, actual) }
async function absentGroup(adapter: PlatformAdapter, group: ProcessGroupIdentity): Promise<boolean> {
  const result = await verifyQualificationAbsence(adapter, [], group, [], 2000)
  if (result.outcome === "timed_out") fail("ABSENCE_TIMEOUT")
  if (result.outcome === "failed" && result.provider !== "present") fail("ABSENCE_UNAVAILABLE")
  return result.outcome === "completed"
}
async function terminateHandler(adapter: PlatformAdapter, p: ProcessIdentity): Promise<void> {
  const current = await adapter.readProcess(p.pid)
  if (current === null) return
  if (!sameProcess(p, current)) fail("OWNERSHIP_INVALID")
  await adapter.signalGroup(p.processGroupId, "SIGKILL")
}
async function defaultDependencies(): Promise<QualificationDependencies> {
  if (process.platform !== "darwin") fail("ADAPTER_UNQUALIFIED")
  const hostKey = await readHostId("darwin")
  return { adapter: createDarwinAdapter(), hostKey, verify: verifyCodexQualification,
    handler: (candidatePath, root) => ({ file: process.execPath, args: [fileURLToPath(new URL("./qualify-codex-handler.js", import.meta.url)), candidatePath, root], env: { ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])), PATH: "/usr/bin:/bin", HOME: root } }),
    normalStatePaths: [join(process.env.XDG_STATE_HOME ?? "/Users/moon/.local/state", "agency/hosts", hostKey), `/private/tmp/agy-${process.getuid!()}-${hostKey.slice(0, 12)}`],
    createExecutionRoot: () => mkdtemp("/private/tmp/agyq-"),
    currentRevision: observeCurrentRevision,
  }
}

async function evidenceDirectory(parent: string): Promise<string> {
  canonical(parent)
  const stat = await lstat(parent)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.mode & 0o022 || await realpath(parent) !== parent) fail("EVIDENCE_PUBLICATION_FAILED")
  const directory = join(parent, "codex-qualification")
  try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
  await assertPrivateDirectory(directory); await syncDirectory(parent)
  return directory
}
export async function runCodexQualification(request: QualificationRequest, dependencies?: QualificationDependencies): Promise<QualificationResult> {
  const revision = reviewedRevision(request)
  if (request.reportPath !== undefined) canonical(request.reportPath)
  const candidate = parseQualificationCandidate(await readPrivateJson(request.candidatePath))
  const deps = dependencies ?? await defaultDependencies(), publish = deps.publish ?? durableQualificationWrite
  await requireCurrentRevision(deps, revision)
  const directory = await evidenceDirectory(request.evidenceParent)
  const evidence = await mkdtemp(join(directory, "attempt-"))
  await syncDirectory(directory)
  const git = promisify(execFile)
  const report: CodexQualificationReport = {
    version: 3, manifestFingerprint: candidate.fingerprint, ...revision, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), qualified: false, failure: null,
    observation: { candidate, verification: null, retained: { command: null, agent: null, admission: null, launch: null, handlers: [], recovery: null }, receipt: null, descriptors: null, absence: null, normalAgencyState: { before: [], after: [] } },
    prompt: { state: "not_started", challenge: null, prompt: null, answer: null, normalizedAnswer: null, stopReason: null, durationMs: null },
    protocol: { protocolVersion: 1, methods: [] }, selection: { modelId: "gpt-5.6-sol", reasoning: "high", mode: "read-only" }, session: null, authentication: "unknown",
    ownership: { handlerGeneration: null, agentId: null, providerGeneration: null, leaseId: null, launchAttemptId: null, sessionId: null, handlers: [], providerProcessGroup: null },
    deadlines: Object.fromEntries(PHASES.map(name => [name, { limitMs: limits(candidate.manifest)[name], outcome: "not_reached" }])) as CodexQualificationReport["deadlines"],
    postconditions: Object.fromEntries(Object.keys(success).map(name => [name, "unknown"])) as CodexQualificationReport["postconditions"],
  }
  let root: string | undefined, paths: PlatformPaths | undefined, rootIdentity: { dev: bigint; ino: bigint } | undefined
  let current: HandlerGenerationRecord | undefined, target: AgentTuple | null = null, commandId: string | undefined, startSent = false, stopSent = false, recovered = false, handlerInvoked = false
  let overallStart = performance.now(), overallDeadline = Infinity
  const parentDurations: QualificationReceipt["durations"] = {}
  const handlerOwners: HandlerGenerationRecord[] = []
  let cleanupLaunch: LaunchRecord | undefined
  const sockets = new Set<Socket>(), retained = report.observation.retained
  const setFailure = (error: unknown, fallback: Failure): void => { report.failure ??= classify(error, fallback) }
  let preflightComplete = false
  async function observeNormal(side: "before" | "after"): Promise<void> {
    try { report.observation.normalAgencyState[side] = await Promise.all(deps.normalStatePaths.map(path => snapshotTree(path, true))) }
    catch { report.postconditions.normalAgencyState = "unknown"; fail("NORMAL_STATE_UNAVAILABLE") }
    if (side === "after") {
      report.postconditions.normalAgencyState = isDeepStrictEqual(report.observation.normalAgencyState.before, report.observation.normalAgencyState.after) ? "unchanged" : "changed"
      if (report.postconditions.normalAgencyState === "changed") fail("NORMAL_STATE_CHANGED")
    }
  }
  const budget = (): number => { const remaining = overallDeadline - performance.now(); if (remaining <= 0) { report.deadlines.overall.outcome = "timed_out"; fail("OVERALL_TIMEOUT") }; return Math.min(remaining, candidate.manifest.deadlines.commandMs) }
  const keepHandler = (h: HandlerGenerationRecord): void => {
    if (!h.process || h.hostId !== deps.hostKey || h.socketPath !== paths!.handlerSocketPath || !h.launchAttempted) fail("OWNERSHIP_INVALID")
    if (!retained.handlers.some(previous => previous.generation === h.generation)) {
      retained.handlers.push(structuredClone(h))
      handlerOwners.push(structuredClone(h))
      report.ownership.handlers = retained.handlers.map(h => ({ generation: h.generation, launchAttemptId: h.launchAttemptId, process: structuredClone(h.process!) }))
      report.ownership.handlerGeneration ??= h.generation
      validateQualifiedOwnership(report.ownership)
    } else {
      const previous = retained.handlers.find(previous => previous.generation === h.generation)!
      equal(previous.process, h.process); equal(previous.launchAttemptId, h.launchAttemptId)
      retained.handlers[retained.handlers.indexOf(previous)] = structuredClone(h)
    }
    current = h
  }
  async function launchHandler(): Promise<void> {
    try {
      const inspection = await (deps.start ?? startOrConnect)({ root: paths!.runtimeRoot, hostId: deps.hostKey, adapter: deps.adapter, handler: deps.handler(request.candidatePath, root!), timeoutMs: candidate.manifest.deadlines.commandMs,
        async onTransition(transition) { if (transition === "handler_spawned") handlerInvoked = true; if (transition === "identity_published") keepHandler(await readHandlerRecord(join(paths!.runtimeRoot, "handler.json"))) },
      })
      if (inspection.disposition !== "live") fail("HANDLER_STARTUP_FAILED")
      keepHandler(inspection.record)
    } catch (error) {
      const h = await readHandlerRecord(join(paths!.runtimeRoot, "handler.json")).catch(() => null)
      if (h?.process) keepHandler(h)
      throw error
    }
  }
  type QualificationAgentOperation =
    | Omit<Extract<AgentRequest, { op: "agent_start" }>, "protocol" | "requestId" | "handlerGeneration">
    | Omit<Extract<AgentRequest, { op: "agent_stop" }>, "protocol" | "requestId" | "handlerGeneration">
    | Omit<Extract<AgentRequest, { op: "agent_prompt" }>, "protocol" | "requestId" | "handlerGeneration">
    | { op: "agent_list" }
    | { op: "agent_command"; commandId: string; commandGeneration: string }
  async function requestAgent(op: QualificationAgentOperation, timeout = budget()) {
    const socket = createConnection(paths!.handlerSocketPath); sockets.add(socket)
    const call = (deps.exchangeAgent ?? exchangeAgent)(socket, { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: current!.generation, ...op }, Math.ceil(timeout))
    const lost = async (): Promise<never> => {
      while (!socket.destroyed) { if (await terminal(deps.adapter, current!.process!)) { socket.destroy(); fail("HANDLER_TERMINATED") }; await delay() }
      return new Promise<never>(() => undefined)
    }
    try { const reply = await Promise.race([call, lost()]); if (!reply.ok) throw new AgentError(reply.error.code); return reply.result }
    finally { socket.destroy(); sockets.delete(socket) }
  }
  async function inventory(): Promise<void> {
    if (!paths) return
    const store = createAgentStore(paths.persistentRoot), inv = await store.inventory()
    if (inv.issues.length || inv.agents.length > 1 || inv.commands.filter(c => c.op === "start").length > 1) fail("OWNERSHIP_INVALID")
    const agent = target ? inv.agents.find(a => a.spec.agentId === target!.agentId) : inv.agents[0]
    if (!agent) return
    const s = agent.spec
    if (s.handlerGeneration !== report.ownership.handlerGeneration || s.hostId !== deps.hostKey || s.checkout.root.path !== join(root!, candidate.manifest.qualificationCwd.relative)) fail("OWNERSHIP_INVALID")
    if (target) equal(target, tupleOf(s))
    target ??= tupleOf(s); commandId ??= s.startCommandId
    for (const key of ["agentId", "providerGeneration", "leaseId", "launchAttemptId"] as const) {
      if (report.ownership[key] !== null && report.ownership[key] !== s[key]) fail("OWNERSHIP_INVALID")
      report.ownership[key] = s[key]
    }
    const launch = await readLaunchRecordForReconciliation(join(paths.persistentRoot, "launches", `${s.launchAttemptId}.json`)).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error })
    if (launch) {
      for (const key of ["agentId", "leaseId", "handlerGeneration", "launchAttemptId"] as const) if (launch[key] !== s[key]) fail("OWNERSHIP_INVALID")
      if (launch.checkoutId !== s.checkout.checkoutId) fail("OWNERSHIP_INVALID")
      if (report.deadlines.reservation.outcome !== "timed_out") report.deadlines.reservation.outcome = "completed"
      if (launch.provider !== null) {
        if (report.ownership.providerProcessGroup !== null) {
          equal(report.ownership.providerProcessGroup.leader, launch.provider.group.leader)
          if (["readiness", "active", "cleanup_pending", "cleanup_verified"].includes(launch.phase)) {
            for (const p of report.ownership.providerProcessGroup.observed) if (!launch.provider.group.observed.some(other => isDeepStrictEqual(p, other))) fail("OWNERSHIP_INVALID")
          } else equal(report.ownership.providerProcessGroup, launch.provider.group)
        }
        if (report.ownership.providerProcessGroup === null || ["readiness", "active"].includes(launch.phase)) report.ownership.providerProcessGroup = structuredClone(launch.provider.group)
        cleanupLaunch = structuredClone(launch)
        validateQualifiedOwnership(report.ownership)
      }
    }
  }
  async function waitCommand(id: string, generation: string) {
    while (true) {
      budget()
      try {
        const command = await requestAgent({ op: "agent_command", commandId: id, commandGeneration: generation })
        const list = await requestAgent({ op: "agent_list" })
        if (command.state !== "command" || command.durability !== "verified" || list.state !== "agents") fail("INVALID_PROTOCOL")
        await inventory()
        if (command.command.state !== "pending") return { command: command.command, list }
      } catch (error) {
        if (await terminal(deps.adapter, current!.process!)) fail("HANDLER_TERMINATED")
        budget()
        if (!(error instanceof AgentError) || !["INCOMPLETE", "UNAVAILABLE"].includes(error.code)) throw error
      }
      await delay()
    }
  }
  async function waitAbsentHandler(h: HandlerGenerationRecord): Promise<void> {
    const deadline = performance.now() + candidate.manifest.deadlines.processTerminateMs
    while (true) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) fail("PROCESS_SURVIVED")
      const absent = await within(Promise.all([terminal(deps.adapter, h.process!), observe(() => deps.adapter.readGroup(h.process!.processGroupId))]), remaining, "ABSENCE_TIMEOUT")
      if (performance.now() >= deadline) fail("ABSENCE_TIMEOUT")
      if (absent[0] && !absent[1].length) return
      await delay()
    }
  }
  async function recover(): Promise<void> {
    if (recovered || !paths || !current?.process) return
    recovered = true
    for (const socket of sockets) socket.destroy()
    await terminateHandler(deps.adapter, current.process); await waitAbsentHandler(current)
    await inventory()
    if (report.ownership.providerProcessGroup && !await absentGroup(deps.adapter, report.ownership.providerProcessGroup)) {
      const path = join(paths.persistentRoot, "launches", report.ownership.launchAttemptId + ".json"), launch = await readLaunchRecordForReconciliation(path)
      equal(launch.provider?.group, report.ownership.providerProcessGroup)
      if ((await reconcileRecord(path, deps.adapter, launch)).record.phase !== "cleanup_verified" || !await absentGroup(deps.adapter, report.ownership.providerProcessGroup)) fail("PROCESS_SURVIVED")
    }
    await launchHandler()
    const socket = createConnection(paths.handlerSocketPath)
    const status = await exchange(socket, { protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: current.generation, op: "status" }, candidate.manifest.deadlines.commandMs)
    if (!status.ok) fail("CLEANUP_UNVERIFIED")
    if (commandId) await requestAgent({ op: "agent_command", commandId, commandGeneration: report.ownership.handlerGeneration! }, candidate.manifest.deadlines.commandMs)
    const launches = await inventoryLaunches(join(paths.persistentRoot, "launches")), admissions = await inventoryAdmissions(paths.persistentRoot), inv = await createAgentStore(paths.persistentRoot).inventory()
    const launch = launches.find(e => e.record.launchAttemptId === report.ownership.launchAttemptId)?.record
    const command = inv.commands.find(c => c.commandId === commandId)
    const consistent = !inv.issues.length && !admissionInventoryIssues(deps.hostKey, launches, admissions).length
    retained.recovery = { command: command ?? null, agent: inv.agents.find(a => a.spec.agentId === report.ownership.agentId) ?? null, launch: launch ?? null, admission: admissions.records.find(a => a.launchAttemptId === report.ownership.launchAttemptId) ?? null, consistent }
    if (consistent && launch?.phase === "cleanup_verified" && command && command.state !== "pending") report.postconditions.reservation = "released"
    else report.postconditions.reservation = launch ? "retained" : "unknown"
    if (launch && !launch.launchAttempted && performance.now() - overallStart >= candidate.manifest.deadlines.reservationMs && report.failure === "HANDLER_TERMINATED") { report.deadlines.reservation.outcome = "timed_out"; report.failure = "STARTUP_TIMEOUT" }
  }
  try {
    try { await publish(join(evidence, "manifest.json"), candidate) } catch { fail("EVIDENCE_PUBLICATION_FAILED") }
    const verification = await deps.verify(candidate.manifest)
    try { validateVerification(verification, candidate) } catch { fail("ADAPTER_UNQUALIFIED") }
    report.observation.verification = verification
    await observeNormal("before")
    preflightComplete = true
    root = await deps.createExecutionRoot(); await assertPrivateDirectory(root); const rootStat = await lstat(root, { bigint: true }); rootIdentity = { dev: rootStat.dev, ino: rootStat.ino }
    paths = qualificationPaths(root, deps.hostKey)
    await mkdir(paths.persistentRoot, { mode: 0o700 }); await mkdir(paths.runtimeRoot, { mode: 0o700 }); await mkdir(join(root, "receipts"), { mode: 0o700 })
    const cwd = join(root, candidate.manifest.qualificationCwd.relative); await mkdir(cwd, { mode: 0o700 })
    await git("/usr/bin/git", ["-c", "init.defaultBranch=qualification", "init", "--quiet", cwd], { env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 5000, maxBuffer: 4096 })
    overallStart = performance.now(); overallDeadline = overallStart + candidate.manifest.deadlines.overallMs
    await within((async () => {
    try { await launchHandler() } catch (error) { setFailure(error, "HANDLER_STARTUP_FAILED"); throw error }
    budget()
    commandId = randomUUID(); startSent = true
    let pending
    const started = performance.now()
    try { pending = await within(requestAgent({ op: "agent_start", input: { commandId, handlerGeneration: current!.generation, cwd, selection: { providerId: "codex-acp", modelId: "gpt-5.6-sol", reasoning: { kind: "value", value: "high" }, mode: "read-only", permissionProfile: "deny-all" } } }), candidate.manifest.deadlines.commandMs, "COMMAND_START_TIMEOUT") }
    catch (error) {
      const timeout = performance.now() - started >= candidate.manifest.deadlines.commandMs || error instanceof AgentError && ["INCOMPLETE", "STARTUP_TIMEOUT"].includes(error.code)
      report.deadlines.commandStart.outcome = timeout ? "timed_out" : "failed"
      if (timeout) report.failure = "COMMAND_START_TIMEOUT"; else setFailure(error, "STARTUP_FAILED")
      for (const socket of sockets) socket.destroy(); throw error
    }
    if (performance.now() - started >= candidate.manifest.deadlines.commandMs || pending.state !== "command" || pending.durability !== "verified" || pending.command.state !== "pending" || !pending.command.target) fail("INVALID_PROTOCOL")
    report.deadlines.commandStart.outcome = "completed"; parentDurations.commandStart = performance.now() - started; target = pending.command.target
    const complete = await waitCommand(commandId, current!.generation)
    if (complete.command.result?.outcome !== "started") throw new AgentError(complete.command.result?.failure?.code ?? "STARTUP_FAILED")
    const ready = complete.list.agents.find(a => a.record.spec.agentId === target!.agentId)
    if (!ready || ready.record.phase !== "ready" || ready.launch?.phase !== "active") fail("OWNERSHIP_INVALID")
    retained.command = complete.command; retained.agent = ready.record; retained.launch = ready.launch
    retained.admission = await readAdmission(paths.persistentRoot, ready.record.spec.launchAttemptId)
    report.session = parseSession(complete.command.result.session); report.ownership.sessionId = report.session.sessionId
    report.selection = { modelId: report.session.modelId as "gpt-5.6-sol", reasoning: report.session.reasoning.kind === "value" ? report.session.reasoning.value as "high" : fail("SELECTION_UNSUPPORTED"), mode: report.session.mode as "read-only" }
    report.authentication = "ambient_accepted"
    const challenge = candidate.manifest.prompt.challengePrefix + randomBytes(candidate.manifest.prompt.challengeBytes).toString("hex")
    const prompt = `Return exactly this token and no other text:\n${challenge}\n\nDo not inspect files or use tools.`
    const promptExchangeMs = Math.min(overallDeadline - performance.now(), candidate.manifest.deadlines.promptMs + candidate.manifest.deadlines.commandMs)
    if (promptExchangeMs <= 0) fail("OVERALL_TIMEOUT")
    const promptResult = await requestAgent({ op: "agent_prompt", input: { ...target, text: prompt } }, promptExchangeMs)
    if (promptResult.state !== "prompt") fail("INVALID_PROTOCOL")
    if (promptResult.stopReason !== "end_turn" || promptResult.text.trim() !== challenge) fail("ADAPTER_UNQUALIFIED")
    await deps.beforeCleanup?.(root, report)
    equal(await readHandlerRecord(join(paths.runtimeRoot, "handler.json")), retained.handlers[0])
    equal(await readLaunchRecordForReconciliation(join(paths.persistentRoot, "launches", ready.record.spec.launchAttemptId + ".json")), retained.launch)
    equal(await createAgentStore(paths.persistentRoot).readCommand(commandId), retained.command)
    equal(await createAgentStore(paths.persistentRoot).readAgent(target.agentId), retained.agent)
    correlate(report)
    report.observation.descriptors = await observeQualificationDescriptors(deps.adapter, handlerOwners.map(h => h.process!), report.ownership.providerProcessGroup!, budget(), deps.descriptorCommand)
    if (report.observation.descriptors.outcome !== "verified") fail("DESCRIPTOR_LEAK")
    stopSent = true
    const stopping = await requestAgent({ op: "agent_stop", input: { ...target, commandId: randomUUID() } })
    if (stopping.state !== "command" || stopping.durability !== "verified") fail("CLEANUP_UNVERIFIED")
    const stopped = await waitCommand(stopping.command.commandId, current!.generation)
    if (stopped.command.result?.outcome !== "stopped" || stopped.list.agents.some(a => a.live || a.cleanup !== "verified")) fail("CLEANUP_UNVERIFIED")
    budget(); report.deadlines.overall.outcome = "completed"; parentDurations.overall = performance.now() - overallStart
    })(), candidate.manifest.deadlines.overallMs, "OVERALL_TIMEOUT")
  } catch (error) {
    if (stopSent && report.session !== null && error instanceof AgentError && ["ADMISSION_UNAVAILABLE", "INCOMPLETE"].includes(error.code)) setFailure(new QualificationError("CLEANUP_UNVERIFIED"), "CLEANUP_UNVERIFIED")
    else setFailure(error, "STARTUP_FAILED")
    if (report.failure === "AUTH_REQUIRED") report.authentication = "auth_required"
    else if (startSent && report.authentication !== "ambient_accepted") report.authentication = "failed"
    if (paths && current?.process) {
      try {
        await inventory()
        if (await terminal(deps.adapter, current.process) || report.failure === "COMMAND_START_TIMEOUT" || report.failure === "OVERALL_TIMEOUT") await recover()
        else if (target && !stopSent) { stopSent = true; const result = await requestAgent({ op: "agent_stop", input: { ...target as AgentTuple, commandId: randomUUID() } }, 5000); if (result.state !== "command") fail("CLEANUP_UNVERIFIED") }
      } catch (cleanupError) { setFailure(cleanupError, "CLEANUP_UNVERIFIED") }
    }
  } finally {
    if (paths) {
      try {
        await inventory()
        if (current?.process && !await terminal(deps.adapter, current.process)) {
          const socket = createConnection(paths.handlerSocketPath)
          const shutdown = await exchange(socket, { protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: current.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true }, 5000)
          if (!shutdown.ok) fail("CLEANUP_UNVERIFIED")
        }
      } catch (error) { setFailure(error, "CLEANUP_UNVERIFIED"); if (current?.process) await terminateHandler(deps.adapter, current.process).catch(error => setFailure(error, "CLEANUP_UNVERIFIED")) }
      try {
        for (const h of handlerOwners) await waitAbsentHandler(h)
        report.postconditions.handler = handlerOwners.length || !handlerInvoked ? "absent" : "unknown"
      } catch (error) { report.postconditions.handler = "present"; setFailure(error, "PROCESS_SURVIVED") }
      try {
        if (cleanupLaunch?.provider && !await absentGroup(deps.adapter, cleanupLaunch.provider.group)) {
          const path = join(paths.persistentRoot, "launches", cleanupLaunch.launchAttemptId + ".json"), currentLaunch = await readLaunchRecordForReconciliation(path)
          for (const key of ["agentId", "leaseId", "handlerGeneration", "launchAttemptId", "checkoutId"] as const) equal(currentLaunch[key], cleanupLaunch[key])
          equal(currentLaunch.provider, cleanupLaunch.provider)
          const result = await reconcileRecord(path, deps.adapter, currentLaunch)
          cleanupLaunch = result.record
        }
        if (cleanupLaunch?.provider) report.postconditions.processGroup = await absentGroup(deps.adapter, cleanupLaunch.provider.group) ? "absent" : "present"
      } catch (error) { setFailure(error, "CLEANUP_UNVERIFIED") }
      try {
        await inventory()
        const group = cleanupLaunch?.provider?.group ?? report.ownership.providerProcessGroup
        report.postconditions.processGroup = group ? await absentGroup(deps.adapter, group) ? "absent" : "present" : "absent"
        if (report.postconditions.processGroup !== "absent") fail("PROCESS_SURVIVED")
        const inv = await createAgentStore(paths.persistentRoot).inventory(), launches = await inventoryLaunches(join(paths.persistentRoot, "launches")), admissions = await inventoryAdmissions(paths.persistentRoot)
        if (!group && launches.some(e => e.record.launchAttempted && e.record.provider === null)) report.postconditions.processGroup = "unknown"
        const verified = !inv.issues.length && !admissionInventoryIssues(deps.hostKey, launches, admissions).length && launches.every(e => e.record.phase === "cleanup_verified") && inv.commands.every(c => c.state !== "pending") && inv.agents.every(a => !["starting", "ready", "stopping"].includes(a.phase))
        if (!recovered) report.postconditions.reservation = verified ? "released" : "retained"
        else if (!verified && report.postconditions.reservation === "released") report.postconditions.reservation = "retained"
        report.postconditions.lifecycleOperation = verified ? "terminal" : "in_flight"
        report.postconditions.providerState = report.ownership.launchAttemptId && await exists(providerStatePath(paths.persistentRoot, report.ownership.launchAttemptId)) ? "present" : "absent"
        report.postconditions.catalogProfile = await exists(join(paths.persistentRoot, "catalog/providers.json")) ? "present" : "absent"
        if (report.ownership.launchAttemptId) {
          const receiptPath = join(root!, "receipts", report.ownership.launchAttemptId + ".json")
          const promptReceiptPath = join(root!, "receipts", report.ownership.launchAttemptId + ".prompt.json")
          report.observation.receipt = parseQualificationReceipt(await readPrivateJson(await exists(receiptPath) ? receiptPath : promptReceiptPath), candidate.manifest)
          const receipt = report.observation.receipt
          Object.assign(receipt.durations, parentDurations)
          report.prompt = structuredClone(receipt.prompt)
          if (receipt.launchAttemptId !== report.ownership.launchAttemptId || receipt.handlerGeneration !== report.ownership.handlerGeneration) fail("OWNERSHIP_INVALID")
          report.protocol.methods = receipt.methods
          report.postconditions.directChild = receipt.terminal ? "terminal" : "unknown"
          report.postconditions.transport = receipt.transportClosed ? "closed" : "open"; report.postconditions.ownedHandles = receipt.handlesClosed ? "closed" : "open"
          for (const [name, duration] of Object.entries(receipt.durations) as Array<[Phase, number]>) if (name !== "absence" && name !== "prompt") report.deadlines[name].outcome = duration < report.deadlines[name].limitMs ? "completed" : "timed_out"
          report.deadlines.prompt.outcome = promptDeadlineOutcome(receipt.prompt, candidate.manifest.deadlines.promptMs)
          if (receipt.failure) {
            if (report.failure === "ADMISSION_UNAVAILABLE" || report.failure === "INCOMPLETE") report.failure = receipt.failure
            else setFailure(new QualificationError(receipt.failure), receipt.failure)
          }
        } else { report.postconditions.directChild = "terminal"; report.postconditions.transport = "closed"; report.postconditions.ownedHandles = "closed" }
        if (!verified || report.postconditions.providerState !== "absent") fail("CLEANUP_UNVERIFIED")
      } catch (error) { setFailure(error, "EVIDENCE_MISSING") }
      for (const socket of sockets) socket.destroy()
      try {
        const absence = await verifyQualificationAbsence(deps.absenceAdapter ?? deps.adapter, handlerOwners.map(h => h.process!), cleanupLaunch?.provider?.group ?? report.ownership.providerProcessGroup, report.observation.descriptors?.processes.map(p => p.process) ?? [], candidate.manifest.deadlines.absenceMs)
        report.observation.absence = absence
        report.deadlines.absence.outcome = absence.outcome
        report.postconditions.handler = handlerInvoked && !handlerOwners.length ? "unknown" : absence.handler
        report.postconditions.processGroup = report.postconditions.processGroup === "unknown" ? "unknown" : absence.provider
        report.postconditions.ownedHandles = absence.outcome === "completed" && report.observation.descriptors?.outcome === "verified" && report.postconditions.transport === "closed" ? "closed" : "unknown"
        if (absence.outcome !== "completed") fail(absence.outcome === "timed_out" ? "ABSENCE_TIMEOUT" : absence.handler === "present" || absence.provider === "present" ? "PROCESS_SURVIVED" : "ABSENCE_UNAVAILABLE")
      } catch (error) { setFailure(error, "ABSENCE_UNAVAILABLE") }
      try {
        if (report.postconditions.handler === "absent" && report.postconditions.processGroup === "absent" && report.postconditions.reservation === "released" && report.postconditions.providerState === "absent") {
          const observedRoot = await lstat(root!, { bigint: true })
          equal({ dev: observedRoot.dev, ino: observedRoot.ino }, rootIdentity)
          await assertPrivateDirectory(root!); await rm(root!, { recursive: true })
          report.postconditions.executionRoot = !await exists(root!) ? "absent" : "present"
          report.postconditions.qualificationCwd = report.postconditions.executionRoot
        } else { report.postconditions.executionRoot = "present"; report.postconditions.qualificationCwd = "present" }
      } catch (error) { setFailure(error, "CLEANUP_UNVERIFIED") }
    }
    if (!root) { report.postconditions.handler = "absent"; report.postconditions.processGroup = "absent"; report.postconditions.executionRoot = "absent"; report.postconditions.qualificationCwd = "absent" }
    if (preflightComplete) try { await observeNormal("after") } catch (error) { setFailure(error, "NORMAL_STATE_UNAVAILABLE") }
  }
  report.endedAt = new Date().toISOString()
  if (report.failure === null) {
    report.qualified = true
    try { parseCodexQualificationReport(report) } catch { report.qualified = false; report.failure = "REPORT_INVALID" }
  }
  const primaryReportPath = join(evidence, "report.json")
  let reportPath: string | null = null, reportSha256: string | null = null
  try {
    await publish(primaryReportPath, report)
    if (request.reportPath) await publish(request.reportPath, report)
    reportPath = primaryReportPath
    reportSha256 = (await readPrivateJsonWithDigest(primaryReportPath, 1048576)).sha256
  } catch {
    const unpublished = structuredClone(report)
    report.qualified = false; report.failure = "EVIDENCE_PUBLICATION_FAILED"
    for (const path of [primaryReportPath, ...(request.reportPath ? [request.reportPath] : [])]) {
      try { equal(await readPrivateJson(path), unpublished, "EVIDENCE_PUBLICATION_FAILED"); await rm(path); await syncDirectory(dirname(path)) } catch {}
    }
    const failedReportPath = join(evidence, "report-failed.json")
    try { await durableQualificationWrite(failedReportPath, report); reportPath = failedReportPath; reportSha256 = (await readPrivateJsonWithDigest(failedReportPath, 1048576)).sha256 } catch {}
  }
  return { report, reportPath, reportSha256 }
}

export async function pinnedArtifact(path: string, sha256: string): Promise<ArtifactPin> {
  const pin: ArtifactPin = { path, sha256, identity: statIdentity(await lstat(path, { bigint: true })) }
  return observeArtifact(pin)
}
export async function offlineCandidate(candidatePath: string, evidenceParent: string, deps: OfflineCandidateDependencies = {}): Promise<CodexQualificationCandidate> {
  if (process.execPath !== "/Users/moon/.nodenv/versions/24.13.0/bin/node" || process.versions.node !== "24.13.0" || process.platform !== "darwin" || process.arch !== "arm64") fail("ADAPTER_UNQUALIFIED")
  canonical(candidatePath); canonical(evidenceParent)
  if (await exists(candidatePath)) fail("EVIDENCE_PUBLICATION_FAILED")
  const preserved = await readPrivateJsonWithDigest("/Users/moon/.dotfiles/.worktrees/agency-agent-lifecycle/agency/qualification/codex-darwin-arm64.candidate.json", 1048576)
  if (preserved.sha256 !== "73e440d1698f3e689f12b5dab74b3b9af3316ab9ab826d1c15a3029d3d909270") fail("ADAPTER_UNQUALIFIED")
  const old = object(preserved.value, ["version", "manifest", "fingerprint"])
  const { userStatePaths, ...legacyManifest } = old.manifest as Record<string, unknown>
  for (const name of ["adapterPackageJson", "adapterEntrypoint", "codexExecutable", "nodeExecutable"] as const) {
    const pin = legacyManifest[name] as ArtifactPin
    equal(await (deps.observeArtifact ?? observeArtifact)(pin), pin, "ADAPTER_UNQUALIFIED")
  }
  const manifest = parseCodexQualificationManifest({
    ...legacyManifest, version: 3, policy: "agency-codex-prompt-smoke-v3", contractId: "codex-darwin-arm64-agency-prompt-smoke-v3",
    prompt: { challengePrefix: "AGENCY_CODEX_SMOKE_", challengeBytes: 16, answerBytes: 4096 },
    deadlines: { ...legacyManifest.deadlines as object, promptMs: 90000, overallMs: 150000 },
  })
  const verification = await (deps.verify ?? verifyCodexQualification)(manifest), candidate = { version: 3 as const, manifest, fingerprint: qualificationFingerprint(manifest) }
  equal(verification, { ...candidate, nodeVersion: manifest.nodeVersion, selection: manifest.selection, artifacts: { adapterPackageJson: manifest.adapterPackageJson, adapterEntrypoint: manifest.adapterEntrypoint, codexExecutable: manifest.codexExecutable, nodeExecutable: manifest.nodeExecutable } }, "ADAPTER_UNQUALIFIED")
  const report: CodexQualificationOfflineReport = { version: 3, stage: "offline", qualified: false, candidate, verification }
  const directory = await evidenceDirectory(evidenceParent), evidence = await mkdtemp(join(directory, "offline-")); await syncDirectory(directory)
  await durableQualificationWrite(join(evidence, "manifest.json"), candidate)
  try { await mkdir(dirname(candidatePath), { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
  await durableQualificationWrite(candidatePath, candidate)
  await durableQualificationWrite(join(evidence, "report.json"), report)
  return candidate
}
export async function codexQualificationMain(argv: readonly string[], dependencies?: QualificationDependencies): Promise<number> {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) { const name = argv[i]!, value = argv[i + 1]; if (!["--stage", "--candidate", "--evidence-parent", "--report", "--report-sha256", "--reviewed-branch", "--reviewed-commit"].includes(name) || args.has(name) || !value) fail("USAGE"); args.set(name, value!) }
  const stage = args.get("--stage"), candidatePath = args.get("--candidate"), evidenceParent = args.get("--evidence-parent")
  if (!candidatePath || !evidenceParent || !["offline", "live", "source"].includes(stage ?? "")) fail("USAGE")
  canonical(candidatePath!); canonical(evidenceParent!)
  if (stage === "offline") { const candidate = await offlineCandidate(candidatePath!, evidenceParent!); process.stdout.write(JSON.stringify({ stage, fingerprint: candidate.fingerprint }) + "\n"); return 0 }
  const revision = reviewedRevision({ reviewedBranch: args.get("--reviewed-branch"), reviewedCommit: args.get("--reviewed-commit") })
  const reviewed = { reviewedBranch: revision.branch, reviewedCommit: revision.commit }
  if (stage === "source") {
    const path = args.get("--report"), supplied = args.get("--report-sha256"); if (!path || !supplied) fail("USAGE")
    const reportBytes = await readPrivateJsonWithDigest(path, 1048576), report = parseCodexQualificationReport(reportBytes.value), candidate = parseQualificationCandidate(await readPrivateJson(candidatePath!))
    const source = renderPublishedQualificationSource(candidate, report, supplied, reportBytes.sha256, reviewed)
    const deps = dependencies ?? await defaultDependencies()
    await requireCurrentRevision(deps, revision)
    const verification = await deps.verify(candidate.manifest)
    validateVerification(verification, candidate)
    equal(await Promise.all(deps.normalStatePaths.map(path => snapshotTree(path, true))), report.observation.normalAgencyState.after, "ADAPTER_UNQUALIFIED")
    const absence = await verifyQualificationAbsence(deps.adapter, report.ownership.handlers.map(h => h.process), report.ownership.providerProcessGroup, report.observation.descriptors?.processes.map(p => p.process) ?? [], candidate.manifest.deadlines.absenceMs)
    if (absence.outcome !== "completed") fail("PROCESS_SURVIVED")
    process.stdout.write(source + "\n"); return 0
  }
  const { report, reportPath, reportSha256 } = await runCodexQualification({ candidatePath: candidatePath!, evidenceParent: evidenceParent!, ...reviewed, ...(args.has("--report") ? { reportPath: args.get("--report")! } : {}) }, dependencies)
  process.stdout.write(JSON.stringify({ qualified: report.qualified, failure: report.failure, reportPath, reportSha256 }) + "\n"); return report.qualified ? 0 : 1
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  codexQualificationMain(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { process.stderr.write(classify(error, "ADAPTER_UNQUALIFIED") + "\n"); process.exitCode = 1 })
}