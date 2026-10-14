import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { waitForTask } from "../src/tasks/wait.js"
import { TaskError, type TaskObservation } from "../src/tasks/types.js"
import { sampleTaskRecord } from "./task-test-support.js"

const observation = (): TaskObservation => { const record = sampleTaskRecord(); return { ref: record.ref, record, report: null, runtime: "idle", issue: null } }
test("zero wait inspects once, end_turn stays pending, and reports are repeatable", async () => {
  const value = observation(); let reads = 0
  const client = { inspect: async () => { reads++; return value } }
  assert.deepEqual(await waitForTask(client, value.ref, { timeoutMs: 0 }), { state: "pending", observation: value })
  assert.equal(reads, 1)
  value.report = { outcome: "completed", summary: "explicit" }
  const first = await waitForTask(client, value.ref, { timeoutMs: 0 })
  assert.equal(first.state, "reported"); assert.deepEqual(await waitForTask(client, value.ref, { timeoutMs: 0 }), first)
})
test("later report wins, while exact failure and missing task remain distinct", async () => {
  const value = observation(); let reads = 0
  const result = await waitForTask({ inspect: async () => { if (++reads === 2) value.report = { outcome: "blocked", summary: "blocked" }; return value } }, value.ref, { timeoutMs: 1000, intervalMs: 1 })
  assert.equal(result.state, "reported"); assert.equal(reads, 2)
  value.report = null; value.runtime = "failed"
  assert.equal((await waitForTask({ inspect: async () => value }, value.ref, { timeoutMs: 0 })).state, "failed")
  await assert.rejects(waitForTask({ inspect: async () => { throw new TaskError("TASK_NOT_FOUND", value.ref) } }, value.ref, { timeoutMs: 0 }), { code: "TASK_NOT_FOUND" })
})
for (const before of [true, false]) test(`cancel ${before ? "before" : "during"} read aborts locally`, async () => {
  const value = observation(), controller = new AbortController(); let reads = 0, signal: AbortSignal | undefined
  if (before) controller.abort()
  const waiting = waitForTask({ inspect: async (_ref, s) => { reads++; signal = s; return new Promise(() => {}) } }, value.ref, { timeoutMs: 60000, signal: controller.signal })
  controller.abort()
  assert.deepEqual(await waiting, { state: "cancelled", ref: value.ref }); assert.equal(reads, before ? 0 : 1)
  if (signal) assert.equal(signal.aborted, true)
})
test("deadline bounds hanging reads, retains last observation, and disposes polling", async () => {
  const value = observation(); let reads = 0
  const began = performance.now()
  assert.deepEqual(await waitForTask({ inspect: async () => new Promise(() => {}) }, value.ref, { timeoutMs: 30 }), { state: "unavailable", ref: value.ref })
  assert.ok(performance.now() - began < 1000)
  const waiting = waitForTask({ inspect: async () => ++reads === 1 ? value : new Promise(() => {}) }, value.ref, { timeoutMs: 40, intervalMs: 1 })
  assert.deepEqual(await waiting, { state: "pending", observation: value }); assert.equal(reads, 2)
  const controller = new AbortController()
  const sleeping = waitForTask({ inspect: async () => value }, value.ref, { timeoutMs: 60000, signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  assert.equal((await sleeping).state, "cancelled")
})
test("invalid deadlines and references are rejected before reading", async () => {
  for (const timeoutMs of [-1, 60001, 0.5, NaN]) await assert.rejects(waitForTask({ inspect: async () => { throw new Error("read") } }, { hostId: "a".repeat(64), taskId: randomUUID() }, { timeoutMs }), { code: "INVALID_INPUT" })
})