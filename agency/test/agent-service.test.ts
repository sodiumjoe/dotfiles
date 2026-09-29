import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { promises as filesystem } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { lstat, mkdir, rename, rm, readdir, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { agentGate, agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import { gitFixture } from "./checkout-support.js"
import { createAgentService } from "../src/agent/service.js"
import type { AgentService } from "../src/agent/service.js"
import type { CommandView, StartInput } from "../src/agent/types.js"
import { writeAdmission } from "../src/checkout/records.js"
import { prepareProviderState, providerStatePath } from "../src/agent/state.js"

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

test("restart rejects a state root reappearing after completed removal", async t => {
  const f = await agentServiceFixture(t)
  await f.service.start(f.input)
  const ready = await completed(f.service, f.input)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  const attempt = (await f.store.readAgent(ready.command.target!.agentId))!.spec.launchAttemptId
  const retained = await prepareProviderState(f.root, attempt, f.contract.environment)
  assert.equal(retained.root, providerStatePath(f.root, attempt))
  assert.deepEqual((await f.store.inventory()).issues, [])
  const next = await f.restart()
  assert.equal((await next.list()).unavailable?.code, "CLEANUP_UNVERIFIED")
  assert.equal((await lstat(retained.root)).isDirectory(), true)
})

test("restart removes a retained verified root without removal receipts", async t => {
  const f = await agentServiceFixture(t)
  await f.service.start(f.input)
  const ready = await completed(f.service, f.input)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  const attempt = (await f.store.readAgent(ready.command.target!.agentId))!.spec.launchAttemptId
  const parent = join(f.root, "agents/provider-state")
  await rm(join(parent, `.cleanup-${attempt}.pending.json`))
  await rm(join(parent, `.cleanup-${attempt}.complete.json`))
  const retained = await prepareProviderState(f.root, attempt, f.contract.environment)
  const next = await f.restart()
  assert.equal((await next.list()).unavailable, null)
  await assert.rejects(lstat(retained.root), { code: "ENOENT" })
})

test("restart accepts a completed removal receipt without a state root", async t => {
  const f = await agentServiceFixture(t)
  await f.service.start(f.input)
  const ready = await completed(f.service, f.input)
  const attempt = (await f.store.readAgent(ready.command.target!.agentId))!.spec.launchAttemptId
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  const entries = await readdir(join(f.root, "agents/provider-state"))
  assert.ok(entries.includes(`.cleanup-${attempt}.complete.json`))
  const next = await f.restart()
  assert.equal((await next.list()).unavailable, null)
  assert.equal((await next.list()).agents[0]!.cleanup, "verified")
})

test("restart cannot verify an attempted launch with neither root nor receipt", async t => {
  const f = await agentServiceFixture(t)
  await f.service.start(f.input)
  const ready = await completed(f.service, f.input)
  const attempt = (await f.store.readAgent(ready.command.target!.agentId))!.spec.launchAttemptId
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  const parent = join(f.root, "agents/provider-state")
  await rm(join(parent, `.cleanup-${attempt}.pending.json`))
  await rm(join(parent, `.cleanup-${attempt}.complete.json`))
  const next = await f.restart()
  assert.equal((await next.list()).unavailable?.code, "CLEANUP_UNVERIFIED")
  assert.equal((await next.list()).agents[0]!.cleanup, "unknown")
})

test("restart reports cleanup unknown when removal stopped before parent sync", async t => {
  const f = await agentServiceFixture(t, { failAfterStateRemoval: true })
  await f.service.start(f.input)
  const ready = await completed(f.service, f.input)
  const attempt = (await f.store.readAgent(ready.command.target!.agentId))!.spec.launchAttemptId
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  await until(async () => (await f.service.list()).unavailable?.code === "CLEANUP_UNVERIFIED" ? true : undefined)
  assert.deepEqual(await readdir(join(f.root, "agents/provider-state")), [`.cleanup-${attempt}.pending.json`])
  await assert.rejects(lstat(providerStatePath(f.root, attempt)), { code: "ENOENT" })
  assert.equal((await f.store.readCommand(stop.commandId))!.state, "pending")
  f.context.mutations.unavailable = null
  const next = await f.restart()
  assert.equal((await next.list()).unavailable?.code, "CLEANUP_UNVERIFIED")
  assert.equal((await next.list()).agents[0]!.cleanup, "unknown")
})

for (const defect of ["malformed-completion", "missing-pending", "arbitrary-entry"] as const) test(`restart rejects invalid cleanup evidence: ${defect}`, async t => {
  const f = await agentServiceFixture(t)
  await f.service.start(f.input)
  const ready = await completed(f.service, f.input)
  const attempt = (await f.store.readAgent(ready.command.target!.agentId))!.spec.launchAttemptId
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  const parent = join(f.root, "agents/provider-state")
  if (defect === "malformed-completion") await writeFile(join(parent, `.cleanup-${attempt}.complete.json`), "{}", { mode: 0o600 })
  if (defect === "missing-pending") await rm(join(parent, `.cleanup-${attempt}.pending.json`))
  if (defect === "arbitrary-entry") await writeFile(join(parent, `.cleanup-${attempt}.trash`), "x", { mode: 0o600 })
  const next = await f.restart()
  assert.equal((await next.list()).unavailable?.code, "CLEANUP_UNVERIFIED")
  assert.equal((await next.list()).agents[0]!.cleanup, "unknown")
})

test("restart retains an unknown state root and blocks new agent work", async t => {
  const f = await agentServiceFixture(t)
  await mkdir(join(f.root, "agents"), { mode: 0o700 })
  await mkdir(join(f.root, "agents/provider-state"), { mode: 0o700 })
  const unknown = join(f.root, "agents/provider-state", randomUUID())
  await mkdir(unknown, { mode: 0o700 })
  const next = await f.restart()
  assert.equal((await next.list()).unavailable?.code, "CLEANUP_UNVERIFIED")
  assert.equal((await lstat(unknown)).isDirectory(), true)
})

test("failed state removal leaves stop pending and blocks the current Handler", async t => {
  const f = await agentServiceFixture(t)
  await f.service.start(f.input)
  const ready = await completed(f.service, f.input)
  const attempt = (await f.store.readAgent(ready.command.target!.agentId))!.spec.launchAttemptId
  const state = providerStatePath(f.root, attempt)
  await rename(state, state + "-old"); await mkdir(state, { mode: 0o700 })
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  await until(async () => (await f.service.list()).unavailable?.code === "CLEANUP_UNVERIFIED" ? true : undefined)
  assert.notEqual((await f.service.list()).agents[0]!.cleanup, "verified")
  assert.equal((await f.store.readCommand(stop.commandId))!.state, "pending")
  await assert.rejects(f.service.start({ ...f.input, commandId: randomUUID() }), { code: "ADMISSION_UNAVAILABLE" })
})

test("a concurrent checkout reservation waits for provider-state deletion", async t => {
  const f = await agentServiceFixture(t, { pauseStateRemoval: true })
  await f.service.start(f.input)
  const ready = await completed(f.service, f.input)
  const attempt = (await f.store.readAgent(ready.command.target!.agentId))!.spec.launchAttemptId
  const stopped = await f.service.stop({ ...ready.command.target!, commandId: randomUUID() })
  await until(async () => f.stateRemovalCalls() ? true : undefined)
  const request = f.request()
  let settled = false, mutationEntered = false
  const mutation = f.context.mutations.queue.run(async () => { mutationEntered = true })
  const reservation = f.controller.reserve(request).then(value => { settled = true; return value }, error => { settled = true; throw error })
  void reservation.catch(() => undefined)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(mutationEntered, false)
  assert.equal(settled, false)
  assert.equal(f.context.mutations.accepted.find(entry => entry.record.launchAttemptId === attempt)?.record.phase, "cleanup_verified")
  f.releaseStateRemoval()
  await mutation
  await completed(f.service, stopped.command)
  assert.equal((await reservation).launch.launchAttemptId, request.launchAttemptId)
  assert.equal((await f.controller.cancel(request)).phase, "cleanup_verified")
})

test("state-deletion failure leaves a queued checkout reservation unavailable", async t => {
  const f = await agentServiceFixture(t, { pauseStateRemoval: true, failStateRemoval: true })
  await f.service.start(f.input)
  const ready = await completed(f.service, f.input)
  const stopped = await f.service.stop({ ...ready.command.target!, commandId: randomUUID() })
  await until(async () => f.stateRemovalCalls() ? true : undefined)
  const reservation = f.controller.reserve(f.request())
  f.releaseStateRemoval()
  await assert.rejects(reservation, { code: "ADMISSION_UNAVAILABLE" })
  assert.notEqual(f.context.mutations.unavailable, null)
  assert.equal((await f.store.readCommand(stopped.command.commandId))!.state, "pending")
})

test("recovery with malformed command evidence retains state and reports cleanup unknown", async t => {
  const f = await agentServiceFixture(t)
  await f.service.start(f.input)
  const ready = await completed(f.service, f.input)
  const stopped = await f.service.stop({ ...ready.command.target!, commandId: randomUUID() })
  await completed(f.service, stopped.command)
  const attempt = (await f.store.readAgent(ready.command.target!.agentId))!.spec.launchAttemptId
  const retained = await prepareProviderState(f.root, attempt, f.contract.environment)
  await writeFile(join(f.root, "agents/commands", f.input.commandId + ".json"), "{}", { mode: 0o600 })
  const next = await f.restart(), listed = await next.list()
  assert.notEqual(listed.unavailable, null)
  assert.equal(listed.agents[0]!.cleanup, "unknown")
  assert.equal((await lstat(retained.root)).isDirectory(), true)
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

for (const kind of ["orphan", "malformed"] as const) test(`empty lifecycle permits shutdown despite ${kind} admission metadata`, async t => {
  const f = await agentServiceFixture(t)
  if (kind === "orphan") await writeAdmission(f.root, { version: 1, checkout: f.checkout, agentId: randomUUID(), leaseId: randomUUID(), handlerGeneration: randomUUID(), launchAttemptId: randomUUID() })
  else { await mkdir(join(f.root, "admissions"), { recursive: true, mode: 0o700 }); await writeFile(join(f.root, "admissions", randomUUID() + ".json"), "{", { mode: 0o600 }) }
  assert.notEqual((await f.service.list()).unavailable, null)
  assert.doesNotThrow(() => f.service.assertOrdinaryShutdownSafe())
  await f.service.freezeAndDrain(true)
  await f.context.mutations.queue.run(() => f.service.verifyDischarged())
  assert.equal(f.spawns(), 0)
})

test("corrupt agent metadata cannot grant liveness or prevent independent qualified cleanup", async t => {
  const f = await agentServiceFixture(t), accepted = await f.service.start(f.input)
  await completed(f.service, f.input)
  await writeFile(join(f.root, "agents/records", accepted.command.target!.agentId + ".json"), "{}", { mode: 0o600 })
  const unknown = await f.service.list()
  assert.notEqual(unknown.unavailable, null)
  assert.equal(unknown.agents[0]!.live, false)
  await assert.rejects(f.context.mutations.queue.run(() => f.service.verifyDischarged()))
  await f.cleanupOwned()
  const cleaned = (await f.service.list()).agents[0]!
  assert.equal(cleaned.launch?.phase, "cleanup_verified")
  assert.equal(cleaned.cleanup, "unverified")
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
test("launch evidence is observed before reservation, before spawn and before readiness", async t => {
  const f = await agentServiceFixture(t)
  await f.service.start(f.input)
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "started")
  assert.ok(f.evidenceCalls() >= 3)
  assert.ok(f.publications.indexOf("evidence") < f.publications.indexOf("reservation"))
  assert.equal(f.cleanupCalls(), 0)
})

test("reservation deadline fail-stops without awaiting a never-settling reserve", async t => {
  const f = await agentServiceFixture(t, { neverReserve: true })
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await f.service.start(f.input)
  await f.reservationEntered
  assert.equal(f.reservationCalls(), 1)
  t.mock.timers.tick(4999)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.fatalCalls(), 0)
  t.mock.timers.tick(1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.fatalCalls(), 1)
  assert.equal(f.spawns(), 0)
  assert.notEqual(f.context.mutations.unavailable, null)
  assert.equal((await f.store.readCommand(f.input.commandId))!.state, "pending")
})

test("successful reservation clears its timer before provider startup", async t => {
  const f = await agentServiceFixture(t, { pause: "ready" })
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await f.service.start(f.input); await f.entered
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(5001)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.fatalCalls(), 0)
  t.mock.timers.reset()
  f.release()
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "started")
})

test("initial command deadline never acts as a reservation timeout", async t => {
  const f = await agentServiceFixture(t, { pauseCommand: true })
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let settled = false
  const pending = f.service.start(f.input)
  void pending.then(() => { settled = true }, () => { settled = true })
  await f.commandEntered
  t.mock.timers.tick(5000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, true)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
  assert.equal(f.fatalCalls(), 0)
  assert.equal(f.reservationCalls(), 0)
  f.release(); t.mock.timers.reset()
  await f.context.mutations.queue.run(async () => undefined)
  assert.equal(f.reservationCalls(), 0)
  assert.equal(f.spawns(), 0)
})

test("injected complete evidence launches without catalog configuration or snapshot files", async t => {
  const f = await agentServiceFixture(t, { injectedOnly: true })
  await f.service.start(f.input)
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "started")
  await assert.rejects(lstat(join(f.root, "catalog")), { code: "ENOENT" })
  assert.equal(f.evidenceCalls(), 5)
})

test("a reservation released after its deadline cannot spawn or repeat fail-stop", async t => {
  const f = await agentServiceFixture(t, { pause: "reservation" })
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await f.service.start(f.input); await f.entered
  t.mock.timers.tick(5000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.fatalCalls(), 1)
  f.release(); t.mock.timers.tick(10000)
  await f.context.mutations.queue.run(async () => undefined)
  assert.equal(f.fatalCalls(), 1)
  assert.equal(f.spawns(), 0)
  assert.equal(f.publications.includes("agent:ready"), false)
})

test("late reservation completion cannot beat an overdue timeout callback", async t => {
  let now = performance.now()
  t.mock.method(performance, "now", () => now)
  const f = await agentServiceFixture(t, { pause: "reservation" })
  await f.service.start(f.input); await f.entered
  now += 5001
  f.release()
  await until(async () => f.fatalCalls() || f.spawns() ? true : undefined)
  assert.equal(f.fatalCalls(), 1)
  assert.equal(f.spawns(), 0)
  assert.equal(f.publications.includes("agent:ready"), false)
})

test("ready evidence observation cannot publish after the startup envelope", async t => {
  let now = performance.now()
  t.mock.method(performance, "now", () => now)
  const f = await agentServiceFixture(t, { async observe(count) { if (count === 5) now += 45000 } })
  await f.service.start(f.input)
  await until(async () => (await f.service.list()).unavailable?.code === "CLEANUP_UNVERIFIED" ? true : undefined)
  assert.equal((await f.service.list()).agents[0]!.record.failure?.code, "STARTUP_TIMEOUT")
  assert.equal(f.publications.includes("agent:ready"), false)
  assert.equal((await f.store.readCommand(f.input.commandId))!.state, "pending")
  assert.notEqual((await f.service.list()).agents[0]!.cleanup, "verified")
})

for (const boundary of [4, 5, "publication"] as const) test(`startup watchdog fail-stops stalled readiness ${boundary} without abandoning its queue`, async t => {
  const entered = agentGate(), released = agentGate()
  t.after(() => released.resolve())
  const f = await agentServiceFixture(t, { async observe(count) { if (count === boundary) { entered.resolve(); await released.promise } } })
  if (boundary === "publication") f.holdReady(true)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await f.service.start(f.input)
  await (boundary === "publication" ? f.readyCommitEntered : entered.promise)
  let queueReleased = false
  const following = f.context.mutations.queue.run(async () => { queueReleased = true; return f.context.mutations.unavailable })
  t.mock.timers.tick(30000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.fatalCalls(), 1)
  assert.notEqual(f.context.mutations.unavailable, null)
  assert.equal(queueReleased, false)
  assert.equal((await f.store.readCommand(f.input.commandId))!.state, "pending")
  released.resolve(); f.releaseReadyCommit()
  assert.notEqual(await following, null)
  t.mock.timers.tick(30000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.fatalCalls(), 1)
  assert.equal(f.publications.includes("start:completed"), false)
  assert.equal((await f.service.list()).agents[0]!.live, false)
  assert.notEqual((await f.service.list()).agents[0]!.cleanup, "verified")
})

for (const boundary of ["preparation", "removal"] as const) test(`startup watchdog fail-stops stalled failed-start ${boundary}`, async t => {
  const f = await agentServiceFixture(t, boundary === "preparation" ? { pause: "attempted" } : { pauseStateRemoval: true, async observe(count) { if (count === 5) throw new Error("final evidence failed") } })
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await f.service.start(f.input)
  if (boundary === "preparation") {
    await f.entered
    t.mock.timers.tick(5000)
    await new Promise(resolve => setImmediate(resolve))
  } else while (!f.stateRemovalCalls()) await new Promise(resolve => setImmediate(resolve))
  let queueReleased = false
  const following = f.context.mutations.queue.run(async () => { queueReleased = true; return f.context.mutations.unavailable })
  t.mock.timers.tick(30000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.fatalCalls(), 1)
  assert.notEqual(f.context.mutations.unavailable, null)
  assert.equal(queueReleased, false)
  f.release(); f.releaseStateRemoval()
  assert.notEqual(await following, null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.publications.includes("start:completed"), false)
  assert.notEqual((await f.service.list()).agents[0]!.cleanup, "verified")
})

test("initial receipt completing after its deadline cannot launch before the timer runs", async t => {
  let now = performance.now()
  t.mock.method(performance, "now", () => now)
  const f = await agentServiceFixture(t, { pauseCommand: true })
  const pending = f.service.start(f.input)
  await f.commandEntered
  now += 5000; f.release()
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
  assert.equal(f.reservationCalls(), 0)
  assert.equal(f.spawns(), 0)
  assert.equal(f.fatalCalls(), 0)
})

test("a later explicit stop gets fresh budgets after durable service readiness", async t => {
  let now = performance.now()
  t.mock.method(performance, "now", () => now)
  const f = await agentServiceFixture(t)
  await f.service.start(f.input)
  const ready = await completed(f.service, f.input)
  now += 45001
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  assert.equal((await completed(f.service, stop)).command.result!.outcome, "stopped")
  assert.equal((await f.service.list()).agents[0]!.cleanup, "verified")
})

for (const [boundary, reservations, spawns] of [[1, 0, 0], [3, 1, 0], [5, 1, 1]] as const) for (const artifact of ["configuration", "adapterPackageJson", "codexExecutable", "adapterEntrypoint", "catalog", "profile"] as const) test(`evidence gate ${boundary} rejects replacement of ${artifact}`, async t => {
  const f = await agentServiceFixture(t, { async observe(count) {
    if (count !== boundary) return
    if (artifact === "catalog") { await f.changeCatalog("refresh"); return }
    if (artifact === "profile") { f.profile.enabled = false; return }
    const path = artifact === "configuration" ? f.config : artifact === "adapterPackageJson" ? f.profile.adapterPackageJson : artifact === "codexExecutable" ? f.profile.executable : f.contract.entrypoint
    const bytes = await readFile(path)
    await rename(path, path + ".old")
    await writeFile(path, bytes, { mode: artifact === "codexExecutable" ? 0o700 : 0o600 })
  } })
  await f.service.start(f.input)
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "failed")
  assert.equal(f.reservationCalls(), reservations)
  assert.equal(f.spawns(), spawns)
  assert.equal(f.cleanupCalls(), reservations)
  assert.equal(f.publications.includes("agent:ready"), false)
  assert.equal((await f.service.list()).agents[0]!.cleanup, reservations ? "verified" : "not_reserved")
})

for (const boundary of [1, 3, 5]) test(`evidence gate ${boundary} rejects changed Node executable identity`, async t => {
  let changed = false
  const original = filesystem.lstat
  const mocked = t.mock.method(filesystem, "lstat", async (path: any, options: any) => {
    const metadata = await original(path, options)
    return changed && path === process.execPath ? new Proxy(metadata, { get(target, key, receiver) { return key === "ino" ? BigInt(target.ino) + 1n : Reflect.get(target, key, receiver) } }) : metadata
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  const f = await agentServiceFixture(t, { async observe(count) { if (count === boundary) changed = true } })
  await f.service.start(f.input)
  assert.equal((await completed(f.service, f.input)).command.result!.outcome, "failed")
  assert.equal(f.reservationCalls(), boundary === 1 ? 0 : 1)
  assert.equal(f.spawns(), boundary === 5 ? 1 : 0)
  assert.equal(f.publications.includes("agent:ready"), false)
  assert.equal(f.cleanupCalls(), boundary === 1 ? 0 : 1)
})