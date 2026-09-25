import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { createAdmissionController, type AdmissionDependencies } from "../src/checkout/admission.js"
import { resolveCheckout } from "../src/checkout/identity.js"
import { inventoryAdmissions, readAdmission, writeAdmission } from "../src/checkout/records.js"
import { inventoryLaunches } from "../src/handler/inventory.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import { admissionFixture, testHostId } from "./checkout-support.js"
import { launch } from "./control-support.js"

const dependencies: AdmissionDependencies = { resolve: resolveCheckout, publishLaunch: writeLaunchRecord, publishAdmission: writeAdmission, reconcile: reconcileRecord }

test("32 same-checkout reservations admit exactly one writer", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t)
  const outcomes = await Promise.allSettled(Array.from({ length: 32 }, () => f.controller.reserve(f.request())))
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1)
  for (const value of outcomes) if (value.status === "rejected") assert.equal(value.reason.code, "CHECKOUT_BUSY")
  assert.equal(f.context.state.launches.length, 1)
  assert.equal(f.context.state.launches[0]!.phase, "launch_pending")
  assert.equal((await inventoryAdmissions(f.root)).records.length, 1)
})

test("retries preserve IDs, cancellations release only unattempted leases, and spent attempts stay spent", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t), request = f.request(), first = await f.controller.reserve(request)
  assert.deepEqual(await f.controller.reserve(request), first)
  for (const changes of [{ agentId: randomUUID() }, { leaseId: randomUUID() }, { launchAttemptId: randomUUID() }]) await assert.rejects(f.controller.reserve({ ...request, ...changes }), { code: "IDENTITY_CONFLICT" })
  assert.equal((await f.controller.cancel(request)).phase, "cleanup_verified")
  assert.equal((await f.controller.cancel(request)).phase, "cleanup_verified")
  await assert.rejects(f.controller.reserve(request), { code: "ATTEMPT_RELEASED" })
  assert.equal((await f.controller.reserve(f.request())).launch.launchAttempted, false)
  assert.deepEqual(await readAdmission(f.root, request.launchAttemptId), first.admission)
})

test("aliases and nested roots conflict while linked worktrees remain independent", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t)
  await f.controller.reserve(f.request())
  for (const path of [f.git.alias, f.git.nested]) await assert.rejects(f.controller.reserve({ ...f.request(), checkout: await resolveCheckout(path, testHostId) }), { code: "CHECKOUT_BUSY" })
  const linked = await f.controller.reserve({ ...f.request(), checkout: await resolveCheckout(f.git.linked, testHostId) })
  assert.equal(linked.launch.phase, "launch_pending")
  assert.equal(f.context.state.launches.length, 2)
})

for (const boundary of ["launch-before", "launch-after", "admission-before", "admission-after"]) {
  test(`failure at ${boundary} retains evidence and an exact retry finishes publication`, { timeout: 20000 }, async t => {
    const f = await admissionFixture(t), request = f.request()
    const controller = createAdmissionController(f.context, { ...dependencies,
      publishLaunch: async (path, value) => { if (boundary === "launch-before") throw new Error("fault"); await writeLaunchRecord(path, value); if (boundary === "launch-after") throw new Error("fault") },
      publishAdmission: async (root, value) => { if (boundary === "admission-before") throw new Error("fault"); await writeAdmission(root, value); if (boundary === "admission-after") throw new Error("fault") },
    })
    await assert.rejects(controller.reserve(request), { code: "ADMISSION_UNAVAILABLE" })
    assert.equal(f.context.state.launches.length, boundary === "launch-before" ? 0 : 1)
    assert.equal((await f.controller.reserve(request)).launch.launchAttemptId, request.launchAttemptId)
    assert.equal(f.context.mutations.unavailable, null)
  })
}

test("partial unattempted publication can be cancelled without inventing metadata", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t), request = f.request()
  const controller = createAdmissionController(f.context, { ...dependencies, publishAdmission: async () => { throw new Error("fault") } })
  await assert.rejects(controller.reserve(request))
  await rename(f.git.repo, join(f.git.root, "moved"))
  assert.equal((await f.controller.cancel(request)).phase, "cleanup_verified")
  assert.equal(await readAdmission(f.root, request.launchAttemptId), null)
})

test("post-publication identity change retains a cancellable pending lease", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t), request = f.request()
  const controller = createAdmissionController(f.context, { ...dependencies, publishAdmission: async (root, value) => { await writeAdmission(root, value); await rename(f.git.repo, join(f.git.root, "moved")) } })
  await assert.rejects(controller.reserve(request), { code: "IDENTITY_CHANGED" })
  assert.equal(f.context.state.launches[0]!.phase, "launch_pending")
  assert.equal((await f.controller.cancel(request)).phase, "cleanup_verified")
})

for (const replace of [false, true]) {
  test(`moving a leased nested checkout blocks its new parent, old path replaced=${replace}`, { timeout: 20000 }, async t => {
    const f = await admissionFixture(t), request = { ...f.request(), checkout: await resolveCheckout(f.git.nested, testHostId) }
    await f.controller.reserve(request)
    await rename(f.git.nested, join(f.git.linked, "nested"))
    if (replace) await f.git.git(["init", "-q", f.git.nested])
    const next = { ...f.request(), checkout: await resolveCheckout(f.git.linked, testHostId) }
    await assert.rejects(f.controller.reserve(next), { code: "ADMISSION_UNAVAILABLE" })
    await f.controller.cancel(request)
    assert.equal((await f.controller.reserve(next)).launch.phase, "launch_pending")
  })
}

