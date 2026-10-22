import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import fs, { access } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { gate, syntheticProbeFixture } from "./catalog-support.js"
import type { ProbeOutcome } from "../src/catalog/probes.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import { readProbeDiagnostic } from "../src/catalog/diagnostics.js"

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function clock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() })
  t.mock.method(performance, "now", () => Date.now())
}

test("probe cleanup returns incomplete while its mutation queue remains held", async t => {
  const f = await syntheticProbeFixture(t)
  clock(t)
  let outcome: ProbeOutcome | undefined
  const operation = f.runtime.run(f.request, new AbortController().signal).then(value => { outcome = value; return value })
  await f.workerObserved.promise; f.releaseWorkerIdentity(); await f.nativeRegistered.promise
  const entered = gate(), held = gate()
  const queued = f.queue.run(async () => { entered.resolve(); await held.promise })
  await entered.promise
  try {
    f.releaseResult(); await f.physicalCleanup.promise; await turn()
    assert.deepEqual(f.signals, ["SIGTERM"])
    assert.deepEqual([...f.processes.values()], [])
    assert.equal(Boolean(outcome), false)
    t.mock.timers.tick(5011); await turn()
    assert.ok(outcome)
    assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
    assert.equal(outcome.result, null)
  } finally { held.resolve(); await queued; await operation }
  await f.queue.run(async () => undefined)
  assert.notEqual((await readLaunchRecordForReconciliation(f.path)).phase, "cleanup_verified")
  const reads = [t.mock.method(f.adapter, "readProcess"), t.mock.method(f.adapter, "readGroup")]
  await f.runtime.verifyDischarged()
  assert.equal((await readLaunchRecordForReconciliation(f.path)).phase, "cleanup_verified")
  assert.deepEqual(f.signals, ["SIGTERM"])
  assert.deepEqual(reads.map(read => read.mock.callCount()), [0, 0])
})

