import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { MutationQueue, refreshLaunchState, type HandlerMutations } from "../src/handler/mutations.js"
import type { HandlerStatus } from "../src/control/protocol.js"
import { writeLaunchRecord } from "../src/platform/private-state.js"
import { privateRoot, launch } from "./control-support.js"

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

test("unrecognized launch mutations latch admission unavailable without erasing cached status", async t => {
  const root = await privateRoot(t), directory = join(root, "launches")
  await mkdir(directory, { mode: 0o700 })
  const mutations: HandlerMutations = { queue: new MutationQueue(), accepted: [], unavailable: null }
  const state: HandlerStatus = { hostId: "a".repeat(64), handlerGeneration: "generation", phase: "ready", reconciliation: { classified: 0, total: 0, quarantined: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] }
  await refreshLaunchState(state, mutations, directory)
  const record = launch(), path = join(directory, `${record.launchAttemptId}.json`)
  await writeLaunchRecord(path, record)
  await refreshLaunchState(state, mutations, directory)
  assert.notEqual(mutations.unavailable, null)
  assert.equal(state.launches.length, 0)
  mutations.accepted = [{ path, record }]
  await refreshLaunchState(state, mutations, directory)
  assert.notEqual(mutations.unavailable, null)
  assert.equal(state.launches[0]!.launchAttemptId, record.launchAttemptId)
})