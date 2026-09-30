import assert from "node:assert/strict"
import test from "node:test"
import { syntheticAgentProcess, sampleSpec, sampleContract } from "./agent-support.js"
import { spawn, type ChildProcess } from "node:child_process"
import { lstat, mkdtemp, mkdir, realpath, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createAgentProcess } from "../src/agent/process.js"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { sameProcess, type LaunchRecord } from "../src/platform/types.js"
import { writeLaunchRecord } from "../src/platform/private-state.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import { checkoutIdFor } from "../src/checkout/identity.js"
import { MutationQueue } from "../src/handler/mutations.js"
import { assertFixtureBatchHealthy, failFixtureBatch, until } from "./control-support.js"
import { providerStatePath } from "../src/agent/state.js"

test("spawn identity observation has a bounded phase and cannot publish a late identity", async t => {
  const f = await syntheticAgentProcess(t, "identity-hang")
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  let settled = false
  const pending = f.owner.initialize(new AbortController().signal)
  void pending.then(() => { settled = true }, () => { settled = true })
  await f.spawned
  t.mock.timers.tick(5000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, true)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.equal(f.owner.record().provider, null)
  assert.equal(f.writesBeforeIdentity(), 0)
  assert.deepEqual(f.signals, [])
})

test("spawn phase timeout during attempted publication prevents a late spawn", async t => {
  const f = await syntheticAgentProcess(t, "publication-paused")
  t.after(() => f.releasePublication())
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  let settled = false
  const pending = f.owner.initialize(new AbortController().signal)
  void pending.then(() => { settled = true }, () => { settled = true })
  await f.beforeSpawn.promise
  t.mock.timers.tick(5000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, true)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
  f.releasePublication()
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.equal(f.spawnCount(), 0)
})

for (const scenario of ["publication-never", "publication-paused"] as const) test(`failed-start envelope bounds ${scenario} cleanup while retaining queue ownership`, async t => {
  const f = await syntheticAgentProcess(t, scenario)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  const initializing = f.owner.initialize(new AbortController().signal)
  void initializing.catch(() => undefined)
  await f.beforeSpawn.promise
  t.mock.timers.tick(5000)
  await assert.rejects(initializing, { code: "STARTUP_TIMEOUT" })
  let settled = false, queueReleased = false
  const cleaning = f.owner.cleanup()
  void cleaning.then(() => { settled = true }, () => { settled = true })
  const following = f.context.mutations.queue.run(async () => { queueReleased = true; return f.context.mutations.unavailable })
  t.mock.timers.tick(25000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, true)
  await assert.rejects(cleaning, { code: "CLEANUP_UNVERIFIED" })
  assert.equal(queueReleased, false)
  assert.notEqual(f.context.mutations.unavailable, null)
  assert.equal(f.spawnCount(), 0)
  assert.notEqual((await f.record()).phase, "cleanup_verified")
  if (scenario === "publication-paused") {
    f.releasePublication()
    assert.notEqual(await following, null)
    await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
    assert.notEqual((await f.record()).phase, "cleanup_verified")
    assert.equal(f.spawnCount(), 0)
  }
})

for (const scenario of ["removal-never", "removal-paused"] as const) test(`failed-start envelope bounds ${scenario} without releasing its mutation`, async t => {
  const f = await syntheticAgentProcess(t, scenario, true)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  await f.owner.initialize(new AbortController().signal)
  let settled = false, queueReleased = false
  const cleaning = f.owner.cleanup()
  void cleaning.then(() => { settled = true }, () => { settled = true })
  await f.removalEntered
  const following = f.context.mutations.queue.run(async () => { queueReleased = true; return f.context.mutations.unavailable })
  t.mock.timers.tick(30000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, true)
  await assert.rejects(cleaning, { code: "CLEANUP_UNVERIFIED" })
  assert.equal(queueReleased, false)
  assert.notEqual(f.context.mutations.unavailable, null)
  if (scenario === "removal-paused") {
    f.releaseRemoval()
    assert.notEqual(await following, null)
    await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  }
})

