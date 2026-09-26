import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { createCatalogService, type CatalogClock } from "../src/catalog/service.js"
import { CatalogError, failure, type ConfigEvidence, type ProviderId, type ProviderProfile } from "../src/catalog/types.js"
import { createCatalogStore } from "../src/catalog/store.js"
import type { ProbeOutcome, ProbeRequest, ProbeResult, ProbeRuntime } from "../src/catalog/probes.js"
import { MutationQueue } from "../src/handler/mutations.js"
import { gate } from "./catalog-support.js"
import { privateRoot, until } from "./control-support.js"

const result = (providerId: ProviderId, modelId = "a"): ProbeResult => ({ models: [{ providerId, modelId, resolvedModelId: null, displayName: "Model", reasoning: { state: "unknown" }, modes: { state: "unknown" }, availability: "advertised" }], providerVersion: null, providerVersionSource: "unknown" })
async function fixture(t: Parameters<typeof privateRoot>[0], retainedRoot?: string) {
  const root = retainedRoot ?? await privateRoot(t)
  let now = 1000000, tick: (() => void) | undefined, blocked = false, ready = true, shutdown = false
  const profiles: ProviderProfile[] = ["claude-agent-acp", "codex-acp"].map(id => ({ id: id as ProviderId, enabled: true, executable: "/fixture/native", adapterPackageJson: "/fixture/package.json", sdkPackageJson: id === "codex-acp" ? null : "/fixture/sdk.json", configurationFiles: [] }))
  const evidence = new Map(profiles.map(p => [p.id, { providerId: p.id, scope: "declared-config-v1" as const, fingerprint: (p.id === "codex-acp" ? "b" : "a").repeat(64), adapterVersion: "1", sdkVersion: p.id === "codex-acp" ? null : "0.3.232" }]))
  const queue = new MutationQueue(), store = createCatalogStore(root), generation = randomUUID(), paths = { hostKey: "c".repeat(64), persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "socket") }
  const started: ProbeRequest[] = [], pending: Array<{ request: ProbeRequest; gate: ReturnType<typeof gate<ProbeOutcome>> }> = []
  const probes: ProbeRuntime = {
    recover: async () => { if (blocked) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED") },
    verifyDischarged: async () => { if (blocked || pending.length) throw new CatalogError("PROBE_CLEANUP_UNVERIFIED") },
    async run(request, signal) {
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
    if (code === "PROBE_CLEANUP_UNVERIFIED") blocked = true
    const m = entry.request.meta
    entry.gate.resolve({ request: entry.request, record: { version: 1, checkoutId: `catalog-v1:${m.providerId}:${m.fingerprint}`, leaseId: m.leaseId, agentId: m.agentId, handlerGeneration: m.handlerGeneration, launchAttemptId: m.attemptId, launchBootId: "fixture", launchAttempted: false, provider: null, phase: blocked ? "quarantined" : "cleanup_verified", reason: blocked ? "fixture" : null }, result: value, error: code ? failure(new CatalogError(code)) : null })
  }
  const clock: CatalogClock = { now: () => now, every: (ms, callback) => { assert.equal(ms, 30000); tick = callback; return () => { tick = undefined } } }
  const options = { paths, generation, queue, store, probes, isReady: () => ready, shutdownPending: () => shutdown, readProfiles: async () => structuredClone(profiles), observeConfig: async (p: ProviderProfile) => structuredClone(evidence.get(p.id)!), clock }
  const service = createCatalogService(options)
  t.after(async () => { await service.freezeAndDrain(); service.close() })
  const waitProbe = async (providerId: ProviderId) => until(async () => pending.find(e => e.request.meta.providerId === providerId))
  const completeProbe = async (providerId: ProviderId, value: ProbeResult | null = result(providerId), code?: "PROBE_FAILED" | "PROBE_CLEANUP_UNVERIFIED") => complete(await waitProbe(providerId), value, code)
  const finish = async (commandId: string) => until(async () => { const response = await service.refresh(commandId, generation); return response.command.state === "pending" ? undefined : response })
  return { root, service, store, generation, profiles, evidence, options, probes, queue, pending, started, completeProbe, waitProbe, finish, advance(ms: number) { now += ms; tick?.() }, setTime(value: number) { now = value }, setReady(value: boolean) { ready = value }, setShutdown(value: boolean) { shutdown = value } }
}

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

test("launch evidence never refreshes and requires fresh accepted configuration provenance", async t => {
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
  await assert.rejects(f.service.launchEvidence("codex-acp"))
  f.setTime(999999)
  await assert.rejects(f.service.launchEvidence("codex-acp"))
  f.setTime(1000000)
  f.evidence.get("codex-acp")!.fingerprint = "e".repeat(64)
  await assert.rejects(f.service.launchEvidence("codex-acp"))
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

test("unverified probe ownership blocks all new probes but retains readable history", async t => {
  const f = await fixture(t), command = randomUUID()
  await f.service.initialize(); await f.service.refresh(command, f.generation)
  await f.completeProbe("claude-agent-acp", null, "PROBE_CLEANUP_UNVERIFIED")
  await f.finish(command)
  assert.equal(f.started.length, 1)
  assert.equal((await f.service.list()).discovery.state, "blocked")
  await assert.rejects(f.service.refresh(randomUUID(), f.generation))
  await assert.rejects(f.service.verifyDischarged())
  await f.service.freezeAndDrain(); f.service.resume()
  assert.equal((await f.service.list()).discovery.state, "blocked")
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

test("pending bindings are bounded and configuration/generation conflicts do not start work", async t => {
  const f = await fixture(t)
  await f.service.initialize()
  const ids = Array.from({ length: 32 }, () => randomUUID())
  await Promise.all(ids.map(id => f.service.refresh(id, f.generation)))
  await assert.rejects(f.service.refresh(randomUUID(), f.generation), { code: "INCOMPLETE" })
  await assert.rejects(f.service.refresh(ids[0]!, randomUUID()), { code: "STALE_HANDLER" })
  f.evidence.get("claude-agent-acp")!.fingerprint = "d".repeat(64)
  await assert.rejects(f.service.refresh(ids[0]!, f.generation), { code: "COMMAND_CONFLICT" })
  assert.equal(f.started.length, 1)
})

test("restart interrupts pending commands without replay and rejects old IDs", async t => {
  const f = await fixture(t), command = randomUUID()
  await f.store.writeCommand({ version: 1, commandId: command, hostId: f.options.paths.hostKey, handlerGeneration: randomUUID(), batchId: randomUUID(), fingerprints: [], attempts: [], state: "pending", snapshotId: null }, null)
  await f.service.initialize()
  assert.equal((await f.store.readCommand(command))!.state, "interrupted")
  assert.equal(f.started.length, 0)
  await assert.rejects(f.service.refresh(command, f.generation), { code: "COMMAND_CONFLICT" })
})

test("changed declared config during a probe cannot become a fresh result", async t => {
  const f = await fixture(t), command = randomUUID()
  await f.service.initialize(); await f.service.refresh(command, f.generation)
  await f.waitProbe("claude-agent-acp")
  f.evidence.get("claude-agent-acp")!.fingerprint = "d".repeat(64)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp")
  await until(async () => (await f.store.readCommand(command))?.state === "completed" ? true : undefined)
  assert.notEqual((await f.service.list()).providers[0]!.freshness, "fresh")
})

test("external command disappearance latches unavailable and does not repair evidence", async t => {
  const f = await fixture(t), command = randomUUID()
  await f.service.initialize(); await f.service.refresh(command, f.generation)
  await f.waitProbe("claude-agent-acp")
  await unlink(join(f.root, "catalog/commands", command + ".json"))
  assert.equal((await f.service.list()).discovery.state, "blocked")
  await assert.rejects(f.service.refresh(randomUUID(), f.generation))
  assert.equal(await f.store.readCommand(command), null)
})

test("automatic refresh starts only after ready, polls configuration and backs off failures", async t => {
  const f = await fixture(t)
  f.setReady(false)
  await f.service.initialize(); f.service.startScheduling(); f.advance(30000)
  assert.equal(f.started.length, 0)
  f.setReady(true); f.advance(30000)
  await f.completeProbe("claude-agent-acp", null, "PROBE_FAILED"); await f.completeProbe("codex-acp", null, "PROBE_FAILED")
  await until(async () => (await f.service.list()).discovery.state === "idle" ? true : undefined)
  f.advance(30000)
  await f.service.list()
  assert.equal(f.started.length, 2)
  f.advance(30000)
  await f.waitProbe("claude-agent-acp")
  assert.equal(f.started.length, 3)
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

test("a configuration change during uncertain publication interrupts without replay", async t => {
  const f = await fixture(t), command = randomUUID(), failed = gate()
  const write = f.store.writeSnapshot
  let fail = true
  f.store.writeSnapshot = async snapshot => { await write(snapshot); if (fail) { failed.resolve(); throw new Error("snapshot sync uncertainty") } }
  await f.service.initialize(); await f.service.refresh(command, f.generation)
  await f.completeProbe("claude-agent-acp"); await f.completeProbe("codex-acp"); await failed.promise
  f.evidence.get("claude-agent-acp")!.fingerprint = "d".repeat(64)
  fail = false
  const response = await f.service.refresh(command, f.generation)
  assert.equal(response.command.state, "interrupted")
  assert.equal(response.snapshot, null)
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
  await f.service.initialize(); f.service.startScheduling()
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

test("an externally added immutable snapshot is not accepted as Handler-owned history", async t => {
  const f = await fixture(t)
  await f.service.initialize()
  await createCatalogStore(f.root).writeSnapshot({ version: 1, hostId: f.options.paths.hostKey, handlerGeneration: f.generation, snapshotId: randomUUID(), createdAt: 1000000, providers: [] })
  assert.equal((await f.service.list()).discovery.state, "blocked")
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