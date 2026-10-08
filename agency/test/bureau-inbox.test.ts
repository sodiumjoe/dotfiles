import assert from "node:assert/strict"
import test from "node:test"
import { notificationsFixture } from "./bureau-notifications-support.js"

test("report acceptance and its parent inbox share one authoritative event", async t => {
  const f = await notificationsFixture(t), receipt = await f.report(), inbox = await f.core.inbox(f.parent, f.input.runId)
  assert.equal(inbox.pending.length, 1)
  assert.equal(inbox.pending[0]!.report.commandId, receipt.commandId)
  const event = (await f.origins.forRun(f.input.runId).read(0, 256)).entries[0]!
  assert.equal(inbox.pending[0]!.report.attemptId, f.child.attempt.ref.attemptId)
  assert.equal(event.eventId, receipt.commandId)
  const bureau = await f.core.inspect(f.input.runId)
  assert.equal(bureau.assignments[0]!.attempt.state, "completed")
  await f.restart()
  assert.deepEqual(await f.core.inbox(f.parent, f.input.runId), inbox)
})

test("late reports preserve evidence without creating a parent notification", async t => {
  const f = await notificationsFixture(t)
  await f.core.cancel(crypto.randomUUID(), f.input.runId)
  assert.equal((await f.report()).state, "late")
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).pending.length, 0)
})

test("two accepted reports remain queued together while the parent is busy", async t => {
  const f = await notificationsFixture(t), second = await f.delegate()
  await f.report(); await f.report(second)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).pending.length, 2)
  assert.equal(f.host.promptCount, 2)
})

test("a failed inbox snapshot recovers report and recipient from their shared journal event", async t => {
  const f = await notificationsFixture(t), write = f.store.writeInbox
  let failure = true
  f.store.writeInbox = async entry => { if (failure) { failure = false; throw new Error("inbox publication failed") }; await write(entry) }
  await assert.rejects(f.report(), /inbox publication failed/)
  assert.equal((await f.core.status()).writeAvailable, false)
  await f.restart()
  const inbox = await f.core.inbox(f.parent, f.input.runId)
  assert.equal(inbox.pending.length, 1)
  assert.equal((await f.core.assignment(f.child.assignmentId)).attempt.state, "completed")
})

test("recovery rejects a delivery whose immutable source digest was forged", async t => {
  const f = await notificationsFixture(t)
  await f.report(); await f.core.wait(f.waitInput)
  const delivery = (await f.core.inbox(f.parent, f.input.runId)).deliveries[0]!, { canonicalDigest } = await import("../src/orchestration/types.js"), { createJournalPool } = await import("../src/orchestration/journal.js")
  const sources = delivery.sources.map(source => ({ ...source, digest: "f".repeat(64) }))
  await createJournalPool(f.root, f.filesystem, f.clock.now).forRun(f.input.runId).append(crypto.randomUUID(), "bureau-delivery", { previousDigest: canonicalDigest(delivery), delivery: { ...delivery, sources, digest: canonicalDigest(sources) } })
  await assert.rejects(f.restart(), /INVALID_DELIVERY/)
})

test("inbox pages keep large report payloads bounded without losing cursors", async t => {
  const f = await notificationsFixture(t)
  await f.report()
  const source = (await f.core.inbox(f.parent, f.input.runId)).entries[0]!
  for (let offset = 1; offset <= 8; offset++) {
    const eventId = crypto.randomUUID()
    await f.store.writeInbox({ ...source, eventId, source: { ...source.source, eventId, seq: source.source.seq + offset }, report: { ...source.report, commandId: eventId, report: { ...source.report.report, summary: "x".repeat(65536) } } })
  }
  const seen = new Set<string>()
  let after = 0, next: number | null
  do {
    const page = await f.core.inbox(f.parent, f.input.runId, after)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 600000)
    for (const entry of page.entries) { assert.equal(seen.has(entry.eventId), false); seen.add(entry.eventId) }
    next = page.nextCursor; after = next ?? after
  } while (next !== null)
  assert.equal(seen.size, 9)
})