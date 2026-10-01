import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { recoverAgents } from "../src/agent/recovery.js"
import { createAgentStore } from "../src/agent/store.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import type { AgentService } from "../src/agent/service.js"
import type { CommandView, StartRequest } from "../src/agent/types.js"

const completed = (service: AgentService, request: Pick<StartRequest, "commandId" | "handlerGeneration">): Promise<CommandView> => until(async () => {
  const view = await service.command(request.commandId, request.handlerGeneration)
  return view.command.state !== "pending" && view.durability === "verified" ? view : undefined
}, 10000)

test("start persists a version-two definition and digest without environment values", async t => {
  const f = await agentServiceFixture(t)
  const request = { ...f.input, environment: { ...f.input.environment, SECRET_TOKEN: "not-for-state" } }
  const accepted = await f.service.start(request)
  assert.equal(accepted.command.version, 2)
  assert.equal(accepted.command.op, "start")
  assert.equal(JSON.stringify(accepted.command).includes("SECRET_TOKEN"), false)
  assert.equal(JSON.stringify(accepted.command).includes("not-for-state"), false)
  const ready = await completed(f.service, request)
  assert.equal(ready.command.result?.outcome, "started")
  const agent = (await f.service.current(request.cwd)).agents[0]!
  assert.equal(agent.record.version, 2)
  assert.equal(agent.record.definition.cwd, request.cwd)
  assert.equal(agent.record.definition.createdCommandId, request.commandId)
  assert.equal(agent.launch?.version, 2)
  assert.equal(JSON.stringify(agent.record).includes("SECRET_TOKEN"), false)
  await assert.rejects(lstat(join(f.root, "agents/provider-state")), { code: "ENOENT" })
  await f.service.freezeAndDrain(true)
})

test("same command retries compare the environment digest before accepting", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" })
  const accepted = await f.service.start(f.input)
  assert.deepEqual((await f.service.start(f.input)).command.target, accepted.command.target)
  await assert.rejects(f.service.start({ ...f.input, environment: { ...f.input.environment, SECRET_TOKEN: "changed" } }), { code: "COMMAND_CONFLICT" })
  await assert.rejects(f.service.start({ ...f.input, cwd: "/workspace/a-link" }), { code: "COMMAND_CONFLICT" })
  f.release()
  assert.equal((await completed(f.service, f.input)).command.result?.outcome, "started")
  await f.service.freezeAndDrain(true)
})

test("an identical start retries an unpublished command without replacing its agent", async t => {
  const f = await agentServiceFixture(t)
  f.failInitialCommand(true)
  await assert.rejects(f.service.start(f.input), { code: "INCOMPLETE" })
  assert.equal(await f.store.readCommand(f.input.commandId), null)
  await assert.rejects(f.service.start({ ...f.input, environment: { ...f.input.environment, CHANGED: "yes" } }), { code: "COMMAND_CONFLICT" })
  f.failInitialCommand(false)
  const retry = await f.service.start(f.input)
  assert.equal(retry.command.state, "pending")
  assert.equal((await completed(f.service, f.input)).command.result?.outcome, "started")
  assert.equal(f.spawns(), 1)
  assert.equal((await f.service.list()).agents.length, 1)
  await f.service.freezeAndDrain(true)
})

test("restart repairs completed command durability before reporting availability", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  const base = createAgentStore(f.root)
  let rejectSync = true
  const store = { ...base, async writeCommand(value: Parameters<typeof base.writeCommand>[0], expected: Parameters<typeof base.writeCommand>[1]) {
    if (rejectSync && value.state === "completed") throw new Error("receipt durability unavailable")
    await base.writeCommand(value, expected)
  } }
  assert.notEqual((await recoverAgents({ context: f.context, store })).unavailable, null)
  rejectSync = false
  assert.equal((await recoverAgents({ context: f.context, store })).unavailable, null)
})

test("restart repairs terminal agent durability before reporting availability", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  const base = createAgentStore(f.root)
  let rejectSync = true
  const store = { ...base, async writeAgent(value: Parameters<typeof base.writeAgent>[0], expected: Parameters<typeof base.writeAgent>[1]) {
    if (rejectSync && value.phase === "stopped") throw new Error("terminal durability unavailable")
    await base.writeAgent(value, expected)
  } }
  assert.notEqual((await recoverAgents({ context: f.context, store })).unavailable, null)
  rejectSync = false
  assert.equal((await recoverAgents({ context: f.context, store })).unavailable, null)
})

