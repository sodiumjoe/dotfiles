import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { MutationQueue } from "../handler/mutations.js"
import type { PlatformPaths } from "../platform/paths.js"
import { observeConfig, readProfiles } from "./config.js"
import type { ProbeOutcome, ProbeRequest, ProbeRuntime } from "./probes.js"
import type { CatalogInventory, CatalogStore } from "./store.js"
import { CatalogError, failure, id, isFresh, PROVIDERS, type CatalogFailure, type CatalogSnapshot, type ConfigEvidence, type ProviderId, type ProviderProfile, type ProviderSnapshot, type RefreshCommand } from "./types.js"

export type RefreshView = Pick<RefreshCommand, "commandId" | "handlerGeneration" | "state" | "snapshotId">
export type ProviderView = ProviderSnapshot & { state: "unconfigured" | "ready" | "unavailable" | "blocked"; freshness: "fresh" | "stale" | "unverified"; refreshIssue?: CatalogFailure | null }
export type CatalogView = { state: "catalog"; hostId: string; handlerGeneration: string; observedAt: number; launchAuthorized: false; providers: ProviderView[]; refresh: RefreshView | null; discovery: { state: "idle" | "refreshing" | "blocked"; error: CatalogFailure | null } }
export type RefreshResult = { state: "refresh"; command: RefreshView; snapshot: CatalogSnapshot | null }
export type LaunchEvidence = { snapshotId: string; provider: ProviderSnapshot; profile: ProviderProfile; configuration: ConfigEvidence }
export type CatalogService = { initialize(): Promise<void>; startScheduling(): void; list(): Promise<CatalogView>; launchEvidence(providerId: ProviderId): Promise<LaunchEvidence>; refresh(commandId: string, generation: string): Promise<RefreshResult>; freezeAndDrain(): Promise<void>; resume(): void; verifyDischarged(): Promise<void>; close(): void }
export type CatalogClock = { now(): number; every(ms: number, tick: () => void): () => void }
type Config = { profiles: ProviderProfile[]; evidence: Map<ProviderId, ConfigEvidence>; errors: Map<ProviderId, CatalogFailure>; fingerprints: RefreshCommand["fingerprints"] }
type Batch = { id: string; config: Config; requests: ProbeRequest[]; commands: string[]; controller: AbortController; operation: Promise<void> | null; snapshot: CatalogSnapshot | null; finished: boolean; started: boolean; outcomes: Map<ProviderId, ProbeOutcome> }
const empty = (providerId: ProviderId): ProviderSnapshot => ({ providerId, fingerprint: null, verifiedAt: null, verifiedHandlerGeneration: null, providerVersion: null, providerVersionSource: "unknown", adapterVersion: null, sdkVersion: null, models: [], error: null })
const view = ({ commandId, handlerGeneration, state, snapshotId }: RefreshCommand): RefreshView => ({ commandId, handlerGeneration, state, snapshotId })
const systemClock: CatalogClock = { now: Date.now, every(ms, tick) { const timer = setInterval(tick, ms); timer.unref(); return () => clearInterval(timer) } }

