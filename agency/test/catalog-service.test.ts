import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { createCatalogService, type CatalogClock } from "../src/catalog/service.js"
import { CatalogError, failure, type ConfigEvidence, type ProviderId, type ProviderProfile } from "../src/catalog/types.js"
import { createCatalogStore } from "../src/catalog/store.js"
import type { ProbeOutcome, ProbeRequest, ProbeResult, ProbeRuntime } from "../src/catalog/probes.js"
import { MutationQueue } from "../src/handler/mutations.js"
import { gate, syntheticProbeFixture } from "./catalog-support.js"
import { privateRoot, until } from "./control-support.js"

const result = (providerId: ProviderId, modelId = "a"): ProbeResult => ({ models: [{ providerId, modelId, resolvedModelId: null, displayName: "Model", reasoning: { state: "unknown" }, modes: { state: "unknown" }, availability: "advertised" }], providerVersion: null, providerVersionSource: "unknown" })
async function fixture(t: Parameters<typeof privateRoot>[0], retainedRoot?: string) {
  const root = retainedRoot ?? await privateRoot(t, { retainRoot: true })
  let now = 1000000, ready = true, shutdown = false
  const blocked = new Set<ProviderId>()
  const profiles: ProviderProfile[] = ["claude-agent-acp", "codex-acp"].map(id => ({ id: id as ProviderId, enabled: true, executable: "/fixture/native", adapterPackageJson: "/fixture/package.json", sdkPackageJson: id === "codex-acp" ? null : "/fixture/sdk.json", configurationFiles: [] }))
  const evidence = new Map(profiles.map(p => [p.id, { providerId: p.id, scope: "declared-config-v1" as const, fingerprint: (p.id === "codex-acp" ? "b" : "a").repeat(64), adapterVersion: "1", sdkVersion: p.id === "codex-acp" ? null : "0.3.232" }]))
  const queue = new MutationQueue(), store = createCatalogStore(root), generation = randomUUID(), paths = { hostKey: "c".repeat(64), persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "socket") }
  const started: ProbeRequest[] = [], pending: Array<{ request: ProbeRequest; gate: ReturnType<typeof gate<ProbeOutcome>> }> = []
  const probes: ProbeRuntime = {
    verifyDischarged: async () => { if (blocked.size || pending.length) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED") },
    async run(request, signal) {
      if (blocked.has(request.meta.providerId)) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED")
      started.push(request)
      const done = gate<ProbeOutcome>(), entry = { request, gate: done }
      pending.push(entry)
      const abort = () => complete(entry, null, "INCOMPLETE")
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      try { return await done.promise } finally { signal.removeEventListener("abort", abort) }
    },
  }
  function complete(entry: typeof pending[number], value: ProbeResult | null, code?: "PROBE_FAILED" | "PROBE_CLEANUP_UNVERIFIED" | "INCOMPLETE") {
    const index = pending.indexOf(entry)
    if (index < 0) return
    pending.splice(index, 1)
    if (code === "PROBE_CLEANUP_UNVERIFIED") blocked.add(entry.request.meta.providerId)
    const m = entry.request.meta
    entry.gate.resolve({ request: entry.request, record: { version: 2, owner: { kind: "catalog-probe", providerId: m.providerId, commandId: m.commandId }, handlerGeneration: m.handlerGeneration, launchAttemptId: m.attemptId, launchBootId: "fixture", launchAttempted: false, provider: null, phase: blocked.has(m.providerId) ? "quarantined" : "cleanup_verified", reason: blocked.has(m.providerId) ? "fixture" : null }, result: value, error: code ? failure(new CatalogError(code)) : null })
  }
  const clock: CatalogClock = { now: () => now }
  const options = { paths, generation, queue, store, probes, isReady: () => ready, shutdownPending: () => shutdown, readProfiles: async () => structuredClone(profiles), observeConfig: async (p: ProviderProfile) => structuredClone(evidence.get(p.id)!), clock }
  const service = createCatalogService(options)
  t.after(async () => { await service.freezeAndDrain(); service.close() })
  const waitProbe = async (providerId: ProviderId) => until(async () => pending.find(e => e.request.meta.providerId === providerId))
  const completeProbe = async (providerId: ProviderId, value: ProbeResult | null = result(providerId), code?: "PROBE_FAILED" | "PROBE_CLEANUP_UNVERIFIED") => complete(await waitProbe(providerId), value, code)
  const finish = async (commandId: string) => until(async () => { const response = await service.refresh(commandId, generation); return response.command.state === "pending" ? undefined : response })
  return { root, service, store, generation, profiles, evidence, options, probes, queue, pending, started, completeProbe, waitProbe, finish, advance(ms: number) { now += ms }, setTime(value: number) { now = value }, setReady(value: boolean) { ready = value }, setShutdown(value: boolean) { shutdown = value } }
}

