import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import { gitFixture } from "./checkout-support.js"
import { createAgentService } from "../src/agent/service.js"
import type { AgentService } from "../src/agent/service.js"
import type { CommandView, StartInput } from "../src/agent/types.js"

const completed = (service: AgentService, input: Pick<StartInput, "commandId" | "handlerGeneration">): Promise<CommandView> => until(async () => {
  const view = await service.command(input.commandId, input.handlerGeneration)
  return view.command.state !== "pending" && view.durability === "verified" ? view : undefined
}, 10000)

test("concurrent same-ID starts share one immutable attempt and historical receipt", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" })
  const [a, b] = await Promise.all([f.service.start(f.input), f.service.start(f.input)])
  assert.deepEqual(a.command.target, b.command.target)
  await f.entered; f.release()
  const ready = await completed(f.service, f.input)
  assert.equal(ready.command.result!.outcome, "started"); assert.equal(f.spawns(), 1)
  assert.equal((await f.service.current(f.input.cwd)).agent!.live, true)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); assert.equal((await completed(f.service, stop)).command.result!.outcome, "stopped")
  assert.deepEqual(await f.service.start(f.input), ready)
  assert.equal((await f.service.current(f.input.cwd)).agent, null)
  assert.equal((await f.service.list()).agents[0]!.live, false)
  assert.equal(f.refreshes(), 0)
})

test("same-ID changed selection or cwd conflicts without replacing the tuple", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" }), accepted = await f.service.start(f.input)
  await assert.rejects(f.service.start({ ...f.input, selection: { ...f.input.selection, modelId: "other" } }), { code: "COMMAND_CONFLICT" })
  await assert.rejects(f.service.start({ ...f.input, cwd: f.git.alias }), { code: "COMMAND_CONFLICT" })
  f.release(); await completed(f.service, f.input)
  assert.deepEqual((await f.service.command(f.input.commandId, f.input.handlerGeneration)).command.target, accepted.command.target)
  await f.service.freezeAndDrain(true)
})

for (const pause of ["reservation", "spawn", "ready"] as const) test(`stop racing ${pause} cannot publish readiness or duplicate cleanup`, async t => {
  const f = await agentServiceFixture(t, { pause }), start = await f.service.start(f.input)
  await f.entered
  const stop = { ...start.command.target!, commandId: randomUUID() }
  const accepted = await f.service.stop(stop)
  assert.equal(accepted.command.op, "stop")
  f.release()
  assert.equal((await completed(f.service, stop)).command.result!.outcome, "stopped")
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "failed")
  assert.equal((await f.service.list()).agents[0]!.live, false)
  assert.equal(f.spawns(), pause === "ready" ? 1 : 0)
})

test("stop queued during attempted publication drains without deadlock or late readiness", async t => {
  const f = await agentServiceFixture(t, { pause: "attempted" }), start = await f.service.start(f.input)
  await f.entered
  const stop = { ...start.command.target!, commandId: randomUUID() }, stopping = f.service.stop(stop)
  f.release(); await stopping
  assert.equal((await completed(f.service, stop)).command.result!.outcome, "stopped")
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "failed")
  assert.equal((await f.service.list()).agents[0]!.cleanup, "verified")
  assert.equal(f.spawns(), 1)
})

test("unqualified production rejects before catalog reads or reservation", async t => {
  const f = await agentServiceFixture(t, { contract: false })
  await assert.rejects(f.service.start(f.input), { code: "ADAPTER_UNQUALIFIED" })
  assert.equal(f.catalogReads(), 0); assert.equal(f.spawns(), 0)
  assert.equal(f.context.mutations.accepted.length, 0)
})

test("uncertain receipt fsync is repaired without repeating process or session work", async t => {
  const f = await agentServiceFixture(t)
  f.failReceipt(true)
  await f.service.start(f.input)
  await until(async () => (await f.store.readCommand(f.input.commandId))!.state === "completed" ? true : undefined)
  assert.equal((await f.service.command(f.input.commandId, f.input.handlerGeneration)).durability, "unverified")
  f.failReceipt(false)
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "started")
  assert.equal(f.spawns(), 1)
  await f.service.freezeAndDrain(true)
})

