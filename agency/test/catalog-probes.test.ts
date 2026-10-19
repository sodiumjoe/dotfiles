import { fixtureIdentity } from "./fixtures/ownership.js"
import assert from "node:assert/strict"
import test from "node:test"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import { until } from "./control-support.js"
import { createCatalogService } from "../src/catalog/service.js"
import { createAgentStore } from "../src/agent/store.js"
import { createAgentService } from "../src/agent/service.js"
import { createRetentionStore } from "../src/retention/store.js"
import { createRetentionCoordinator } from "../src/retention/coordinator.js"
import { gate, syntheticProbeFixture } from "./catalog-support.js"
import { cleanProbeEnvironment } from "../src/catalog/probes.js"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { mkdtemp, mkdir, readFile, stat, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createProbeRuntime, type ProbeRequest } from "../src/catalog/probes.js"
import { createCatalogStore } from "../src/catalog/store.js"
import { MutationQueue } from "../src/handler/mutations.js"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { observeConfig } from "../src/catalog/config.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import { createProbeTransition } from "../src/catalog/probe-transitions.js"
import type { ManagedLaunchRecord, LaunchRecord } from "../src/platform/types.js"
import { readProbeDiagnostic, retainProbeDiagnostic } from "../src/catalog/diagnostics.js"

let catalogFixtureFailure: Error | undefined

for (const fault of ["directory-sync", "persistent-directory-sync", "stderr-close"] as const) test(`final diagnostic ${fault} failure remains retained after restart`, async t => {
  const f = await syntheticProbeFixture(t)
  await f.runtime.recover()
  const original = fs.open
  let injected = false
  fs.open = (async (...args: Parameters<typeof original>) => {
    const handle = await original(...args), path = String(args[0])
    if (path === f.request.meta.workPath) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        let value
        try { value = JSON.parse(await readFile(join(path, "diagnostic.json"), "utf8")) } catch { }
        if (fault !== "stderr-close" && (!injected || fault === "persistent-directory-sync") && value?.finishedAt != null) {
          injected = true
          throw Object.assign(new Error("fixture final " + fault + " failure"), { code: "EIO" })
        }
        return sync()
      }
    }
    if (fault === "stderr-close" && path === join(f.request.meta.workPath, "worker.stderr")) {
      const close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        injected = true
        throw Object.assign(new Error("fixture stderr-close failure"), { code: "EIO" })
      }
    }
    return handle
  }) as typeof original
  syncBuiltinESMExports()
  let outcome
  try {
    const operation = f.runtime.run(f.request, new AbortController().signal)
    await f.workerObserved.promise; f.releaseWorkerIdentity()
    await f.nativeRegistered.promise; f.releaseResult()
    outcome = await operation
  } finally { fs.open = original; syncBuiltinESMExports() }
  assert.equal(injected, true)
  assert.equal(outcome.error?.code, "PROBE_FAILED")
  assert.equal(outcome.record.phase, "cleanup_verified")
  const diagnostic = (await readProbeDiagnostic(f.request.meta))!
  assert.equal(retainProbeDiagnostic(diagnostic, Date.now()), true)
  assert.equal(diagnostic.stderrComplete, false)
  if (fault === "stderr-close") { assert.equal(diagnostic.firstFailure?.stage, "diagnostic-write"); assert.equal(diagnostic.firstFailure?.code, "EIO") }
  else assert.ok(f.runtime.retentionPins().paths.includes("catalog/work/" + f.request.meta.attemptId))
  const restartedStore = createCatalogStore(f.root)
  const retained = (await restartedStore.inventory()).metadata.find(meta => meta.attemptId === f.request.meta.attemptId)!
  assert.equal(retainProbeDiagnostic((await readProbeDiagnostic(retained))!, Date.now() + 604800001), true)
  assert.deepEqual([...f.processes.values()], [])
})


test("pending capture removal failure conservatively retains a successful probe", async t => {
  const f = await syntheticProbeFixture(t)
  await f.runtime.recover()
  const original = fs.unlink
  let injected = false
  fs.unlink = (async path => {
    if (String(path) === join(f.request.meta.workPath, "capture-pending.json")) { injected = true; throw Object.assign(new Error("fixture pending removal"), { code: "EIO" }) }
    return original(path)
  }) as typeof original
  syncBuiltinESMExports()
  let outcome
  try {
    const operation = f.runtime.run(f.request, new AbortController().signal)
    await f.workerObserved.promise; f.releaseWorkerIdentity()
    await f.nativeRegistered.promise; f.releaseResult()
    outcome = await operation
  } finally { fs.unlink = original; syncBuiltinESMExports() }
  assert.equal(injected, true)
  assert.equal(outcome.error, null)
  assert.equal((await readProbeDiagnostic(f.request.meta))!.stderrComplete, false)
  assert.ok(f.runtime.retentionPins().paths.includes("catalog/work/" + f.request.meta.attemptId))
})