test("probe timeout preserves queue ownership through an issued native publication", async t => {
  const f = await syntheticProbeFixture(t, "held-native-publication"), controller = new AbortController()
  clock(t)
  let outcome: ProbeOutcome | undefined
  const operation = f.runtime.run(f.request, controller.signal).then(value => { outcome = value; return value })
  f.releaseWorkerIdentity()
  await f.nativePublication.promise
  let queueReleased = false
  try {
    controller.abort(); await f.physicalCleanup.promise; await turn()
    t.mock.timers.tick(5011); await turn()
    assert.ok(outcome)
    assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
    assert.equal(outcome.result, null)
    void f.queue.run(async () => { queueReleased = true })
    await turn()
    assert.equal(queueReleased, false)
    assert.deepEqual(f.acknowledgements, [])
  } finally { f.releaseNativePublication(); await operation }
  await f.queue.run(async () => undefined)
  assert.equal(queueReleased, true)
  assert.deepEqual(f.acknowledgements, [])
  assert.notEqual((await readLaunchRecordForReconciliation(f.path)).phase, "cleanup_verified")
  await f.runtime.verifyDischarged()
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("explicit probe discharge is bounded behind an issued terminal publication", async t => {
  const f = await syntheticProbeFixture(t, "held-cleanup-publication")
  clock(t)
  let outcome: ProbeOutcome | undefined, dischargeSettled = false
  const operation = f.runtime.run(f.request, new AbortController().signal).then(value => { outcome = value; return value })
  f.releaseWorkerIdentity(); f.releaseResult()
  await f.cleanupPublication.promise
  try {
    t.mock.timers.tick(5011); await turn()
    assert.ok(outcome)
    assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
    assert.equal(outcome.result, null)
    const verified = assert.rejects(f.runtime.verifyDischarged(), { code: "PROBE_CLEANUP_UNVERIFIED" }).then(() => { dischargeSettled = true })
    t.mock.timers.tick(5011); await turn()
    assert.equal(dischargeSettled, true)
    await verified
  } finally { f.releaseCleanupPublication(); await operation }
  await f.queue.run(async () => undefined)
  await f.runtime.verifyDischarged()
  assert.deepEqual(f.signals, ["SIGTERM"])
  assert.equal(outcome!.error?.code, "PROBE_CLEANUP_UNVERIFIED")
})

test("expired probe repair cannot advance from cleanup_pending to cleanup_verified", async t => {
  const entered = gate(), held = gate(), publications: string[] = []
  let failing = true, repairing = false
  const f = await syntheticProbeFixture(t, "success", false, { publish: async (file, record) => {
    publications.push(record.phase)
    if (failing && record.phase === "cleanup_verified") throw new Error("fixture terminal publication")
    if (repairing && record.phase === "cleanup_pending") { entered.resolve(); await held.promise }
    await writeLaunchRecord(file, record)
  } })
  clock(t)
  f.releaseWorkerIdentity(); f.releaseResult()
  const outcome = await f.runtime.run(f.request, new AbortController().signal)
  assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  failing = false; repairing = true; publications.length = 0
  let rejected = false
  const verified = assert.rejects(f.runtime.verifyDischarged(), { code: "PROBE_CLEANUP_UNVERIFIED" }).then(() => { rejected = true })
  void verified.catch(() => undefined)
  try {
    await entered.promise
    t.mock.timers.tick(5011); await turn()
    assert.equal(rejected, true)
    await verified
  } finally { held.resolve(); await f.queue.run(async () => undefined); await verified.catch(() => undefined) }
  assert.deepEqual(publications, ["cleanup_pending"])
  repairing = false
  await f.runtime.verifyDischarged()
  assert.equal((await readLaunchRecordForReconciliation(f.path)).phase, "cleanup_verified")
  assert.deepEqual(f.signals, ["SIGTERM"])
})

for (const fault of ["sync", "stat", "close", "write", "marker"] as const) test(`held diagnostic ${fault} cannot extend probe cleanup`, async t => {
  const f = await syntheticProbeFixture(t), entered = gate(), held = gate(), released = gate()
  const originalOpen = fs.open, originalUnlink = fs.unlink
  const closes: string[] = []
  let diagnosticWrites = 0, removals = 0, observed: ProbeOutcome | undefined
  fs.open = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args), path = String(args[0])
    if (path.endsWith("/worker.stderr") || path.endsWith("/native.stderr")) {
      const close = handle.close.bind(handle)
      handle.close = async () => {
        closes.push(path)
        if (fault === "close" && path.endsWith("/worker.stderr")) { entered.resolve(); await held.promise }
        try { await close() } finally { if (fault === "close" && path.endsWith("/worker.stderr")) released.resolve() }
      }
    }
    if (path === join(f.request.meta.workPath, "worker.stderr")) {
      if (fault === "sync") {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { entered.resolve(); await held.promise; try { await sync() } finally { released.resolve() } }
      }
      if (fault === "stat") {
        const stat = handle.stat.bind(handle)
        handle.stat = (async () => { entered.resolve(); await held.promise; try { return await stat() } finally { released.resolve() } }) as typeof handle.stat
      }
    }
    if (path === join(f.request.meta.workPath, ".diagnostic.json.tmp") && ++diagnosticWrites === 2 && fault === "write") {
      const write = handle.writeFile.bind(handle)
      handle.writeFile = async (...values: Parameters<typeof write>) => { entered.resolve(); await held.promise; try { await write(...values) } finally { released.resolve() } }
    }
    return handle
  }) as typeof originalOpen
  fs.unlink = (async path => {
    if (String(path) === join(f.request.meta.workPath, "capture-pending.json")) {
      removals++
      if (fault === "marker") { entered.resolve(); await held.promise; try { return await originalUnlink(path) } finally { released.resolve() } }
    }
    return originalUnlink(path)
  }) as typeof originalUnlink
  syncBuiltinESMExports()
  clock(t)
  const operation = f.runtime.run(f.request, new AbortController().signal).then(value => { observed = value; return value })
  try {
    f.releaseWorkerIdentity(); f.releaseResult()
    await entered.promise
    assert.equal((await readLaunchRecordForReconciliation(f.path)).phase, "cleanup_verified")
    assert.deepEqual([...f.processes.values()], [])
    t.mock.timers.tick(5011); await turn()
    assert.ok(observed)
    assert.equal(observed.error?.code, "PROBE_FAILED")
    assert.equal(observed.result, null)
    assert.equal(new Set(closes).size, 2)
    assert.ok(f.runtime.diagnostics!().some(issue => issue.includes(f.request.meta.attemptId)))
    await f.runtime.verifyDischarged()
  } finally {
    held.resolve(); await released.promise; await operation; await turn()
    fs.open = originalOpen; fs.unlink = originalUnlink; syncBuiltinESMExports()
  }
  assert.equal(removals, fault === "marker" ? 1 : 0)
  assert.equal((await readProbeDiagnostic(f.request.meta))!.stderrComplete, fault === "marker")
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("late preparation after probe expiry cannot spawn and permits fresh discharge", async t => {
  const f = await syntheticProbeFixture(t), entered = gate(), held = gate(), cleanupQueued = gate()
  const queueRun = f.queue.run.bind(f.queue)
  let queued = 0
  f.queue.run = operation => { const result = queueRun(operation); if (++queued === 2) cleanupQueued.resolve(); return result }
  const writeMeta = f.store.writeProbeMeta.bind(f.store)
  f.store.writeProbeMeta = async meta => { entered.resolve(); await held.promise; await writeMeta(meta) }
  clock(t)
  let outcome: ProbeOutcome | undefined
  const operation = f.runtime.run(f.request, new AbortController().signal).then(value => { outcome = value; return value })
  try {
    await entered.promise
    t.mock.timers.tick(5001); await cleanupQueued.promise
    t.mock.timers.tick(5011); await turn()
    assert.ok(outcome)
    assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  } finally { held.resolve(); await operation; await f.queue.run(async () => undefined) }
  assert.equal(f.spawnInvoked(), false)
  assert.deepEqual(f.signals, [])
  await assert.rejects(access(f.request.meta.workPath), { code: "ENOENT" })
  await f.runtime.verifyDischarged()
  assert.deepEqual([...f.runtime.issues!()], [])
  f.store.writeProbeMeta = writeMeta
  const commandId = randomUUID(), attemptId = randomUUID()
  const next = { ...f.request, meta: { ...f.request.meta, commandId, attemptId, workPath: join(f.root, "catalog/work", attemptId) } }
  await f.store.writeCommand({ version: 1, commandId, hostId: next.meta.hostId, handlerGeneration: f.generation, batchId: randomUUID(), fingerprints: [{ providerId: f.profile.id, fingerprint: next.evidence.fingerprint }], attempts: [{ providerId: f.profile.id, attemptId }], state: "pending", snapshotId: null }, null)
  f.bindRequest(next); f.releaseWorkerIdentity(); f.releaseResult()
  const later = await f.runtime.run(next, new AbortController().signal)
  assert.equal(later.error, null)
  assert.equal(later.record.phase, "cleanup_verified")
  await f.runtime.verifyDischarged()
  assert.equal(outcome!.error?.code, "PROBE_CLEANUP_UNVERIFIED")
  assert.equal(outcome!.result, null)
})

test("expired physical observation never authorizes a late probe signal or discharge", async t => {
  const f = await syntheticProbeFixture(t), entered = gate(), held = gate()
  clock(t)
  let outcome: ProbeOutcome | undefined
  const operation = f.runtime.run(f.request, new AbortController().signal).then(value => { outcome = value; return value })
  f.releaseWorkerIdentity(); await f.nativeRegistered.promise
  const readGroup = f.adapter.readGroup.bind(f.adapter)
  f.adapter.readGroup = async group => { entered.resolve(); await held.promise; return readGroup(group) }
  try {
    f.releaseResult(); await entered.promise
    t.mock.timers.tick(5011); await turn()
    assert.ok(outcome)
    assert.equal(outcome.error?.code, "PROBE_CLEANUP_UNVERIFIED")
    assert.equal(outcome.result, null)
    assert.notEqual(outcome.record.phase, "cleanup_verified")
  } finally { held.resolve(); await operation; await turn() }
  assert.deepEqual(f.signals, [])
  await assert.rejects(f.runtime.verifyDischarged(), { code: "PROBE_CLEANUP_UNVERIFIED" })
})