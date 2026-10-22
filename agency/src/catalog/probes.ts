import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { mkdir, open, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import type { MutationQueue } from "../handler/mutations.js"
import type { InventoryEntry } from "../handler/inventory.js"
import { agencyLaunchMarker } from "../platform/launch-marker.js"
import type { PlatformPaths } from "../platform/paths.js"
import { assertPrivateDirectory, readLaunchRecordForReconciliation, writeLaunchRecord } from "../platform/private-state.js"
import { spawnOwnedChild, type OwnedChild } from "../runtime/owned-child.js"
import { captureLiveProcess, isLiveCleanupEvidence, type LiveProcessGroup, type LiveCleanupEvidence } from "../platform/live-process.js"
import { createProbeTransition, type ProbeTransition } from "./probe-transitions.js"
import { parseNativeSettlement, parseWorkerEnvelope, type NativeSettlement } from "./worker-protocol.js"
import { type ManagedLaunchRecord, type LaunchRecord, type PlatformAdapter } from "../platform/types.js"
import { beginProbeCapture, completeProbeCapture, initialProbeDiagnostic, openProbeStderr, parseProbeFailureDetail, parseProbeTerminal, probeFailureDetail, writeProbeDiagnostic, writeProbeStderr, type ProbeStage } from "./diagnostics.js"
import type { CatalogStore } from "./store.js"
import { CatalogError, failure, invalid, keys, object, parseModels, parseProbeMeta, text, type CatalogFailure, type ConfigEvidence, type Model, type ProbeMeta, type ProviderId, type ProviderProfile } from "./types.js"

export type ProbeResult = { models: Model[]; providerVersion: string | null; providerVersionSource: "reported" | "unknown" }
export type ProbeRequest = { meta: ProbeMeta; profile: ProviderProfile; evidence: ConfigEvidence }
export type ProbeOutcome = { request: ProbeRequest; record: LaunchRecord; result: ProbeResult | null; error: CatalogFailure | null }
export type ProbeRuntime = { run(request: ProbeRequest, signal: AbortSignal): Promise<ProbeOutcome>; verifyDischarged(): Promise<void>; issues?(): Map<ProviderId, CatalogFailure>; diagnostics?(): string[] }
export type ProbeDependencies = { spawn?: typeof spawn; publish?: typeof writeLaunchRecord; timeoutMs?: number; closeMs?: number; env?: NodeJS.ProcessEnv; now?: () => number }
export function cleanProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key !== "NODE_OPTIONS" && key !== "NODE_PATH" && !key.startsWith("AGENCY_") && !key.startsWith("GIT_")))
}
export function parseProbeResult(input: unknown, providerId: ProviderId): ProbeResult {
  const v = object(input)
  keys(v, ["models", "providerVersion", "providerVersionSource"])
  if (v.providerVersionSource !== "reported" && v.providerVersionSource !== "unknown") invalid()
  if ((v.providerVersion === null) !== (v.providerVersionSource === "unknown")) invalid()
  return { models: parseModels(v.models, providerId), providerVersion: v.providerVersion === null ? null : text(v.providerVersion), providerVersionSource: v.providerVersionSource }
}
export async function privateProbeDirectory(parent: string, name: string, requireNew = false): Promise<string> {
  await assertPrivateDirectory(parent)
  const directory = join(parent, name)
  try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (requireNew || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
  await assertPrivateDirectory(directory)
  const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
  return directory
}
type CurrentProbe = {
  providerId: ProviderId; mutations: Promise<unknown>[]; completion: Promise<void>; done: boolean; cleanupFailed: boolean
  publicationFailed: boolean; unresolved: boolean; repairable: boolean; epoch: number; transition?: ProbeTransition
  owner?: OwnedChild; group?: LiveProcessGroup; capture?: Promise<LiveProcessGroup>; evidence?: LiveCleanupEvidence
  spawnInvoked: boolean; startAttempted: boolean; nativePid: number | null; attributedPid: number | null
  native: NativeSettlement | null; nativeClosed: boolean; nativeTerminal: { code: number | null; signal: string | null } | null
  nativeCommand: boolean; protocolInvalid: boolean; ipcComplete: boolean; physicalComplete: boolean
}
export function createProbeRuntime(options: { paths: PlatformPaths; adapter: PlatformAdapter; queue: MutationQueue; store: CatalogStore; generation: string; canStart(): boolean; workerFile?: string; dependencies?: ProbeDependencies }): ProbeRuntime {
  const { paths, adapter, queue, store, generation } = options, deps = options.dependencies ?? {}, publish = deps.publish ?? writeLaunchRecord, now = deps.now ?? (() => performance.now())
  const cleanupBudget = 4000 + 1000 + (deps.closeMs ?? 1000)
  const checkDeadline = (deadline: number): void => { if (now() >= deadline) throw new CatalogError("PROBE_TIMEOUT") }
  const bounded = async <T>(operation: () => Promise<T>, deadline: number): Promise<T> => {
    let timer: NodeJS.Timeout | undefined
    try {
      checkDeadline(deadline)
      const value = await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CatalogError("PROBE_TIMEOUT")), Math.max(1, deadline - now())) })])
      checkDeadline(deadline)
      return value
    } finally { clearTimeout(timer) }
  }
  let accepted: InventoryEntry[] = [], running = false
  const blockedProviders = new Map<ProviderId, CatalogFailure>()
  const current = new Map<string, CurrentProbe>()
  const unscopedIssues = new Set<string>()
  const recomputeIssues = () => { blockedProviders.clear(); for (const attempt of current.values()) if (attempt.cleanupFailed) blockedProviders.set(attempt.providerId, failure(new CatalogError("PROBE_CLEANUP_UNVERIFIED"))) }
  function accept(path: string, record: LaunchRecord): void {
    accepted = [...accepted.filter(e => e.path !== path), { path, record: structuredClone(record) }].sort((a, b) => a.path < b.path ? -1 : 1)
  }
  async function publishClean(attempt: CurrentProbe, check: () => void): Promise<void> {
    check()
    const transition = attempt.transition
    if (!transition || !attempt.repairable) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
    let record = transition.current()
    if (attempt.spawnInvoked) {
      if (!attempt.group || !attempt.evidence || !isLiveCleanupEvidence(attempt.evidence, attempt.group)) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
      if (record.phase !== "cleanup_verified") {
        record = { ...record, phase: "cleanup_pending", provider: { kind: "process-group", group: structuredClone(attempt.evidence.group) }, reason: null }
        await transition.publish(record); check()
      }
      record = { ...record, phase: "cleanup_verified", provider: { kind: "process-group", group: structuredClone(attempt.evidence.group) }, reason: null }
    } else {
      if (record.launchAttempted) { record = { ...record, launchAttempted: false }; await transition.publish(record); check() }
      record = { ...record, launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null }
    }
    check(); await transition.publish(record); check()
  }
  async function verifyDischarged(): Promise<void> {
    const deadline = now() + cleanupBudget, check = () => checkDeadline(deadline)
    try {
      await bounded(() => Promise.allSettled([...current.values()].map(attempt => attempt.completion)), deadline)
      await bounded(() => Promise.allSettled([...current.values()].flatMap(attempt => attempt.mutations)), deadline)
      await bounded(() => queue.run(async () => {
        check()
        for (const attempt of current.values()) {
          if (attempt.cleanupFailed && attempt.repairable) {
            try {
              if (attempt.transition || attempt.spawnInvoked) await publishClean(attempt, check)
              check(); attempt.publicationFailed = false; attempt.cleanupFailed = false
            }
            catch { attempt.cleanupFailed = true }
          }
          check()
        }
        recomputeIssues()
        if (running || blockedProviders.size
          || [...current.values()].some(attempt => !attempt.done || attempt.cleanupFailed || (attempt.transition ? !attempt.transition.durable() : attempt.spawnInvoked))
          || accepted.some(entry => entry.record.phase !== "cleanup_verified")) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
      }), deadline)
    } catch { recomputeIssues(); throw new CatalogError("PROBE_CLEANUP_UNVERIFIED") }
  }
  async function run(input: ProbeRequest, signal: AbortSignal): Promise<ProbeOutcome> {
    const request = structuredClone(input), m = parseProbeMeta(request.meta), path = join(paths.persistentRoot, "catalog/probe-launches", m.attemptId + ".json")
    if (blockedProviders.has(m.providerId) || running || current.has(m.attemptId) || m.handlerGeneration !== generation || m.hostId !== paths.hostKey) throw new CatalogError(blockedProviders.has(m.providerId) ? "PROBE_CLEANUP_UNVERIFIED" : "CATALOG_UNAVAILABLE")
    running = true
    let complete!: () => void
    const attempt: CurrentProbe = { providerId: m.providerId, mutations: [], completion: new Promise(resolve => { complete = resolve }), done: false, cleanupFailed: false, publicationFailed: false, unresolved: false, repairable: false, epoch: 0, spawnInvoked: false, startAttempted: false, nativePid: null, attributedPid: null, native: null, nativeClosed: false, nativeTerminal: null, nativeCommand: false, protocolInvalid: false, ipcComplete: false, physicalComplete: false }
    current.set(m.attemptId, attempt)
    let record: ManagedLaunchRecord = { version: 2, owner: { kind: "catalog-probe", providerId: m.providerId, commandId: m.commandId }, handlerGeneration: generation, launchAttemptId: m.attemptId, launchBootId: "unknown", launchAttempted: false, phase: "launch_pending", provider: null, reason: null }
    let result: ProbeResult | null = null, error: CatalogFailure | null = null, registered = false, messages = 0, candidates = 0, finished = false, cleaning = false, finalized = false
    const diagnostic = initialProbeDiagnostic(m), preparationDeadline = now() + 5000
    let stage: ProbeStage = "preparation", diagnosticCreated = false, workerStderr: FileHandle | undefined, nativeStderr: FileHandle | undefined, stderrFailed = false, disconnected = false
    let finish!: () => void, nativeReport!: () => void
    const completed = new Promise<void>(resolve => { finish = () => { finished = true; resolve() } }), reported = new Promise<void>(resolve => { nativeReport = resolve })
    const fail = (cause: unknown, at: ProbeStage = stage): void => { if (finalized) return; diagnostic.firstFailure ??= probeFailureDetail(at, cause); error ??= failure(cause instanceof CatalogError ? cause : new CatalogError("PROBE_FAILED")); finish() }
    const abort = (): void => fail(new CatalogError("INCOMPLETE"), "cancelled")
    let timer = setTimeout(() => fail(new CatalogError("PROBE_TIMEOUT"), "timeout"), 5000), discoveryDeadline = preparationDeadline
    signal.addEventListener("abort", abort, { once: true })
    const checkPreparation = (): void => {
      if (cleaning || finalized || finished || signal.aborted || !options.canStart()) throw new CatalogError("INCOMPLETE")
      checkDeadline(preparationDeadline)
    }
    const openStderr = async (name: "worker.stderr" | "native.stderr"): Promise<FileHandle> => {
      checkPreparation()
      const handle = await openProbeStderr(m.workPath, name)
      try { checkPreparation(); return handle }
      catch (cause) { void handle.close().catch(() => undefined); throw cause }
    }
    const update = async (next: ManagedLaunchRecord): Promise<void> => {
      if (finalized) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
      try { await attempt.transition!.publish(next) }
      catch (cause) { attempt.publicationFailed = true; throw cause }
      finally { record = attempt.transition!.current() }
    }
    const sends: Promise<void>[] = []
    const send = (message: object): Promise<void> => {
      const pending = new Promise<void>((resolve, reject) => {
        const child = attempt.owner?.child
        if (!child?.connected || disconnected) { reject(new CatalogError("PROBE_FAILED")); return }
        try { child.send({ ...message, attemptId: m.attemptId, generation }, cause => cause ? reject(cause) : resolve()) } catch (cause) { reject(cause) }
      })
      sends.push(pending); void pending.catch(cause => fail(cause, "worker-ipc")); return pending
    }
    const nativeComplete = (): boolean => {
      if (attempt.protocolInvalid || attempt.unresolved) return false
      if (!attempt.startAttempted) return attempt.nativePid === null && !attempt.nativeCommand
      const native = attempt.native
      if (!native) return false
      if (native.kind === "not-spawned") return !attempt.nativeCommand && attempt.nativePid === null && !attempt.nativeTerminal && !attempt.nativeClosed
      if (native.kind === "spawn-error") return attempt.nativeCommand && attempt.nativePid === null && attempt.nativeClosed && !attempt.nativeTerminal
      return native.pid === attempt.attributedPid && native.pid === attempt.nativePid && attempt.nativeClosed && isDeepStrictEqual({ code: native.code, signal: native.signal }, attempt.nativeTerminal)
    }
    const receive = (raw: unknown): void => {
      if (finalized) return
      let nativeMessage = false
      try {
        messages += Buffer.byteLength(JSON.stringify(raw))
        if (messages > 1048576) { attempt.protocolInvalid = true; invalid() }
        nativeMessage = typeof raw === "object" && raw !== null && "type" in raw && ["native-settled", "native-terminal", "native-closed"].includes(String(raw.type))
        const v = parseWorkerEnvelope(raw, { attemptId: m.attemptId, generation })
        if (v.type === "native-command") {
          keys(v, ["type", "attemptId", "generation", "command"])
          const command = object(v.command); keys(command, ["file", "args"])
          if (cleaning || attempt.nativeCommand || command.file !== request.profile.executable || !Array.isArray(command.args) || command.args.some(a => typeof a !== "string" || a.includes("\0")) || Buffer.byteLength(JSON.stringify(command)) > 65536) { attempt.protocolInvalid = true; invalid() }
          attempt.nativeCommand = true
          diagnostic.nativeCommand = { file: command.file as string, args: command.args as string[] }
        } else if (v.type === "native") {
          keys(v, ["type", "attemptId", "generation", "pid"])
          if (cleaning || attempt.nativePid !== null || typeof v.pid !== "number" || !Number.isSafeInteger(v.pid) || v.pid <= 0) { attempt.unresolved = true; invalid() }
          attempt.nativePid = v.pid
          const registration = queue.run(async () => {
            try {
              if (cleaning) { attempt.unresolved = true; throw new CatalogError("PROBE_FAILED") }
              const member = await bounded(() => adapter.readProcess(v.pid as number), discoveryDeadline)
              if (cleaning || finalized) throw new CatalogError("PROBE_FAILED")
              diagnostic.nativeIdentity = member
              if (!member || member.pid !== v.pid || !attempt.group) { attempt.unresolved = true; throw new CatalogError("PROBE_FAILED") }
              try { attempt.group.observeMember(member) } catch (cause) { attempt.unresolved = true; throw cause }
              attempt.attributedPid = member.pid
              await update({ ...record, provider: { kind: "process-group", group: attempt.group.identity() } })
              if (!cleaning && !finished && now() < discoveryDeadline && options.canStart() && !signal.aborted) { registered = true; await send({ type: "registered", pid: member.pid }) }
              else if (!cleaning) abort()
            } catch (cause) { if (!attempt.publicationFailed) attempt.unresolved = true; throw cause }
          })
          attempt.mutations.push(registration); void registration.catch(cause => fail(cause, "native-registration"))
        } else if (v.type === "result") {
          keys(v, ["type", "attemptId", "generation", "result"])
          if (++candidates > 1 || !registered || cleaning) invalid()
          result = parseProbeResult(v.result, m.providerId); finish()
        } else if (v.type === "failure") {
          keys(v, ["type", "attemptId", "generation", ...(v.detail === undefined ? [] : ["detail"])])
          if (v.detail !== undefined) {
            const detail = parseProbeFailureDetail(v.detail)
            if (detail.stage === "diagnostic-write" || detail.stage === "native-stream") stderrFailed = true
            diagnostic.firstFailure ??= detail
          }
          fail(new CatalogError("PROBE_FAILED"), "discovery")
        } else if (v.type === "native-terminal") {
          keys(v, ["type", "attemptId", "generation", "terminal"])
          if (attempt.nativeTerminal) invalid()
          attempt.nativeTerminal = parseProbeTerminal(v.terminal); diagnostic.nativeTerminal = attempt.nativeTerminal
          if (!registered || !finished && (diagnostic.nativeTerminal.code !== 0 || diagnostic.nativeTerminal.signal !== null)) fail(new CatalogError("PROBE_FAILED"), "native-exit")
        } else if (v.type === "native-closed") {
          keys(v, ["type", "attemptId", "generation"])
          if (attempt.nativeClosed) invalid()
          attempt.nativeClosed = true
        } else if (v.type === "native-settled") {
          keys(v, ["type", "attemptId", "generation", "native"])
          if (attempt.native) invalid()
          attempt.native = parseNativeSettlement(v.native); nativeReport()
        } else if (v.type === "cancel") {
          keys(v, ["type", "attemptId", "generation"]); fail(new CatalogError("PROBE_FAILED"), "cancelled")
        } else invalid()
      } catch (cause) { if (nativeMessage) attempt.protocolInvalid = true; fail(cause, "worker-ipc") }
    }
    try {
      const admission = queue.run(async () => {
        if (!options.canStart() || signal.aborted || finished || accepted.some(e => e.record.launchAttemptId === m.attemptId)) throw new CatalogError("INCOMPLETE")
        record.launchBootId = await bounded(() => adapter.bootId(), preparationDeadline); checkPreparation()
        if (m.fingerprint !== request.evidence.fingerprint || m.providerId !== request.profile.id) throw new CatalogError("CONFIG_CHANGED")
        await store.writeProbeMeta(m); checkPreparation()
        const catalog = join(paths.persistentRoot, "catalog")
        await privateProbeDirectory(catalog, "probe-launches"); checkPreparation()
        attempt.transition = createProbeTransition({ path, initial: record, io: { publish, read: readLaunchRecordForReconciliation }, accept: value => accept(path, value) })
        const work = await privateProbeDirectory(catalog, "work"); checkPreparation()
        await privateProbeDirectory(work, m.attemptId, true); checkPreparation()
        await beginProbeCapture(m.workPath, diagnostic); checkPreparation()
        await writeProbeDiagnostic(m.workPath, diagnostic); checkPreparation()
        diagnosticCreated = true
        workerStderr = await openStderr("worker.stderr"); nativeStderr = await openStderr("native.stderr")
        await update(record); checkPreparation()
        await update({ ...record, launchAttempted: true }); checkPreparation()
        attempt.spawnInvoked = true; stage = "worker-launch"
        attempt.owner = spawnOwnedChild({ launchAttemptId: m.attemptId,
          spawn: () => (deps.spawn ?? spawn)(process.execPath, [options.workerFile ?? fileURLToPath(new URL("./worker.js", import.meta.url))], { argv0: agencyLaunchMarker("provider", m.attemptId), detached: true, shell: false, cwd: m.workPath, env: cleanProbeEnvironment(deps.env ?? process.env), stdio: ["ignore", "pipe", "pipe", "ipc", nativeStderr!.fd] }),
          onEvent: event => {
            if (event.kind === "error") fail(event.error, "worker-launch")
            if (event.kind === "exit") { diagnostic.workerTerminal = { code: event.code, signal: event.signal }; if (!finished) fail(new CatalogError("PROBE_FAILED"), "worker-exit") }
            if (event.kind === "close" && !finished) fail(new CatalogError("PROBE_FAILED"), "worker-exit")
          },
        })
        const child = attempt.owner.child
        child.on("disconnect", () => { disconnected = true; if (!finished) fail(new CatalogError("PROBE_FAILED"), "worker-ipc") })
        let stdoutBytes = 0
        child.stdout?.on("data", (bytes: Buffer) => { stdoutBytes += bytes.length; if (stdoutBytes > 65536) fail(new CatalogError("PROBE_FAILED"), "worker-stream") })
        child.stderr?.on("data", (bytes: Buffer) => { try { writeProbeStderr(workerStderr!.fd, bytes) } catch (cause) { stderrFailed = true; fail(cause, "diagnostic-write") } })
        for (const stream of [child.stdout, child.stderr]) stream?.on("error", cause => { if (stream === child.stderr) stderrFailed = true; fail(cause, "worker-stream") })
        child.on("message", receive); stage = "worker-registration"
        attempt.capture = captureLiveProcess({ owner: attempt.owner, adapter, launchBootId: record.launchBootId, marker: agencyLaunchMarker("provider", m.attemptId), deadline: preparationDeadline, now })
        attempt.group = await attempt.capture; checkPreparation()
        diagnostic.workerIdentity = attempt.group.identity().leader
        await update({ ...record, phase: "readiness", provider: { kind: "process-group", group: attempt.group.identity() } })
        if (!finished && !cleaning && now() < preparationDeadline && options.canStart() && !signal.aborted) {
          clearTimeout(timer); discoveryDeadline = now() + (deps.timeoutMs ?? 20000)
          timer = setTimeout(() => fail(new CatalogError("PROBE_TIMEOUT"), "timeout"), deps.timeoutMs ?? 20000)
          stage = "discovery"; attempt.startAttempted = true; await send({ type: "start", request })
        } else abort()
      })
      attempt.mutations.push(admission); void admission.catch(cause => fail(cause))
      if (signal.aborted) abort()
      await completed
      await new Promise<void>(resolve => setImmediate(resolve))
    } catch (cause) { fail(cause) }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort) }
    stage = "cleanup"; cleaning = true
    const epoch = ++attempt.epoch, cleanupDeadline = now() + cleanupBudget
    const checkCleanup = (): void => {
      checkDeadline(cleanupDeadline)
      if (finalized || epoch !== attempt.epoch) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
    }
    const stopWorkerAndGroup = async (): Promise<void> => {
      if (!attempt.owner) {
        if (attempt.spawnInvoked) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
        attempt.physicalComplete = true; attempt.ipcComplete = true; return
      }
      const owner = attempt.owner
      if (!disconnected && owner.child.connected) void send({ type: "stop" })
      try {
        const group = attempt.group ?? (attempt.capture ? await bounded(() => attempt.capture!, cleanupDeadline) : undefined)
        if (!group) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
        attempt.group = group
        attempt.evidence = await group.cleanup({ deadline: cleanupDeadline, terminateMs: 4000, absenceMs: 1000, transportCloseMs: deps.closeMs ?? 1000 })
        attempt.physicalComplete = isLiveCleanupEvidence(attempt.evidence, group) && owner.snapshot().terminal?.kind === "exit" && owner.snapshot().closed
        if (attempt.startAttempted && !attempt.native && !disconnected) await bounded(() => Promise.race([reported, owner.closed]), cleanupDeadline)
        const sent = await bounded(() => Promise.allSettled(sends), cleanupDeadline)
        if (sent.some(value => value.status === "rejected")) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
      } finally {
        if (owner.child.connected) { try { owner.child.disconnect() } catch { } }
        attempt.ipcComplete = disconnected || !owner.child.connected
      }
    }
    let physicalSucceeded = false
    const physical = stopWorkerAndGroup().then(() => { checkCleanup(); physicalSucceeded = true }, cause => { attempt.physicalComplete = false; throw cause })
    const pendingPublication = queue.run(async () => {
      checkCleanup()
      if (attempt.transition && attempt.spawnInvoked && attempt.group) await update({ ...attempt.transition.current(), phase: "cleanup_pending", provider: { kind: "process-group", group: attempt.group.identity() }, reason: null })
    })
    attempt.mutations.push(pendingPublication)
    const settled = Promise.allSettled([physical, ...attempt.mutations])
    try {
      try { await bounded(() => settled, cleanupDeadline) }
      finally { attempt.repairable = physicalSucceeded && attempt.physicalComplete && attempt.ipcComplete && nativeComplete() }
      checkCleanup()
      if (attempt.publicationFailed || !attempt.repairable) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
      if (attempt.transition) {
        const publication = queue.run(() => publishClean(attempt, checkCleanup))
        attempt.mutations.push(publication); void publication.catch(() => undefined)
        await bounded(() => publication, cleanupDeadline)
      } else if (attempt.spawnInvoked) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
      checkCleanup()
    } catch (cause) {
      attempt.cleanupFailed = true
      diagnostic.firstFailure ??= probeFailureDetail("cleanup", cause)
      error = failure(new CatalogError("PROBE_CLEANUP_UNVERIFIED"))
    } finally { recomputeIssues() }
    record = attempt.transition?.current() ?? record
    if (signal.aborted) error ??= failure(new CatalogError("INCOMPLETE"))
    const captureFailure = (cause: unknown): void => {
      if (finalized) return
      diagnostic.firstFailure ??= probeFailureDetail("diagnostic-write", cause)
      stderrFailed = true
      error ??= failure(new CatalogError("PROBE_FAILED"))
      unscopedIssues.add("probe diagnostics unavailable: " + m.attemptId)
    }
    try {
      try {
        if (diagnosticCreated) {
          for (const handle of [workerStderr, nativeStderr]) {
            try { await bounded(() => handle!.sync(), cleanupDeadline) } catch (cause) { captureFailure(cause) }
          }
          try { diagnostic.workerStderrBytes = (await bounded(() => workerStderr!.stat(), cleanupDeadline)).size } catch (cause) { captureFailure(cause) }
          try { diagnostic.nativeStderrBytes = (await bounded(() => nativeStderr!.stat(), cleanupDeadline)).size } catch (cause) { captureFailure(cause) }
        }
      } finally {
        const closes = [workerStderr, nativeStderr].map(async handle => { try { await handle?.close() } catch (cause) { captureFailure(cause) } })
        await bounded(() => Promise.all(closes), cleanupDeadline)
      }
      if (diagnosticCreated) {
        diagnostic.stderrComplete = !stderrFailed && diagnostic.firstFailure?.stage !== "diagnostic-write" && record.phase === "cleanup_verified" && (!attempt.spawnInvoked || !!attempt.owner?.snapshot().closed) && (!attempt.startAttempted || nativeComplete()) && !!workerStderr && !!nativeStderr
        diagnostic.failed = error !== null
        diagnostic.finishedAt = Date.now()
        try { await bounded(() => writeProbeDiagnostic(m.workPath, diagnostic), cleanupDeadline) }
        catch (cause) { captureFailure(cause); diagnostic.stderrComplete = false; diagnostic.failed = true; throw cause }
        try { await bounded(() => completeProbeCapture(m.workPath), cleanupDeadline) }
        catch (cause) {
          unscopedIssues.add("probe diagnostics unavailable: " + m.attemptId)
          if (now() >= cleanupDeadline) captureFailure(cause)
        }
      }
    } catch (cause) { captureFailure(cause) }
    finally { finalized = true; attempt.owner?.child.off("message", receive); attempt.done = true; running = false; complete() }
    return { request, record: structuredClone(record), result: error === null ? result : null, error }
  }
  return { run, verifyDischarged, issues: () => new Map(blockedProviders), diagnostics: () => [...unscopedIssues].sort(),
  }
}