import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { createRemoteOrigins } from "../src/bureau/origins.js"
import { replayOriginSnapshot } from "../src/bridge/replay.js"
import { canonicalDigest, type JournalEntry } from "../src/orchestration/types.js"
import { coreFixture } from "./orchestration-support.js"

async function fixture(t: Parameters<typeof coreFixture>[0]) {
  const f = await coreFixture(t), hostId = f.input.agent.hostId, key = { hostId, runId: f.input.runId, streamId: f.input.runId }
  const execution = { ...f.input.agent, handlerGeneration: randomUUID(), providerGeneration: randomUUID() }
  const entry = (seq: number): JournalEntry => {
    const payload = { runId: key.runId, assignmentId: f.input.assignmentId, attemptId: randomUUID(), commandId: randomUUID(), execution, report: f.input.report }
    const kind = "report-retained"
    return { seq, eventId: payload.commandId, kind, payload, digest: canonicalDigest({ kind, payload }) }
  }
  const snapshot = { hostId, handlerGeneration: randomUUID(), backendChoices: [], agents: [], receipts: [], replayFences: [{ runId: key.runId, streamId: key.streamId, throughSeq: 2, checkpoint: 0 }] }
  return { ...f, key, entry, snapshot, mirror: createRemoteOrigins(f.root, hostId, f.filesystem) }
}

test("reordered origin events preserve sender sequence and require the complete snapshot fence", async t => {
  const f = await fixture(t), one = f.entry(1), two = f.entry(2), connectionId = randomUUID()
  await f.mirror.import(f.key, [two])
  await assert.rejects(f.mirror.complete(f.snapshot, connectionId), /MISSING_ORIGIN/)
  await f.mirror.import(f.key, [one])
  await f.mirror.complete(f.snapshot, connectionId)
  assert.deepEqual((await f.mirror.read(f.key, 0, 256)).entries.map(entry => entry.seq), [1, 2])
  assert.equal(await f.mirror.completed(f.snapshot, connectionId), true)
  assert.equal(await f.mirror.completed({ ...f.snapshot, handlerGeneration: randomUUID() }, connectionId), false)
  assert.equal(await f.mirror.completed(f.snapshot, randomUUID()), false)
})

test("duplicate origin transfer is idempotent but cannot change digest or reuse an event ID", async t => {
  const f = await fixture(t), one = f.entry(1)
  await f.mirror.import(f.key, [one]); await f.mirror.import(f.key, [one])
  await f.mirror.verify(f.key, one, one.kind, one.payload)
  const changed = { ...one, payload: { ...(one.payload as object), report: { ...f.input.report, summary: "changed" } } }
  await assert.rejects(f.mirror.import(f.key, [{ ...changed, digest: canonicalDigest({ kind: changed.kind, payload: changed.payload }) }]), /CONFLICT/)
  await assert.rejects(f.mirror.import(f.key, [{ ...one, seq: 2 }]), /CONFLICT/)
  await assert.rejects(f.mirror.verify(f.key, { ...one, digest: "f".repeat(64) }, one.kind, one.payload), /INVALID_ORIGIN/)
})

test("origin acknowledgment holes survive restart and advance only a contiguous prefix", async t => {
  const f = await fixture(t), one = f.entry(1), two = f.entry(2)
  await f.mirror.import(f.key, [one, two]); await f.mirror.acknowledge(f.key, two)
  assert.equal(await f.mirror.watermark(f.key), 0)
  const recovered = createRemoteOrigins(f.root, f.key.hostId, f.filesystem)
  assert.equal(await recovered.acknowledged(f.key, two), true)
  await recovered.acknowledge(f.key, one)
  assert.equal(await recovered.watermark(f.key), 2)
})

test("origin import disk failure cannot yield a durable acknowledgment", async t => {
  const f = await fixture(t), one = f.entry(1)
  f.failAt("file-sync", "origins")
  await assert.rejects(f.mirror.import(f.key, [one]), /ENOSPC/)
  await assert.rejects(f.mirror.acknowledge(f.key, one), /INVALID_ORIGIN|MISSING_ORIGIN/)
  await f.mirror.import(f.key, [one]); await f.mirror.acknowledge(f.key, one)
  assert.equal(await f.mirror.watermark(f.key), 1)
})

test("missing unexpired origin evidence cannot establish a completed fence", async t => {
  const f = await fixture(t), one = f.entry(1), two = f.entry(2), connectionId = randomUUID()
  await f.mirror.import(f.key, [one, two]); await f.mirror.complete(f.snapshot, connectionId)
  await unlink(join(f.root, "bureau/origins", f.key.hostId, f.key.runId, f.key.streamId, "entries/0000000000000001.json"))
  await assert.rejects(f.mirror.complete(f.snapshot, connectionId), /STATE_CHANGED|MISSING_ORIGIN/)
})

test("expired origin cursor replays retained committed evidence before exposing lifecycle fences", async t => {
  const f = await fixture(t), one = f.entry(1), two = f.entry(2), snapshot = { ...f.snapshot, replayFences: [{ ...f.snapshot.replayFences[0]!, checkpoint: 1 }] }
  let retainedReads = 0
  await replayOriginSnapshot({ mirror: f.mirror, snapshot, connectionId: randomUUID(), async read(_key, after, retained) {
    if (!retained) throw Object.assign(new Error("CURSOR_EXPIRED"), { code: "CURSOR_EXPIRED" })
    retainedReads++; assert.equal(after, 0)
    return { entries: [one, two], checkpoint: 1, lastSeq: 2, nextCursor: 2 }
  } })
  assert.equal(retainedReads, 1)
  assert.equal((await f.mirror.read(f.key, 0, 256)).entries.length, 2)
})

test("remote origin import rejects another host or run ownership", async t => {
  const f = await fixture(t), one = f.entry(1)
  await assert.rejects(f.mirror.import({ ...f.key, hostId: "b".repeat(64) }, [one]), /INVALID_ORIGIN/)
  await assert.rejects(f.mirror.import({ ...f.key, runId: randomUUID() }, [one]), /INVALID_ORIGIN/)
})

test("reconnect transfers only events after the durable contiguous acknowledgment", async t => {
  const f = await fixture(t), one = f.entry(1), two = f.entry(2), reads: number[] = []
  await f.mirror.import(f.key, [one]); await f.mirror.acknowledge(f.key, one)
  const recovered = createRemoteOrigins(f.root, f.key.hostId, f.filesystem)
  await replayOriginSnapshot({ mirror: recovered, snapshot: f.snapshot, connectionId: randomUUID(), async read(_key, after) {
    reads.push(after)
    return { entries: [one, two].filter(entry => entry.seq > after), checkpoint: 0, lastSeq: 2, nextCursor: 2 }
  } })
  assert.deepEqual(reads, [1])
  assert.deepEqual((await recovered.read(f.key, 0, 256)).entries.map(entry => entry.seq), [1, 2])
})

test("a committed report after a missing origin prefix cannot be verified for publication", async t => {
  const f = await fixture(t), two = f.entry(2)
  await f.mirror.import(f.key, [two])
  await assert.rejects(f.mirror.verify(f.key, two, two.kind, two.payload), /MISSING_ORIGIN/)
})