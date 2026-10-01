import { spawn, type ChildProcess } from "node:child_process"
import { constants } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import type { MutationQueue } from "../handler/mutations.js"
import type { InventoryEntry } from "../handler/inventory.js"
import { agencyLaunchMarker, exactAgencyBirth } from "../platform/launch-marker.js"
import type { PlatformPaths } from "../platform/paths.js"
import { assertPrivateDirectory, readLaunchRecordForReconciliation, writeLaunchRecord } from "../platform/private-state.js"
import { reconcileRecord } from "../platform/reconcile.js"
import { sameProcess, sameProcessGeneration, type LaunchRecord, type PlatformAdapter } from "../platform/types.js"
import { observeConfig } from "./config.js"
import type { CatalogInventory, CatalogStore } from "./store.js"
import { CatalogError, failure, invalid, keys, object, parseModels, parseProbeMeta, text, type CatalogFailure, type ConfigEvidence, type Model, type ProbeMeta, type ProviderId, type ProviderProfile, type RetainedProbeMeta } from "./types.js"

export type ProbeResult = { models: Model[]; providerVersion: string | null; providerVersionSource: "reported" | "unknown" }
export type ProbeRequest = { meta: ProbeMeta; profile: ProviderProfile; evidence: ConfigEvidence }
export type ProbeOutcome = { request: ProbeRequest; record: LaunchRecord; result: ProbeResult | null; error: CatalogFailure | null }
export type ProbeRuntime = { run(request: ProbeRequest, signal: AbortSignal): Promise<ProbeOutcome>; recover(): Promise<void>; verifyDischarged(): Promise<void>; issues?(): Map<ProviderId, CatalogFailure>; diagnostics?(): string[] }
export type ProbeDependencies = { spawn?: typeof spawn; publish?: typeof writeLaunchRecord; timeoutMs?: number; closeMs?: number; env?: NodeJS.ProcessEnv }
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
export function createProbeRuntime(options: { paths: PlatformPaths; adapter: PlatformAdapter; queue: MutationQueue; store: CatalogStore; generation: string; canStart(): boolean; workerFile?: string; dependencies?: ProbeDependencies }): ProbeRuntime {
  const { paths, adapter, queue, store, generation } = options, deps = options.dependencies ?? {}, publish = deps.publish ?? writeLaunchRecord
  let accepted: InventoryEntry[] = [], metadata: RetainedProbeMeta[] = [], initialized = false, blocked = false, running = false
  const blockedProviders = new Map<ProviderId, CatalogFailure>()
  const unscopedIssues = new Set<string>()
  const terminal = new Map<string, { child: ChildProcess; exit: boolean; close: boolean }>()
  const unavailable = (): never => { blocked = true; throw new CatalogError("PROBE_CLEANUP_UNVERIFIED") }
  const scopedUnavailable = (providerId: ProviderId): never => { blockedProviders.set(providerId, failure(new CatalogError("PROBE_CLEANUP_UNVERIFIED"))); throw new CatalogError("PROBE_CLEANUP_UNVERIFIED") }
  const issueFor = (attemptId: string, kind: "probe-meta" | "probe-launches") => `${kind}/${attemptId}.json`
  const ownerOf = (entry: InventoryEntry): ProviderId | null => entry.record.version === 2 && entry.record.owner.kind === "catalog-probe" ? entry.record.owner.providerId : null
  function providerFor(attemptId: string, inventory: CatalogInventory, known?: InventoryEntry): ProviderId | null {
    const acceptedEntry = known ?? accepted.find(entry => entry.record.launchAttemptId === attemptId)
    return (acceptedEntry ? ownerOf(acceptedEntry) : null)
      ?? metadata.find(meta => meta.attemptId === attemptId)?.providerId
      ?? inventory.commands.flatMap(command => command.attempts).find(attempt => attempt.attemptId === attemptId)?.providerId
      ?? inventory.metadata.find(meta => meta.attemptId === attemptId)?.providerId
      ?? null
  }
  function markIssue(issue: string, providerId: ProviderId | null): void {
    if (providerId) blockedProviders.set(providerId, failure(new CatalogError("PROBE_CLEANUP_UNVERIFIED")))
    else unscopedIssues.add(issue)
  }
  const unavailableFor = (entry: InventoryEntry): never => {
    const providerId = ownerOf(entry) ?? metadata.find(meta => meta.attemptId === entry.record.launchAttemptId)?.providerId
    if (providerId) return scopedUnavailable(providerId)
    unscopedIssues.add(issueFor(entry.record.launchAttemptId, "probe-launches"))
    throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
  }
  async function verify(): Promise<void> {
    const inventory = await store.inventory()
    unscopedIssues.clear()
    for (const issue of inventory.issues) {
      const match = /^probe-(?:meta|launches)\/([0-9a-f-]+)\.json$/.exec(issue)
      if (!match) {
        if (issue.startsWith("probe-meta/") || issue.startsWith("probe-launches/")) { unscopedIssues.add(issue); continue }
        return unavailable()
      }
      markIssue(issue, providerFor(match[1]!, inventory))
    }
    const markLaunch = (entry: InventoryEntry, known?: InventoryEntry): void => markIssue(issueFor(entry.record.launchAttemptId, "probe-launches"), providerFor(entry.record.launchAttemptId, inventory, known))
    const launchesByPath = new Map(inventory.launches.map(entry => [entry.path, entry]))
    const acceptedByPath = new Map(accepted.map(entry => [entry.path, entry]))
    for (const entry of inventory.launches) if (!isDeepStrictEqual(entry, acceptedByPath.get(entry.path))) markLaunch(entry, acceptedByPath.get(entry.path))
    for (const entry of accepted) if (!isDeepStrictEqual(entry, launchesByPath.get(entry.path))) markLaunch(entry, entry)
    const metadataByAttempt = new Map(inventory.metadata.map(entry => [entry.attemptId, entry]))
    const acceptedMetaByAttempt = new Map(metadata.map(entry => [entry.attemptId, entry]))
    for (const entry of inventory.metadata) if (entry.hostId !== paths.hostKey || !isDeepStrictEqual(entry, acceptedMetaByAttempt.get(entry.attemptId))) markIssue(issueFor(entry.attemptId, "probe-meta"), acceptedMetaByAttempt.get(entry.attemptId)?.providerId ?? providerFor(entry.attemptId, inventory))
    for (const entry of metadata) if (!isDeepStrictEqual(entry, metadataByAttempt.get(entry.attemptId))) markIssue(issueFor(entry.attemptId, "probe-meta"), entry.providerId)
    const affected = (attemptId: string): boolean => {
      const providerId = providerFor(attemptId, inventory)
      return providerId !== null && blockedProviders.has(providerId) || unscopedIssues.has(issueFor(attemptId, "probe-meta")) || unscopedIssues.has(issueFor(attemptId, "probe-launches"))
    }
    const permitted = (entry: InventoryEntry) => !affected(entry.record.launchAttemptId)
    const permittedMeta = (entry: RetainedProbeMeta) => !affected(entry.attemptId)
    if (!isDeepStrictEqual(inventory.launches.filter(permitted), accepted.filter(permitted)) || !isDeepStrictEqual(inventory.metadata.filter(permittedMeta), metadata.filter(permittedMeta))) unavailable()
  }
  function accept(path: string, record: LaunchRecord): void {
    accepted = [...accepted.filter(e => e.path !== path), { path, record: structuredClone(record) }].sort((a, b) => a.path < b.path ? -1 : 1)
  }
  async function update(path: string, record: LaunchRecord): Promise<void> {
    await publish(path, record)
    if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(path), record)) return record.version === 2 && record.owner.kind === "catalog-probe" ? scopedUnavailable(record.owner.providerId) : unavailable()
    accept(path, record)
  }
  async function discharge(entry: InventoryEntry): Promise<LaunchRecord> {
    const result = await reconcileRecord(entry.path, adapter, entry.record)
    if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(entry.path), result.record)) return unavailableFor(entry)
    accept(entry.path, result.record)
    if (result.record.phase !== "cleanup_verified") return unavailableFor(entry)
    if (result.record.provider !== null && result.record.launchBootId === await adapter.bootId()) {
      for (let n = 0; n < 2; n++) {
        for (const retained of result.record.provider.group.observed) {
          const current = await adapter.readProcess(retained.pid)
          if (current !== null && current.processGroupId === result.record.provider.group.leader.pid && sameProcessGeneration(retained, current)) return unavailableFor(entry)
        }
        if ((await adapter.readGroup(result.record.provider.group.leader.pid)).some(p => p.bootId === result.record.launchBootId)) return unavailableFor(entry)
      }
    }
    return result.record
  }
  async function recover(): Promise<void> {
    await queue.run(async () => {
      if (running) unavailable()
      const inventory = await store.inventory()
      accepted = inventory.launches; metadata = inventory.metadata; initialized = true
      if (inventory.issues.some(issue => !issue.startsWith("probe-meta/") && !issue.startsWith("probe-launches/"))) blocked = true
      for (const meta of metadata) if (meta.hostId !== paths.hostKey) blockedProviders.set(meta.providerId, failure(new CatalogError("PROBE_CLEANUP_UNVERIFIED")))
      for (const entry of [...accepted]) {
        try { await discharge(entry) }
        catch { markIssue(issueFor(entry.record.launchAttemptId, "probe-launches"), ownerOf(entry) ?? metadata.find(meta => meta.attemptId === entry.record.launchAttemptId)?.providerId ?? null) }
      }
      await verify()
      if (blocked) unavailable()
    })
  }
  async function verifyDischarged(): Promise<void> {
    await verify()
    if (blocked || running) unavailable()
    if (blockedProviders.size || unscopedIssues.size || accepted.some(e => e.record.phase !== "cleanup_verified") || [...terminal.values()].some(t => !t.exit || !t.close)) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
    for (const entry of [...accepted]) await discharge(entry)
  }
  async function run(input: ProbeRequest, signal: AbortSignal): Promise<ProbeOutcome> {
    const request = structuredClone(input), m = parseProbeMeta(request.meta), path = join(paths.persistentRoot, "catalog/probe-launches", m.attemptId + ".json")
    if (!initialized || blocked || blockedProviders.has(m.providerId) || running || m.handlerGeneration !== generation || m.hostId !== paths.hostKey) throw new CatalogError(blockedProviders.has(m.providerId) ? "PROBE_CLEANUP_UNVERIFIED" : "CATALOG_UNAVAILABLE")
    running = true
    let record: LaunchRecord = { version: 2, owner: { kind: "catalog-probe", providerId: m.providerId, commandId: m.commandId }, handlerGeneration: generation, launchAttemptId: m.attemptId, launchBootId: await adapter.bootId(), launchAttempted: false, phase: "launch_pending", provider: null, reason: null }
    let result: ProbeResult | null = null, error: CatalogFailure | null = null, child: ChildProcess | undefined, registered = false, messages = 0, candidates = 0, finished = false, spawnInvoked = false
    let finish!: () => void
    const completed = new Promise<void>(resolve => { finish = () => { finished = true; resolve() } })
    const fail = (cause: unknown): void => { error ??= failure(cause instanceof CatalogError ? cause : new CatalogError("PROBE_FAILED")); finish() }
    const abort = (): void => fail(new CatalogError("INCOMPLETE"))
    let timer = setTimeout(() => fail(new CatalogError("PROBE_TIMEOUT")), 5000)
    signal.addEventListener("abort", abort, { once: true })
    const send = (message: object): void => {
      if (!child?.connected) { fail(new CatalogError("PROBE_FAILED")); return }
      try { child.send({ ...message, attemptId: m.attemptId, generation }, failure => { if (failure) fail(failure) }) } catch (error) { fail(error) }
    }
    try {
      await queue.run(async () => {
        await verify()
        if (!options.canStart() || signal.aborted || finished || accepted.some(e => e.record.launchAttemptId === m.attemptId)) throw new CatalogError("INCOMPLETE")
        if (!isDeepStrictEqual(await observeConfig(request.profile), request.evidence) || m.fingerprint !== request.evidence.fingerprint || m.providerId !== request.profile.id) throw new CatalogError("CONFIG_CHANGED")
        await store.writeProbeMeta(m)
        metadata = [...metadata, m].sort((a, b) => a.attemptId < b.attemptId ? -1 : 1)
        const catalog = join(paths.persistentRoot, "catalog")
        await privateProbeDirectory(catalog, "probe-launches")
        const work = await privateProbeDirectory(catalog, "work")
        await privateProbeDirectory(work, m.attemptId, true)
        await update(path, record)
        record = { ...record, launchAttempted: true }
        await update(path, record)
        if (!options.canStart() || signal.aborted || finished) throw new CatalogError("INCOMPLETE")
        spawnInvoked = true
        child = (deps.spawn ?? spawn)(process.execPath, [options.workerFile ?? fileURLToPath(new URL("./worker.js", import.meta.url))], { argv0: agencyLaunchMarker("provider", m.attemptId), detached: true, shell: false, cwd: m.workPath, env: cleanProbeEnvironment(deps.env ?? process.env), stdio: ["ignore", "pipe", "pipe", "ipc"] })
        const facts = { child, exit: false, close: false }
        terminal.set(m.attemptId, facts)
        child.on("error", fail)
        child.on("exit", () => { facts.exit = true; if (!finished) fail(new CatalogError("PROBE_FAILED")) })
        child.on("close", () => { facts.close = true; if (!finished) fail(new CatalogError("PROBE_FAILED")) })
        child.on("disconnect", () => { if (!finished) fail(new CatalogError("PROBE_FAILED")) })
        for (const [stream, limit] of [[child.stdout, 65536], [child.stderr, 8192]] as const) {
          let total = 0
          stream?.on("data", (bytes: Buffer) => { total += bytes.length; if (total > limit) fail(new CatalogError("PROBE_FAILED")) })
          stream?.on("error", fail)
        }
        child.on("message", raw => {
          try {
            messages += Buffer.byteLength(JSON.stringify(raw))
            if (messages > 1048576) invalid()
            const v = object(raw)
            if (v.attemptId !== m.attemptId || v.generation !== generation) invalid()
            if (v.type === "native") {
              keys(v, ["type", "attemptId", "generation", "pid"])
              if (registered || finished || typeof v.pid !== "number" || !Number.isSafeInteger(v.pid) || v.pid <= 0) invalid()
              registered = true
              const pid = v.pid
              void queue.run(async () => {
                await verify()
                const leader = record.provider?.group.leader, first = await adapter.readProcess(pid), second = await adapter.readProcess(pid)
                if (!leader || !first || !second || !sameProcess(first, second) || first.parentPid !== leader.pid || first.pid === leader.pid || first.processGroupId !== leader.pid || first.sessionId !== leader.sessionId || first.bootId !== leader.bootId || first.uid !== leader.uid || first.gid !== leader.gid) throw new CatalogError("PROBE_FAILED")
                const group = await adapter.readGroup(leader.pid)
                if (!group.some(p => sameProcess(first, p))) throw new CatalogError("PROBE_FAILED")
                record = { ...record, provider: { kind: "process-group", group: { leader, observed: [leader, first] } } }
                await update(path, record)
                if (!finished && options.canStart() && !signal.aborted) send({ type: "registered", pid })
                else abort()
              }).catch(fail)
            } else if (v.type === "result") {
              keys(v, ["type", "attemptId", "generation", "result"])
              if (++candidates > 1 || !registered) invalid()
              result = parseProbeResult(v.result, m.providerId); finish()
            } else if (v.type === "failure" || v.type === "cancel" || v.type === "native-terminal") {
              keys(v, ["type", "attemptId", "generation"])
              if (v.type !== "native-terminal" || !registered) fail(new CatalogError("PROBE_FAILED"))
            } else invalid()
          } catch (error) { fail(error) }
        })
        if (child.pid === undefined) throw new CatalogError("PROBE_FAILED")
        const first = await adapter.readProcess(child.pid), second = await adapter.readProcess(child.pid)
        if (!first || !second || !sameProcess(first, second) || !exactAgencyBirth(first.birth, agencyLaunchMarker("provider", m.attemptId)) || first.pid !== first.processGroupId || first.pid !== first.sessionId || first.bootId !== record.launchBootId || first.uid !== process.getuid!() || first.gid !== process.getgid!()) throw new CatalogError("PROBE_FAILED")
        record = { ...record, phase: "readiness", provider: { kind: "process-group", group: { leader: first, observed: [first] } } }
        await update(path, record)
        if (!finished && options.canStart() && !signal.aborted) {
          clearTimeout(timer)
          timer = setTimeout(() => fail(new CatalogError("PROBE_TIMEOUT")), deps.timeoutMs ?? 20000)
          send({ type: "start", request })
        }
        else abort()
      })
      if (signal.aborted) abort()
      await completed
      await new Promise<void>(resolve => setImmediate(resolve))
    } catch (cause) { fail(cause) }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort) }
    try {
      await queue.run(async () => {
        await verify()
        let entry = accepted.find(e => e.path === path)
        if (entry && !spawnInvoked && entry.record.launchAttempted && entry.record.provider === null && entry.record.phase === "launch_pending") {
          await update(path, { ...entry.record, launchAttempted: false })
          entry = accepted.find(e => e.path === path)
        }
        if (entry) record = await discharge(entry)
        else if (child !== undefined || record.launchAttempted) scopedUnavailable(m.providerId)
      })
      const facts = terminal.get(m.attemptId)
      if (facts && (!facts.exit || !facts.close)) await new Promise<void>(resolve => {
        const timeout = setTimeout(done, deps.closeMs ?? 1000)
        function done() { clearTimeout(timeout); facts!.child.off("close", done); resolve() }
        facts.child.once("close", done)
      })
      if (facts && (!facts.exit || !facts.close)) scopedUnavailable(m.providerId)
      if (!isDeepStrictEqual(await observeConfig(request.profile), request.evidence)) throw new CatalogError("CONFIG_CHANGED")
    } catch (cause) {
      if (!(cause instanceof CatalogError) || cause.code !== "CONFIG_CHANGED") { blockedProviders.set(m.providerId, failure(new CatalogError("PROBE_CLEANUP_UNVERIFIED"))); error = failure(new CatalogError("PROBE_CLEANUP_UNVERIFIED")) }
      else error = failure(cause)
    } finally { running = false }
    if (signal.aborted) error ??= failure(new CatalogError("INCOMPLETE"))
    return { request, record, result: error === null ? result : null, error }
  }
  return { run, recover, verifyDischarged, issues: () => new Map(blockedProviders), diagnostics: () => [...unscopedIssues].sort() }
}