test("explicit refresh remains available above 4096 retained receipts", async t => {
  const f = await fixture(t)
  const snapshot = { version: 1 as const, hostId: f.options.paths.hostKey, handlerGeneration: f.generation, snapshotId: randomUUID(), createdAt: 1000000, providers: [] }
  await f.store.writeSnapshot(snapshot)
  const directory = join(f.root, "catalog", "commands")
  await mkdir(directory, { mode: 0o700 })
  for (let index = 0; index < 4097; index++) {
    const command = { version: 1, commandId: randomUUID(), hostId: snapshot.hostId, handlerGeneration: f.generation, batchId: randomUUID(), fingerprints: [], attempts: [], state: "completed", snapshotId: snapshot.snapshotId }
    await writeFile(join(directory, command.commandId + ".json"), JSON.stringify(command), { mode: 0o600 })
  }
  await f.service.initialize()
  const commandId = randomUUID()
  assert.equal((await f.service.refresh(commandId, f.generation)).command.state, "pending")
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp")
  assert.equal((await f.finish(commandId)).command.state, "completed")
})

test("malformed unrelated history does not block fresh catalog refresh", async t => {
  const f = await fixture(t), directory = join(f.root, "catalog", "commands")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (let index = 0; index < 4097; index++) {
    const command = { version: 1, commandId: randomUUID(), hostId: f.options.paths.hostKey, handlerGeneration: f.generation, batchId: randomUUID(), fingerprints: [], attempts: [], state: "interrupted", snapshotId: null }
    await writeFile(join(directory, command.commandId + ".json"), JSON.stringify(command), { mode: 0o600 })
  }
  await writeFile(join(directory, "ffffffff-ffff-ffff-ffff-ffffffffffff.json"), "{", { mode: 0o600 })
  await f.service.initialize()
  const commandId = randomUUID()
  await f.service.refresh(commandId, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp")
  assert.equal((await f.finish(commandId)).command.state, "completed")
})

test("32 callers coalesce durable identity and preserve immutable command snapshots", async t => {
  const f = await fixture(t), command = randomUUID()
  await f.service.initialize()
  await Promise.all(Array.from({ length: 32 }, () => f.service.refresh(command, f.generation)))
  await f.waitProbe("claude-agent-acp")
  assert.equal(f.started.length, 1)
  assert.equal((await f.store.readCommand(command))!.state, "pending")
  await f.completeProbe("claude-agent-acp")
  await f.completeProbe("codex-acp")
  const first = await f.finish(command)
  assert.equal(f.started.length, 2)
  const second = randomUUID()
  await f.service.refresh(second, f.generation)
  await f.completeProbe("claude-agent-acp", result("claude-agent-acp", "replacement"))
  await f.completeProbe("codex-acp")
  const newer = await f.finish(second)
  assert.notEqual(newer.snapshot!.snapshotId, first.snapshot!.snapshotId)
  assert.deepEqual((await f.service.refresh(command, f.generation)).snapshot, first.snapshot)
  assert.deepEqual((await f.service.list()).providers[0]!.models.map(m => m.modelId), ["replacement"])
})

test("freshness respects expiry, backwards time, and generation provenance", async t => {
  const f = await fixture(t), command = randomUUID()
  await f.service.initialize()
  await f.service.refresh(command, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await f.finish(command)
  assert.deepEqual((await f.service.list()).providers.map(p => p.freshness), ["fresh", "fresh"])
  f.advance(599999)
  assert.equal((await f.service.list()).providers[0]!.freshness, "fresh")
  f.advance(1)
  assert.equal((await f.service.list()).providers[0]!.freshness, "stale")
  f.setTime(999999)
  assert.equal((await f.service.list()).providers[0]!.freshness, "stale")
  const next = createCatalogService({ ...f.options, generation: randomUUID() })
  t.after(() => next.close())
  await f.service.freezeAndDrain(); f.service.close()
  await next.initialize()
  assert.equal((await next.list()).providers[0]!.freshness, "stale")
})

test("cached launch evidence remains advisory across expiry, configuration edits and generations", async t => {
  const f = await fixture(t), command = randomUUID()
  await f.service.initialize()
  await assert.rejects(f.service.launchEvidence("codex-acp"))
  assert.equal(f.started.length, 0)
  await f.service.refresh(command, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp")
  const completed = await f.finish(command)
  const evidence = await f.service.launchEvidence("codex-acp")
  assert.equal(evidence.snapshotId, completed.snapshot!.snapshotId)
  assert.equal(evidence.provider.verifiedHandlerGeneration, f.generation)
  evidence.provider.models.length = 0
  assert.equal((await f.service.launchEvidence("codex-acp")).provider.models.length, 1)
  f.advance(600000)
  assert.equal((await f.service.launchEvidence("codex-acp")).snapshotId, completed.snapshot!.snapshotId)
  f.setTime(999999)
  assert.equal((await f.service.launchEvidence("codex-acp")).snapshotId, completed.snapshot!.snapshotId)
  f.setTime(1000000)
  f.evidence.get("codex-acp")!.fingerprint = "e".repeat(64)
  assert.equal((await f.service.launchEvidence("codex-acp")).configuration.fingerprint, "b".repeat(64))
  await f.service.freezeAndDrain(); f.service.close()
  const next = createCatalogService({ ...f.options, generation: randomUUID() })
  t.after(() => next.close())
  await next.initialize()
  assert.equal((await next.launchEvidence("codex-acp")).provider.verifiedHandlerGeneration, f.generation)
  assert.equal(f.started.length, 2)
})

test("partial refresh across clock rollback completes without rewriting historical verification time", async t => {
  const f = await fixture(t), first = randomUUID(), second = randomUUID()
  await f.service.initialize(); await f.service.refresh(first, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await f.finish(first)
  f.setTime(999999)
  await f.service.refresh(second, f.generation)
  await f.completeProbe("claude-agent-acp", null, "PROBE_FAILED"); await f.completeProbe("codex-acp")
  const complete = await f.finish(second)
  assert.equal(complete.command.state, "completed")
  assert.equal(complete.snapshot!.createdAt, 999999)
  assert.equal(complete.snapshot!.providers[0]!.verifiedAt, 1000000)
  assert.deepEqual((await f.service.list()).providers.map(p => p.freshness), ["stale", "fresh"])
  assert.deepEqual(await f.service.refresh(second, f.generation), complete)
  await f.service.freezeAndDrain(); await f.service.verifyDischarged(); f.service.resume()
  const third = randomUUID()
  await f.service.refresh(third, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp")
  assert.equal((await f.finish(third)).command.state, "completed")
})

test("verified query failure retains stale data while the other provider succeeds", async t => {
  const f = await fixture(t), first = randomUUID()
  await f.service.initialize(); await f.service.refresh(first, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await f.finish(first)
  const old = (await f.service.list()).providers[0]!, second = randomUUID()
  f.advance(10)
  await f.service.refresh(second, f.generation)
  await f.completeProbe("claude-agent-acp", null, "PROBE_FAILED")
  await f.completeProbe("codex-acp", result("codex-acp", "new")); await f.finish(second)
  const view = await f.service.list()
  assert.equal(view.providers[0]!.verifiedAt, old.verifiedAt)
  assert.equal(view.providers[0]!.freshness, "stale")
  assert.equal(view.providers[1]!.freshness, "fresh")
})

test("uncertain probe cleanup leaves verified evidence and unrelated provider launches usable", async t => {
  const f = await fixture(t), first = randomUUID(), second = randomUUID()
  await f.service.initialize(); await f.service.refresh(first, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await f.finish(first)
  const prior = await f.service.launchEvidence("claude-agent-acp")
  await f.service.refresh(second, f.generation)
  await f.completeProbe("claude-agent-acp", null, "PROBE_CLEANUP_UNVERIFIED")
  await f.completeProbe("codex-acp", result("codex-acp", "new"))
  await f.finish(second)
  const status = await f.service.list()
  assert.equal(status.discovery.state, "idle")
  assert.equal(status.providers[0]!.refreshIssue?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.deepEqual((await f.service.launchEvidence("claude-agent-acp")).provider, prior.provider)
  assert.deepEqual((await f.service.launchEvidence("codex-acp")).provider.models.map(model => model.modelId), ["new"])
  await assert.rejects(f.service.verifyDischarged())
})

test("external probe history edits are not audited during ordinary operations", async t => {
  const f = await fixture(t), first = randomUUID(), orphan = randomUUID()
  await f.service.initialize(); await f.service.refresh(first, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await f.finish(first)
  const prior = await f.service.launchEvidence("claude-agent-acp")
  await mkdir(join(f.root, "catalog/probe-meta"), { mode: 0o700 })
  await writeFile(join(f.root, "catalog/probe-meta", orphan + ".json"), "{", { mode: 0o600 })
  await writeFile(join(f.root, "catalog/probe-meta/unknown.json"), "{", { mode: 0o600 })
  await writeFile(join(f.root, "catalog/probe-meta/line\nbreak.json"), "{", { mode: 0o600 })
  const status = await f.service.list()
  assert.equal(status.discovery.state, "idle")
  assert.equal(status.discovery.issues, undefined)
  assert.deepEqual(await f.service.launchEvidence("claude-agent-acp"), prior)
  const second = randomUUID()
  await f.service.refresh(second, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await f.finish(second)
})

test("freeze permits queued terminal writes and interrupts accepted commands", async t => {
  const f = await fixture(t), command = randomUUID()
  await f.service.initialize(); await f.service.refresh(command, f.generation); await f.waitProbe("claude-agent-acp")
  const frozen = f.service.freezeAndDrain()
  await f.queue.run(async () => undefined)
  await frozen
  assert.equal((await f.service.refresh(command, f.generation)).command.state, "interrupted")
  assert.equal((await f.service.list()).providers[0]!.verifiedAt, null)
  f.service.resume()
  await f.service.refresh(randomUUID(), f.generation)
  await f.waitProbe("claude-agent-acp")
  assert.equal(f.started.length, 2)
})

test("pending bindings are bounded and retries retain captured configuration", async t => {
  const f = await fixture(t)
  await f.service.initialize()
  const ids = Array.from({ length: 32 }, () => randomUUID())
  await Promise.all(ids.map(id => f.service.refresh(id, f.generation)))
  await assert.rejects(f.service.refresh(randomUUID(), f.generation), { code: "INCOMPLETE" })
  await assert.rejects(f.service.refresh(ids[0]!, randomUUID()), { code: "STALE_HANDLER" })
  f.evidence.get("claude-agent-acp")!.fingerprint = "d".repeat(64)
  assert.equal((await f.service.refresh(ids[0]!, f.generation)).command.state, "pending")
  assert.equal(f.started.length, 1)
})

test("restart interrupts pending commands without replay and rejects old IDs", async t => {
  const f = await fixture(t), command = randomUUID()
  await f.store.writeCommand({ version: 1, commandId: command, hostId: f.options.paths.hostKey, handlerGeneration: randomUUID(), batchId: randomUUID(), fingerprints: [], attempts: [], state: "pending", snapshotId: null }, null)
  await f.service.initialize()
  assert.equal((await f.store.readCommand(command))!.state, "pending")
  assert.equal(f.started.length, 0)
  await assert.rejects(f.service.refresh(command, f.generation), { code: "COMMAND_CONFLICT" })
})

test("a batch retains its captured configuration when declared config changes", async t => {
  const f = await fixture(t), command = randomUUID()
  await f.service.initialize(); await f.service.refresh(command, f.generation)
  await f.waitProbe("claude-agent-acp")
  f.evidence.get("claude-agent-acp")!.fingerprint = "d".repeat(64)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp")
  await until(async () => (await f.service.list()).refresh?.state === "completed" ? true : undefined)
  assert.equal((await f.store.readCommand(command))!.state, "completed")
  assert.equal((await f.service.list()).providers[0]!.fingerprint, "a".repeat(64))
  assert.equal((await f.service.list()).providers[0]!.freshness, "fresh")
})

test("catalog display and explicit refresh use initialized inventory", async t => {
  const f = await fixture(t)
  await f.service.initialize()
  f.store.inventory = async () => { throw new Error("unexpected inventory") }
  assert.equal((await f.service.list()).discovery.state, "idle")
  const commandId = randomUUID()
  await f.service.refresh(commandId, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp")
  assert.equal((await f.finish(commandId)).command.state, "completed")
})

test("historical private identities conflict and pending restart does not replay", async t => {
  const f = await fixture(t), privateId = randomUUID()
  await f.store.writeAutomatic({ version: 1, commandId: privateId, hostId: f.options.paths.hostKey, handlerGeneration: f.generation, batchId: randomUUID(), fingerprints: [], attempts: [], state: "pending", snapshotId: null }, null)
  await f.service.initialize()
  await assert.rejects(f.service.refresh(privateId, f.generation), { code: "COMMAND_CONFLICT" })
  assert.equal(f.started.length, 0)
  assert.equal((await f.store.readAutomatic(privateId))!.state, "pending")
  assert.equal((await f.service.list()).refresh, null)
})

test("publication retries finish durability without repeating provider work", async t => {
  const f = await fixture(t), command = randomUUID(), failed = gate()
  const write = f.store.publishCurrent
  let fail = true
  f.store.publishCurrent = async snapshot => { await write(snapshot); if (fail) { failed.resolve(); throw new Error("directory sync uncertainty") } }
  await f.service.initialize(); await f.service.refresh(command, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await failed.promise
  assert.equal((await f.store.readCommand(command))!.state, "pending")
  assert.equal((await f.service.list()).providers[0]!.verifiedAt, null)
  fail = false
  const response = await f.service.refresh(command, f.generation)
  assert.equal(response.command.state, "completed")
  assert.equal(f.started.length, 2)
})

test("uncertain publication retains captured configuration without replay", async t => {
  const f = await fixture(t), command = randomUUID(), failed = gate()
  const write = f.store.writeSnapshot
  let fail = true
  f.store.writeSnapshot = async snapshot => { await write(snapshot); if (fail) { failed.resolve(); throw new Error("snapshot sync uncertainty") } }
  await f.service.initialize(); await f.service.refresh(command, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await failed.promise
  f.evidence.get("claude-agent-acp")!.fingerprint = "d".repeat(64)
  fail = false
  const response = await f.service.refresh(command, f.generation)
  assert.equal(response.command.state, "completed")
  assert.equal(response.snapshot!.providers[0]!.fingerprint, "a".repeat(64))
  assert.equal(f.started.length, 2)
})

test("freeze during queued snapshot publication prevents a fresh cache publication", async t => {
  const f = await fixture(t), command = randomUUID(), writing = gate(), release = gate()
  const write = f.store.writeSnapshot
  f.store.writeSnapshot = async snapshot => { writing.resolve(); await release.promise; await write(snapshot) }
  await f.service.initialize(); await f.service.refresh(command, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await writing.promise
  const frozen = f.service.freezeAndDrain()
  release.resolve()
  await frozen
  assert.equal((await f.store.readCommand(command))!.state, "interrupted")
  assert.equal(await f.store.readCurrent(), null)
  assert.equal((await f.service.list()).providers[0]!.verifiedAt, null)
})

test("restart within TTL preserves the old verifying generation of a failed provider", async t => {
  const f = await fixture(t), first = randomUUID()
  await f.service.initialize(); await f.service.refresh(first, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await f.finish(first)
  f.service.close()
  const next = await fixture(t, f.root), second = randomUUID()
  await next.service.initialize(); await next.service.refresh(second, next.generation)
  await next.completeProbe("claude-agent-acp", null, "PROBE_FAILED"); await next.completeProbe("codex-acp"); await next.finish(second)
  const view = await next.service.list()
  assert.equal(view.providers[0]!.verifiedHandlerGeneration, f.generation)
  assert.equal(view.providers[0]!.freshness, "stale")
  assert.equal(view.providers[1]!.verifiedHandlerGeneration, next.generation)
  assert.equal(view.providers[1]!.freshness, "fresh")
  assert.equal(view.launchAuthorized, false)
})

test("removed and disabled profiles remain unconfigured without new probe work", async t => {
  const f = await fixture(t)
  f.profiles[0]!.enabled = false
  f.profiles.splice(1)
  await f.service.initialize()
  assert.deepEqual((await f.service.list()).providers.map(p => p.state), ["unconfigured", "unconfigured"])
  assert.equal(f.started.length, 0)
})

test("uncertain command acceptance retries durable binding before first spawn", async t => {
  const f = await fixture(t), command = randomUUID(), write = f.store.writeCommand
  let fail = true
  f.store.writeCommand = async (record, expected) => { await write(record, expected); if (fail) throw new Error("command fsync") }
  await f.service.initialize()
  await assert.rejects(f.service.refresh(command, f.generation))
  assert.equal(f.started.length, 0)
  fail = false
  await f.service.refresh(command, f.generation)
  await f.waitProbe("claude-agent-acp")
  assert.equal(f.started.length, 1)
})

test("an externally added snapshot does not invalidate initialized catalog state", async t => {
  const f = await fixture(t)
  await f.service.initialize()
  await createCatalogStore(f.root).writeSnapshot({ version: 1, hostId: f.options.paths.hostKey, handlerGeneration: f.generation, snapshotId: randomUUID(), createdAt: 1000000, providers: [] })
  assert.equal((await f.service.list()).discovery.state, "idle")
})

test("visible completed commands repeat failed durability before reporting completion", async t => {
  const f = await fixture(t), command = randomUUID(), failed = gate(), write = f.store.writeCommand
  let fail = true, completionWrites = 0
  f.store.writeCommand = async (record, expected) => {
    await write(record, expected)
    if (record.state === "completed") { completionWrites++; if (fail) { failed.resolve(); throw new Error("completion fsync") } }
  }
  await f.service.initialize(); await f.service.refresh(command, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await failed.promise
  fail = false
  assert.equal((await f.service.refresh(command, f.generation)).command.state, "completed")
  assert.equal(completionWrites, 2)
  assert.equal(f.started.length, 2)
})

for (const scenario of ["held-native-publication", "held-cleanup-publication"]) test("catalog drain waits for admitted " + scenario, { timeout: 15000 }, async t => {
  const f = await syntheticProbeFixture(t, scenario, true), outcomes: ProbeOutcome[] = []
  const service = createCatalogService({ paths: { persistentRoot: f.root, runtimeRoot: f.root, handlerSocketPath: join(f.root, "socket"), hostKey: f.request.meta.hostId }, generation: f.generation, queue: f.queue, store: f.store, isReady: () => true, shutdownPending: () => false, readProfiles: async () => [f.profile], probes: { ...f.runtime, async run(request, signal) { f.bindRequest(request); const outcome = await f.runtime.run(request, signal); outcomes.push(outcome); return outcome } } })
  t.after(() => service.close())
  await service.initialize(); await service.refresh(randomUUID(), f.generation)
  await f.workerObserved.promise; f.releaseWorkerIdentity()
  if (scenario === "held-native-publication") await f.nativePublication.promise
  else {
    await f.nativeRegistered.promise
    f.child.emit("message", { type: "failure", attemptId: f.request.meta.attemptId, generation: f.generation })
    await f.cleanupPublication.promise
  }
  const drainStarted = gate(), drained = gate()
  let finished = false
  const operation = (async () => { drainStarted.resolve(); await service.freezeAndDrain(); finished = true; drained.resolve() })()
  await drainStarted.promise; await f.physicalCleanup.promise
  assert.equal(finished, false)
  assert.equal(outcomes.length, 0)
  f.advanceClock(10000)
  if (scenario === "held-native-publication") f.releaseNativePublication()
  else f.releaseCleanupPublication()
  await drained.promise; await operation
  assert.equal(outcomes[0]!.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.equal(outcomes[0]!.result, null)
  assert.equal(await f.store.readCurrent(), null)
  assert.equal((await service.list()).providers.find(p => p.providerId === f.profile.id)!.verifiedAt, null)
})

test("visible terminal cleanup with failed durability cannot publish fresh catalog evidence", { timeout: 15000 }, async t => {
  const f = await syntheticProbeFixture(t, "terminal-fsync-failure", true), terminal = gate()
  const service = createCatalogService({ paths: { persistentRoot: f.root, runtimeRoot: f.root, handlerSocketPath: join(f.root, "socket"), hostKey: f.request.meta.hostId }, generation: f.generation, queue: f.queue, store: f.store, isReady: () => true, shutdownPending: () => false, readProfiles: async () => [f.profile], probes: { ...f.runtime, async run(request, signal) { f.bindRequest(request); return f.runtime.run(request, signal) } } })
  t.after(() => service.close())
  await service.initialize(); await service.refresh(randomUUID(), f.generation)
  await f.workerObserved.promise; f.releaseWorkerIdentity()
  await f.nativeRegistered.promise; f.releaseResult(); await until(async () => (await service.list()).discovery.state === "idle" ? true : undefined)
  const inventory = await f.store.inventory()
  assert.equal(inventory.launches[0]!.record.phase, "cleanup_verified")
  const view = await service.list(), provider = view.providers.find(p => p.providerId === f.profile.id)!
  assert.equal(provider.verifiedAt, null)
  assert.equal(provider.state, "blocked")
  await service.freezeAndDrain()
  await assert.rejects(service.verifyDischarged(), { code: "PROBE_CLEANUP_UNVERIFIED" })
})

test("discovery is explicit and display does not observe configuration", async t => {
  const f = await fixture(t)
  let observations = 0
  const observe = f.options.observeConfig
  f.options.observeConfig = async profile => { observations++; return observe(profile) }
  await f.service.initialize()
  await f.service.list(); f.service.resume(); f.advance(3600000); await f.service.list()
  assert.equal(observations, 0)
  assert.equal(f.started.length, 0)
  assert.equal("startScheduling" in f.service, false)
  const commandId = randomUUID()
  await f.service.refresh(commandId, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp")
  assert.equal((await f.finish(commandId)).command.state, "completed")
  assert.equal(observations, 2)
  await f.service.list()
  assert.equal(observations, 2)
})

for (const kind of ["commands", "automatic"]) test(`a missing ${kind} receipt named by pending retirement cannot be reused`, async t => {
  const f = await fixture(t), commandId = randomUUID(), marker = join(f.root, "retention/pending.json")
  await mkdir(join(f.root, "retention"), { mode: 0o700 })
  const bytes = JSON.stringify({ version: 1, entries: [{ path: "catalog/" + kind + "/" + commandId + ".json" }] })
  await writeFile(marker, bytes, { mode: 0o600 })
  await f.service.initialize()
  await assert.rejects(f.service.refresh(commandId, f.generation), { code: "INCOMPLETE" })
  assert.equal(f.started.length, 0)
  assert.equal(await f.store.readCommand(commandId), null)
  await f.service.freezeAndDrain(); await f.service.verifyDischarged()
  assert.equal(await readFile(marker, "utf8"), bytes)
})

test("fresh catalog receipts and current retries ignore a malformed historical retirement marker", async t => {
  const f = await fixture(t), commandId = randomUUID(), marker = join(f.root, "retention/pending.json")
  await mkdir(join(f.root, "retention"), { mode: 0o700 })
  await writeFile(marker, "{", { mode: 0o600 })
  await f.service.initialize()
  assert.equal((await f.service.refresh(commandId, f.generation)).command.state, "pending")
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp")
  assert.equal((await f.finish(commandId)).command.state, "completed")
  await f.service.freezeAndDrain(); await f.service.verifyDischarged()
  assert.equal(await readFile(marker, "utf8"), "{")
})

function deadlineClock(t: test.TestContext): void {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 })
  t.mock.method(performance, "now", () => Date.now())
}
function tracked<T>(operation: Promise<T>) {
  let result: PromiseSettledResult<T> | undefined
  const done = operation.then(value => { result = { status: "fulfilled", value } }, reason => { result = { status: "rejected", reason } })
  return { done, result: () => result }
}
async function deadlineFixture(t: test.TestContext) {
  const f = await fixture(t)
  deadlineClock(t)
  const entries = new Map(f.profiles.map(profile => [profile.id, gate()]))
  const run = f.probes.run
  f.probes.run = (request, signal) => { const operation = run(request, signal); entries.get(request.meta.providerId)!.resolve(); return operation }
  await f.service.initialize()
  return { ...f, entries, async completeAll() { for (const profile of f.profiles) { await entries.get(profile.id)!.promise; await f.completeProbe(profile.id) } } }
}

for (const stage of ["snapshot", "current", "current-read", "command", "command-read"] as const) test(`catalog deadline bounds held ${stage} and permits explicit repair without replay`, async t => {
  const f = await deadlineFixture(t), command = randomUUID(), entered = gate(), release = gate()
  await f.service.refresh(command, f.generation)
  const writeSnapshot = f.store.writeSnapshot, publishCurrent = f.store.publishCurrent, writeCommand = f.store.writeCommand, readCommand = f.store.readCommand, readCurrent = f.store.readCurrent
  const hold = async () => { entered.resolve(); await release.promise }
  f.store.writeSnapshot = async value => { if (stage === "snapshot") await hold(); await writeSnapshot(value) }
  f.store.publishCurrent = async value => { if (stage === "current") await hold(); await publishCurrent(value) }
  f.store.readCurrent = async () => { const value = await readCurrent(); if (stage === "current-read") await hold(); return value }
  f.store.writeCommand = async (value, expected) => { if (stage === "command" && value.state === "completed") await hold(); await writeCommand(value, expected) }
  f.store.readCommand = async id => { const value = await readCommand(id); if (stage === "command-read" && value?.state === "completed") await hold(); return value }
  await f.completeAll(); await entered.promise
  let queueReleased = false
  const queued = f.queue.run(async () => { queueReleased = true })
  const drain = tracked(f.service.freezeAndDrain())
  try {
    t.mock.timers.tick(15000)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(drain.result()?.status, "rejected")
    assert.equal((drain.result() as PromiseRejectedResult).reason.code, "PROBE_CLEANUP_UNVERIFIED")
    assert.equal(queueReleased, false)
  } finally { release.resolve(); await queued; await drain.done; await f.queue.run(async () => undefined) }
  if (stage === "snapshot" || stage === "current" || stage === "current-read") assert.equal((await f.service.list()).providers[0]!.verifiedAt, null)
  await assert.rejects(f.service.verifyDischarged(), { code: "PROBE_CLEANUP_UNVERIFIED" })
  f.service.resume()
  await assert.rejects(f.service.refresh(randomUUID(), f.generation), { code: "CATALOG_UNAVAILABLE" })
  assert.equal((await f.service.refresh(command, f.generation)).command.state, "completed")
  assert.equal(f.started.length, 2)
  await f.service.freezeAndDrain(); await f.service.verifyDischarged()
})

for (const stage of ["queue", "configuration", "command"] as const) test(`catalog deadline prevents late ${stage} admission`, async t => {
  const f = await deadlineFixture(t), command = randomUUID(), entered = gate(), release = gate()
  let queueOperation: Promise<void> | undefined
  if (stage === "queue") queueOperation = f.queue.run(async () => { entered.resolve(); await release.promise })
  if (stage === "configuration") {
    const read = f.options.readProfiles
    f.options.readProfiles = async () => { entered.resolve(); await release.promise; return read() }
  }
  if (stage === "command") {
    const write = f.store.writeCommand
    f.store.writeCommand = async (value, expected) => { entered.resolve(); await release.promise; await write(value, expected) }
  }
  const refresh = tracked(f.service.refresh(command, f.generation))
  await entered.promise
  try {
    t.mock.timers.tick(15000)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(refresh.result()?.status, "rejected")
    assert.equal((refresh.result() as PromiseRejectedResult).reason.code, "INCOMPLETE")
  } finally { release.resolve(); await queueOperation; await refresh.done; await f.queue.run(async () => undefined) }
  assert.equal(f.started.length, 0)
  assert.equal((await f.service.refresh(command, f.generation)).command.state, "pending")
  await f.entries.get("claude-agent-acp")!.promise
  assert.equal(f.started.length, 1)
  await f.service.freezeAndDrain(); await f.service.verifyDischarged()
})

test("catalog deadline bounds a queued drain while abort starts immediately", async t => {
  const f = await deadlineFixture(t), command = randomUUID(), entered = gate(), release = gate()
  await f.service.refresh(command, f.generation); await f.entries.get("claude-agent-acp")!.promise
  const queueOperation = f.queue.run(async () => { entered.resolve(); await release.promise })
  await entered.promise
  const drain = tracked(f.service.freezeAndDrain())
  assert.equal(f.pending.length, 0)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    t.mock.timers.tick(15000)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(drain.result()?.status, "rejected")
  } finally { release.resolve(); await queueOperation; await drain.done; await f.queue.run(async () => undefined) }
  assert.equal((await f.store.readCommand(command))!.state, "pending")
  await f.service.freezeAndDrain(); await f.service.verifyDischarged()
  assert.equal((await f.store.readCommand(command))!.state, "interrupted")
  assert.equal(f.started.length, 1)
})

test("catalog interrupted discovery survives drain deadline and resume without publishing partial results", async t => {
  const f = await deadlineFixture(t), command = randomUUID(), entered = gate(), release = gate()
  await f.service.refresh(command, f.generation)
  await f.entries.get("claude-agent-acp")!.promise
  await f.completeProbe("claude-agent-acp")
  await f.entries.get("codex-acp")!.promise
  const queued = f.queue.run(async () => { entered.resolve(); await release.promise })
  await entered.promise
  const drain = tracked(f.service.freezeAndDrain())
  assert.equal(f.pending.length, 0)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    t.mock.timers.tick(15000)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(drain.result()?.status, "rejected")
  } finally { release.resolve(); await queued; await drain.done; await f.queue.run(async () => undefined) }
  f.service.resume()
  const retry = await f.service.refresh(command, f.generation)
  assert.equal(retry.command.state, "interrupted")
  assert.equal(retry.snapshot, null)
  assert.equal(await f.store.readCurrent(), null)
  assert.deepEqual((await f.service.list()).providers.map(provider => provider.verifiedAt), [null, null])
  assert.equal(f.started.length, 2)
  await f.service.verifyDischarged()
  assert.equal((await f.service.refresh(randomUUID(), f.generation)).command.state, "pending")
  assert.equal(f.started.length, 3)
  await f.service.freezeAndDrain(); await f.service.verifyDischarged()
})