test("accepted command with failed initial agent publication retains IDs for repair", async t => {
  const f = await agentServiceFixture(t)
  f.failInitialAgent(true)
  await assert.rejects(f.service.start(f.input), { code: "INCOMPLETE" })
  const intent = await f.store.readCommand(f.input.commandId)
  assert.ok(intent?.target); assert.equal(f.spawns(), 0)
  f.failInitialAgent(false)
  const retry = await f.service.start(f.input)
  assert.deepEqual(retry.command.target, intent.target)
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "started")
  assert.equal(f.spawns(), 1); await f.service.freezeAndDrain(true)
})

test("uncertain ready publication racing stop never resurrects the session", async t => {
  const f = await agentServiceFixture(t)
  f.failReady(true)
  const accepted = await f.service.start(f.input)
  await until(async () => f.readyFailures() ? true : undefined)
  const stop = { ...accepted.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  f.failReady(false)
  assert.equal((await completed(f.service, stop)).command.result!.outcome, "stopped")
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "failed")
  const view = (await f.service.list()).agents[0]!
  assert.notEqual(view.record.phase, "ready"); assert.equal(view.live, false); assert.equal(view.cleanup, "verified")
})

test("uncertain ready publication can be repaired by its live owner without spawn", async t => {
  const f = await agentServiceFixture(t)
  f.failReady(true); await f.service.start(f.input)
  await until(async () => f.readyFailures() ? true : undefined)
  f.failReady(false)
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "started")
  assert.equal(f.spawns(), 1); await f.service.freezeAndDrain(true)
})

test("configuration drift while ready durability is uncertain fails and cleans the accepted start", async t => {
  const f = await agentServiceFixture(t)
  f.failReady(true); await f.service.start(f.input)
  await until(async () => f.readyFailures() ? true : undefined)
  await writeFile(f.config, '{"changed":true}')
  f.failReady(false)
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "failed")
  assert.equal((await f.service.list()).agents[0]!.cleanup, "verified")
  assert.equal(f.spawns(), 1)
})

test("provider fault before ready fsync finishes wins over historical startup success", async t => {
  const f = await agentServiceFixture(t)
  f.holdReady(true)
  const accepted = await f.service.start(f.input)
  await f.readyCommitEntered
  f.fault(accepted.command.target!.agentId)
  await new Promise(resolve => setImmediate(resolve))
  f.releaseReadyCommit()
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "failed")
  assert.equal((await f.service.list()).agents[0]!.cleanup, "verified")
})

for (const kind of ["stale", "rollback", "missing"] as const) test(`catalog ${kind} evidence cannot launch or initiate discovery`, async t => {
  const f = await agentServiceFixture(t)
  await f.changeCatalog(kind)
  await assert.rejects(f.service.start(f.input), { code: "MODEL_UNAVAILABLE" })
  assert.equal(f.spawns(), 0); assert.equal(f.refreshes(), 0)
})

for (const kind of ["configuration", "checkout", "catalog"] as const) test(`startup revalidation rejects changed ${kind} evidence`, async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" })
  await f.service.start(f.input); await f.entered
  if (kind === "configuration") await writeFile(f.config, '{"changed":true}')
  if (kind === "checkout") await rename(f.git.repo, join(f.git.root, "moved"))
  if (kind === "catalog") await f.changeCatalog("refresh")
  f.release()
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "failed")
  assert.equal(f.spawns(), 0)
})

test("independent worktrees remain usable after one provider faults", async t => {
  const f = await agentServiceFixture(t)
  const first = await f.service.start(f.input), secondInput = { ...f.input, cwd: f.git.linked, commandId: randomUUID() }
  await f.service.start(secondInput)
  await completed(f.service, f.input); await completed(f.service, secondInput)
  f.fault(first.command.target!.agentId)
  await until(async () => (await f.service.list()).agents.find(a => a.record.spec.agentId === first.command.target!.agentId)?.cleanup === "verified" ? true : undefined)
  assert.equal((await f.service.current(secondInput.cwd)).agent!.live, true)
  assert.equal((await f.service.command(f.input.commandId, f.input.handlerGeneration)).command.result!.outcome, "started")
  await f.service.freezeAndDrain(true)
})

