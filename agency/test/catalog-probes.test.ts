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
  await writeLaunchRecord(f.path, { version: 1, checkoutId: `catalog-v1:${m.providerId}:${m.fingerprint}`, leaseId: m.leaseId, agentId: m.agentId, handlerGeneration: m.handlerGeneration, launchAttemptId: m.attemptId, launchBootId: "boot", launchAttempted: true, phase: "launch_pending", provider: null, reason: null })
  await assert.rejects(f.runtime.recover())
  assert.equal((await readLaunchRecordForReconciliation(f.path)).phase, "quarantined")
  assert.deepEqual(f.signals, [])
  await assert.rejects(f.runtime.run(f.request, new AbortController().signal))
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
  const adapterPath = join(root, "adapter.json")
  await writeFile(adapterPath, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.7.0" }), { mode: 0o600 })
  const profile = { id: "codex-acp" as const, enabled: true, executable: process.execPath, adapterPackageJson: adapterPath, sdkPackageJson: null, configurationFiles: ignoreTerm ? [adapterPath] : [] }
  const evidence = await observeConfig(profile), store = createCatalogStore(root)
  const request: ProbeRequest = { profile, evidence, meta: { version: 1, hostId, handlerGeneration: generation, commandId, providerId: profile.id, attemptId, agentId: randomUUID(), leaseId: randomUUID(), fingerprint: evidence.fingerprint, workPath: join(root, "catalog/work", attemptId) } }
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