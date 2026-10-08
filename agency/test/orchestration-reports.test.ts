import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { createJournalPool } from "../src/orchestration/journal.js"
import { createReportOutbox } from "../src/orchestration/reports.js"
import { createBureauService } from "../src/bureau/service.js"
import { bureauFixture } from "./bureau-support.js"

async function fixture(t: Parameters<typeof bureauFixture>[0]) {
  const f = await bureauFixture(t), child = await f.delegate(), origins = createJournalPool(f.root, f.filesystem, f.clock.now, "origin")
  const input = { ...child.attempt.ref, commandId: randomUUID(), execution: child.attempt.execution!, report: f.input.report }
  let live = true, online = true
  let core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), origins, hosts: [f.host.raw] })
  await core.initialize()
  const outbox = createReportOutbox({ journals: origins, validate: async execution => { if (!live || execution.agentId !== child.agent.agentId || execution.providerGeneration !== child.attempt.execution!.providerGeneration) throw new Error("STALE_EXECUTION") }, relay: async envelope => { if (!online) throw new Error("offline"); return core.acceptReport(envelope) } })
  return { ...f, child, reportInput: input, origins, outbox, get bureau() { return core }, offline() { online = false }, retire() { live = false; f.host.retire() }, async recover() { online = true; core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), origins, hosts: [f.host.raw] }); await core.initialize(); await outbox.replay() } }
}

test("report origin retains before Bureau acceptance and exact acknowledgment", async t => {
  const f = await fixture(t), receipt = await f.outbox.report(f.reportInput)
  assert.equal(receipt.state, "accepted")
  assert.equal((await f.bureau.assignment(f.child.assignmentId)).attempt.state, "completed")
  const journal = f.origins.forRun(f.input.runId), page = await journal.read(0, 256)
  assert.equal(page.entries.length, 1)
  assert.equal(await journal.watermark("bureau"), 1)
  assert.deepEqual(await f.outbox.report(f.reportInput), receipt)
})

test("offline historical report replays before generation interruption", async t => {
  const f = await fixture(t)
  f.offline()
  assert.equal((await f.outbox.report(f.reportInput)).state, "retained")
  f.retire(); await f.recover()
  assert.equal((await f.bureau.assignment(f.child.assignmentId)).attempt.state, "completed")
  assert.equal(f.host.promptCount, 1)
  await assert.rejects(f.outbox.report({ ...f.reportInput, commandId: randomUUID(), report: { ...f.reportInput.report, summary: "after retirement" } }), /STALE_EXECUTION/)
})

test("late report after explicit replacement cannot complete the replacement attempt", async t => {
  const f = await fixture(t)
  f.retire(); await f.bureau.reconcile()
  const next = await f.bureau.retry(randomUUID(), f.child.assignmentId, "replace", f.invocation)
  const entry = await f.origins.forRun(f.input.runId).append(f.reportInput.commandId, "report-retained", f.reportInput)
  const receipt = await f.bureau.acceptReport({ input: f.reportInput, origin: { seq: entry.seq, eventId: entry.eventId, digest: entry.digest } })
  assert.equal(receipt.state, "late")
  assert.equal((await f.bureau.assignment(next.assignmentId)).attempt.state, "running")
})

test("one immutable terminal report is retained across distinct command IDs", async t => {
  const f = await fixture(t), receipt = await f.outbox.report(f.reportInput)
  assert.deepEqual(await f.outbox.report({ ...f.reportInput, commandId: randomUUID() }), receipt)
  await assert.rejects(f.outbox.report({ ...f.reportInput, commandId: randomUUID(), report: { ...f.reportInput.report, summary: "changed" } }), /REPORT_CONFLICT/)
})

test("forged report origin or execution cannot terminate an attempt", async t => {
  const f = await fixture(t), entry = await f.origins.forRun(f.input.runId).append(f.reportInput.commandId, "report-retained", f.reportInput)
  const origin = { seq: entry.seq, eventId: entry.eventId, digest: entry.digest }
  await assert.rejects(f.bureau.acceptReport({ input: { ...f.reportInput, execution: { ...f.reportInput.execution, providerGeneration: randomUUID() } }, origin }), /INVALID_ORIGIN|STALE_EXECUTION/)
  await assert.rejects(f.bureau.acceptReport({ input: f.reportInput, origin: { ...origin, digest: "b".repeat(64) } }), /INVALID_ORIGIN/)
  assert.equal((await f.store.readAttempt(f.child.attempt.ref.attemptId))!.state, "running")
  assert.equal(await f.store.readReport(f.child.attempt.ref.attemptId), null)
  assert.equal((await f.bureau.assignment(f.child.assignmentId)).attempt.state, "completed")
})

test("origin disk failure cannot return a retained acknowledgment", async t => {
  const f = await fixture(t)
  f.failAt("file-sync", "origin-runs")
  await assert.rejects(f.outbox.report(f.reportInput), /ENOSPC/)
  assert.equal((await f.bureau.assignment(f.child.assignmentId)).attempt.state, "running")
})

test("blocked and failed reports preserve their category and fail the attempt", async t => {
  for (const status of ["blocked", "failed"] as const) {
    const f = await fixture(t), input = { ...f.reportInput, report: { ...f.reportInput.report, status } }
    assert.equal((await f.outbox.report(input)).state, "accepted")
    assert.equal((await f.bureau.assignment(f.child.assignmentId)).attempt.state, "failed")
    assert.equal((await f.store.readReport(f.child.attempt.ref.attemptId))?.input.report.status, status)
  }
})

test("duplicate report replay cannot substitute another assignment identity", async t => {
  const f = await fixture(t)
  await f.outbox.report(f.reportInput)
  await assert.rejects(f.outbox.report({ ...f.reportInput, commandId: randomUUID(), assignmentId: randomUUID() }), /REPORT_CONFLICT|STALE_EXECUTION/)
})

test("visible report after failed publication must reverify origin fsync before relay", async t => {
  const f = await fixture(t)
  f.failAt("rename", "origin-runs", true)
  await assert.rejects(f.outbox.report(f.reportInput), /ENOSPC/)
  f.failAt("directory-sync", "journal/entries")
  await assert.rejects(f.outbox.report(f.reportInput), /ENOSPC/)
  assert.equal((await f.store.readAttempt(f.child.attempt.ref.attemptId))!.state, "running")
  assert.equal(await f.store.readReport(f.child.attempt.ref.attemptId), null)
  f.failAt("directory-sync", "journal/entries")
  await assert.rejects(f.bureau.assignment(f.child.assignmentId), /ENOSPC/)
  assert.equal((await f.store.readAttempt(f.child.attempt.ref.attemptId))!.state, "running")
  assert.equal(await f.store.readReport(f.child.attempt.ref.attemptId), null)
  assert.equal((await f.outbox.report(f.reportInput)).state, "accepted")
  assert.equal((await f.bureau.assignment(f.child.assignmentId)).attempt.state, "completed")
})