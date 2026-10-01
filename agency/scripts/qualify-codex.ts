import { createHash, randomBytes, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, mkdtemp, open, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize } from "node:path"
import { createConnection } from "node:net"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual, promisify } from "node:util"
import { parseCodexQualificationCandidate, parseCodexQualificationManifest, qualificationFingerprint, renderQualifiedContractSource, verifyCodexQualification, type CodexQualificationCandidate } from "../src/agent/qualification.js"
import { AGENT_CODES, AgentError, type AgentTuple, type CommandView } from "../src/agent/types.js"
import { launchEnvironmentDigest, snapshotLaunchEnvironment, type LaunchEnvironment } from "../src/agent/environment.js"
import { AGENT_PROTOCOL, exchangeAgent, type AgentRequest } from "../src/agent/protocol.js"
import { createAgentStore } from "../src/agent/store.js"
import { readHandlerRecord, readLaunchRecordForReconciliation, assertPrivateDirectory } from "../src/platform/private-state.js"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { readHostId } from "../src/platform/host-id.js"
import { startOrConnect, inspectHandlerGeneration, type HandlerCommand } from "../src/platform/singleton.js"
import { sameProcess, type HandlerGenerationRecord, type PlatformAdapter, type ProcessGroupIdentity, type ProcessIdentity } from "../src/platform/types.js"
import { agencyLaunchMarker, exactAgencyBirth } from "../src/platform/launch-marker.js"
import { PROTOCOL } from "../src/control/protocol.js"
import { exchange } from "../src/control/wire.js"
import { resolvePlatformPaths, type PlatformPaths } from "../src/platform/paths.js"
import { exactKeys, parseAbsence, parseGroupIdentity, verifyQualificationAbsence, type QualificationAbsence } from "./qualification-observation.js"

