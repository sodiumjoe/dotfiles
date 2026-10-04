import assert from "node:assert/strict"
import test from "node:test"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import { syntheticProbeFixture } from "./catalog-support.js"
import { cleanProbeEnvironment } from "../src/catalog/probes.js"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
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
import type { LaunchRecord } from "../src/platform/types.js"

let catalogFixtureFailure: Error | undefined

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
  assert.equal((await readLaunchRecordForReconciliation(f.path)).phase, "quarantined")
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

for (const scenario of ["timeout", "closed", "malformed", "stdout", "stderr", "ipc", "double", "early-exit", "cleanup-failure", "missing-close"]) test(`probe ${scenario} cannot publish a successful candidate`, async t => {
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
  if (["early-exit", "cleanup-failure", "missing-close"].includes(scenario)) await assert.rejects(f.runtime.verifyDischarged())
  else await f.runtime.verifyDischarged()
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

test("changed configuration discards a candidate after independently verified cleanup", async t => {
  const f = await syntheticProbeFixture(t)
  await f.runtime.recover()
  const operation = f.runtime.run(f.request, new AbortController().signal)
  await f.workerObserved.promise
  f.releaseWorkerIdentity()
  await f.nativeRegistered.promise
  await writeFile(f.config, "replaced")
  f.releaseResult()
  const outcome = await operation
  assert.equal(outcome.result, null)
  assert.equal(outcome.error!.code, "CONFIG_CHANGED")
  assert.equal(outcome.record.phase, "cleanup_verified")
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
  await f.runtime.verifyDischarged()
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

for (const ignoreTerm of [false, true]) test(`gated worker owns a real native fixture through independent group cleanup, ignore TERM=${ignoreTerm}`, { timeout: 60000 }, async t => {
  if (catalogFixtureFailure) throw catalogFixtureFailure
  const root = await mkdtemp(join(await realpath("/tmp"), "agy-catalog-")), adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  let pid: number | undefined, operation: Promise<unknown> | undefined
  const attemptId = randomUUID(), generation = randomUUID(), commandId = randomUUID(), hostId = "a".repeat(64)
  const path = join(root, "catalog/probe-launches", attemptId + ".json")
  t.after(async () => {
    try {
    await operation?.catch(() => undefined)
    if (pid !== undefined) {
      const record = await readLaunchRecordForReconciliation(path)
      assert.notEqual(record.provider, null, `retained uncertain fixture root: ${root}`)
      const cleanup = join(root, "cleanup.json")
      await writeLaunchRecord(cleanup, record)
      assert.equal((await reconcileRecord(cleanup, adapter, record)).record.phase, "cleanup_verified")
      for (let observation = 0; observation < 2; observation++) {
        for (const identity of record.provider!.group.observed) assert.equal(await adapter.readProcess(identity.pid), null)
        assert.deepEqual(await adapter.readGroup(pid), [])
      }
    }
    await rm(root, { recursive: true })
    } catch (cause) { catalogFixtureFailure = new Error(`unverified fixture cleanup; retained ${root}`, { cause }); throw catalogFixtureFailure }
  })
  await mkdir(join(root, "home"), { mode: 0o700 })
  const adapterPath = join(root, "adapter.json"), adapterEntry = join(root, "adapter.mjs")
  await writeFile(adapterPath, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.7.0", main: "adapter.mjs" }), { mode: 0o600 })
  await writeFile(adapterEntry, "throw new Error('adapter fixture metadata only')", { mode: 0o600 })
  const profile = { id: "codex-acp" as const, enabled: true, executable: process.execPath, adapterPackageJson: adapterPath, sdkPackageJson: null, configurationFiles: ignoreTerm ? [adapterPath] : [] }
  const evidence = await observeConfig(profile), store = createCatalogStore(root)
  const request: ProbeRequest = { profile, evidence, meta: { version: 2, hostId, handlerGeneration: generation, commandId, providerId: profile.id, attemptId, fingerprint: evidence.fingerprint, workPath: join(root, "catalog/work", attemptId) } }
  await store.writeCommand({ version: 1, commandId, hostId, handlerGeneration: generation, batchId: randomUUID(), fingerprints: [{ providerId: profile.id, fingerprint: evidence.fingerprint }], attempts: [{ providerId: profile.id, attemptId }], state: "pending", snapshotId: null }, null)
  const runtime = createProbeRuntime({ paths: { hostKey: hostId, persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "handler.sock") }, adapter, queue: new MutationQueue(), store, generation, canStart: () => true, workerFile: fileURLToPath(new URL("./fixtures/catalog-worker.js", import.meta.url)), dependencies: { env: { HOME: join(root, "home"), PATH: "/usr/bin:/bin" }, spawn: ((...args: Parameters<typeof spawn>) => { const child = spawn(...args); pid = child.pid; return child }) as typeof spawn } })
  await runtime.recover()
  const run = runtime.run(request, new AbortController().signal)
  operation = run
  const outcome = await run
  assert.equal(outcome.error, null)
  assert.equal(outcome.result!.providerVersion, "fixture-1")
  assert.equal(outcome.record.provider!.group.observed.length, 2)
  assert.equal(outcome.record.phase, "cleanup_verified")
  await runtime.verifyDischarged()
})