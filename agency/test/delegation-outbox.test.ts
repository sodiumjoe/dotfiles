import assert from "node:assert/strict"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createOutboxStore, TEXT_LIMIT } from "../src/delegation/outbox.js"

const child = "00000000-0000-4000-8000-000000000001", parent = { hostId: "a".repeat(64), agentId: "00000000-0000-4000-8000-000000000002" }
async function store(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "agency-outbox-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, outbox: createOutboxStore(root, () => new Date("2026-11-19T00:00:00.000Z")) }
}
const answer = (n: number, text = "answer " + n) => ({ submissionId: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`, state: "answer" as const, stopReason: "end_turn", failure: null, text })

test("an outbox is created once, kept private, and listed", async t => {
  const { root, outbox } = await store(t)
  const created = await outbox.create({ childId: child, parent, depth: 1, ref: "master" })
  assert.deepEqual(await outbox.create({ childId: child, parent, depth: 1, ref: "other" }), created)
  assert.equal((await stat(join(root, "children", child + ".json"))).mode & 0o777, 0o600)
  assert.equal((await stat(join(root, "children"))).mode & 0o777, 0o700)
  assert.deepEqual((await outbox.list()).map(value => [value.childId, value.ref, value.entries.length]), [[child, "master", 0]])
  await assert.rejects(outbox.create({ childId: "../x", parent, depth: 1, ref: "master" }))
})

test("answers are capped, empty answers say so, and the bounds keep undelivered entries", async t => {
  const { outbox } = await store(t)
  await outbox.create({ childId: child, parent, depth: 1, ref: "master" })
  await outbox.append(child, answer(0, "x".repeat(TEXT_LIMIT + 10)))
  await outbox.append(child, answer(1, ""))
  let value = (await outbox.read(child))!
  assert.ok(value.entries[0]!.text.endsWith("(answer cut at 65536 characters)"))
  assert.equal(value.entries[1]!.text, "(no text)")
  for (let n = 2; n < 25; n++) await outbox.append(child, answer(n))
  value = (await outbox.read(child))!
  assert.equal(value.entries.filter(entry => !entry.delivered).length, 20)
  assert.equal(value.dropped, 5)
  assert.equal(value.entries[0]!.text, "answer 5")
  await outbox.update(child, current => { for (const entry of current.entries) entry.delivered = true })
  value = (await outbox.read(child))!
  assert.deepEqual(value.entries.map(entry => entry.text), ["answer 22", "answer 23", "answer 24"])
})

test("concurrent appends are all kept, and a stopped outbox with everything delivered is removed", async t => {
  const { root, outbox } = await store(t)
  await outbox.create({ childId: child, parent, depth: 1, ref: "master" })
  await Promise.all([1, 2, 3, 4].map(n => outbox.append(child, answer(n))))
  assert.equal((await outbox.read(child))!.entries.length, 4)
  assert.notEqual(await outbox.update(child, current => { current.stopped = true }), null)
  assert.equal(await outbox.update(child, current => { for (const entry of current.entries) entry.delivered = true }), null)
  assert.deepEqual(await readdir(join(root, "children")), [])
  await outbox.flushed()
})