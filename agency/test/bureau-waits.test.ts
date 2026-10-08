import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { notificationsFixture } from "./bureau-notifications-support.js"
import { until } from "./control-support.js"

test("a report before wait registration yields a durable result and no pending notification", async t => {
  const f = await notificationsFixture(t)
  await f.report()
  const result = await f.core.wait({ ...f.waitInput, timeoutMs: 0 })
  assert.equal(result.kind, "reports")
  assert.equal(result.reports.length, 1)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).pending.length, 0)
  await f.restart()
  assert.deepEqual(await f.core.wait({ ...f.waitInput, timeoutMs: 0 }), result)
  assert.equal(f.host.promptCount, 1)
})

test("a live waiter receives a report only after its saved route and result exist", async t => {
  const f = await notificationsFixture(t), waiting = f.core.wait(f.waitInput)
  await until(async () => await f.core.waitRecord(f.waitInput.waitId) ?? undefined)
  await f.report()
  const result = await waiting, saved = await f.core.waitRecord(f.waitInput.waitId)
  assert.equal(result.kind, "reports")
  assert.deepEqual(saved!.result, result)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).pending.length, 0)
})

test("transport loss retains the result route for exact wait replay", async t => {
  const f = await notificationsFixture(t), controller = new AbortController(), waiting = f.core.wait(f.waitInput, controller.signal)
  void waiting.catch(() => undefined)
  await until(async () => await f.core.waitRecord(f.waitInput.waitId) ?? undefined)
  controller.abort()
  await assert.rejects(waiting, /ABORTED/)
  await f.report()
  await until(async () => (await f.core.waitRecord(f.waitInput.waitId))?.result ?? undefined)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).pending.length, 0)
  await f.restart()
  assert.equal((await f.core.wait(f.waitInput)).kind, "reports")
})

test("same-ID timeout replay does not consume reports that arrived afterward", async t => {
  const f = await notificationsFixture(t), input = { ...f.waitInput, timeoutMs: 0 }
  const timedOut = await f.core.wait(input)
  assert.equal(timedOut.kind, "timeout")
  await f.report()
  assert.deepEqual(await f.core.wait(input), timedOut)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).pending.length, 1)
  assert.equal((await f.core.wait({ ...input, waitId: randomUUID() })).kind, "reports")
})

test("overlapping waits can read the report with only one delivery claim", async t => {
  const f = await notificationsFixture(t), first = f.core.wait(f.waitInput), secondInput = { ...f.waitInput, waitId: randomUUID() }, second = f.core.wait(secondInput)
  await until(async () => await f.core.waitRecord(secondInput.waitId) ?? undefined)
  await f.report()
  assert.equal((await first).kind, "reports")
  assert.equal((await second).kind, "reports")
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).deliveries.length, 1)
})

test("explicit wait cancellation releases its route without stopping descendants", async t => {
  const f = await notificationsFixture(t)
  await f.report()
  await f.core.wait(f.waitInput)
  await f.core.cancelWait(f.waitInput.waitId)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).pending.length, 1)
  assert.equal(f.host.stopCalls, 0)
})

test("recovery after a durable claim retains one result without another delivery", async t => {
  const f = await notificationsFixture(t), write = f.store.writeDelivery
  await f.report()
  let failure = true
  f.store.writeDelivery = async (delivery, previous) => { await write(delivery, previous); if (failure && delivery.state === "claimed") { failure = false; throw new Error("crash after claim") } }
  await assert.rejects(f.core.wait(f.waitInput), /crash after claim/)
  await f.restart()
  const result = await f.core.wait(f.waitInput), inbox = await f.core.inbox(f.parent, f.input.runId)
  assert.equal(result.kind, "reports")
  assert.equal(inbox.deliveries.length, 1)
  assert.equal(inbox.pending.length, 0)
  assert.equal(f.host.promptCount, 1)
})

test("a durable result whose snapshot publication failed replays after restart", async t => {
  const f = await notificationsFixture(t), write = f.store.writeWait
  await f.report()
  let failure = true
  f.store.writeWait = async (wait, previous) => { if (failure && wait.result) { failure = false; throw new Error("crash before result snapshot") }; await write(wait, previous) }
  await assert.rejects(f.core.wait(f.waitInput), /crash before result snapshot/)
  await f.restart()
  assert.equal((await f.core.wait(f.waitInput)).kind, "reports")
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).deliveries.length, 1)
})