for (const fault of ["directory-sync", "stderr-close"]) test(`automatic ${fault} failure retains its receipt graph after runtime restart`, async t => {
  const f = await syntheticProbeFixture(t, "success", true), original = fs.open
  const paths = { persistentRoot: f.root, runtimeRoot: f.root, handlerSocketPath: join(f.root, "handler.sock"), hostKey: f.request.meta.hostId }
  let injected = false
  fs.open = (async (...args: Parameters<typeof original>) => {
    const handle = await original(...args), path = String(args[0])
    if (fault === "directory-sync" && path === f.request.meta.workPath) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        let value
        try { value = JSON.parse(await readFile(join(path, "diagnostic.json"), "utf8")) } catch { }
        if (!injected && value?.finishedAt != null) { injected = true; throw Object.assign(new Error("fixture final sync"), { code: "EIO" }) }
        return sync()
      }
    }
    if (fault === "stderr-close" && path === join(f.request.meta.workPath, "worker.stderr")) {
      const close = handle.close.bind(handle)
      handle.close = async () => { await close(); injected = true; throw Object.assign(new Error("fixture close"), { code: "EIO" }) }
    }
    return handle
  }) as typeof original
  syncBuiltinESMExports()
  const catalog = createCatalogService({ paths, generation: f.generation, queue: f.queue, store: f.store, isReady: () => true, shutdownPending: () => false, readProfiles: async () => [f.profile], probes: { ...f.runtime, async run(request, signal) { f.bindRequest(request); return f.runtime.run(request, signal) } } })
  try {
    await catalog.initialize()
    await catalog.refresh(randomUUID(), f.generation)
    await f.workerObserved.promise; f.releaseWorkerIdentity()
    await f.nativeRegistered.promise; f.releaseResult()
    await until(async () => (await catalog.list()).discovery.state === "idle" ? true : undefined)
  } finally { catalog.close(); fs.open = original; syncBuiltinESMExports() }
  assert.equal(injected, true)
  const initial = await f.store.inventory()
  assert.equal(initial.commands.length, 1); assert.equal(initial.automatic.length, 0)
  assert.equal(initial.commands[0]!.state, "completed")
  assert.equal(initial.metadata[0]!.version, 3)
  assert.equal(initial.snapshots[0]!.providers.find(p => p.providerId === f.profile.id)!.error?.code, "PROBE_FAILED")
  const generation = randomUUID(), queue = new MutationQueue(), retention = createRetentionStore(f.root, paths.hostKey, generation), store = createCatalogStore(f.root, undefined, retention.view)
  const runtime = createProbeRuntime({ paths, adapter: f.adapter, queue, store, generation, canStart: () => false, retirement: retention.view })
  const restarted = createCatalogService({ paths, generation, queue, store, probes: runtime, retirement: retention.view, isReady: () => true, shutdownPending: () => false, readProfiles: async () => [f.profile] })
  await restarted.initialize()
  assert.deepEqual(runtime.retentionPins().paths, [])
  await mkdir(join(f.root, "launches"), { mode: 0o700 })
  const agentStore = createAgentStore(f.root, undefined, retention.view), mutations = { root: f.root, queue, accepted: [], retirement: retention.view }
  const state = { hostId: paths.hostKey, handlerGeneration: generation, phase: "ready" as const, reconciliation: { classified: 0, total: 0, uncertain: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] as ["status", "doctor", "shutdown"] }
  const agents = createAgentService({ context: { paths, adapter: f.adapter, mutations, state, shutdownPending: () => false }, catalog: restarted, contracts: [], store: agentStore, retirement: retention.view })
  const coordinator = createRetentionCoordinator({ root: f.root, hostId: paths.hostKey, generation, queue, adapter: f.adapter, store: retention, catalogStore: store, agentStore, mutations, catalog: restarted, agents, now: () => Date.now() + 604800001 })
  try {
    await coordinator.initialize()
    assert.deepEqual(coordinator.diagnostics(), [])
    const retained = await store.inventory()
    for (const kind of ["commands", "metadata", "launches", "snapshots"] as const) assert.equal(retained[kind].length, 1)
    assert.equal((await readProbeDiagnostic(retained.metadata[0]!))!.stderrComplete, false)
    assert.deepEqual([...f.processes.values()], [])
  } finally { agents.close(); restarted.close() }
})


test("stderr stream errors preserve the first fault and mark capture incomplete", async t => {
  const f = await syntheticProbeFixture(t)
  await f.runtime.recover()
  const operation = f.runtime.run(f.request, new AbortController().signal)
  await f.workerObserved.promise; f.releaseWorkerIdentity()
  await f.nativeRegistered.promise
  f.child.stderr!.emit("error", Object.assign(new Error("fixture capture failure"), { code: "EIO" }))
  const outcome = await operation, diagnostic = (await readProbeDiagnostic(f.request.meta))!
  assert.notEqual(outcome.error, null)
  assert.equal(diagnostic.firstFailure?.stage, "worker-stream")
  assert.equal(diagnostic.firstFailure?.code, "EIO")
  assert.equal(diagnostic.stderrComplete, false)
  assert.equal(outcome.record.phase, "cleanup_verified")
})

for (const [scenario, stage] of [["spawn-throws", "worker-launch"], ["worker-mismatch", "worker-registration"], ["native-mismatch", "native-registration"], ["closed", "worker-ipc"], ["stderr", null]] as const) test(`private discovery diagnostic retains ${scenario} evidence`, async t => {
  const f = await syntheticProbeFixture(t, scenario)
  await f.runtime.recover()
  f.releaseWorkerIdentity(); f.releaseResult()
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  const diagnostic = await readProbeDiagnostic(f.request.meta)
  assert.ok(diagnostic)
  assert.equal(diagnostic.firstFailure?.stage ?? null, stage)
  assert.equal(diagnostic.commandId, f.request.meta.commandId)
  assert.equal(diagnostic.attemptId, f.request.meta.attemptId)
  assert.equal(diagnostic.handlerGeneration, f.request.meta.handlerGeneration)
  assert.equal(diagnostic.failed, outcome.error !== null)
  assert.ok(diagnostic.finishedAt)
  if (scenario === "stderr") {
    assert.equal(diagnostic.stderrComplete, true)
    assert.equal(diagnostic.workerStderrBytes, 139264)
    assert.equal((await readFile(join(f.request.meta.workPath, "worker.stderr"))).length, 139264)
    assert.equal(diagnostic.workerTerminal?.signal, "SIGTERM")
    assert.equal(diagnostic.workerIdentity?.pid, 10001)
    assert.equal(diagnostic.nativeIdentity?.pid, 10002)
  }
  for (const name of ["diagnostic.json", "worker.stderr", "native.stderr"]) assert.equal((await stat(join(f.request.meta.workPath, name))).mode & 0o777, 0o600)
})