test("late absence response cannot start another observation after the startup envelope", async t => {
  const f = await syntheticAgentProcess(t, "absence-paused", true)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  await f.owner.initialize(new AbortController().signal)
  const cleaning = f.owner.cleanup()
  void cleaning.catch(() => undefined)
  await f.absentEntered
  t.mock.timers.tick(30000)
  await assert.rejects(cleaning, { code: "CLEANUP_UNVERIFIED" })
  f.releaseAbsence()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.lateAbsenceReads(), 0)
  assert.notEqual(f.context.mutations.unavailable, null)
  f.owner.dispose()
})

test("failed-start envelope cannot shorten transport-close grace into cleanup success", async t => {
  const f = await syntheticAgentProcess(t, "close-held", true)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  await f.owner.initialize(new AbortController().signal)
  t.mock.timers.tick(29500)
  let closeWait = false, settled = false
  const set = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms?: number) => { if (ms! <= 1000 && f.owner.record().phase === "cleanup_verified") closeWait = true; return set(callback, ms) }) as typeof setTimeout)
  const cleaning = f.owner.cleanup()
  void cleaning.then(() => { settled = true }, () => { settled = true })
  while (!closeWait) await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(500)
  const observationDeadline = performance.now() + 100
  while (!settled && performance.now() < observationDeadline) await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, true)
  await assert.rejects(cleaning, { code: "CLEANUP_UNVERIFIED" })
  assert.equal(f.pipesDestroyed(), false)
  assert.notEqual(f.context.mutations.unavailable, null)
  t.mock.timers.tick(500)
  await f.context.mutations.queue.run(async () => undefined)
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.equal((await lstat(providerStatePath(f.root, f.spec.launchAttemptId))).isDirectory(), true)
  f.owner.dispose()
})

test("process terminal observation uses the five-second termination deadline", async t => {
  const f = await syntheticAgentProcess(t, "termination-hang")
  await f.owner.initialize(new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  let terminalWaiting = false
  const set = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms?: number) => { if (ms === 5000 && f.context.mutations.accepted[0]!.record.phase === "cleanup_verified") terminalWaiting = true; return set(callback, ms) }) as typeof setTimeout)
  let settled = false
  const pending = f.owner.cleanup()
  void pending.then(() => { settled = true }, () => { settled = true })
  await f.terminated
  while (!terminalWaiting) await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(4999)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, true)
  await assert.rejects(pending, { code: "CLEANUP_UNVERIFIED" })
  assert.notEqual(f.context.mutations.unavailable, null)
  assert.equal((await lstat(providerStatePath(f.root, f.spec.launchAttemptId))).isDirectory(), true)
})

test("repeated absence cannot turn an unanswered observation into verified cleanup", async t => {
  const f = await syntheticAgentProcess(t, "absence-hang")
  await f.owner.initialize(new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  let settled = false
  const pending = f.owner.cleanup()
  void pending.then(() => { settled = true }, () => { settled = true })
  await f.absentEntered
  t.mock.timers.tick(2000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, true)
  await assert.rejects(pending, { code: "CLEANUP_UNVERIFIED" })
  assert.notEqual(f.context.mutations.unavailable, null)
  assert.equal((await lstat(providerStatePath(f.root, f.spec.launchAttemptId))).isDirectory(), true)
})

test("transport close waits one second after proven absence before descriptor destruction", async t => {
  const f = await syntheticAgentProcess(t, "close-held")
  await f.owner.initialize(new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let entered = false
  const set = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms?: number) => { if (ms === 1000) entered = true; return set(callback, ms) }) as typeof setTimeout)
  const pending = f.owner.cleanup()
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.pipesDestroyed(), false)
  t.mock.timers.tick(999)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.pipesDestroyed(), false)
  t.mock.timers.tick(1)
  assert.equal((await pending).phase, "cleanup_verified")
  assert.equal(f.pipesDestroyed(), true)
})

test("a ready provider receives fresh cleanup budgets after the startup envelope", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  t.mock.timers.tick(45001)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("a ready provider prompts after the startup deadline with a fresh prompt budget", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  t.mock.timers.tick(45001)
  assert.deepEqual(await f.owner.prompt("after startup", new AbortController().signal), { stopReason: "end_turn", text: "after startup" })
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})