test("exact parent retirement ends the route and releases saved report claims", async t => {
  const f = await notificationsFixture(t)
  await f.report(); await f.core.wait(f.waitInput)
  f.host.retire(); await f.core.reconcile()
  assert.equal((await f.core.waitRecord(f.waitInput.waitId))!.ended, true)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).pending.length, 1)
  assert.equal(f.host.promptCount, 1)
})

test("a stopped worker with no report produces a durable terminal failure result", async t => {
  const f = await notificationsFixture(t), waiting = f.core.wait(f.waitInput)
  await until(async () => await f.core.waitRecord(f.waitInput.waitId) ?? undefined)
  f.host.agents.get(f.child.agent.agentId)!.phase = "stopped"
  await f.core.reconcile()
  const result = await waiting
  assert.equal(result.kind, "terminal_failure")
  assert.equal(result.failures[0]!.state, "interrupted")
  await f.restart()
  assert.deepEqual(await f.core.wait(f.waitInput), result)
})

test("wait identity rejects changed input and unrelated parent authority", async t => {
  const f = await notificationsFixture(t)
  await f.core.wait({ ...f.waitInput, timeoutMs: 0 })
  await assert.rejects(f.core.wait({ ...f.waitInput, after: 1, timeoutMs: 0 }), /COMMAND_CONFLICT/)
  await assert.rejects(f.core.wait({ ...f.waitInput, waitId: randomUUID(), parent: f.host.addRoot(true), timeoutMs: 0 }), /INVALID_PARENT/)
})

test("an ancestor reads descendant evidence without claiming another parent's inbox", async t => {
  const f = await notificationsFixture(t), grandchild = await f.delegate(randomUUID(), { ...f.input.assignment, parent: f.child.agent })
  await f.report(grandchild)
  const result = await f.core.wait({ ...f.waitInput, assignmentIds: [grandchild.assignmentId], timeoutMs: 0 })
  assert.equal(result.kind, "reports")
  assert.equal((await f.core.inbox(f.child.agent, f.input.runId)).pending.length, 1)
})

test("disabled notification pumps do not poison write availability", async t => {
  const f = await notificationsFixture(t)
  const waiting = f.core.wait({ ...f.waitInput, timeoutMs: 2000 })
  void waiting.catch(() => undefined)
  await until(async () => await f.core.waitRecord(f.waitInput.waitId) ?? undefined)
  await f.core.disable()
  await new Promise(resolve => setTimeout(resolve, 2100))
  assert.equal((await f.core.status()).writeAvailable, true)
})

test("a live deadline resolves without a report or model polling", async t => {
  const f = await notificationsFixture(t), result = await f.core.wait({ ...f.waitInput, timeoutMs: 20 })
  assert.equal(result.kind, "timeout")
  assert.equal(f.host.promptCount, 1)
})

test("a wait batches saved reports and preserves its exact cursor", async t => {
  const f = await notificationsFixture(t), second = await f.delegate()
  await f.report(); await f.report(second)
  const result = await f.core.wait({ ...f.waitInput, assignmentIds: [f.child.assignmentId, second.assignmentId] })
  assert.equal(result.reports.length, 2)
  assert.equal(result.cursor, result.reports[1]!.source.seq)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).pending.length, 0)
})

test("run closure refuses pending inbox entries and live wait routes", async t => {
  const f = await notificationsFixture(t)
  await f.report()
  await assert.rejects(f.core.closeRun(randomUUID(), f.input.runId), /UNRESOLVED/)
  await f.core.wait(f.waitInput)
  await assert.rejects(f.core.closeRun(randomUUID(), f.input.runId), /UNRESOLVED/)
})

test("a changed run epoch ends its saved wait route", async t => {
  const f = await notificationsFixture(t)
  await f.report(); await f.core.wait(f.waitInput)
  const run = (await f.store.readRun(f.input.runId))!
  await f.store.writeRun({ ...run, bindingEpoch: randomUUID() }, run)
  await f.core.reconcile()
  assert.equal((await f.core.waitRecord(f.waitInput.waitId))!.ended, true)
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).pending.length, 1)
})