for (const scenario of ["pause-before-attempted", "pause-after-attempted"]) test(`cancellation during ${scenario} discharges a provably unstarted probe`, async t => {
  const f = await syntheticProbeFixture(t, scenario), controller = new AbortController()
  await f.runtime.recover()
  f.releaseWorkerIdentity(); f.releaseResult()
  const operation = f.runtime.run(f.request, controller.signal)
  await f.attemptedPublication.promise
  controller.abort(); f.releaseAttempted()
  const outcome = await operation
  assert.equal(f.spawnInvoked(), false)
  assert.equal(outcome.record.launchAttempted, false)
  assert.equal(outcome.record.phase, "cleanup_verified")
  assert.equal(outcome.error!.code, "INCOMPLETE")
  assert.deepEqual(f.signals, [])
  await f.runtime.verifyDischarged()
})

test("uncertain pre-spawn restoration never authorizes a successful discharge", async t => {
  const f = await syntheticProbeFixture(t, "restore-failure"), controller = new AbortController()
  await f.runtime.recover()
  const operation = f.runtime.run(f.request, controller.signal)
  await f.attemptedPublication.promise
  controller.abort(); f.releaseAttempted()
  const outcome = await operation
  assert.equal(f.spawnInvoked(), false)
  assert.equal(outcome.error!.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.equal((await readLaunchRecordForReconciliation(f.path)).launchAttempted, true)
  await assert.rejects(f.runtime.verifyDischarged())
})

test("entering spawn preserves attempted uncertainty even when invocation throws", async t => {
  const f = await syntheticProbeFixture(t, "spawn-throws")
  await f.runtime.recover()
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  assert.equal(f.spawnInvoked(), true)
  assert.equal(outcome.record.launchAttempted, true)
  assert.equal((await readLaunchRecordForReconciliation(f.path)).phase, "launch_pending")
  await assert.rejects(f.runtime.verifyDischarged())
})

test("probe worker and native gates follow durable independent identity registration", async t => {
  const f = await syntheticProbeFixture(t)
  await f.runtime.recover()
  const operation = f.runtime.run(f.request, new AbortController().signal)
  await f.spawnObserved.promise
  await f.workerObserved.promise
  assert.equal(f.durableAtSpawn(), true)
  assert.equal((await readLaunchRecordForReconciliation(f.path)).launchAttempted, true)
  assert.equal(f.nativeSpawned(), false)
  f.releaseWorkerIdentity()
  await f.nativeRegistered.promise
  assert.equal((await readLaunchRecordForReconciliation(f.path)).provider!.group.observed.length, 2)
  f.releaseResult()
  const outcome = await operation
  assert.equal(outcome.record.phase, "cleanup_verified")
  assert.deepEqual(outcome.result, { models: [], providerVersion: null, providerVersionSource: "unknown" })
  assert.equal(outcome.error, null)
  assert.deepEqual(f.signals, ["SIGTERM"])
  await f.runtime.verifyDischarged()
})

for (const scenario of ["timeout", "closed", "malformed", "stdout", "ipc", "double", "early-exit", "cleanup-failure", "missing-close"]) test(`probe ${scenario} cannot publish a successful candidate`, async t => {
  const f = await syntheticProbeFixture(t, scenario)
  await f.runtime.recover()
  const operation = f.runtime.run(f.request, new AbortController().signal)
  if (scenario !== "timeout") await f.workerObserved.promise
  f.releaseWorkerIdentity()
  if (scenario !== "timeout") await f.nativeRegistered.promise
  f.releaseResult()
  const outcome = await operation
  assert.equal(outcome.result, null)
  assert.notEqual(outcome.error, null)
  if (["early-exit", "cleanup-failure", "missing-close", "ipc", "closed"].includes(scenario)) await assert.rejects(f.runtime.verifyDischarged())
  else await f.runtime.verifyDischarged()
})

test("probe stderr output beyond the former threshold preserves a successful candidate", async t => {
  const f = await syntheticProbeFixture(t, "stderr")
  await f.runtime.recover()
  const operation = f.runtime.run(f.request, new AbortController().signal)
  await f.workerObserved.promise
  f.releaseWorkerIdentity()
  await f.nativeRegistered.promise
  f.releaseResult()
  const outcome = await operation
  assert.equal(outcome.error, null)
  assert.deepEqual(outcome.result, { models: [], providerVersion: null, providerVersionSource: "unknown" })
  assert.equal(outcome.record.phase, "cleanup_verified")
  await f.runtime.verifyDischarged()
})

test("cancellation discards output after verified cleanup", async t => {
  const f = await syntheticProbeFixture(t), controller = new AbortController()
  await f.runtime.recover()
  const operation = f.runtime.run(f.request, controller.signal)
  await f.workerObserved.promise
  f.releaseWorkerIdentity()
  await f.nativeRegistered.promise
  controller.abort()
  const outcome = await operation
  assert.equal(outcome.result, null)
  assert.equal(outcome.record.phase, "cleanup_verified")
})

test("changed configuration preserves captured evidence and independently verified cleanup", async t => {
  const f = await syntheticProbeFixture(t)
  await f.runtime.recover()
  const operation = f.runtime.run(f.request, new AbortController().signal)
  await f.workerObserved.promise
  f.releaseWorkerIdentity()
  await f.nativeRegistered.promise
  await writeFile(f.config, "replaced")
  f.releaseResult()
  const outcome = await operation
  assert.notEqual(outcome.result, null)
  assert.equal(outcome.error, null)
  assert.equal(outcome.record.phase, "cleanup_verified")
  await f.runtime.verifyDischarged()
})

for (const existing of [false, true]) for (const failure of ["configuration", "metadata"] as const) test(`preflight ${failure} failure leaves no launch with ${existing ? "existing" : "fresh"} launch directory`, async t => {
  const f = await syntheticProbeFixture(t)
  if (existing) await mkdir(join(f.root, "catalog/probe-launches"), { mode: 0o700 })
  await f.runtime.recover()
  const writeMeta = f.store.writeProbeMeta
  if (failure === "configuration") f.request.meta.fingerprint = "f".repeat(64)
  else f.store.writeProbeMeta = async () => { throw new Error("metadata unavailable") }
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  assert.equal(outcome.error?.code, failure === "configuration" ? "CONFIG_CHANGED" : "PROBE_FAILED")
  assert.equal(f.spawnInvoked(), false)
  assert.deepEqual(f.signals, [])
  const inventory = await f.store.inventory()
  assert.deepEqual(inventory.launches, [])
  assert.deepEqual(inventory.metadata, [])
  assert.deepEqual(inventory.issues, [])
  await f.runtime.verifyDischarged()
  assert.deepEqual([...f.runtime.issues!()], [])
  f.store.writeProbeMeta = writeMeta
  const evidence = await observeConfig(f.profile), commandId = randomUUID(), attemptId = randomUUID()
  const next = { ...f.request, evidence, meta: { ...f.request.meta, commandId, attemptId, fingerprint: evidence.fingerprint, workPath: join(f.root, "catalog/work", attemptId) } }
  await f.store.writeCommand({ version: 1, commandId, hostId: next.meta.hostId, handlerGeneration: f.generation, batchId: randomUUID(), fingerprints: [{ providerId: f.profile.id, fingerprint: evidence.fingerprint }], attempts: [{ providerId: f.profile.id, attemptId }], state: "pending", snapshotId: null }, null)
  f.bindRequest(next); f.releaseWorkerIdentity(); f.releaseResult()
  const later = await f.runtime.run(next, new AbortController().signal)
  assert.equal(later.error, null)
  assert.equal(later.record.phase, "cleanup_verified")
  await f.runtime.verifyDischarged()
})

test("a pre-existing scratch checkout cannot become discovery cwd", async t => {
  const f = await syntheticProbeFixture(t)
  await mkdir(join(f.root, "catalog/work"), { mode: 0o700 })
  await mkdir(f.request.meta.workPath, { mode: 0o700 })
  await mkdir(join(f.request.meta.workPath, ".git"), { mode: 0o700 })
  await f.runtime.recover()
  f.releaseWorkerIdentity(); f.releaseResult()
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  assert.equal(outcome.result, null)
  assert.equal(f.nativeSpawned(), false)
})

test("attempted provider-null recovery quarantines only catalog ownership", async t => {
  const f = await syntheticProbeFixture(t)
  await f.store.writeProbeMeta(f.request.meta)
  const { mkdir } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  await mkdir(dirname(f.path), { mode: 0o700 })
  const m = f.request.meta
  await writeLaunchRecord(f.path, { version: 2, owner: { kind: "catalog-probe", providerId: m.providerId, commandId: m.commandId }, handlerGeneration: m.handlerGeneration, launchAttemptId: m.attemptId, launchBootId: "boot", launchAttempted: true, phase: "launch_pending", provider: null, reason: null })
  await f.runtime.recover()
  assert.equal(f.runtime.issues?.().get(m.providerId)?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.equal((await readLaunchRecordForReconciliation(f.path)).phase, "quarantined")
  assert.deepEqual(f.signals, [])
  await assert.rejects(f.runtime.verifyDischarged())
  await assert.rejects(f.runtime.run(f.request, new AbortController().signal))
})

test("historical version-one probe records are reconciled during recovery", async t => {
  const f = await syntheticProbeFixture(t), m = f.request.meta, agentId = randomUUID(), leaseId = randomUUID()
  await mkdir(join(f.root, "catalog/probe-meta"), { mode: 0o700 })
  await writeFile(join(f.root, "catalog/probe-meta", m.attemptId + ".json"), JSON.stringify({ ...m, version: 1, agentId, leaseId }), { mode: 0o600 })
  await mkdir(join(f.root, "catalog/probe-launches"), { mode: 0o700 })
  const leader = { bootId: "boot", pid: 10001, birth: `100:agy-provider:${m.attemptId}`, parentPid: process.pid, processGroupId: 10001, sessionId: 10001, uid: process.getuid!(), gid: process.getgid!() }
  f.processes.set(leader.pid, leader)
  await writeLaunchRecord(f.path, { version: 1, checkoutId: `catalog-v1:${m.providerId}:${m.fingerprint}`, agentId, leaseId, handlerGeneration: m.handlerGeneration, launchAttemptId: m.attemptId, launchBootId: "boot", launchAttempted: true, phase: "active", provider: { kind: "process-group", group: { leader, observed: [leader] } }, reason: null })
  assert.deepEqual((await f.store.inventory()).issues, [])
  await f.runtime.recover()
  assert.deepEqual(f.signals, ["SIGTERM"])
  const recovered = await readLaunchRecordForReconciliation(f.path)
  assert.equal(recovered.version, 1)
  assert.equal(recovered.phase, "cleanup_verified")
  assert.equal(f.recoverCalls(), 1)
  await f.runtime.verifyDischarged()
  assert.equal(f.recoverCalls(), 2)
})

test("orphan malformed probe evidence remains diagnostic without stopping new probes", async t => {
  const f = await syntheticProbeFixture(t), orphan = randomUUID()
  await mkdir(join(f.root, "catalog/probe-meta"), { mode: 0o700 })
  await writeFile(join(f.root, "catalog/probe-meta", orphan + ".json"), "{", { mode: 0o600 })
  await writeFile(join(f.root, "catalog/probe-meta/unknown.json"), "{", { mode: 0o600 })
  assert.deepEqual((await f.store.inventory()).issues, [`probe-meta/${orphan}.json`, "probe-meta/unknown.json"])
  await f.runtime.recover()
  f.releaseWorkerIdentity(); f.releaseResult()
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  assert.equal(outcome.error, null)
  await assert.rejects(f.runtime.verifyDischarged())
})

test("a replaced accepted probe launch is attributed to its original provider", async t => {
  const f = await syntheticProbeFixture(t), m = f.request.meta
  await f.store.writeProbeMeta(m)
  await mkdir(join(f.root, "catalog/probe-launches"), { mode: 0o700 })
  await writeLaunchRecord(f.path, { version: 2, owner: { kind: "catalog-probe", providerId: m.providerId, commandId: m.commandId }, handlerGeneration: m.handlerGeneration, launchAttemptId: m.attemptId, launchBootId: "boot", launchAttempted: false, phase: "launch_pending", provider: null, reason: null })
  await f.runtime.recover()
  const original = await readLaunchRecordForReconciliation(f.path)
  if (original.version !== 2 || original.owner.kind !== "catalog-probe") throw new Error("expected catalog probe launch")
  await writeLaunchRecord(f.path, { ...original, owner: { ...original.owner, providerId: "codex-acp" } })
  await assert.rejects(f.runtime.verifyDischarged())
  assert.equal(f.runtime.issues?.().get(m.providerId)?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.equal(f.runtime.issues?.().has("codex-acp"), false)
})

test("worker environment removes preload and inherited launcher authority", () => {
  assert.deepEqual(cleanProbeEnvironment({ NODE_OPTIONS: "--require secret", NODE_PATH: "/secret", AGENCY_SOCKET: "secret", GIT_DIR: "secret", HOME: "/fixture", PATH: "/bin" }), { HOME: "/fixture", PATH: "/bin" })
})

for (const scenario of ["worker-error", "worker-mismatch", "native-death", "native-mismatch", "before-unattempted", "after-unattempted", "before-attempted", "after-attempted", "before-worker", "after-worker", "before-native", "after-native"]) test(`probe ${scenario} refuses successful publication`, async t => {
  const f = await syntheticProbeFixture(t, scenario)
  await f.runtime.recover()
  f.releaseWorkerIdentity()
  f.releaseResult()
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  assert.equal(outcome.result, null)
  assert.notEqual(outcome.error, null)
})

for (const scenario of ["normal", "ignore-term", "verbose-stderr", "rpc-rejection", "native-early-exit", "native-launch-failure", "graceful-native-exit"]) test(`gated worker owns a real native fixture through independent group cleanup, ${scenario}`, { timeout: 60000 }, async t => {
  const ignoreTerm = scenario === "ignore-term"
  if (catalogFixtureFailure) throw catalogFixtureFailure
  const root = await mkdtemp(join(await realpath(process.env.AGENCY_TEST_FIXTURE_ROOT ?? "/tmp"), "agy-catalog-")), adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  let pid: number | undefined, operation: Promise<unknown> | undefined, workerClosed: Promise<void> | undefined
  const attemptId = randomUUID(), generation = randomUUID(), commandId = randomUUID(), hostId = "a".repeat(64)
  const path = join(root, "catalog/probe-launches", attemptId + ".json")
  t.after(async () => {
    try {
    await operation?.catch(() => undefined)
    await workerClosed
    if (pid !== undefined) {
      const record = await readLaunchRecordForReconciliation(path)
      assert.notEqual(record.provider, null, `retained uncertain fixture root: ${root}`)
      for (const identity of record.provider!.group.observed) fixtureIdentity("catalog-probe/" + scenario, identity)
      const cleanup = join(root, "cleanup.json")
      await writeLaunchRecord(cleanup, record)
      assert.equal((await reconcileRecord(cleanup, adapter, record)).record.phase, "cleanup_verified")
      for (let observation = 0; observation < 2; observation++) {
        for (const identity of record.provider!.group.observed) assert.equal(await adapter.readProcess(identity.pid), null)
        assert.deepEqual(await adapter.readGroup(pid), [])
      }
    }
    t.diagnostic("retained fixture root: " + root)
    } catch (cause) { catalogFixtureFailure = new Error(`unverified fixture cleanup; retained ${root}`, { cause }); throw catalogFixtureFailure }
  })
  await mkdir(join(root, "home"), { mode: 0o700 })
  const adapterPath = join(root, "adapter.json"), adapterEntry = join(root, "adapter.mjs")
  await writeFile(adapterPath, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.7.0", main: "adapter.mjs" }), { mode: 0o600 })
  await writeFile(adapterEntry, "throw new Error('adapter fixture metadata only')", { mode: 0o600 })
  const count = ignoreTerm ? 1 : scenario === "verbose-stderr" ? 2 : scenario === "rpc-rejection" ? 3 : scenario === "native-early-exit" ? 4 : scenario === "graceful-native-exit" ? 5 : 0
  const profile = { id: "codex-acp" as const, enabled: true, executable: scenario === "native-launch-failure" ? adapterEntry : process.execPath, adapterPackageJson: adapterPath, sdkPackageJson: null, configurationFiles: Array.from({ length: count }, (_, i) => join(root, "declared-" + i)) }
  const evidence = await observeConfig(profile), store = createCatalogStore(root)
  const request: ProbeRequest = { profile, evidence, meta: { version: 2, hostId, handlerGeneration: generation, commandId, providerId: profile.id, attemptId, fingerprint: evidence.fingerprint, workPath: join(root, "catalog/work", attemptId) } }
  await store.writeCommand({ version: 1, commandId, hostId, handlerGeneration: generation, batchId: randomUUID(), fingerprints: [{ providerId: profile.id, fingerprint: evidence.fingerprint }], attempts: [{ providerId: profile.id, attemptId }], state: "pending", snapshotId: null }, null)
  const runtime = createProbeRuntime({ paths: { hostKey: hostId, persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "handler.sock") }, adapter, queue: new MutationQueue(), store, generation, canStart: () => true, workerFile: fileURLToPath(new URL("./fixtures/catalog-worker.js", import.meta.url)), dependencies: { env: { HOME: join(root, "home"), PATH: "/usr/bin:/bin" }, spawn: ((...args: Parameters<typeof spawn>) => { const child = spawn(...args); pid = child.pid; workerClosed = new Promise(resolve => child.once("close", () => resolve())); return child }) as typeof spawn } })
  await runtime.recover()
  const run = runtime.run(request, new AbortController().signal)
  operation = run
  const outcome = await run
  const diagnostic = await readProbeDiagnostic(request.meta)
  assert.ok(diagnostic)
  assert.equal(diagnostic.stderrComplete, !ignoreTerm)
  if (scenario === "rpc-rejection") {
    assert.equal(outcome.result, null)
    assert.equal(diagnostic.firstFailure?.stage, "rpc-rejection")
    assert.equal(diagnostic.firstFailure?.method, "model/list")
    assert.equal(diagnostic.firstFailure?.message, "fixture rejection")
    assert.equal(await readFile(join(request.meta.workPath, "native.stderr"), "utf8"), "native fixture rejected RPC\n")
  } else if (scenario === "native-early-exit") {
    assert.equal(outcome.result, null)
    assert.equal(diagnostic.nativeTerminal?.code, 23)
    assert.ok(diagnostic.nativeIdentity)
    assert.equal(outcome.record.provider!.group.observed.length, 2)
    assert.equal(diagnostic.firstFailure?.stage, "native-exit")
    assert.equal(await readFile(join(request.meta.workPath, "native.stderr"), "utf8"), "native fixture exited\n")
  } else if (scenario === "native-launch-failure") {
    assert.equal(outcome.result, null)
    assert.equal(diagnostic.firstFailure?.stage, "native-launch")
    assert.equal(diagnostic.firstFailure?.code, "EACCES")
  } else if (ignoreTerm) {
    assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
    assert.equal(outcome.result, null)
    assert.equal(diagnostic.workerTerminal?.signal, "SIGKILL")
  } else {
    assert.equal(outcome.error, null)
    assert.equal(outcome.result!.providerVersion, "fixture-1")
    assert.equal(outcome.record.provider!.group.observed.length, 2)
    assert.equal(diagnostic.firstFailure, null)
    if (scenario === "graceful-native-exit") assert.equal(diagnostic.nativeTerminal?.code, 0)
    if (scenario === "verbose-stderr") {
      const stderr = await readFile(join(request.meta.workPath, "native.stderr"))
      assert.equal(stderr.length, 2097152)
      assert.ok(stderr.every(byte => byte === 255))
    }
  }
  if (ignoreTerm) await assert.rejects(runtime.verifyDischarged(), { code: "PROBE_CLEANUP_UNVERIFIED" })
  else { assert.equal(outcome.record.phase, "cleanup_verified"); await runtime.verifyDischarged() }
})

test("current discovery never invokes historical reconciliation or reinitializes its owners", async t => {
  const f = await syntheticProbeFixture(t); await f.runtime.recover()
  f.releaseWorkerIdentity(); f.releaseResult()
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  assert.equal(outcome.error, null)
  await f.runtime.verifyDischarged()
  assert.equal(f.recoverCalls(), 0)
  await assert.rejects(f.runtime.recover())
  assert.equal(f.recoverCalls(), 0)
})

test("worker loss after start without native notification remains unknown with an empty group", async t => {
  const f = await syntheticProbeFixture(t, "worker-loss-before-native"); await f.runtime.recover(); f.releaseWorkerIdentity()
  const operation = f.runtime.run(f.request, new AbortController().signal)
  await f.startObserved.promise
  f.processes.clear(); f.exitWorker(); f.closeWorker()
  const outcome = await operation
  assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.equal(outcome.result, null)
  assert.deepEqual(f.signals, [])
  await assert.rejects(f.runtime.verifyDischarged())
})

for (const scenario of ["native-missing-close", "native-missing-report", "native-wrong-report", "native-double-report"]) test("current cleanup rejects " + scenario, async t => {
  const f = await syntheticProbeFixture(t, scenario); await f.runtime.recover(); f.releaseWorkerIdentity(); f.releaseResult()
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.equal(outcome.result, null)
  await assert.rejects(f.runtime.verifyDischarged())
})

for (const scenario of ["terminal-fsync-failure", "cleanup-pending-failure"]) test("exact durable retry repairs only publication after " + scenario, async t => {
  const f = await syntheticProbeFixture(t, scenario); await f.runtime.recover(); f.releaseWorkerIdentity(); f.releaseResult()
  const outcome = await f.runtime.run(f.request, new AbortController().signal), signals = [...f.signals]
  assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.equal(outcome.result, null)
  assert.deepEqual([...f.processes.values()], [])
  await assert.rejects(f.runtime.verifyDischarged())
  f.repairPublication()
  await f.runtime.verifyDischarged()
  assert.deepEqual(f.signals, signals)
  assert.equal(f.runtime.issues?.().has(f.profile.id), false)
  assert.equal(f.recoverCalls(), 0)
  assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.equal(outcome.result, null)
})

test("physical cleanup precedes held native publication and late publication cannot acknowledge", { timeout: 15000 }, async t => {
  const f = await syntheticProbeFixture(t, "held-native-publication"), controller = new AbortController()
  await f.runtime.recover(); f.releaseWorkerIdentity()
  let settled = false
  const operation = f.runtime.run(f.request, controller.signal).then(value => { settled = true; return value })
  await f.nativePublication.promise
  controller.abort()
  await f.physicalCleanup.promise
  assert.deepEqual([...f.processes.values()], [])
  assert.equal(settled, false)
  assert.deepEqual(f.acknowledgements, [])
  f.advanceClock(10000); f.releaseNativePublication()
  const outcome = await operation
  assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.deepEqual(f.acknowledgements, [])
  await f.runtime.verifyDischarged()
  assert.equal(outcome.result, null)
})

test("held terminal publication retains run and explicit discharge until its mutation settles", { timeout: 15000 }, async t => {
  const f = await syntheticProbeFixture(t, "held-cleanup-publication"); await f.runtime.recover(); f.releaseWorkerIdentity(); f.releaseResult()
  let settled = false
  const operation = f.runtime.run(f.request, new AbortController().signal).then(value => { settled = true; return value })
  await f.cleanupPublication.promise
  const inspected = gate(), verified = f.runtime.verifyDischarged().finally(() => inspected.resolve())
  let discharged = false; void inspected.promise.then(() => { discharged = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(settled, false); assert.equal(discharged, false)
  f.advanceClock(10000); f.releaseCleanupPublication()
  const outcome = await operation
  await verified
  assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.equal(outcome.result, null)
})

test("observed native escape after leader loss prevents current cleanup without stale signals", async t => {
  const f = await syntheticProbeFixture(t); await f.runtime.recover(); f.releaseWorkerIdentity()
  const operation = f.runtime.run(f.request, new AbortController().signal)
  await f.nativeRegistered.promise
  const native = f.processes.get(10002)!
  f.processes.set(10002, { ...native, processGroupId: 10002, sessionId: 10002 })
  f.adapter.readGroup = async () => []
  f.emitNativeTerminal(); f.emitNativeClosed(); f.emitNativeSettled({ kind: "exit", pid: 10002, code: 0, signal: null })
  f.exitWorker(); f.closeWorker()
  const outcome = await operation
  assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.deepEqual(f.signals, [])
})

test("native exit before attribution cannot be repaired by an empty group", async t => {
  const f = await syntheticProbeFixture(t, "native-death"); await f.runtime.recover(); f.releaseWorkerIdentity(); f.releaseResult()
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  await assert.rejects(f.runtime.verifyDischarged())
})

for (const field of ["owner", "handlerGeneration", "launchAttemptId", "launchBootId", "missing", "malformed"] as const) test("probe publisher refuses changed exact " + field, async () => {
  const initial: ManagedLaunchRecord = { version: 2, owner: { kind: "catalog-probe", providerId: "codex-acp", commandId: randomUUID() }, handlerGeneration: randomUUID(), launchAttemptId: randomUUID(), launchBootId: "boot", launchAttempted: false, phase: "launch_pending", provider: null, reason: null }
  let visible: LaunchRecord | null = null, calls = 0, malformed = false
  const transition = createProbeTransition({ path: "/fixture", initial, accept() {}, io: {
    read: async () => { if (malformed) throw new Error("malformed record"); if (!visible) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return structuredClone(visible) },
    publish: async (_path, record) => { calls++; visible = structuredClone(record) },
  } })
  await transition.publish(initial)
  if (field === "missing") visible = null
  else if (field === "malformed") malformed = true
  else visible = { ...initial, [field]: field === "owner" ? { kind: "catalog-probe", providerId: "claude-agent-acp", commandId: randomUUID() } : "foreign" } as ManagedLaunchRecord
  await assert.rejects(transition.publish({ ...initial, phase: "cleanup_verified" }))
  assert.equal(calls, 1)
})

test("probe publisher tracks visible terminal bytes separately from directory durability", async () => {
  const initial: ManagedLaunchRecord = { version: 2, owner: { kind: "catalog-probe", providerId: "codex-acp", commandId: randomUUID() }, handlerGeneration: randomUUID(), launchAttemptId: randomUUID(), launchBootId: "boot", launchAttempted: false, phase: "launch_pending", provider: null, reason: null }
  let visible: LaunchRecord | null = null, fault = false, calls = 0
  const transition = createProbeTransition({ path: "/fixture", initial, accept() {}, io: {
    read: async () => { if (!visible) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return structuredClone(visible) },
    publish: async (_path, record) => { calls++; visible = structuredClone(record); if (fault) throw new Error("fsync") },
  } })
  await transition.publish(initial); fault = true
  await assert.rejects(transition.publish({ ...initial, phase: "cleanup_verified" }))
  assert.equal(transition.current().phase, "cleanup_verified"); assert.equal(transition.durable(), false)
  fault = false; await transition.publish(transition.current())
  assert.equal(transition.durable(), true); assert.equal(calls, 3)
  await assert.rejects(createProbeTransition({ path: "/fixture", initial, accept() {}, io: { read: async () => visible!, publish: async () => { calls++ } } }).publish(initial))
  assert.equal(calls, 3)
})

test("publication repair does not audit unrelated metadata edits", async t => {
  const f = await syntheticProbeFixture(t, "terminal-fsync-failure"); await f.runtime.recover(); f.releaseWorkerIdentity(); f.releaseResult()
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  const path = join(f.root, "catalog/probe-meta", f.request.meta.attemptId + ".json"), original = JSON.parse(await readFile(path, "utf8"))
  await writeFile(path, JSON.stringify({ ...original, fingerprint: "b".repeat(64) }), { mode: 0o600 })
  f.repairPublication()
  await f.runtime.verifyDischarged()
  assert.equal((await readLaunchRecordForReconciliation(f.path)).phase, "cleanup_verified")
  assert.equal(f.runtime.issues?.().get(f.profile.id), undefined)
  assert.equal(outcome.result, null)
})

test("matching not-spawned settlement permits cleanup after cancellation before native invocation", async t => {
  const f = await syntheticProbeFixture(t, "no-native"), controller = new AbortController()
  await f.runtime.recover(); f.releaseWorkerIdentity()
  const operation = f.runtime.run(f.request, controller.signal)
  await f.startObserved.promise; controller.abort()
  const outcome = await operation
  assert.equal(outcome.record.phase, "cleanup_verified")
  assert.equal(outcome.error?.code, "INCOMPLETE")
  await f.runtime.verifyDischarged()
})

test("leader exit during current authorization refuses every stale group signal", async t => {
  const f = await syntheticProbeFixture(t); await f.runtime.recover(); f.releaseWorkerIdentity()
  const operation = f.runtime.run(f.request, new AbortController().signal)
  await f.nativeRegistered.promise
  f.adapter.readGroup = async () => {
    f.adapter.readGroup = async () => []
    f.processes.clear(); f.emitNativeTerminal(); f.emitNativeClosed(); f.emitNativeSettled({ kind: "exit", pid: 10002, code: 0, signal: null }); f.exitWorker(); f.closeWorker(); return []
  }
  f.releaseResult()
  const outcome = await operation
  assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.deepEqual(f.signals, [])
})

test("failed boot observation releases run admission without manufacturing a worker", async t => {
  const f = await syntheticProbeFixture(t); await f.runtime.recover()
  const boot = f.adapter.bootId; f.adapter.bootId = async () => { throw new Error("boot unavailable") }
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  assert.equal(f.spawnInvoked(), false); assert.equal(outcome.error?.code, "PROBE_FAILED")
  f.adapter.bootId = boot
  await f.runtime.verifyDischarged()
})

test("native observation must match the notified PID before acknowledgement", async t => {
  const f = await syntheticProbeFixture(t); await f.runtime.recover()
  const read = f.adapter.readProcess
  f.adapter.readProcess = async pid => { const member = await read(pid); return pid === 10002 && member ? { ...member, pid: 10003 } : member }
  f.releaseWorkerIdentity(); f.releaseResult()
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.deepEqual(f.acknowledgements, [])
})

test("failed historical recovery never adopts an unrelated replacement", async t => {
  const f = await syntheticProbeFixture(t), m = f.request.meta
  await f.store.writeProbeMeta(m)
  await mkdir(join(f.root, "catalog/probe-launches"), { mode: 0o700 })
  const original: ManagedLaunchRecord = { version: 2, owner: { kind: "catalog-probe", providerId: m.providerId, commandId: m.commandId }, handlerGeneration: m.handlerGeneration, launchAttemptId: m.attemptId, launchBootId: "boot", launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null }
  await writeLaunchRecord(f.path, original)
  const runtime = createProbeRuntime({ paths: { persistentRoot: f.root, runtimeRoot: f.root, handlerSocketPath: join(f.root, "handler.sock"), hostKey: m.hostId }, adapter: f.adapter, queue: f.queue, store: f.store, generation: f.generation, canStart: () => true, dependencies: { recoverEntry: async () => {
    await writeLaunchRecord(f.path, { ...original, owner: { kind: "catalog-probe", commandId: m.commandId, providerId: "codex-acp" } })
    throw new Error("recovery failed after replacement")
  } } })
  await runtime.recover()
  await writeLaunchRecord(f.path, original)
  await runtime.recover()
  assert.equal(runtime.issues?.().has("codex-acp"), false)
  assert.equal(runtime.issues?.().get(m.providerId)?.code, "PROBE_CLEANUP_UNVERIFIED")
})