test("expired cleanup budgets cannot begin another platform observation or signal", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  let observations = 0, clockReads = 0
  const time = Date.now()
  f.context.adapter.bootId = async () => { observations++; return "boot-a" }
  t.mock.method(Date, "now", () => time + (clockReads++ === 0 ? 0 : 5000))
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.equal(observations, 0)
  assert.deepEqual(f.signals, [])
})

test("a cleanup observation timeout latches admission before releasing the mutation queue", async t => {
  const f = await syntheticAgentProcess(t, "cleanup-boot-hang")
  await f.owner.initialize(new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  const pending = f.owner.cleanup()
  void pending.catch(() => undefined)
  await f.cleanupObservation
  const following = f.context.mutations.queue.run(async () => f.context.mutations.unavailable)
  t.mock.timers.tick(5000)
  assert.notEqual(await following, null)
  await assert.rejects(pending, { code: "CLEANUP_UNVERIFIED" })
  assert.deepEqual(f.signals, [])
})

test("direct owner publishes identity before ACP, starts once, and coalesces cleanup", async t => {
  const f = await syntheticAgentProcess(t, "normal"), abort = new AbortController()
  const [a, b] = await Promise.all([f.owner.initialize(abort.signal), f.owner.initialize(abort.signal)])
  assert.deepEqual(a, b)
  assert.equal(f.spawnCount(), 1)
  assert.equal(f.writesBeforeIdentity(), 0)
  assert.equal(f.options()!.cwd, "/checkout")
  assert.equal(f.options()!.argv0, `agy-provider:${f.spec.launchAttemptId}`)
  assert.equal(f.options()!.detached, true)
  assert.equal(f.options()!.shell, false)
  assert.deepEqual(f.options()!.stdio, ["pipe", "pipe", "pipe"])
  assert.deepEqual(f.options()!.env, { HOME: "/fixture-home", FIXTURE: "yes" })
  const snapshot = f.owner.record(); snapshot.phase = "quarantined"
  assert.equal(f.owner.record().phase, "readiness")
  const cleaned = await Promise.all([f.owner.cleanup(), f.owner.cleanup()])
  assert.equal(cleaned[0]!.phase, "cleanup_verified")
  assert.deepEqual(cleaned[0], cleaned[1])
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("owned process forwards one prompt only while its initialized connection is live", async t => {
  const before = await syntheticAgentProcess(t, "normal")
  await assert.rejects(before.owner.prompt("challenge", new AbortController().signal), { code: "NOT_READY" })
  await before.owner.cleanup()

  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  assert.deepEqual(await f.owner.prompt("challenge", new AbortController().signal), { stopReason: "end_turn", text: "challenge" })
  await f.owner.cleanup()
  await assert.rejects(f.owner.prompt("late", new AbortController().signal), { code: "NOT_READY" })
})

test("owner prepares state before attempted publication and removes it after verified process cleanup", async t => {
  const f = await syntheticAgentProcess(t, "normal"), path = providerStatePath(f.root, f.spec.launchAttemptId)
  await f.owner.initialize(new AbortController().signal)
  assert.equal((await lstat(path)).isDirectory(), true)
  assert.equal((await f.record()).launchAttempted, true)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  await assert.rejects(lstat(path), { code: "ENOENT" })
})

test("state cleanup failure rejects owner cleanup and retains the substituted root", async t => {
  const f = await syntheticAgentProcess(t, "normal"), path = providerStatePath(f.root, f.spec.launchAttemptId)
  await f.owner.initialize(new AbortController().signal)
  await rename(path, path + "-old")
  await mkdir(path, { mode: 0o700 })
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.equal((await lstat(path)).isDirectory(), true)
})

test("cancellation during attempted publication does not spawn", async t => {
  const f = await syntheticAgentProcess(t, "publication-paused"), abort = new AbortController()
  const startup = f.owner.initialize(abort.signal)
  await f.beforeSpawn.promise
  abort.abort(); f.releasePublication()
  await assert.rejects(startup)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.equal(f.spawnCount(), 0)
  assert.deepEqual(f.signals, [])
})

for (const change of ["configuration", "checkout", "catalog-age"]) test(`second preflight prevents spawn after ${change} changed during publication`, async t => {
  const f = await syntheticAgentProcess(t, "publication-paused")
  const startup = f.owner.initialize(new AbortController().signal)
  await f.beforeSpawn.promise
  f.invalidate(change); f.releasePublication()
  await assert.rejects(startup)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.equal(f.spawnCount(), 0)
})

for (const scenario of ["attempt-write", "attempt-readback", "restore-failure", "spawn-throws", "identity-mismatch", "wrong-boot", "wrong-birth", "wrong-group", "wrong-uid", "child-exit"]) test(`failed ownership never invents cleanup or numeric signal authority: ${scenario}`, async t => {
  const f = await syntheticAgentProcess(t, scenario)
  await assert.rejects(f.owner.initialize(new AbortController().signal))
  if (scenario === "attempt-write") assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  else await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.deepEqual(f.signals, [])
  assert.equal(f.writesBeforeIdentity(), 0)
  if (scenario === "spawn-throws") assert.equal((await f.record()).launchAttempted, true)
})

test("exact generation mismatch after readiness prevents signals and lease release", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  f.replaceIdentity()
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.deepEqual(f.signals, [])
})

for (const scenario of ["ignore-term", "esrch-survivor"]) test(`cleanup independently verifies the TERM/KILL sequence: ${scenario}`, async t => {
  const f = await syntheticAgentProcess(t, scenario)
  await f.owner.initialize(new AbortController().signal)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"])
})

test("EOF is a fault, not proof of process absence", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  f.eof()
  assert.equal((await f.owner.fault).code, "STARTUP_FAILED")
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("inherited descriptors are destroyed only after independent process absence", async t => {
  const f = await syntheticAgentProcess(t, "close-held")
  await f.owner.initialize(new AbortController().signal)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.equal(f.pipesDestroyed(), true)
})

test("disposal while preparation is queued prevents spawning", async t => {
  const f = await syntheticAgentProcess(t, "queued-preparation"), initializing = f.owner.initialize(new AbortController().signal)
  await f.beforeSpawn.promise
  f.owner.dispose(); f.owner.dispose(); f.releasePublication()
  await assert.rejects(initializing)
  assert.equal(f.spawnCount(), 0)
  assert.equal((await f.record()).launchAttempted, false)
  assert.deepEqual(f.signals, [])
})

for (const scenario of ["publication-paused", "identity-publication-paused"] as const) test(`disposal during ${scenario} releases handles without late startup or cleanup claims`, async t => {
  const f = await syntheticAgentProcess(t, scenario), initializing = f.owner.initialize(new AbortController().signal)
  await f.beforeSpawn.promise
  const retained = await f.record()
  f.owner.dispose(); f.owner.dispose(); f.releasePublication()
  await assert.rejects(initializing)
  assert.equal(f.spawnCount(), scenario === "publication-paused" ? 0 : 1)
  assert.deepEqual(await f.record(), retained)
  assert.deepEqual(f.signals, [])
  if (scenario === "identity-publication-paused") { assert.equal(f.pipesDestroyed(), true); assert.equal(f.unrefs(), 1) }
})

test("disposal after unverified cleanup releases handles without changing quarantine", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  f.replaceIdentity()
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  const retained = await f.record()
  assert.equal(retained.phase, "quarantined")
  f.owner.dispose(); f.owner.dispose()
  assert.equal(f.pipesDestroyed(), true); assert.equal(f.unrefs(), 1)
  assert.deepEqual(f.signals, []); assert.deepEqual(await f.record(), retained)
})

test("direct Node fixture stays idle after exact ACP setup and leaves no survivors", async t => {
  assertFixtureBatchHealthy()
  const entrypoint = fileURLToPath(new URL("./fixtures/agent-provider.js", import.meta.url))
  await stat(entrypoint)
  const root = await mkdtemp(join(await realpath("/tmp"), "agy-agent-process-")), adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  const spec = sampleSpec(), checkoutRoot = { path: root, device: "1", inode: "2" }, gitDirectory = { path: join(root, ".git"), device: "1", inode: "3" }
  spec.checkout = { ...spec.checkout, root: checkoutRoot, gitDirectory, commonDirectory: gitDirectory, checkoutId: checkoutIdFor(spec.hostId, checkoutRoot, gitDirectory) }
  spec.checkout.ancestors = []
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    const metadata = await stat(parent, { bigint: true })
    spec.checkout.ancestors.push({ path: parent, device: String(metadata.dev), inode: String(metadata.ino) })
    if (parent === "/") break
  }
  const launch: LaunchRecord = { version: 1, agentId: spec.agentId, leaseId: spec.leaseId, launchAttemptId: spec.launchAttemptId, handlerGeneration: spec.handlerGeneration, checkoutId: spec.checkout.checkoutId, launchBootId: await adapter.bootId(), launchAttempted: false, provider: null, phase: "launch_pending", reason: null }
  const directory = join(root, "launches"), path = join(directory, spec.launchAttemptId + ".json")
  let child: ChildProcess | undefined, proof: LaunchRecord | undefined
  t.after(async () => {
    try {
      if (child?.pid) {
        if (proof) {
          const cleanupPath = join(root, "supervisor.json")
          await writeLaunchRecord(cleanupPath, proof)
          assert.equal((await reconcileRecord(cleanupPath, adapter, proof)).record.phase, "cleanup_verified")
          for (let pass = 0; pass < 2; pass++) {
            assert.equal(await adapter.readProcess(child.pid), null)
            assert.deepEqual(await adapter.readGroup(child.pid), [])
          }
        } else {
          for (let pass = 0; pass < 2; pass++) {
            assert.equal(await adapter.readProcess(child.pid), null, `unattributed fixture; retained ${root}`)
            assert.deepEqual(await adapter.readGroup(child.pid), [])
          }
        }
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy()
      }
      await rm(root, { recursive: true })
    } catch (error) { throw failFixtureBatch(error) }
  })
  await mkdir(directory, { mode: 0o700 }); await writeLaunchRecord(path, launch)
  const owner = createAgentProcess({
    context: { paths: { hostKey: spec.hostId, persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "handler.sock") }, adapter, mutations: { queue: new MutationQueue(), accepted: [{ path, record: launch }], unavailable: null }, shutdownPending: () => false, state: { hostId: spec.hostId, handlerGeneration: spec.handlerGeneration, phase: "ready", reconciliation: { classified: 1, total: 1, quarantined: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] } },
    spec, contract: { ...sampleContract(), entrypoint, environment: { fixed: { HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root, FIXTURE_ROOT: root }, private: {} } }, reservation: { launch, admission: { version: 1, checkout: spec.checkout, agentId: spec.agentId, leaseId: spec.leaseId, launchAttemptId: spec.launchAttemptId, handlerGeneration: spec.handlerGeneration } }, revalidate: async () => undefined,
  }, { spawn: ((...args: Parameters<typeof spawn>) => { child = spawn(...args); return child }) as typeof spawn })
  const startup = owner.initialize(new AbortController().signal)
  void startup.catch(() => undefined)
  await until(() => child?.pid ? Promise.resolve(true) : Promise.resolve(undefined))
  const identity = await adapter.readProcess(child!.pid!)
  assert.ok(identity)
  assert.equal(identity.birth.split(":").slice(1).join(":"), `agy-provider:${spec.launchAttemptId}`)
  const group = await adapter.readGroup(identity.pid)
  assert.deepEqual(group, await adapter.readGroup(identity.pid))
  assert.equal(group.length, 1); assert.ok(sameProcess(identity, group[0]!))
  proof = { ...launch, launchAttempted: true, phase: "readiness", provider: { kind: "process-group", group: { leader: identity, observed: group } } }
  const session = await startup
  assert.equal(session.mode, "review")
  assert.ok(sameProcess(identity, (await adapter.readProcess(identity.pid))!))
  assert.equal((await owner.cleanup()).phase, "cleanup_verified")
})