export function createCatalogService(options: { paths: PlatformPaths; generation: string; queue: MutationQueue; store: CatalogStore; probes: ProbeRuntime; isReady(): boolean; shutdownPending(): boolean; readProfiles?: typeof readProfiles; observeConfig?: typeof observeConfig; clock?: CatalogClock }): CatalogService {
  const { paths, generation, queue, store, probes } = options, clock = options.clock ?? systemClock
  let current: CatalogSnapshot | null = null, diskCurrent: CatalogSnapshot | null = null, initialized = false, closed = false, frozen = false, scheduling = false, nextAutomatic = 0
  let blocked: CatalogFailure | null = null, inventoryBlocked = false, active: Batch | null = null, latest: RefreshCommand | null = null, cancelTimer: (() => void) | undefined
  const probeIssues = new Map<ProviderId, CatalogFailure>()
  const commands = new Map<string, RefreshCommand>()
  function latch(error: unknown, inventory = false): void { blocked ??= failure(error); inventoryBlocked ||= inventory }
  function scopeProbeIssues(inventory: CatalogInventory): void {
    for (const issue of inventory.issues) {
      const match = /^probe-(?:meta|launches)\/([0-9a-f-]+)\.json$/.exec(issue)
      const attempt = match?.[1]
      const providerId = inventory.metadata.find(meta => meta.attemptId === attempt)?.providerId
        ?? inventory.launches.flatMap(entry => entry.record.version === 2 && entry.record.owner.kind === "catalog-probe" ? [{ attemptId: entry.record.launchAttemptId, providerId: entry.record.owner.providerId }] : []).find(value => value.attemptId === attempt)?.providerId
        ?? inventory.commands.flatMap(command => command.attempts).find(value => value.attemptId === attempt)?.providerId
      if (!providerId) throw new CatalogError("CATALOG_UNAVAILABLE")
      probeIssues.set(providerId, failure(new CatalogError("PROBE_CLEANUP_UNVERIFIED")))
    }
  }
  const canStart = () => initialized && !closed && !frozen && !blocked && options.isReady() && !options.shutdownPending()
  async function config(): Promise<Config> {
    const profiles = (await (options.readProfiles ?? readProfiles)(paths.persistentRoot)).filter(p => p.enabled).sort((a, b) => a.id < b.id ? -1 : 1)
    const evidence = new Map<ProviderId, ConfigEvidence>(), errors = new Map<ProviderId, CatalogFailure>()
    for (const p of profiles) { try { evidence.set(p.id, await (options.observeConfig ?? observeConfig)(p)) } catch (error) { errors.set(p.id, failure(error)) } }
    return { profiles, evidence, errors, fingerprints: [...evidence].map(([providerId, e]) => ({ providerId, fingerprint: e.fingerprint })) }
  }
  async function verify(): Promise<void> {
    try {
      const inventory = await store.inventory()
      scopeProbeIssues(inventory)
      const expected = [...commands.values()].sort((a, b) => a.commandId < b.commandId ? -1 : 1)
      if (inventory.issues.some(issue => !issue.startsWith("probe-meta/") && !issue.startsWith("probe-launches/")) || !isDeepStrictEqual(inventory.commands, expected) || !isDeepStrictEqual(await store.readCurrent(), diskCurrent) || inventory.commands.some(c => c.hostId !== paths.hostKey)) throw new CatalogError("CATALOG_UNAVAILABLE")
    } catch (error) { latch(error, true); throw new CatalogError("CATALOG_UNAVAILABLE") }
  }
  async function persist(value: RefreshCommand, expected: RefreshCommand | null): Promise<void> {
    try { await store.writeCommand(value, expected) }
    finally {
      const visible = await store.readCommand(value.commandId)
      if (isDeepStrictEqual(visible, value)) { commands.set(value.commandId, value); latest = value }
      else if (!isDeepStrictEqual(visible, expected)) latch(new CatalogError("CATALOG_UNAVAILABLE"), true)
    }
  }
  async function receipt(command: RefreshCommand): Promise<RefreshResult> {
    const snapshot = command.snapshotId === null ? null : await store.readSnapshot(command.snapshotId)
    if (command.state === "completed" && (snapshot === null || snapshot.hostId !== paths.hostKey || snapshot.handlerGeneration !== command.handlerGeneration)) throw new CatalogError("CATALOG_UNAVAILABLE")
    return { state: "refresh", command: view(command), snapshot }
  }
  async function finalize(batch: Batch): Promise<void> {
    if (active !== batch || !batch.finished) return
    await verify()
    const interrupted = () => frozen || closed || options.shutdownPending() || !options.isReady()
    let interrupt = interrupted()
    if (!interrupt && batch.snapshot !== null) {
      const observed = await config()
      interrupt = batch.snapshot.providers.some(p => p.error === null && p.verifiedHandlerGeneration === generation && (p.fingerprint !== observed.evidence.get(p.providerId)?.fingerprint || !observed.profiles.some(profile => profile.id === p.providerId)))
    }
    if (!interrupt) {
      const publicationConfig = await config()
      if (batch.snapshot === null) {
        const observed = await config()
        const providers = PROVIDERS.map(providerId => {
          const previous = current?.providers.find(p => p.providerId === providerId) ?? empty(providerId), outcome = batch.outcomes.get(providerId), evidence = batch.config.evidence.get(providerId)
          let error = batch.config.errors.get(providerId) ?? outcome?.error ?? probeIssues.get(providerId) ?? null
          if (outcome?.result && evidence) {
            if (outcome.record.phase !== "cleanup_verified") error = failure(new CatalogError("PROBE_CLEANUP_UNVERIFIED"))
            else if (!isDeepStrictEqual(observed.evidence.get(providerId), evidence) || !observed.profiles.some(p => p.id === providerId)) error = failure(new CatalogError("CONFIG_CHANGED"))
            else return { providerId, fingerprint: evidence.fingerprint, verifiedAt: clock.now(), verifiedHandlerGeneration: generation, adapterVersion: evidence.adapterVersion, sdkVersion: evidence.sdkVersion, ...outcome.result, error: null }
          }
          return { ...previous, error: error?.code === "PROBE_CLEANUP_UNVERIFIED" && previous.verifiedAt !== null ? previous.error : error ?? previous.error }
        })
        batch.snapshot = { version: 1, hostId: paths.hostKey, snapshotId: randomUUID(), handlerGeneration: generation, createdAt: clock.now(), providers }
      }
      await store.writeSnapshot(batch.snapshot)
      interrupt = interrupted() || !isDeepStrictEqual(await config(), publicationConfig)
      if (!interrupt) {
        try { await store.publishCurrent(batch.snapshot); interrupt = interrupted(); if (!interrupt) current = batch.snapshot }
        finally {
          const observed = await store.readCurrent()
          if (isDeepStrictEqual(observed, batch.snapshot)) diskCurrent = observed
          else if (!isDeepStrictEqual(observed, diskCurrent)) latch(new CatalogError("CATALOG_UNAVAILABLE"), true)
        }
      }
    }
    for (const commandId of batch.commands) {
      const previous = commands.get(commandId)!
      const updated: RefreshCommand = previous.state !== "pending" ? previous : { ...previous, state: interrupt ? "interrupted" : "completed", snapshotId: interrupt ? null : batch.snapshot!.snapshotId }
      await persist(updated, previous)
    }
    if (active === batch) active = null
    nextAutomatic = clock.now() + (batch.snapshot?.providers.some(p => p.error) ? 60000 : 0)
  }
  function launch(batch: Batch): void {
    if (batch.started || active !== batch) return
    batch.started = true
    batch.operation = (async () => {
      for (const request of batch.requests) {
        if (!canStart() || batch.controller.signal.aborted || active !== batch) break
        let outcome: ProbeOutcome
        try { outcome = await probes.run(request, batch.controller.signal) }
        catch (error) {
          if (!(error instanceof CatalogError) || error.code !== "PROBE_CLEANUP_UNVERIFIED") { latch(error); break }
          const issue = failure(error)
          batch.config.errors.set(request.meta.providerId, issue)
          probeIssues.set(request.meta.providerId, issue)
          continue
        }
        if (active !== batch) break
        batch.outcomes.set(request.meta.providerId, outcome)
        if (outcome.record.phase !== "cleanup_verified" || outcome.error?.code === "PROBE_CLEANUP_UNVERIFIED") probeIssues.set(request.meta.providerId, failure(new CatalogError("PROBE_CLEANUP_UNVERIFIED")))
        else if (outcome.error === null) probeIssues.delete(request.meta.providerId)
      }
      batch.finished = true
      await queue.run(async () => { try { await finalize(batch) } catch (error) { if (inventoryBlocked) latch(error, true) } })
    })().catch(error => { batch.finished = true; latch(error) })
  }
  async function accept(commandId: string): Promise<RefreshResult> {
    await verify()
    const retained = commands.get(commandId)
    if (retained && retained.handlerGeneration !== generation) throw new CatalogError("COMMAND_CONFLICT")
    if (retained && active?.finished) { await finalize(active); return receipt(commands.get(commandId)!) }
    if (retained && retained.state !== "pending") return receipt(retained)
    if (!canStart()) throw new CatalogError("CATALOG_UNAVAILABLE")
    const observed = await config()
    if (retained) {
      if (!isDeepStrictEqual(retained.fingerprints, observed.fingerprints) || active?.id !== retained.batchId) throw new CatalogError("COMMAND_CONFLICT")
      await persist(retained, retained)
      launch(active)
      return receipt(retained)
    }
    if (commands.size >= 4096) throw new CatalogError("CATALOG_UNAVAILABLE")
    if (active && (!isDeepStrictEqual(active.config.fingerprints, observed.fingerprints) || !isDeepStrictEqual(active.config.profiles, observed.profiles))) throw new CatalogError("INCOMPLETE")
    if (active && active.commands.length >= 32) throw new CatalogError("INCOMPLETE")
    const batch: Batch = active ?? { id: randomUUID(), config: observed, requests: [], commands: [], controller: new AbortController(), operation: null, snapshot: null, finished: false, started: false, outcomes: new Map() }
    if (!active) {
      for (const profile of observed.profiles) {
        const evidence = observed.evidence.get(profile.id)
        if (!evidence) continue
        const attemptId = randomUUID()
        batch.requests.push({ profile, evidence, meta: { version: 2, hostId: paths.hostKey, handlerGeneration: generation, commandId, providerId: profile.id, attemptId, fingerprint: evidence.fingerprint, workPath: join(paths.persistentRoot, "catalog/work", attemptId) } })
      }
      active = batch
    }
    const command: RefreshCommand = { version: 1, commandId, hostId: paths.hostKey, handlerGeneration: generation, batchId: batch.id, fingerprints: observed.fingerprints, attempts: batch.requests.map(r => ({ providerId: r.meta.providerId, attemptId: r.meta.attemptId })), state: "pending", snapshotId: null }
    if (!batch.commands.includes(commandId)) batch.commands.push(commandId)
    try { await persist(command, null) }
    catch (error) {
      if (!commands.has(commandId)) batch.commands = batch.commands.filter(id => id !== commandId)
      if (batch.commands.length === 0 && active === batch) active = null
      throw error
    }
    launch(batch)
    return receipt(command)
  }
  async function automatic(): Promise<void> {
    if (!scheduling || !canStart() || active || clock.now() < nextAutomatic) return
    try {
      await queue.run(async () => {
        if (!scheduling || !canStart() || active || clock.now() < nextAutomatic) return
        const observed = await config()
        const stale = observed.profiles.some(profile => {
          const p = current?.providers.find(p => p.providerId === profile.id)
          return !p || p.error !== null || p.verifiedHandlerGeneration !== generation || !isFresh(p.verifiedAt, clock.now()) || p.fingerprint !== observed.evidence.get(profile.id)?.fingerprint
        })
        if (stale) await accept(randomUUID())
      })
    } catch { nextAutomatic = clock.now() + 60000 }
  }
  async function initialize(): Promise<void> {
    try {
      const inventory = await store.inventory()
      scopeProbeIssues(inventory)
      for (const c of inventory.commands) commands.set(c.commandId, c)
      if (inventory.issues.some(issue => !issue.startsWith("probe-meta/") && !issue.startsWith("probe-launches/")) || inventory.commands.some(c => c.hostId !== paths.hostKey)) throw new CatalogError("CATALOG_UNAVAILABLE")
      current = diskCurrent = await store.readCurrent()
      if (current && current.hostId !== paths.hostKey) throw new CatalogError("CATALOG_UNAVAILABLE")
      try { await probes.recover(); for (const [providerId, issue] of probes.issues?.() ?? []) probeIssues.set(providerId, issue) } catch (error) { latch(error) }
      await queue.run(async () => {
        await verify()
        for (const c of commands.values()) if (c.state === "pending") await persist({ ...c, state: "interrupted" }, c)
      })
    } catch (error) { latch(error, true) }
    initialized = true
  }
  async function list(): Promise<CatalogView> {
    const result = await queue.run(async () => {
      try { await verify() } catch { }
      let observed: Config = { profiles: [], evidence: new Map(), errors: new Map(), fingerprints: [] }
      try { observed = await config() } catch (error) { latch(error) }
      const now = clock.now()
      const providers: ProviderView[] = PROVIDERS.map(providerId => {
        const snapshot = current?.providers.find(p => p.providerId === providerId) ?? empty(providerId), configured = observed.profiles.some(p => p.id === providerId)
        const error = observed.errors.get(providerId) ?? snapshot.error
        const fresh = configured && !error && snapshot.verifiedHandlerGeneration === generation && snapshot.fingerprint === observed.evidence.get(providerId)?.fingerprint && isFresh(snapshot.verifiedAt, now)
        return { ...snapshot, error, state: !configured ? "unconfigured" : error?.code === "PROBE_CLEANUP_UNVERIFIED" ? "blocked" : error || snapshot.verifiedAt === null ? "unavailable" : "ready", freshness: snapshot.verifiedAt === null ? "unverified" : fresh ? "fresh" : "stale", ...(probeIssues.has(providerId) ? { refreshIssue: probeIssues.get(providerId)! } : {}) }
      })
      return { state: "catalog" as const, hostId: paths.hostKey, handlerGeneration: generation, observedAt: now, launchAuthorized: false as const, providers, refresh: latest === null ? null : view(latest), discovery: { state: blocked ? "blocked" as const : active ? "refreshing" as const : "idle" as const, error: blocked } }
    })
    void automatic()
    return result
  }
  return {
    initialize, list,
    launchEvidence(providerId) {
      return queue.run(async () => {
        await verify()
        if (!canStart() || !current) throw new CatalogError("CATALOG_UNAVAILABLE")
        const observed = await config(), profile = observed.profiles.find(p => p.id === providerId), configuration = observed.evidence.get(providerId), provider = current.providers.find(p => p.providerId === providerId)
        if (!profile || !configuration || !provider || observed.errors.has(providerId) || provider.error || provider.verifiedHandlerGeneration !== generation || provider.fingerprint !== configuration.fingerprint || !isFresh(provider.verifiedAt, clock.now())) throw new CatalogError("CATALOG_UNAVAILABLE")
        return structuredClone({ snapshotId: current.snapshotId, provider, profile, configuration })
      })
    },
    startScheduling() { if (scheduling || closed) return; scheduling = true; cancelTimer = clock.every(30000, () => { void automatic() }); void automatic() },
    async refresh(commandId, expectedGeneration) { id(commandId); if (expectedGeneration !== generation) throw new CatalogError("STALE_HANDLER"); return queue.run(() => accept(commandId)) },
    async freezeAndDrain() {
      frozen = true
      const batch = active
      batch?.controller.abort()
      if (batch?.operation) await batch.operation
      if (batch && active === batch) {
        batch.finished = true
        await queue.run(async () => { try { await finalize(batch) } catch (error) { latch(error, true) } })
      }
    },
    resume() { if (closed) return; frozen = false; void automatic() },
    async verifyDischarged() { await verify(); await probes.verifyDischarged(); if (blocked || active || [...commands.values()].some(c => c.state === "pending")) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED") },
    close() { closed = true; frozen = true; scheduling = false; cancelTimer?.(); active?.controller.abort() },
  }
}