test("mapped attempted quarantine blocks only its checkout and cannot be cancelled", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t), request = f.request(), reservation = await f.controller.reserve(request)
  const record = { ...reservation.launch, launchAttempted: true, phase: "quarantined" as const, reason: "ambiguous" }
  await writeLaunchRecord(join(f.root, "launches", `${record.launchAttemptId}.json`), record)
  f.context.mutations.accepted = await inventoryLaunches(join(f.root, "launches"))
  await assert.rejects(f.controller.cancel(request), { code: "CANNOT_CANCEL" })
  await assert.rejects(f.controller.reserve(f.request()), { code: "CHECKOUT_QUARANTINED" })
  assert.equal((await f.controller.reserve({ ...f.request(), checkout: await resolveCheckout(f.git.linked, testHostId) })).launch.phase, "launch_pending")
})

test("unknown legacy evidence, orphan metadata, and external replacement never free admission", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t), record = launch(), path = join(f.root, "launches", `${record.launchAttemptId}.json`)
  await writeLaunchRecord(path, record)
  f.context.mutations.accepted = await inventoryLaunches(join(f.root, "launches"))
  await assert.rejects(f.controller.reserve(f.request()), { code: "ADMISSION_UNAVAILABLE" })
  await rm(path)
  await assert.rejects(f.controller.reserve(f.request()), { code: "ADMISSION_UNAVAILABLE" })
  assert.notEqual(f.context.mutations.unavailable, null)
  await writeLaunchRecord(path, record)
  await assert.rejects(f.controller.reserve(f.request()), { code: "ADMISSION_UNAVAILABLE" })
})

test("generation and readiness checks occur inside the queue and caller mutation cannot retarget it", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t), request = f.request()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const paused = f.context.mutations.queue.run(() => gate)
  const operation = f.controller.reserve(request)
  f.context.state.handlerGeneration = randomUUID()
  request.handlerGeneration = f.context.state.handlerGeneration
  release(); await paused
  await assert.rejects(operation, { code: "STALE_HANDLER" })
  f.context.state.phase = "draining"
  await assert.rejects(f.controller.reserve(request), { code: "NOT_READY" })
  assert.equal(f.context.state.launches.length, 0)
})

test("changed Git relationship invalidates immutable request before publication", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t), request = f.request(), previous = join(f.git.repo, ".git")
  await rename(previous, join(f.git.repo, "old-git"))
  await f.git.git(["init", "-q", f.git.repo])
  await assert.rejects(f.controller.reserve(request), { code: "IDENTITY_CHANGED" })
  assert.deepEqual(await inventoryLaunches(join(f.root, "launches")), [])
})

test("a final refresh detecting changed inventory cannot return reservation success", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t), request = f.request()
  let summaries = f.context.state.launches, replaced = false
  Object.defineProperty(f.context.state, "launches", { get: () => summaries, set: value => {
    summaries = value
    if (!replaced && value.length > 0) {
      replaced = true
      const record = f.context.mutations.accepted[0]!
      writeFileSync(record.path, JSON.stringify({ ...record.record, checkoutId: "replaced" }))
    }
  } })
  await assert.rejects(f.controller.reserve(request), { code: "ADMISSION_UNAVAILABLE" })
  assert.notEqual(f.context.mutations.unavailable, null)
})

test("malformed retry evidence and orphan metadata cannot be repaired by a new reservation", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t), request = f.request(), reserved = await f.controller.reserve(request)
  const path = join(f.root, "admissions", `${request.launchAttemptId}.json`)
  await writeFile(path, "{")
  await assert.rejects(f.controller.reserve(request), { code: "ADMISSION_UNAVAILABLE" })
  assert.equal(await readFile(path, "utf8"), "{")
  await writeFile(path, JSON.stringify(reserved.admission))
  await rm(join(f.root, "launches", `${request.launchAttemptId}.json`))
  f.context.mutations.accepted = []
  await assert.rejects(f.controller.reserve(f.request()), { code: "ADMISSION_UNAVAILABLE" })
})

for (const nestedFirst of [false, true]) {
  test(`whole-parent rename preserves nested conflicts, nested first=${nestedFirst}`, { timeout: 20000 }, async t => {
    const f = await admissionFixture(t), original = nestedFirst ? f.git.nested : f.git.repo
    const request = { ...f.request(), checkout: await resolveCheckout(original, testHostId) }
    await f.controller.reserve(request)
    const moved = join(f.git.root, "moved")
    await rename(f.git.repo, moved)
    const candidate = await resolveCheckout(nestedFirst ? moved : join(moved, "nested"), testHostId)
    await assert.rejects(f.controller.reserve({ ...f.request(), checkout: candidate }), { code: "CHECKOUT_BUSY" })
    await f.controller.cancel(request)
  })
}

test("attempted records cannot enter the cancellation reconciliation path", { timeout: 20000 }, async t => {
  const f = await admissionFixture(t), request = f.request(), reserved = await f.controller.reserve(request)
  await writeLaunchRecord(join(f.root, "launches", `${request.launchAttemptId}.json`), { ...reserved.launch, launchAttempted: true })
  f.context.mutations.accepted = await inventoryLaunches(join(f.root, "launches"))
  const controller = createAdmissionController(f.context, { ...dependencies, reconcile: async () => { assert.fail("attempted cancellation invoked cleanup") } })
  await assert.rejects(controller.cancel(request), { code: "CANNOT_CANCEL" })
})