test("two starts in one checkout cannot acquire two live owners", async t => {
  const f = await agentServiceFixture(t), other = { ...f.input, commandId: randomUUID() }
  await Promise.all([f.service.start(f.input), f.service.start(other)])
  const results = await Promise.all([completed(f.service, f.input), completed(f.service, other)])
  assert.deepEqual(results.map(r => r.command.result!.outcome).sort(), ["failed", "started"])
  assert.equal(f.spawns(), 1); await f.service.freezeAndDrain(true)
})

test("four pending startup slots are bounded before durable acceptance", async t => {
  const f = await agentServiceFixture(t, { pause: "reservation" })
  await Promise.all(Array.from({ length: 4 }, (_, i) => f.service.start({ ...f.input, commandId: randomUUID(), cwd: i % 2 ? f.git.linked : f.git.repo })))
  await assert.rejects(f.service.start(f.input), { code: "INCOMPLETE" })
  assert.equal(await f.store.readCommand(f.input.commandId), null)
  f.release(); await f.service.freezeAndDrain(true)
})

test("ordinary shutdown refusal does not cancel accepted startup", async t => {
  const f = await agentServiceFixture(t, { pause: "ready" })
  await f.service.start(f.input); await f.entered
  assert.throws(() => f.service.assertOrdinaryShutdownSafe(), { code: "ACTIVE_AGENTS" })
  f.release(); assert.equal((await completed(f.service, f.input)).command.result!.outcome, "started")
  await f.service.freezeAndDrain(true); f.service.assertOrdinaryShutdownSafe()
})

test("restart repairs completed receipt durability without adopting or replaying a provider", async t => {
  const f = await agentServiceFixture(t)
  f.failReceipt(true); await f.service.start(f.input)
  await until(async () => (await f.store.readCommand(f.input.commandId))!.state === "completed" ? true : undefined)
  f.failReceipt(false)
  const next = await f.restart(), historical = await next.command(f.input.commandId, f.input.handlerGeneration)
  assert.equal(historical.command.result!.outcome, "started"); assert.equal(historical.durability, "verified")
  assert.equal((await next.list()).agents[0]!.record.phase, "interrupted")
  assert.equal((await next.list()).agents[0]!.live, false)
  assert.equal(f.spawns(), 1)
})

test("restart interrupts an accepted pending start without replay", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" })
  await f.service.start(f.input); await f.entered
  const next = await f.restart()
  assert.equal((await next.command(f.input.commandId, f.input.handlerGeneration)).command.state, "interrupted")
  assert.equal((await next.list()).agents[0]!.record.phase, "interrupted")
  assert.equal((await next.list()).agents[0]!.cleanup, "verified")
  assert.equal(f.spawns(), 0)
})

test("restart interrupts a pending stop independently of verified platform cleanup", async t => {
  const f = await agentServiceFixture(t)
  await f.service.start(f.input); const ready = await completed(f.service, f.input)
  const stop = { ...ready.command.target!, commandId: randomUUID() }, record = (await f.service.list()).agents[0]!.record
  await f.context.mutations.queue.run(async () => {
    await f.store.writeCommand({ version: 1, hostId: record.spec.hostId, op: "stop", commandId: stop.commandId, handlerGeneration: stop.handlerGeneration, input: stop, target: ready.command.target, state: "pending", result: null }, null)
    await f.store.writeAgent({ ...record, phase: "stopping" }, record)
  })
  const next = await f.restart()
  assert.equal((await next.command(stop.commandId, stop.handlerGeneration)).command.state, "interrupted")
  const view = (await next.list()).agents[0]!
  assert.equal(view.record.phase, "interrupted"); assert.equal(view.cleanup, "verified"); assert.equal(view.live, false)
})

test("command-only pre-spawn crash is interrupted after complete inventory", async t => {
  const f = await agentServiceFixture(t)
  f.failInitialAgent(true)
  await assert.rejects(f.service.start(f.input), { code: "INCOMPLETE" })
  const next = await f.restart()
  assert.equal((await next.command(f.input.commandId, f.input.handlerGeneration)).command.state, "interrupted")
  assert.equal((await next.list()).agents.length, 0); assert.equal(f.spawns(), 0)
})

