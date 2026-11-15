import assert from "node:assert/strict"
import test from "node:test"
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { consumeCleanShutdown, markCleanShutdownSync, openEventLog } from "../src/handler/event-log.js"

const lines = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line))

test("the event log numbers events and continues after reopening", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-events-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await openEventLog({ root, hostId: "h" })
  first.append({ type: "one" }); first.append({ type: "two", agentId: "a" })
  await first.flush()
  const second = await openEventLog({ root, hostId: "h" })
  second.append({ type: "three" })
  await second.flush()
  assert.deepEqual((await lines(join(root, "events.jsonl"))).map(entry => [entry.seq, entry.type, entry.host]), [[1, "one", "h"], [2, "two", "h"], [3, "three", "h"]])
})

test("the event log continues after a truncated last line", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-events-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "events.jsonl"), JSON.stringify({ seq: 7, at: "x", host: "h", type: "old" }) + "\n" + '{"seq":8,"at":')
  const log = await openEventLog({ root, hostId: "h" })
  log.append({ type: "next" })
  await log.flush()
  assert.equal(log.lastSequence(), 8)
  const text = (await readFile(join(root, "events.jsonl"), "utf8")).trim().split("\n")
  assert.deepEqual(JSON.parse(text[text.length - 1]!).type, "next")
  assert.equal((await openEventLog({ root, hostId: "h" })).lastSequence(), 8)
})

test("the event log rotates and keeps a bounded number of files", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-events-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const log = await openEventLog({ root, hostId: "h", maxBytes: 200, keep: 2 })
  for (let n = 0; n < 40; n++) log.append({ type: "filler", n })
  await log.flush()
  const names = (await readdir(root)).filter(name => name.startsWith("events")).sort()
  assert.deepEqual(names, ["events.1.jsonl", "events.2.jsonl", "events.jsonl"])
  assert.equal(log.lastSequence(), 40)
})

test("a failed write is ignored", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-events-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, "not-a-directory")
  await appendFile(file, "x")
  const log = await openEventLog({ root: file, hostId: "h" })
  assert.doesNotThrow(() => log.append({ type: "lost" }))
  await log.flush()
})

test("the clean-shutdown marker is consumed once", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-events-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(await consumeCleanShutdown(root), false)
  markCleanShutdownSync(root)
  assert.equal(await consumeCleanShutdown(root), true)
  assert.equal(await consumeCleanShutdown(root), false)
})