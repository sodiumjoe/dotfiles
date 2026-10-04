import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { delay, until } from "./control-support.js"
import { attachmentHandlerFixture } from "./agent-support.js"

test("a lost acceptance response is inspected without dispatching twice", { timeout: 60000 }, async t => {
  const f = await attachmentHandlerFixture(t, { pauseAt: "prompt" })
  const ready = await f.waitCompleted(await f.start()), target = ready.command.target!
  const first = await f.attach(target), submissionId = randomUUID()
  first.send({ op: "submit", submissionId, text: "retained λ" })
  await f.waitPrompt()
  first.close()
  const second = await f.attach(target)
  const inspected = await second.request({ op: "inspect-submission", submissionId })
  assert.ok(inspected.ok && inspected.receipt?.submissionId === submissionId)
  const matched = await second.request({ op: "submit", submissionId, text: "retained λ" })
  assert.ok(matched.ok)
  const conflict = await second.request({ op: "submit", submissionId, text: "different" })
  assert.ok(!conflict.ok && conflict.error.code === "COMMAND_CONFLICT")
  await f.releaseBarrier()
  await second.completed(submissionId)
  assert.equal((await f.providerRequests()).filter(row => row.method === "session/prompt").length, 1)
  second.close()
  await f.stopAndVerify(target)
})

test("stop, restore, and Handler restart reject stale attachment generations", { timeout: 90000 }, async t => {
  const f = await attachmentHandlerFixture(t)
  const target = (await f.waitCompleted(await f.start())).command.target!
  const old = await f.attach(target)
  await assert.rejects(f.attach({ ...target, providerGeneration: randomUUID() }), { code: "STALE_PROVIDER" })
  await f.stopAndVerify(target)
  await until(async () => old.socket.destroyed ? true : undefined)
  const restored = (await f.waitCompleted(await f.restore(target.agentId))).command.target!
  assert.notEqual(restored.providerGeneration, target.providerGeneration)
  await assert.rejects(f.attach(target), { code: "STALE_PROVIDER" })
  const live = await f.attach(restored)
  await f.crashHandler()
  await until(async () => live.socket.destroyed ? true : undefined)
  await f.restart()
  await f.assertProviderAbsent(restored)
  await assert.rejects(f.attach(restored), { code: "STALE_HANDLER" })
  const afterRestart = (await f.waitCompleted(await f.restore(target.agentId))).command.target!
  assert.notEqual(afterRestart.handlerGeneration, restored.handlerGeneration)
  const fresh = await f.attach(afterRestart)
  fresh.close()
  assert.equal((await f.providerRequests()).filter(row => row.method === "session/new").length, 1)
  assert.equal((await f.providerRequests()).filter(row => row.method === "session/prompt").length, 0)
  await f.stopAndVerify(afterRestart)
})

test("a slow observer overflows independently while fresh readers see truncated history", { timeout: 120000 }, async t => {
  const f = await attachmentHandlerFixture(t, { providerScenario: "large-replay" })
  const target = (await f.waitCompleted(await f.start())).command.target!
  const slow = await f.attach(target), fast = await f.attach(target)
  slow.socket.pause()
  for (let i = 0; i < 30; i++) {
    const id = randomUUID()
    const accepted = await fast.request({ op: "submit", submissionId: id, text: `window ${i}` })
    assert.ok(accepted.ok)
    await fast.completed(id)
    await delay(180)
  }
  slow.socket.resume()
  await until(async () => slow.socket.destroyed ? true : undefined)
  assert.ok(slow.frames.filter(frame => frame.type === "event").length < fast.frames.filter(frame => frame.type === "event").length)
  const fault = slow.frames.find(frame => frame.type === "fault")
  if (fault?.type === "fault") assert.equal(fault.error.code, "INCOMPLETE")
  const fresh = await f.attach(target)
  const snapshot = fresh.frames.find(frame => frame.type === "snapshot_begin")!
  assert.equal(snapshot.type, "snapshot_begin")
  if (snapshot.type !== "snapshot_begin") throw new Error("missing snapshot")
  assert.equal(snapshot.historyTruncated, true)
  assert.ok(snapshot.firstSeq > 1)
  const last = fast.frames.filter(frame => frame.type === "event").at(-1)!
  assert.equal(last.type, "event")
  if (last.type !== "event") throw new Error("missing event")
  assert.equal(snapshot.lastSeq, last.event.seq)
  fast.close(); fresh.close()
  assert.equal((await f.current()).agents[0]!.record.phase, "ready")
  assert.equal((await f.providerRequests()).filter(row => row.method === "session/cancel").length, 0)
  await f.stopAndVerify(target)
})