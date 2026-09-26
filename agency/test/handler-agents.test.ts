import assert from "node:assert/strict"
import test from "node:test"
import { agentHandlerFixture } from "./agent-support.js"
import { until } from "./control-support.js"

test("ready agent survives client disconnect and stops with proof", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t), accepted = await f.start()
  const completed = await until(async () => { const value = await f.command(accepted.command.commandId, accepted.command.handlerGeneration); return value.command.state === "completed" ? value : undefined }, 35000)
  assert.equal(completed.command.result!.outcome, "started")
  const target = completed.command.target!
  assert.equal((await f.current()).agent!.record.spec.agentId, target.agentId)
  assert.equal((await f.list()).agents[0]!.live, true)
  assert.deepEqual(await f.retry(accepted.command), completed)
  assert.equal(f.providerCount(), 1)
  const stop = await f.stop(target)
  await until(async () => (await f.command(stop.command.commandId, stop.command.handlerGeneration)).command.state === "completed" ? true : undefined, 15000)
  assert.equal((await f.current()).agent, null)
  assert.deepEqual(await f.retry(accepted.command), completed)
  await f.verifyZeroSurvivors()
})

test("one fixture provider failure leaves the other worktree agent ready", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t), first = await f.start()
  await f.waitCompleted(first)
  const second = await f.startAt(f.git.linked); await f.waitCompleted(second)
  await f.killProvider(first.command.target!)
  await until(async () => (await f.list()).agents.find(a => a.record.spec.agentId === first.command.target!.agentId)?.cleanup === "verified" ? true : undefined, 15000)
  assert.equal((await f.currentAt(f.git.linked)).agent!.live, true)
  assert.equal((await f.command(first.command.commandId, first.command.handlerGeneration)).command.result!.outcome, "started")
  await f.stop(second.command.target!)
  await f.verifyZeroSurvivors()
})

const boundaries = ["intent", "reservation", "attempted", "identity", "session", "ready", "receipt", "stop-intent", "stop-cleanup", "stop-verified", "stop-receipt-before", "stop-receipt-after"] as const
for (const pauseAt of boundaries) test(`Handler crash preserves historical evidence without adoption: ${pauseAt}`, { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t, { pauseAt })
  let operation
  if (pauseAt.startsWith("stop-")) {
    const start = await f.start(), ready = await f.waitCompleted(start)
    operation = f.stop(ready.command.target!)
  } else operation = f.start()
  void operation.catch(() => undefined)
  await f.waitBarrier()
  const before = await f.inventory()
  if (pauseAt === "stop-cleanup") assert.equal(before.launches[0]!.record.phase, "cleanup_pending")
  await f.crashHandler(); await operation.catch(() => undefined)
  await f.restart()
  const after = await f.list(), evidence = await f.inventory()
  assert.ok(after.agents.every(a => !a.live))
  for (const old of before.agents) {
    const current = evidence.agents.find(a => a.spec.agentId === old.spec.agentId)!
    assert.equal(current.phase, ["starting", "ready", "stopping"].includes(old.phase) ? "interrupted" : old.phase)
  }
  for (const old of before.commands) {
    const current = await f.command(old.commandId, old.handlerGeneration)
    assert.equal(current.command.state, old.state === "pending" ? "interrupted" : old.state)
    assert.equal(current.durability, "verified")
    if (old.state === "completed") assert.deepEqual(current.command, old)
  }
  if (pauseAt === "attempted") {
    assert.equal(after.agents[0]!.cleanup, "unknown")
    const blocked = await f.start(); const result = await f.waitCompleted(blocked)
    assert.equal(result.command.result!.outcome, "failed")
    assert.equal(result.command.result!.failure!.code, "CHECKOUT_QUARANTINED")
    assert.equal(f.providerCount(), 0)
  } else {
    assert.ok(after.agents.every(a => ["not_reserved", "verified"].includes(a.cleanup)))
    const replacement = await f.start(); assert.equal((await f.waitCompleted(replacement)).command.result!.outcome, "started")
    await f.stop(replacement.command.target!)
  }
  await f.verifyZeroSurvivors()
})

test("crash after receipt visibility repairs directory-fsync uncertainty without another spawn", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t, { pauseAt: "receipt", failReceiptSync: true }), operation = f.start()
  void operation.catch(() => undefined)
  await f.waitBarrier()
  const before = await f.inventory(), completed = before.commands.find(c => c.op === "start")!
  assert.equal(completed.state, "completed")
  await f.crashHandler(); await operation.catch(() => undefined); await f.restart()
  assert.deepEqual((await f.command(completed.commandId, completed.handlerGeneration)).command, completed)
  assert.equal((await f.list()).agents[0]!.live, false)
  assert.equal(f.providerCount(), 1)
  await f.verifyZeroSurvivors()
})