import assert from "node:assert/strict"
import test from "node:test"
import { MutationQueue } from "../src/handler/mutations.js"

test("failed mutations do not poison the queue or overlap later operations", async () => {
  const queue = new MutationQueue(), order: number[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = queue.run(async () => { order.push(1); await gate; throw new Error("failure") })
  const failed = assert.rejects(first, /failure/)
  const second = queue.run(async () => { order.push(2); return 7 })
  await Promise.resolve()
  assert.deepEqual(order, [1])
  release()
  await failed
  assert.equal(await second, 7)
  assert.deepEqual(order, [1, 2])
})