test("twenty independent starts have no admission or capacity limit and current uses exact cwd strings", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" })
  const requests = Array.from({ length: 20 }, (_, index) => ({ ...f.input, commandId: randomUUID(), cwd: index < 3 ? "/workspace/a" : `/workspace/${index}`, environment: { ...f.input.environment, REQUEST_INDEX: String(index) } }))
  const accepted = await Promise.all(requests.map(request => f.service.start(request)))
  assert.equal(accepted.length, 20)
  assert.equal(new Set(accepted.map(view => view.command.target?.agentId)).size, 20)
  assert.equal(f.spawns(), 0)
  const matchingIds = accepted.slice(0, 3).map(view => view.command.target!.agentId).sort()
  const current = await until(async () => { const view = await f.service.current("/workspace/a"); return view.agents.length === 3 ? view : undefined }, 10000)
  assert.deepEqual(current.agents.map(agent => agent.record.definition.agentId).sort(), matchingIds)
  assert.deepEqual((await f.service.current("/workspace/a-link")).agents, [])
  for (const result of accepted) assert.ok(!["INCOMPLETE", "CHECKOUT_BUSY", "CHECKOUT_QUARANTINED", "ADMISSION_UNAVAILABLE"].includes(result.command.result?.failure?.code ?? ""))
  f.release()
  await Promise.all(requests.map(request => completed(f.service, request)))
  await f.service.freezeAndDrain(true)
})

test("stop targets the exact provider generation and removes a live current entry", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const target = ready.command.target!
  await assert.rejects(f.service.stop({ ...target, providerGeneration: randomUUID(), commandId: randomUUID() }), { code: "STALE_PROVIDER" })
  const stop = { ...target, commandId: randomUUID() }
  await f.service.stop(stop)
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  assert.deepEqual((await f.service.current(f.input.cwd)).agents, [])
  assert.equal((await f.service.list()).agents[0]!.cleanup, "verified")
})

test("unqualified start rejects before process ownership", async t => {
  const f = await agentServiceFixture(t, { contract: false })
  await assert.rejects(f.service.start(f.input), { code: "ADAPTER_UNQUALIFIED" })
  assert.equal(f.spawns(), 0)
  assert.deepEqual(f.context.mutations.accepted, [])
})

test("stop racing an unspawned start cannot publish a ready session", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" })
  const accepted = await f.service.start(f.input)
  await f.entered
  const stop = { ...accepted.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  f.release()
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  assert.equal((await completed(f.service, f.input)).command.result?.outcome, "failed")
  assert.equal(f.spawns(), 0)
})

test("startup revalidation rejects changed catalog evidence before spawn", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" })
  await f.service.start(f.input)
  await f.entered
  await f.changeCatalog("refresh")
  f.release()
  assert.equal((await completed(f.service, f.input)).command.result?.outcome, "failed")
  assert.equal(f.spawns(), 0)
})

test("uncertain completed receipt is repaired without repeating a provider launch", async t => {
  const f = await agentServiceFixture(t)
  f.failReceipt(true)
  await f.service.start(f.input)
  await until(async () => (await f.store.readCommand(f.input.commandId))?.state === "completed" ? true : undefined)
  assert.equal((await f.service.command(f.input.commandId, f.input.handlerGeneration)).durability, "unverified")
  f.failReceipt(false)
  assert.equal((await completed(f.service, f.input)).command.result?.outcome, "started")
  assert.equal(f.spawns(), 1)
  await f.service.freezeAndDrain(true)
})

test("failed initial agent publication repairs the retained command target", async t => {
  const f = await agentServiceFixture(t)
  f.failInitialAgent(true)
  await assert.rejects(f.service.start(f.input), { code: "INCOMPLETE" })
  const intent = await f.store.readCommand(f.input.commandId)
  assert.ok(intent?.target)
  assert.equal(f.spawns(), 0)
  f.failInitialAgent(false)
  const retry = await f.service.start(f.input)
  assert.deepEqual(retry.command.target, intent.target)
  assert.equal((await completed(f.service, f.input)).command.result?.outcome, "started")
  assert.equal(f.spawns(), 1)
  await f.service.freezeAndDrain(true)
})

test("uncertain ready publication is repaired by its live owner without another spawn", async t => {
  const f = await agentServiceFixture(t)
  f.failReady(true)
  await f.service.start(f.input)
  await until(async () => f.readyFailures() ? true : undefined)
  f.failReady(false)
  assert.equal((await completed(f.service, f.input)).command.result?.outcome, "started")
  assert.equal(f.spawns(), 1)
  await f.service.freezeAndDrain(true)
})

test("stop aborts an active prompt before verifying process cleanup", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const pending = f.service.prompt({ ...ready.command.target!, text: "challenge" })
  void pending.catch(() => undefined)
  await f.promptEntered
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  await assert.rejects(pending, { code: "STARTUP_FAILED" })
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  assert.equal((await f.service.list()).agents[0]!.cleanup, "verified")
})

test("restart interrupts a pending start without replaying its transient environment", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" })
  await f.service.start(f.input)
  await f.entered
  const next = await f.restart()
  assert.equal((await next.command(f.input.commandId, f.input.handlerGeneration)).command.state, "interrupted")
  assert.equal((await next.list()).agents[0]!.record.phase, "interrupted")
  assert.equal(f.spawns(), 0)
})