test("stop terminal fsync must be repaired before a completed receipt is verified", async t => {
  const f = await agentServiceFixture(t)
  await f.service.start(f.input); const ready = await completed(f.service, f.input)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  f.failTerminal(true); await f.service.stop(stop)
  await until(async () => f.terminalFailures() ? true : undefined)
  await f.service.stop(stop)
  await until(async () => f.terminalFailures() > 1 || (await f.service.command(stop.commandId, stop.handlerGeneration)).command.state === "completed" ? true : undefined)
  assert.equal((await f.service.command(stop.commandId, stop.handlerGeneration)).command.state, "pending")
  f.failTerminal(false)
  assert.equal((await completed(f.service, stop)).command.result!.outcome, "stopped")
  assert.equal(f.spawns(), 1)
})

test("legacy reservations remain checkout blockers without fabricated agents", async t => {
  const f = await agentServiceFixture(t), reservation = f.request()
  await f.controller.reserve(reservation)
  const current = await f.service.current(f.input.cwd)
  assert.equal(current.agent, null); assert.deepEqual(current.blockers, [reservation.launchAttemptId])
  await f.service.start(f.input)
  assert.equal((await completed(f.service, f.input)).command.result!.failure!.code, "CHECKOUT_BUSY")
  assert.equal(f.spawns(), 0); await f.controller.cancel(reservation)
})

test("corrupt agent metadata cannot grant liveness or prevent independent qualified cleanup", async t => {
  const f = await agentServiceFixture(t), accepted = await f.service.start(f.input)
  await completed(f.service, f.input)
  await writeFile(join(f.root, "agents/records", accepted.command.target!.agentId + ".json"), "{}", { mode: 0o600 })
  const unknown = await f.service.list()
  assert.notEqual(unknown.unavailable, null)
  assert.equal(unknown.agents[0]!.live, false)
  await f.cleanupOwned()
  assert.equal((await f.service.list()).agents[0]!.cleanup, "verified")
})

test("sixteen ready agents exhaust lifecycle capacity without publishing a seventeenth intent", async t => {
  const f = await agentServiceFixture(t), paths = [f.git.repo, f.git.linked]
  for (let i = 0; i < 7; i++) { const git = await gitFixture(t); paths.push(git.repo, git.linked) }
  for (const cwd of paths) {
    const request = { ...f.input, cwd, commandId: randomUUID() }
    await f.service.start(request); assert.equal((await completed(f.service, request)).command.result!.outcome, "started")
  }
  await assert.rejects(f.service.start(f.input), { code: "INCOMPLETE" })
  assert.equal(await f.store.readCommand(f.input.commandId), null)
  assert.equal(f.spawns(), 16)
  await f.service.freezeAndDrain(true)
})

test("ordinary shutdown remains blocked by a recovered interrupted unverified launch", async t => {
  const f = await agentServiceFixture(t), accepted = await f.service.start(f.input)
  await completed(f.service, f.input)
  f.service.close()
  const next = createAgentService({ context: f.context, store: f.store, admission: f.controller, contracts: [], catalog: { initialize: async () => undefined, startScheduling() {}, list: async () => { throw new Error() }, launchEvidence: async () => { throw new Error() }, refresh: async () => { throw new Error() }, freezeAndDrain: async () => undefined, verifyDischarged: async () => undefined, resume() {}, close() {} } })
  await next.initialize()
  assert.equal((await next.list()).agents[0]!.record.phase, "interrupted")
  assert.throws(() => next.assertOrdinaryShutdownSafe(), { code: "ACTIVE_AGENTS" })
  assert.equal((await next.command(f.input.commandId, f.input.handlerGeneration)).command.target!.agentId, accepted.command.target!.agentId)
  await f.cleanupOwned()
})

for (const missing of ["agent", "command", "admission", "launch"] as const) test(`missing ${missing} evidence latches lifecycle unavailable without inventing cleanup`, async t => {
  const f = await agentServiceFixture(t), accepted = await f.service.start(f.input)
  await completed(f.service, f.input)
  const record = (await f.service.list()).agents[0]!.record
  const path = missing === "agent" ? join(f.root, "agents/records", accepted.command.target!.agentId + ".json") : missing === "command" ? join(f.root, "agents/commands", f.input.commandId + ".json") : join(f.root, missing === "launch" ? "launches" : "admissions", record.spec.launchAttemptId + ".json")
  await rm(path)
  assert.notEqual((await f.service.list()).unavailable, null)
  await assert.rejects(f.service.start({ ...f.input, commandId: randomUUID() }))
})