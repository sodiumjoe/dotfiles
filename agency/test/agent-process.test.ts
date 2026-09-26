import assert from "node:assert/strict"
import test from "node:test"
import { syntheticAgentProcess, sampleSpec, sampleContract } from "./agent-support.js"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises"
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
    spec, contract: { ...sampleContract(), entrypoint, environment: { HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root, FIXTURE_ROOT: root } }, reservation: { launch, admission: { version: 1, checkout: spec.checkout, agentId: spec.agentId, leaseId: spec.leaseId, launchAttemptId: spec.launchAttemptId, handlerGeneration: spec.handlerGeneration } }, revalidate: async () => undefined,
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