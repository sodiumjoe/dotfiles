import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { Writable } from "node:stream"
import { createSnapshotWatch, writeWatchFrame } from "../src/bureau/watch.js"

test("a watch sends an initial snapshot and consecutive replacements only after change", async () => {
  const controller = new AbortController(), frames: Array<{ kind: string; seq: number; result?: unknown }> = []
  let reads = 0
  const watch = createSnapshotWatch({ read: async () => ({ pending: reads++ < 2 ? ["a"] : ["b"] }), write: async frame => { frames.push(frame) }, signal: controller.signal,
    pause: async () => { if (reads === 3) controller.abort() } })
  await watch.run()
  assert.deepEqual(frames.map(f => [f.kind, f.seq]), [["snapshot", 1], ["snapshot", 2]])
  assert.deepEqual(frames[1]!.result, { pending: ["b"] })
})

test("watch backpressure prevents additional reads while a frame is pending", async () => {
  const controller = new AbortController(), writing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let reads = 0
  const running = createSnapshotWatch({ read: async () => { reads++; return {} }, write: async () => { writing.resolve(); await release.promise; controller.abort() }, signal: controller.signal, pause: async () => {} }).run()
  await writing.promise; assert.equal(reads, 1)
  release.resolve(); await running; assert.equal(reads, 1)
})

test("a disconnected watch withdraws side-effect freshness and reconnects with a full snapshot", async () => {
  const controller = new AbortController(), frames: Array<{ kind: string; seq: number }> = []
  let reads = 0
  await createSnapshotWatch({ read: async () => { if (++reads === 2) throw new Error("HOST_UNAVAILABLE"); return { pending: [] } }, write: async frame => { frames.push(frame) }, signal: controller.signal,
    pause: async () => { if (reads === 3) controller.abort() } }).run()
  assert.deepEqual(frames.map(f => [f.kind, f.seq]), [["snapshot", 1], ["unavailable", 2], ["snapshot", 3]])
})
test("watch output rejects a delayed callback at the deadline and ignores its later success", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let callback: ((error?: Error | null) => void) | undefined
  const output = new Writable({ write(_bytes, _encoding, done) { callback = done } })
  const completion = writeWatchFrame(output, { protocol: "agency-bureau-watch-v1", generation: randomUUID(), seq: 1, kind: "snapshot", result: {} }, new AbortController().signal)
  const failed = assert.rejects(completion, /OUTPUT_TIMEOUT/)
  t.mock.timers.tick(5000); await failed
  callback!(); assert.equal(output.destroyed, true)
})

test("watch output cancellation releases the blocked writer and consumes a late error", async () => {
  let callback: ((error?: Error | null) => void) | undefined
  const output = new Writable({ write(_bytes, _encoding, done) { callback = done } }), controller = new AbortController()
  const completion = writeWatchFrame(output, { protocol: "agency-bureau-watch-v1", generation: randomUUID(), seq: 1, kind: "snapshot", result: {} }, controller.signal)
  const failed = assert.rejects(completion, /CANCELLED/)
  controller.abort(); await failed
  callback!(new Error("late callback")); await new Promise(resolve => setImmediate(resolve))
  assert.equal(output.destroyed, true)
})