export const QUALIFICATION_METHODS = ["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/set_config_option", "session/prompt", "initialize", "session/load", "session/set_config_option", "session/set_config_option", "session/set_config_option", "session/prompt"]
const FAILURES = [...AGENT_CODES, "REPORT_INVALID", "ANSWER_MISMATCH", "ABSENCE_UNVERIFIED", "EVIDENCE_PUBLICATION_FAILED", "HANDLER_ACTIVE", "HANDLER_STARTUP_FAILED"] as const
export type QualificationFailure = typeof FAILURES[number]
export type ReviewedRevision = { reviewedBranch: string; reviewedCommit: string }
export type QualificationGeneration = { agentId: string; handlerGeneration: string; providerGeneration: string; launchAttemptId: string; commandId: string; sessionGeneration: string; sessionId: string; answer: string }
export type QualificationReceipt = { version: 4; handlerGeneration: string; providerGeneration: string; launchAttemptId: string; methods: string[]; promptCount: number; prompts: Array<{ sessionId: string; text: string }>; terminal: boolean; streamsClosed: boolean; failure: QualificationFailure | null }
export type AmbientQualificationReport = {
  version: 4; policy: "agency-codex-ambient-restore-v4"; candidate: CodexQualificationCandidate; branch: string; commit: string
  cwd: string; startEnvironmentDigest: string; restoreEnvironmentDigest: string | null; challenge: string
  protocol: { methods: string[]; promptCount: number }
  first: QualificationGeneration | null; restored: QualificationGeneration | null
  ownedGroups: Array<{ stage: "initial-stop" | "restored-stop"; identity: ProcessGroupIdentity; absence: QualificationAbsence }>
  receipts: QualificationReceipt[]; qualified: boolean; failure: QualificationFailure | null
}
export type CodexQualificationReport = AmbientQualificationReport
export type QualificationRequest = ReviewedRevision & { candidatePath: string; evidenceParent: string }
export type QualificationResult = { report: AmbientQualificationReport; reportPath: string; reportSha256: string }
export type QualificationDependencies = {
  paths: PlatformPaths; adapter: PlatformAdapter; verify: typeof verifyCodexQualification
  handler(candidatePath: string, receipts: string): HandlerCommand
  currentRevision(): Promise<{ branch: string; commit: string }>
  cwd(): string; snapshot(): LaunchEnvironment
  absenceAdapter?: Pick<PlatformAdapter, "readProcess" | "readGroup">
}
class QualificationError extends Error { constructor(readonly code: QualificationFailure) { super(code) } }
function fail(code: QualificationFailure): never { throw new QualificationError(code) }
function requireEqual(left: unknown, right: unknown, code: QualificationFailure = "REPORT_INVALID"): void { if (!isDeepStrictEqual(left, right)) fail(code) }
function digest(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex") }
function hash(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail("REPORT_INVALID"); return value }
function uuid(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) fail("REPORT_INVALID"); return value }
function canonical(value: unknown): string { if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value.length > 4096 || /[\x00-\x1f]/.test(value)) fail("REPORT_INVALID"); return value }
function reviewed(input: ReviewedRevision): { branch: string; commit: string } {
  if (input.reviewedBranch !== "moon/agency-agent-lifecycle" || !/^[0-9a-f]{40}$/.test(input.reviewedCommit) || input.reviewedCommit === "0".repeat(40)) fail("ADAPTER_UNQUALIFIED")
  return { branch: input.reviewedBranch, commit: input.reviewedCommit }
}
export const parseQualificationCandidate = parseCodexQualificationCandidate
export function initialQualificationPrompt(challenge: string): string { return `Read agency/package.json in the current directory. Return exactly this nonce, the package name, and the Node engine separated by single spaces: ${challenge}. Remember the nonce for the next turn.` }
export function parseQualificationReceipt(value: unknown): QualificationReceipt {
  const r = exactKeys(value, ["version", "handlerGeneration", "providerGeneration", "launchAttemptId", "methods", "promptCount", "prompts", "terminal", "streamsClosed", "failure"])
  if (r.version !== 4 || !Array.isArray(r.methods) || r.methods.length > 32 || r.methods.some(m => typeof m !== "string" || m.length > 128) || r.promptCount !== r.methods.filter(m => m === "session/prompt").length || typeof r.terminal !== "boolean" || typeof r.streamsClosed !== "boolean" || (r.failure !== null && !FAILURES.includes(r.failure as QualificationFailure))) fail("REPORT_INVALID")
  for (const key of ["handlerGeneration", "providerGeneration", "launchAttemptId"]) uuid(r[key])
  if (!Array.isArray(r.prompts) || r.prompts.length !== r.promptCount) fail("REPORT_INVALID")
  for (const prompt of r.prompts) {
    const p = exactKeys(prompt, ["sessionId", "text"])
    for (const key of ["sessionId", "text"]) if (typeof p[key] !== "string" || !(p[key] as string).length || !(p[key] as string).isWellFormed() || Buffer.byteLength(p[key] as string) > 4096 || (p[key] as string).includes("\0")) fail("REPORT_INVALID")
  }
  return structuredClone(r) as QualificationReceipt
}
export function parseCodexQualificationReport(value: unknown): AmbientQualificationReport {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 1048576) fail("REPORT_INVALID")
    const r = exactKeys(value, ["version", "policy", "candidate", "branch", "commit", "cwd", "startEnvironmentDigest", "restoreEnvironmentDigest", "challenge", "protocol", "first", "restored", "ownedGroups", "receipts", "qualified", "failure"])
    if (r.version !== 4 || r.policy !== "agency-codex-ambient-restore-v4" || typeof r.qualified !== "boolean" || (r.failure !== null && !FAILURES.includes(r.failure as QualificationFailure)) || r.qualified !== (r.failure === null)) fail("REPORT_INVALID")
    const candidate = parseQualificationCandidate(r.candidate); reviewed({ reviewedBranch: r.branch as string, reviewedCommit: r.commit as string }); canonical(r.cwd)
    hash(r.startEnvironmentDigest); if (r.restoreEnvironmentDigest !== null) hash(r.restoreEnvironmentDigest)
    if (typeof r.challenge !== "string" || !/^AGENCY_CODEX_RESTORE_[0-9a-f]{32}$/.test(r.challenge)) fail("REPORT_INVALID")
    const protocol = exactKeys(r.protocol, ["methods", "promptCount"])
    if (!Array.isArray(protocol.methods) || protocol.methods.length > 12 || protocol.methods.some((m, i) => m !== QUALIFICATION_METHODS[i]) || protocol.promptCount !== protocol.methods.filter(m => m === "session/prompt").length) fail("REPORT_INVALID")
    const generation = (value: unknown): QualificationGeneration | null => {
      if (value === null) return null
      const g = exactKeys(value, ["agentId", "handlerGeneration", "providerGeneration", "launchAttemptId", "commandId", "sessionGeneration", "sessionId", "answer"])
      for (const key of ["agentId", "handlerGeneration", "providerGeneration", "launchAttemptId", "commandId", "sessionGeneration"]) uuid(g[key])
      for (const key of ["sessionId", "answer"]) if (typeof g[key] !== "string" || !(g[key] as string).isWellFormed() || Buffer.byteLength(g[key] as string) > 4096 || (g[key] as string).includes("\0")) fail("REPORT_INVALID")
      if (!g.sessionId) fail("REPORT_INVALID")
      return g as QualificationGeneration
    }
    const first = generation(r.first), restored = generation(r.restored)
    if (!Array.isArray(r.ownedGroups) || r.ownedGroups.length > 2 || !Array.isArray(r.receipts) || r.receipts.length > 2) fail("REPORT_INVALID")
    const receipts = r.receipts.map(parseQualificationReceipt)
    requireEqual(receipts.flatMap(r => r.methods), protocol.methods)
    const groups = r.ownedGroups.map((value, index) => {
      const g = exactKeys(value, ["stage", "identity", "absence"])
      if (g.stage !== ["initial-stop", "restored-stop"][index]) fail("REPORT_INVALID")
      const identity = parseGroupIdentity(g.identity), absence = parseAbsence(g.absence, identity, candidate.manifest.deadlines.absenceMs)
      const retained = index === 0 ? first : restored
      if (retained && !identity.leader.birth.endsWith(":agy-provider:" + retained.launchAttemptId)) fail("REPORT_INVALID")
      return { identity, absence }
    })
    if (r.qualified) {
      if (!first || !restored || r.restoreEnvironmentDigest === null || protocol.promptCount !== 2 || groups.length !== 2 || receipts.length !== 2) fail("REPORT_INVALID")
      requireEqual(protocol.methods, QUALIFICATION_METHODS)
      if (first.sessionId !== restored.sessionId || first.agentId !== restored.agentId || first.handlerGeneration !== restored.handlerGeneration) fail("REPORT_INVALID")
      for (const key of ["providerGeneration", "launchAttemptId", "commandId", "sessionGeneration"] as const) if (first[key] === restored[key]) fail("REPORT_INVALID")
      if (first.answer.trim() !== `${r.challenge} @moon/agency 24.13.0` || restored.answer.trim() !== r.challenge) fail("REPORT_INVALID")
      if (isDeepStrictEqual(groups[0]!.identity, groups[1]!.identity)) fail("REPORT_INVALID")
      for (const [index, receipt] of receipts.entries()) {
        const retained = index === 0 ? first : restored
        if (!receipt.terminal || !receipt.streamsClosed || receipt.failure !== null || receipt.promptCount !== 1 || receipt.handlerGeneration !== retained.handlerGeneration || receipt.providerGeneration !== retained.providerGeneration || receipt.launchAttemptId !== retained.launchAttemptId) fail("REPORT_INVALID")
        requireEqual(receipt.methods, QUALIFICATION_METHODS.slice(index * 6, index * 6 + 6))
        requireEqual(receipt.prompts, [{ sessionId: retained.sessionId, text: index === 0 ? initialQualificationPrompt(r.challenge as string) : "Return the nonce from the previous turn without reading files." }])
        if (groups[index]!.absence.first?.outcome !== "absent" || groups[index]!.absence.second?.outcome !== "absent") fail("REPORT_INVALID")
      }
    }
    return structuredClone(r) as AmbientQualificationReport
  } catch { return fail("REPORT_INVALID") }
}
export function renderPublishedQualificationSource(candidate: CodexQualificationCandidate, value: unknown, suppliedHash: string, observedHash: string, revision: ReviewedRevision): string {
  const report = parseCodexQualificationReport(value)
  requireEqual(parseQualificationCandidate(candidate), report.candidate, "ADAPTER_UNQUALIFIED")
  requireEqual(reviewed(revision), { branch: report.branch, commit: report.commit }, "ADAPTER_UNQUALIFIED")
  if (!report.qualified || hash(suppliedHash) !== hash(observedHash)) fail("EVIDENCE_PUBLICATION_FAILED")
  return renderQualifiedContractSource(candidate, { qualified: true, manifestFingerprint: candidate.fingerprint })
}
export async function durableQualificationWrite(path: string, value: unknown): Promise<void> {
  canonical(path); await assertPrivateDirectory(dirname(path))
  const bytes = JSON.stringify(value)
  if (Buffer.byteLength(bytes) > 1048576) fail("EVIDENCE_PUBLICATION_FAILED")
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  const directory = await open(dirname(path), constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
}
export async function readPrivateJsonWithDigest(path: string, maxBytes = 1048576): Promise<{ value: unknown; sha256: string }> {
  canonical(path)
  const before = await lstat(path, { bigint: true })
  if (await realpath(path) !== path || !before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o077n) !== 0n || before.size > BigInt(maxBytes)) fail("REPORT_INVALID")
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const identity = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink]
    requireEqual(identity(await handle.stat({ bigint: true })), identity(before))
    const bytes = Buffer.alloc(Number(before.size) + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== Number(before.size)) fail("REPORT_INVALID")
    requireEqual(identity(await handle.stat({ bigint: true })), identity(before)); requireEqual(identity(await lstat(path, { bigint: true })), identity(before))
    const content = bytes.subarray(0, bytesRead)
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)), sha256: digest(content) }
  } finally { await handle.close() }
}
export async function readPrivateJson(path: string): Promise<unknown> { return (await readPrivateJsonWithDigest(path)).value }
export async function observeCurrentRevision(): Promise<{ branch: string; commit: string }> {
  const execute = promisify(execFile), options = { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8" as const, timeout: 5000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" } }
  const branch = await execute("/usr/bin/git", ["branch", "--show-current"], options), commit = await execute("/usr/bin/git", ["rev-parse", "HEAD"], options)
  if (branch.stderr || commit.stderr) fail("ADAPTER_UNQUALIFIED")
  return { branch: branch.stdout.trim(), commit: commit.stdout.trim() }
}
async function defaults(): Promise<QualificationDependencies> {
  if (process.versions.node !== "24.13.0" || process.platform !== "darwin" || process.arch !== "arm64") fail("ADAPTER_UNQUALIFIED")
  const hostKey = await readHostId("darwin")
  const paths = await resolvePlatformPaths({ platform: "darwin", uid: process.getuid!(), hostKey, home: process.env.HOME!, ...(process.env.XDG_STATE_HOME ? { xdgStateHome: process.env.XDG_STATE_HOME } : {}) })
  return { paths, adapter: createDarwinAdapter(), verify: verifyCodexQualification, currentRevision: observeCurrentRevision, cwd: process.cwd, snapshot: () => snapshotLaunchEnvironment(process.env), handler: (candidate, receipts) => ({ file: process.execPath, args: [fileURLToPath(new URL("./qualify-codex-handler.js", import.meta.url)), candidate, receipts], env: process.env }) }
}
export async function runCodexQualification(request: QualificationRequest, dependencies?: QualificationDependencies): Promise<QualificationResult> {
  const revision = reviewed(request), candidate = parseQualificationCandidate(await readPrivateJson(request.candidatePath)), deps = dependencies ?? await defaults()
  requireEqual(await deps.currentRevision(), revision, "ADAPTER_UNQUALIFIED")
  requireEqual((await deps.verify(candidate.manifest)).fingerprint, candidate.fingerprint, "ADAPTER_UNQUALIFIED")
  const old = await inspectHandlerGeneration(deps.paths.runtimeRoot, deps.adapter)
  if (old?.disposition === "live" || old?.disposition === "ambiguous") fail("HANDLER_ACTIVE")
  await assertPrivateDirectory(request.evidenceParent)
  const evidence = await mkdtemp(join(request.evidenceParent, "ambient-v4-")), receiptsPath = join(evidence, "receipts")
  await mkdir(receiptsPath, { mode: 0o700 })
  const startEnvironment = deps.snapshot()
  const validateEnvironment = (environment: LaunchEnvironment): void => {
    if (environment.CODEX_PATH !== candidate.manifest.codexExecutable.path) throw new AgentError("CONFIG_CHANGED")
  }
  validateEnvironment(startEnvironment)
  const report: AmbientQualificationReport = { version: 4, policy: "agency-codex-ambient-restore-v4", candidate, ...revision, cwd: canonical(deps.cwd()), startEnvironmentDigest: launchEnvironmentDigest(startEnvironment), restoreEnvironmentDigest: null, challenge: "AGENCY_CODEX_RESTORE_" + randomBytes(16).toString("hex"), protocol: { methods: [], promptCount: 0 }, first: null, restored: null, ownedGroups: [], receipts: [], qualified: false, failure: null }
  let handler: ProcessIdentity | null = null, generation = "", target: AgentTuple | null = null
  const ownership: { record: HandlerGenerationRecord | null; pid: number | null; ready: boolean } = { record: null, pid: null, ready: false }
  const ownedIdentity = (identity: ProcessIdentity): boolean => ownership.record !== null && identity.pid === ownership.pid && identity.bootId === ownership.record.launchBootId && identity.pid === identity.processGroupId && identity.pid === identity.sessionId && identity.uid === process.getuid!() && identity.gid === process.getgid!() && exactAgencyBirth(identity.birth, agencyLaunchMarker("handler", ownership.record.launchAttemptId))
  const sameOwnedRecord = (record: HandlerGenerationRecord): boolean => ownership.record !== null && record.generation === ownership.record.generation && record.launchAttemptId === ownership.record.launchAttemptId && record.hostId === deps.paths.hostKey && record.socketPath === deps.paths.handlerSocketPath
  const attempts: Array<{ launchAttemptId: string; stage: "initial-stop" | "restored-stop" }> = []
  const failure = (error: unknown): void => { report.failure ??= error instanceof AgentError || error instanceof QualificationError ? error.code : "REPORT_INVALID" }
  type Operation = AgentRequest extends infer R ? R extends AgentRequest ? Omit<R, "protocol" | "requestId" | "handlerGeneration"> : never : never
  async function call(operation: Operation) {
    const reply = await exchangeAgent(createConnection(deps.paths.handlerSocketPath), { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, ...operation } as AgentRequest, operation.op === "agent_prompt" ? candidate.manifest.deadlines.promptMs + 5000 : 5000)
    if (!reply.ok) throw new AgentError(reply.error.code)
    return reply.result
  }
  async function command(operation: Operation): Promise<CommandView> {
    let result = await call(operation)
    if (result.state !== "command") fail("REPORT_INVALID")
    if (result.command.target) target = result.command.target
    const deadline = performance.now() + candidate.manifest.deadlines.overallMs
    while (result.command.state === "pending") {
      if (performance.now() >= deadline) throw new AgentError("STARTUP_TIMEOUT")
      await new Promise(resolve => setTimeout(resolve, 20))
      result = await call({ op: "agent_command", commandId: result.command.commandId, commandGeneration: generation })
      if (result.state !== "command") fail("REPORT_INVALID")
    }
    if (result.durability !== "verified" || !result.command.result || result.command.result.failure) throw new AgentError(result.command.result?.failure?.code ?? "INCOMPLETE")
    return result
  }
  async function retain(stage: "initial-stop" | "restored-stop"): Promise<QualificationGeneration> {
    if (!target) fail("REPORT_INVALID")
    const agent = await createAgentStore(deps.paths.persistentRoot).readAgent(target.agentId)
    if (!agent?.session) fail("REPORT_INVALID")
    attempts.push({ stage, launchAttemptId: agent.launch.launchAttemptId })
    return { ...target, launchAttemptId: agent.launch.launchAttemptId, commandId: agent.launch.commandId, sessionGeneration: agent.session.sessionGeneration, sessionId: agent.session.sessionId, answer: "" }
  }
  async function observeStop(attempt: typeof attempts[number]): Promise<void> {
    if (report.ownedGroups.some(entry => entry.stage === attempt.stage)) return
    const launch = await readLaunchRecordForReconciliation(join(deps.paths.persistentRoot, "launches", attempt.launchAttemptId + ".json"))
    if (!launch.provider || launch.phase !== "cleanup_verified") fail("CLEANUP_UNVERIFIED")
    const identity = launch.provider.group, absence = await verifyQualificationAbsence(deps.absenceAdapter ?? deps.adapter, identity, candidate.manifest.deadlines.absenceMs)
    report.ownedGroups.push({ stage: attempt.stage, identity, absence })
    if (absence.first?.outcome !== "absent" || absence.second?.outcome !== "absent") fail("ABSENCE_UNVERIFIED")
  }
  try {
    const started = await startOrConnect({ root: deps.paths.runtimeRoot, hostId: deps.paths.hostKey, adapter: deps.adapter, handler: deps.handler(request.candidatePath, receiptsPath), timeoutMs: 15000,
      async onTransition(phase, pid) {
        if (phase === "launch_pending_written") {
          const record = await readHandlerRecord(join(deps.paths.runtimeRoot, "handler.json"))
          if (record.phase !== "launch_pending" || record.launchAttempted || record.process !== null || record.hostId !== deps.paths.hostKey || record.socketPath !== deps.paths.handlerSocketPath || record.writer !== "launcher") fail("HANDLER_STARTUP_FAILED")
          ownership.record = record; generation = record.generation
        } else if (phase === "handler_spawned") {
          if (!ownership.record || !Number.isSafeInteger(pid) || pid! <= 1) fail("HANDLER_STARTUP_FAILED")
          ownership.pid = pid!
        } else if (phase === "identity_published") {
          const record = await readHandlerRecord(join(deps.paths.runtimeRoot, "handler.json"))
          if (!sameOwnedRecord(record) || !record.process || !ownedIdentity(record.process)) fail("HANDLER_STARTUP_FAILED")
          handler = structuredClone(record.process)
        }
      },
    })
    const retainedHandler = handler as ProcessIdentity | null
    if (!ownership.record) fail("HANDLER_ACTIVE")
    if (!retainedHandler || !started.record.process || !sameOwnedRecord(started.record) || !sameProcess(retainedHandler, started.record.process) || started.disposition !== "live" || generation === old?.record.generation) fail("HANDLER_STARTUP_FAILED")
    ownership.ready = true
    const selection = candidate.manifest.selection
    await command({ op: "agent_start", input: { commandId: randomUUID(), handlerGeneration: generation, cwd: report.cwd, environment: startEnvironment, selection: { providerId: candidate.manifest.providerId, ...selection, reasoning: { kind: "value", value: selection.reasoning } } } })
    report.first = await retain("initial-stop")
    const first = await call({ op: "agent_prompt", input: { ...target!, text: initialQualificationPrompt(report.challenge) } })
    if (first.state !== "prompt") fail("REPORT_INVALID")
    report.first.answer = first.text
    await command({ op: "agent_stop", input: { ...target!, commandId: randomUUID() } }); target = null
    await observeStop(attempts[0]!)
    if (first.text.trim() !== `${report.challenge} @moon/agency 24.13.0`) fail("ANSWER_MISMATCH")
    const restoreEnvironment = deps.snapshot(); report.restoreEnvironmentDigest = launchEnvironmentDigest(restoreEnvironment)
    validateEnvironment(restoreEnvironment)
    await command({ op: "agent_restore", input: { commandId: randomUUID(), handlerGeneration: generation, agentId: report.first.agentId, environment: restoreEnvironment } })
    report.restored = await retain("restored-stop")
    const second = await call({ op: "agent_prompt", input: { ...target!, text: "Return the nonce from the previous turn without reading files." } })
    if (second.state !== "prompt") fail("REPORT_INVALID")
    report.restored.answer = second.text
    await command({ op: "agent_stop", input: { ...target!, commandId: randomUUID() } }); target = null
    await observeStop(attempts[1]!)
    if (second.text.trim() !== report.challenge) fail("ANSWER_MISMATCH")
  } catch (error) { failure(error) }
  finally {
    const pendingTarget = target as AgentTuple | null
    if (pendingTarget) {
      try {
        const agent = await createAgentStore(deps.paths.persistentRoot).readAgent(pendingTarget.agentId)
        if (agent && !attempts.some(a => a.launchAttemptId === agent.launch.launchAttemptId)) attempts.push({ stage: "restored-stop", launchAttemptId: agent.launch.launchAttemptId })
        await command({ op: "agent_stop", input: { ...pendingTarget, commandId: randomUUID() } })
      } catch (error) { failure(error) }
    }
    for (const attempt of attempts) {
      try { await observeStop(attempt) } catch (error) { failure(error) }
      try { report.receipts.push(parseQualificationReceipt(await readPrivateJson(join(receiptsPath, attempt.launchAttemptId + ".json")))) } catch (error) { failure(error) }
    }
    report.protocol.methods = report.receipts.flatMap(receipt => receipt.methods)
    report.protocol.promptCount = report.protocol.methods.filter(method => method === "session/prompt").length
    if (!handler && ownership.record && ownership.pid !== null) {
      try {
        const observed = await deps.adapter.readProcess(ownership.pid)
        if (observed && ownedIdentity(observed)) handler = observed
        else if (observed) fail("HANDLER_STARTUP_FAILED")
      } catch (error) { failure(error) }
    }
    if (handler) {
      try {
        const identity = handler
        const current = await deps.adapter.readProcess(identity.pid)
        if (current !== null) {
          if (!ownedIdentity(current) || !sameProcess(identity, current)) fail("CLEANUP_UNVERIFIED")
          let stopped = false
          const record = await readHandlerRecord(join(deps.paths.runtimeRoot, "handler.json"))
          if (sameOwnedRecord(record) && record.process && sameProcess(identity, record.process)) {
            try {
              const reply = await exchange(createConnection(deps.paths.handlerSocketPath), { protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, op: "shutdown", commandId: randomUUID(), stopAgents: true }, ownership.ready ? 15000 : 5000)
              stopped = reply.ok
            } catch {}
          }
          if (!stopped) {
            if (ownership.ready || record.phase === "ready") fail("CLEANUP_UNVERIFIED")
            const first = await deps.adapter.readGroup(identity.pid), second = await deps.adapter.readGroup(identity.pid), observed = await deps.adapter.readProcess(identity.pid)
            if (!observed || !sameProcess(identity, observed) || first.length !== 1 || second.length !== 1 || !sameProcess(identity, first[0]!) || !sameProcess(identity, second[0]!)) fail("CLEANUP_UNVERIFIED")
            await deps.adapter.signalGroup(identity.pid, "SIGKILL")
          }
        }
        const deadline = performance.now() + 5000
        while (true) {
          const remaining = deadline - performance.now()
          if (remaining <= 0) fail("ABSENCE_UNVERIFIED")
          let timer: NodeJS.Timeout | undefined
          try {
            const observed = await Promise.race([deps.adapter.readProcess(handler.pid), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new QualificationError("ABSENCE_UNVERIFIED")), remaining) })])
            if (observed === null) break
          } catch (error) {
            if (!(error instanceof Error) || !error.name.endsWith("ObservationUnavailable")) throw error
          } finally { clearTimeout(timer) }
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        const proof = await verifyQualificationAbsence(deps.adapter, { leader: handler, observed: [handler] }, 2000)
        if (proof.first?.outcome !== "absent" || proof.second?.outcome !== "absent") fail("ABSENCE_UNVERIFIED")
      } catch (error) { failure(error) }
    }
  }
  if (!report.failure) { report.qualified = true; try { parseCodexQualificationReport(report) } catch (error) { report.qualified = false; failure(error) } }
  const reportPath = join(evidence, "report.json")
  await durableQualificationWrite(reportPath, report)
  return { report, reportPath, reportSha256: (await readPrivateJsonWithDigest(reportPath)).sha256 }
}
export async function offlineCandidate(candidatePath: string, manifestPath: string): Promise<CodexQualificationCandidate> {
  const manifest = parseCodexQualificationManifest(await readPrivateJson(manifestPath)), observation = await verifyCodexQualification(manifest)
  const candidate = { version: 4 as const, manifest, fingerprint: qualificationFingerprint(manifest) }
  requireEqual(observation.fingerprint, candidate.fingerprint, "ADAPTER_UNQUALIFIED")
  await durableQualificationWrite(candidatePath, candidate)
  return candidate
}
export async function codexQualificationMain(argv: readonly string[]): Promise<number> {
  const args = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!, value = argv[index + 1]
    if (!["--stage", "--candidate", "--manifest", "--evidence-parent", "--report", "--report-sha256", "--reviewed-branch", "--reviewed-commit"].includes(key) || args.has(key) || !value) fail("USAGE")
    args.set(key, value)
  }
  const stage = args.get("--stage"), candidatePath = args.get("--candidate")
  if (!candidatePath || !["candidate", "live", "source"].includes(stage ?? "")) fail("USAGE")
  if (process.versions.node !== "24.13.0") fail("ADAPTER_UNQUALIFIED")
  const revision = { reviewedBranch: args.get("--reviewed-branch")!, reviewedCommit: args.get("--reviewed-commit")! }
  requireEqual(await observeCurrentRevision(), reviewed(revision), "ADAPTER_UNQUALIFIED")
  if (stage === "candidate") {
    if (!args.has("--manifest")) fail("USAGE")
    process.stdout.write(JSON.stringify(await offlineCandidate(candidatePath, args.get("--manifest")!)) + "\n"); return 0
  }
  if (stage === "source") {
    if (!args.has("--report") || !args.has("--report-sha256")) fail("USAGE")
    const candidate = parseQualificationCandidate(await readPrivateJson(candidatePath)), bytes = await readPrivateJsonWithDigest(args.get("--report")!), report = parseCodexQualificationReport(bytes.value)
    const source = renderPublishedQualificationSource(candidate, report, args.get("--report-sha256")!, bytes.sha256, revision)
    requireEqual((await verifyCodexQualification(candidate.manifest)).fingerprint, candidate.fingerprint, "ADAPTER_UNQUALIFIED")
    const adapter = createDarwinAdapter()
    for (const group of report.ownedGroups) {
      const proof = await verifyQualificationAbsence(adapter, group.identity, candidate.manifest.deadlines.absenceMs)
      if (proof.first?.outcome !== "absent" || proof.second?.outcome !== "absent") fail("ABSENCE_UNVERIFIED")
    }
    process.stdout.write(source); return 0
  }
  if (!args.has("--evidence-parent")) fail("USAGE")
  const result = await runCodexQualification({ candidatePath, evidenceParent: args.get("--evidence-parent")!, ...revision })
  process.stdout.write(JSON.stringify({ qualified: result.report.qualified, failure: result.report.failure, reportPath: result.reportPath, reportSha256: result.reportSha256 }) + "\n")
  return result.report.qualified ? 0 : 1
}
if (process.argv[1] === fileURLToPath(import.meta.url)) void codexQualificationMain(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { process.stderr.write((error instanceof QualificationError || error instanceof AgentError ? error.code : "REPORT_INVALID") + "\n"); process.exitCode = 1 })