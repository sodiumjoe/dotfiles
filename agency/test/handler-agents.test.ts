import assert from "node:assert/strict"
import test from "node:test"
import { lstat, readdir } from "node:fs/promises"
import { agentHandlerFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import { providerStatePath } from "../src/agent/state.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { join } from "node:path"

for (const reservationHang of ["before", "launch", "admission"] as const) test(`reservation timeout kills only its Handler and recovers the same attempt: ${reservationHang}`, { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t, { reservationHang })
  const accepted = await f.start()
  const handler = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  assert.ok(handler.process)
  await f.waitHandlerExit()
  const retained = await f.inventory(), timeout = await f.reservationTimeoutEvidence()
  assert.equal(timeout.signal, "SIGKILL")
  assert.equal(timeout.pid, handler.process.pid)
  assert.equal(retained.agents.length, 1)
  assert.equal(timeout.attempt, retained.agents[0]!.spec.launchAttemptId)
  assert.equal(retained.commands[0]!.commandId, accepted.command.commandId)
  assert.equal(retained.commands[0]!.state, "pending")
  assert.equal(retained.launches.length, reservationHang === "before" ? 0 : 1)
  assert.equal(f.providerCount(), 0)
  await f.restart()
  const recovered = await f.inventory(), listed = await f.list()
  assert.equal(recovered.agents.length, 1)
  assert.equal(recovered.agents[0]!.spec.launchAttemptId, timeout.attempt)
  assert.equal(listed.agents.every(agent => !agent.live && agent.record.phase !== "ready"), true)
  assert.equal(recovered.launches.every(launch => launch.record.phase === "cleanup_verified") || listed.unavailable !== null, true)
  if (reservationHang === "launch") {
    assert.equal(listed.unavailable?.code, "INVALID_AGENT_STATE")
    assert.equal(recovered.commands[0]!.state, "pending")
    await assert.rejects(f.start())
    assert.equal((await f.inventory()).agents.length, 1)
  }
  if (reservationHang === "admission") {
    assert.equal(listed.unavailable, null)
    assert.equal(recovered.launches[0]!.record.phase, "cleanup_verified")
    assert.equal(recovered.commands[0]!.state, "interrupted")
  }
  assert.equal(f.providerCount(), 0)
  await f.verifyZeroSurvivors()
})

for (const startupHang of ["evidence", "publication"] as const) test(`startup envelope kills a Handler stalled in final ${startupHang} and recovers its provider`, { timeout: 75000 }, async t => {
  const f = await agentHandlerFixture(t, { startupHang }), accepted = await f.start()
  const handler = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  assert.ok(handler.process)
  await f.waitHandlerExit(40000)
  const retained = await f.inventory(), timeout = await f.reservationTimeoutEvidence()
  assert.equal(timeout.signal, "SIGKILL")
  assert.equal(timeout.pid, handler.process.pid)
  assert.equal(timeout.attempt, retained.agents[0]!.spec.launchAttemptId)
  assert.equal(retained.commands[0]!.commandId, accepted.command.commandId)
  assert.equal(retained.commands[0]!.state, "pending")
  assert.equal(retained.launches[0]!.record.phase, "active")
  assert.equal(f.providerCount(), 1)
  await f.restart()
  const recovered = await f.inventory(), listed = await f.list()
  assert.equal(recovered.agents.length, 1)
  assert.equal(recovered.agents[0]!.spec.launchAttemptId, timeout.attempt)
  assert.equal(recovered.commands[0]!.state, "interrupted")
  assert.equal(recovered.launches[0]!.record.phase, "cleanup_verified")
  assert.equal(listed.unavailable, null)
  assert.equal(listed.agents[0]!.live, false)
  assert.notEqual(listed.agents[0]!.record.phase, "ready")
  assert.equal(f.providerCount(), 1)
  await f.verifyZeroSurvivors()
})

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

test("private Handler protocol routes one prompt through the ready owned provider", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t), ready = await f.waitCompleted(await f.start())
  assert.equal(ready.command.result!.outcome, "started")
  assert.deepEqual(await f.prompt(ready.command.target!, "challenge"), { state: "prompt", target: ready.command.target, stopReason: "end_turn", text: "answer:challenge" })
  await f.stop(ready.command.target!)
  await f.verifyZeroSurvivors()
})

test("Handler failure during a prompt closes the client and restart verifies provider cleanup", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t, { pauseAt: "prompt" }), ready = await f.waitCompleted(await f.start())
  const pending = f.prompt(ready.command.target!, "challenge")
  void pending.catch(() => undefined)
  await f.waitPrompt()
  await f.crashHandler()
  await assert.rejects(pending)
  await f.restart()
  const listed = await f.list()
  assert.equal(listed.agents[0]!.live, false)
  assert.equal(listed.agents[0]!.cleanup, "verified")
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

test("fatal Handler failure exits naturally with a ready provider and restart reconciles without adoption", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t, { fatalClose: true })
  await until(async () => {
    try { await f.list(); return true }
    catch (error) { if ((error as { code?: string }).code === "NOT_READY") return undefined; throw error }
  }, 15000)
  const ready = await f.waitCompleted(await f.start())
  assert.equal(ready.command.result!.outcome, "started")
  await f.failHandler()
  await f.waitHandlerExit()
  const retained = await f.inventory()
  assert.equal(retained.agents[0]!.phase, "ready")
  assert.equal(retained.launches[0]!.record.phase, "active")
  assert.equal((await lstat(providerStatePath(f.paths.persistentRoot, retained.launches[0]!.record.launchAttemptId))).isDirectory(), true)
  await f.restart()
  const after = await f.list()
  assert.equal(after.agents[0]!.live, false)
  assert.equal(after.agents[0]!.record.phase, "interrupted")
  assert.equal(after.agents[0]!.cleanup, "verified")
  await assert.rejects(lstat(providerStatePath(f.paths.persistentRoot, retained.launches[0]!.record.launchAttemptId)), { code: "ENOENT" })
  assert.deepEqual((await f.command(ready.command.commandId, ready.command.handlerGeneration)).command, ready.command)
  assert.equal(f.providerCount(), 1)
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
    assert.equal((await lstat(providerStatePath(f.paths.persistentRoot, before.launches[0]!.record.launchAttemptId))).isDirectory(), true)
    await assert.rejects(f.start(), { code: "ADMISSION_UNAVAILABLE" })
    assert.equal(f.providerCount(), 0)
  } else {
    assert.ok(after.agents.every(a => ["not_reserved", "verified"].includes(a.cleanup)))
    for (const launch of evidence.launches) if (launch.record.phase === "cleanup_verified") await assert.rejects(lstat(providerStatePath(f.paths.persistentRoot, launch.record.launchAttemptId)), { code: "ENOENT" })
    const replacement = await f.start(); assert.equal((await f.waitCompleted(replacement)).command.result!.outcome, "started")
    await f.stop(replacement.command.target!)
  }
  await f.verifyZeroSurvivors()
})

test("verified cleanup retains receipts but no provider-state root", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t), ready = await f.waitCompleted(await f.start())
  const stopped = await f.stop(ready.command.target!)
  await f.waitCompleted(stopped)
  const attempt = (await f.inventory()).agents[0]!.spec.launchAttemptId
  assert.deepEqual((await readdir(f.paths.persistentRoot + "/agents/provider-state")).sort(), [`.cleanup-${attempt}.complete.json`, `.cleanup-${attempt}.pending.json`])
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