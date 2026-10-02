import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { lstat, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentTuple, recoverAgents } from "../src/agent/recovery.js"
import { createAgentStore } from "../src/agent/store.js"
import { AGENT_PROTOCOL, parseAgentReply } from "../src/agent/protocol.js"
import { projectRestoreInput } from "../src/agent/types.js"
import { writeLaunchRecord } from "../src/platform/private-state.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import type { AgentService } from "../src/agent/service.js"
import type { CommandView, StartRequest } from "../src/agent/types.js"

const completed = (service: AgentService, request: Pick<StartRequest, "commandId" | "handlerGeneration">): Promise<CommandView> => until(async () => {
  const view = await service.command(request.commandId, request.handlerGeneration)
  return view.command.state !== "pending" && view.durability === "verified" ? view : undefined
}, 10000)

for (const crashed of [false, true]) test(`restore retains identity and rotates launch after ${crashed ? "crash" : "stop"}`, async t => {
  const f = await agentServiceFixture(t)
  const started = await completed(f.service, (await f.service.start(f.input)).command)
  const before = (await f.service.list()).agents[0]!.record
  assert.equal(before.version, 2)
  if (before.version !== 2) throw new Error()
  let service = f.service
  if (crashed) service = await f.restart()
  else {
    const stop = { ...started.command.target!, commandId: randomUUID() }
    await service.stop(stop); await completed(service, stop)
  }
  const recovered = (await service.list()).agents[0]!.record
  assert.equal(recovered.phase, crashed ? "recoverable" : "stopped")
  assert.doesNotThrow(() => service.assertOrdinaryShutdownSafe())
  const restoringEnvironment = { PATH: "/restoring/bin", SECRET: "new-secret" }
  const request = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, agentId: before.definition.agentId, environment: restoringEnvironment }
  await service.restore(request)
  const done = await completed(service, request)
  assert.equal(done.command.result?.outcome, "restored")
  const restored = (await service.list()).agents[0]!.record
  if (restored.version !== 2) throw new Error()
  assert.deepEqual(restored.definition, before.definition)
  assert.equal(restored.session!.sessionId, before.session!.sessionId)
  assert.notEqual(restored.session!.sessionGeneration, before.session!.sessionGeneration)
  assert.notEqual(restored.launch.providerGeneration, before.launch.providerGeneration)
  assert.notEqual(restored.launch.launchAttemptId, before.launch.launchAttemptId)
  assert.notEqual(restored.launch.commandId, before.launch.commandId)
  assert.equal(f.spawnOptions.at(-1)!.cwd, before.definition.cwd)
  assert.deepEqual(f.spawnOptions.at(-1)!.env, restoringEnvironment)
  assert.deepEqual(f.methodHistory.filter(method => method === "session/new" || method === "session/load"), ["session/new", "session/load"])
  assert.equal(JSON.stringify(done).includes("new-secret"), false)
  await assert.rejects(service.restore({ ...request, environment: { SECRET: "changed" } }), { code: "COMMAND_CONFLICT" })
  assert.equal((await service.command(f.input.commandId, f.input.handlerGeneration)).command.result?.outcome, "started")
  await service.freezeAndDrain(true)
})

test("ordinary production contract starts and restores without qualification authority", async t => {
  const f = await agentServiceFixture(t, { productionContract: true })
  const started = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...started.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  const request = { commandId: randomUUID(), handlerGeneration: f.input.handlerGeneration, agentId: started.command.target!.agentId, environment: { PATH: "/restore" } }
  const restored = await completed(f.service, (await f.service.restore(request)).command)
  assert.equal(restored.command.result?.outcome, "restored")
  assert.equal(restored.command.target?.agentId, started.command.target?.agentId)
  assert.equal(restored.command.result?.session?.sessionId, started.command.result?.session?.sessionId)
  assert.notEqual(restored.command.target?.providerGeneration, started.command.target?.providerGeneration)
})

for (const [sessionLoad, succeeds] of [[false, false], [true, true]] as const) test(`restore follows static session load support ${sessionLoad}`, async t => {
  const f = await agentServiceFixture(t, { sessionLoad })
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  const request = { commandId: randomUUID(), handlerGeneration: f.input.handlerGeneration, agentId: ready.command.target!.agentId, environment: {} }
  if (succeeds) {
    await f.service.restore(request)
    assert.equal((await completed(f.service, request)).command.result?.outcome, "restored")
  } else {
    await assert.rejects(f.service.restore(request), { code: "RESTORE_UNSUPPORTED" })
    assert.equal(f.spawns(), 1)
  }
})

for (const [behavior, code, phase] of [["unsupported", "RESTORE_UNSUPPORTED", "recoverable"], ["auth", "AUTH_REQUIRED", "recoverable"], ["missing", "SESSION_UNAVAILABLE", "failed"], ["invalid-params", "STARTUP_FAILED", "recoverable"], ["cwd", "STARTUP_FAILED", "recoverable"], ["transport", "STARTUP_FAILED", "recoverable"], ["invalid-protocol", "INVALID_PROTOCOL", "recoverable"], ["timeout", "STARTUP_TIMEOUT", "recoverable"]] as const) test(`restore ${behavior} retains the conversation after cleanup`, async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  f.loadBehavior(behavior)
  if (behavior === "timeout") f.contract.deadlines.sessionMs = 25
  const request = { commandId: randomUUID(), handlerGeneration: f.input.handlerGeneration, agentId: ready.command.target!.agentId, environment: {} }
  await f.service.restore(request)
  assert.equal((await completed(f.service, request)).command.result?.failure?.code, code)
  const list = await f.service.list(), agent = list.agents[0]!
  assert.deepEqual(list.issues, [])
  assert.equal(agent.record.phase, phase)
  assert.equal(agent.cleanup, "verified")
  if (agent.record.version !== 2) throw new Error()
  assert.equal(agent.record.session!.sessionId, ready.command.result!.session!.sessionId)
  assert.equal(agent.record.failure?.code, code)
  assert.equal(f.methodHistory.filter(method => method === "session/new").length, 1)
  const unrelated = { ...f.input, commandId: randomUUID() }
  assert.equal((await completed(f.service, (await f.service.start(unrelated)).command)).command.result?.outcome, "started")
  if (phase === "recoverable") {
    f.loadBehavior("normal")
    const retry = { ...request, commandId: randomUUID() }
    await f.service.restore(retry)
    assert.equal((await completed(f.service, retry)).command.result?.outcome, "restored")
  }
})

test("sequential prompts work while concurrent prompts remain rejected", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  const first = f.service.prompt({ ...target, text: "first" })
  await f.promptEntered
  await assert.rejects(f.service.prompt({ ...target, text: "concurrent" }), { code: "INCOMPLETE" })
  f.completePrompt(target.agentId, "first answer")
  assert.equal((await first).text, "first answer")
  const second = f.service.prompt({ ...target, text: "second" })
  await until(async () => f.methodHistory.filter(method => method === "session/prompt").length === 2 ? true : undefined)
  f.completePrompt(target.agentId, "second answer")
  assert.equal((await second).text, "second answer")
})

test("healthy agents continue beside corrupt agent and unknown files, then issues clear after repair", async t => {
  const f = await agentServiceFixture(t)
  const healthy = await completed(f.service, (await f.service.start(f.input)).command)
  const damagedRequest = { ...f.input, commandId: randomUUID() }
  const damaged = await completed(f.service, (await f.service.start(damagedRequest)).command)
  const damagedPath = join(f.root, "agents/records", damaged.command.target!.agentId + ".json")
  const unknownPath = join(f.root, "agents/records/unknown.json"), saved = await readFile(damagedPath)
  await writeFile(damagedPath, "{}", { mode: 0o600 }); await writeFile(unknownPath, "{}", { mode: 0o600 })
  assert.equal((await f.service.prompt({ ...healthy.command.target!, text: "continue" })).stopReason, "end_turn")
  const stop = { ...healthy.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  const thirdRequest = { ...f.input, commandId: randomUUID() }
  assert.equal((await completed(f.service, (await f.service.start(thirdRequest)).command)).command.result?.outcome, "started")
  const restore = { commandId: randomUUID(), handlerGeneration: healthy.command.handlerGeneration, agentId: healthy.command.target!.agentId, environment: {} }
  assert.equal((await completed(f.service, (await f.service.restore(restore)).command)).command.result?.outcome, "restored")
  const listed = await f.service.list()
  assert.equal(listed.agents.some(view => view.record.version === 2 && view.record.definition.agentId === healthy.command.target!.agentId), true)
  assert.deepEqual(listed.issues.map(issue => issue.path), [damagedPath, unknownPath])
  await writeFile(damagedPath, saved); await rm(unknownPath)
  assert.deepEqual((await f.service.list()).issues, [])
})

test("missing related command is unavailable only on its agent view until repaired", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const commandPath = join(f.root, "agents/commands", f.input.commandId + ".json"), saved = await readFile(commandPath)
  await writeFile(commandPath, "{}", { mode: 0o600 })
  const listed = await f.service.list(), view = listed.agents.find(agent => agent.record.version === 2 && agent.record.definition.agentId === ready.command.target!.agentId)
  assert.deepEqual(listed.issues, [])
  assert.equal(view?.record.version, 2)
  if (view?.record.version !== 2) throw new Error("missing agent view")
  assert.equal(view && "unavailable" in view ? view.unavailable?.path : null, commandPath)
  await assert.rejects(f.service.prompt({ ...ready.command.target!, text: "blocked" }), { code: "INVALID_AGENT_STATE" })
  const unrelated = { ...f.input, commandId: randomUUID() }
  const started = await completed(f.service, (await f.service.start(unrelated)).command)
  assert.equal(started.command.result?.outcome, "started")
  assert.equal((await f.service.prompt({ ...started.command.target!, text: "healthy" })).stopReason, "end_turn")
  const unrelatedStop = { ...started.command.target!, commandId: randomUUID() }
  await f.service.stop(unrelatedStop)
  assert.equal((await completed(f.service, unrelatedStop)).command.result?.outcome, "stopped")
  await writeFile(commandPath, saved)
  const repaired = (await f.service.list()).agents.find(agent => agent.record.version === 2 && agent.record.definition.agentId === ready.command.target!.agentId)
  assert.equal(repaired && "unavailable" in repaired ? repaired.unavailable : undefined, null)
})

test("list frames a mismatched owned launch beside a healthy agent and clears it on repair", async t => {
  const f = await agentServiceFixture(t)
  const damaged = await completed(f.service, (await f.service.start(f.input)).command)
  const healthy = await completed(f.service, (await f.service.start({ ...f.input, commandId: randomUUID() })).command)
  const record = await f.store.readAgent(damaged.command.target!.agentId)
  const entry = f.context.mutations.accepted.find(value => value.record.launchAttemptId === record?.launch.launchAttemptId)
  if (!entry || entry.record.version !== 2 || entry.record.owner.kind !== "agent") throw new Error("missing owned launch")
  const original = structuredClone(entry.record), mismatched = { ...entry.record, owner: { ...entry.record.owner, agentId: randomUUID() } }
  await writeLaunchRecord(entry.path, mismatched); entry.record = mismatched
  const listed = await f.service.list()
  const parsed = parseAgentReply({ protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: f.input.handlerGeneration, ok: true, result: listed })
  assert.ok(parsed.ok && parsed.result.state === "agents")
  const affected = parsed.result.agents.find(view => view.record.version === 2 && view.record.definition.agentId === damaged.command.target!.agentId)
  const independent = parsed.result.agents.find(view => view.record.version === 2 && view.record.definition.agentId === healthy.command.target!.agentId)
  assert.equal(affected?.launch, null)
  assert.equal(affected && "unavailable" in affected ? affected.unavailable?.path : null, entry.path)
  assert.equal(independent?.launch?.phase, "active")
  await writeLaunchRecord(entry.path, original); entry.record = original
  const repaired = (await f.service.list()).agents.find(view => view.record.version === 2 && view.record.definition.agentId === damaged.command.target!.agentId)
  assert.equal(repaired && "unavailable" in repaired ? repaired.unavailable : undefined, null)
})

test("exact cleanup retry repairs one agent while unrelated starts continue", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  const launch = (await f.service.list()).agents[0]!.launch
  if (!launch?.provider) throw new Error("missing process owner")
  const group = launch.provider.group.leader.processGroupId, signal = f.context.adapter.signalGroup
  f.context.adapter.signalGroup = async (id, value) => { if (id === group) throw new Error("injected signal failure"); return signal(id, value) }
  const stop = { ...target, commandId: randomUUID() }
  await f.service.stop(stop)
  await until(async () => { const view = (await f.service.list()).agents[0]; return view && "unavailable" in view && view.unavailable ? true : undefined })
  await assert.rejects(f.service.restore({ commandId: randomUUID(), handlerGeneration: target.handlerGeneration, agentId: target.agentId, environment: {} }), { code: "CLEANUP_UNVERIFIED" })
  const unrelated = { ...f.input, commandId: randomUUID() }
  assert.equal((await completed(f.service, (await f.service.start(unrelated)).command)).command.result?.outcome, "started")
  f.context.adapter.signalGroup = signal
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  const repaired = (await f.service.list()).agents.find(agent => agent.record.version === 2 && agent.record.definition.agentId === target.agentId)
  assert.equal(repaired && "unavailable" in repaired ? repaired.unavailable : undefined, null)
})

for (const boundary of ["spawn", "spawned", "ready"]) test(`Handler death while restoring at ${boundary} interrupts the command and retains the session`, async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  const stop = { ...target, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  f.pauseRestore(boundary)
  const request = { commandId: randomUUID(), handlerGeneration: f.input.handlerGeneration, agentId: target.agentId, environment: {} }
  await f.service.restore(request)
  await f.restoreEntered
  if (boundary === "ready") assert.equal(f.methodHistory.filter(method => method === "session/load").length, 1)
  const restarted = await f.restart()
  assert.equal((await restarted.command(request.commandId, request.handlerGeneration)).command.state, "interrupted")
  const recovered = (await restarted.list()).agents[0]!
  assert.equal(recovered.record.phase, "recoverable")
  assert.equal(recovered.cleanup, "verified")
  const retry = { ...request, commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration }
  await restarted.restore(retry)
  assert.equal((await completed(restarted, retry)).command.result?.outcome, "restored")
  assert.equal(f.methodHistory.filter(method => method === "session/new").length, 1)
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 0)
})

test("an unresolved same-boot process prevents only its agent from restoring", async t => {
  const f = await agentServiceFixture(t)
  const first = await completed(f.service, (await f.service.start(f.input)).command)
  const second = await completed(f.service, (await f.service.start({ ...f.input, commandId: randomUUID() })).command)
  const restarted = await f.restart(first.command.target!.agentId)
  const list = await restarted.list()
  assert.deepEqual(list.issues, [])
  assert.equal(list.agents.find(agent => agent.record.version === 2 && agent.record.definition.agentId === first.command.target!.agentId)!.record.phase, "interrupted")
  const request = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, agentId: first.command.target!.agentId, environment: {} }
  await assert.rejects(restarted.restore(request), { code: "NOT_READY" })
  const healthy = { ...request, commandId: randomUUID(), agentId: second.command.target!.agentId }
  await restarted.restore(healthy)
  assert.equal((await completed(restarted, healthy)).command.result?.outcome, "restored")
})

test("repairing a historical stop receipt cannot stop a restored process generation", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  f.failStopReceipt(true)
  const stop = { ...target, commandId: randomUUID() }
  await f.service.stop(stop)
  await until(async () => (await f.store.readAgent(target.agentId))?.phase === "stopped" ? true : undefined)
  const restore = { commandId: randomUUID(), handlerGeneration: f.input.handlerGeneration, agentId: target.agentId, environment: {} }
  await f.service.restore(restore)
  const restored = await completed(f.service, restore)
  f.failStopReceipt(false)
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  assert.equal((await f.service.prompt({ ...restored.command.target!, text: "still running" })).text, "answer:still running")
  assert.equal((await f.service.list()).agents[0]!.record.phase, "ready")
})

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
  assert.equal((await recoverAgents({ context: f.context, store })).assessment.unavailable.size, 1)
  rejectSync = false
  assert.equal((await recoverAgents({ context: f.context, store })).assessment.unavailable.size, 0)
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
  assert.equal((await recoverAgents({ context: f.context, store })).assessment.unavailable.size, 1)
  rejectSync = false
  assert.equal((await recoverAgents({ context: f.context, store })).assessment.unavailable.size, 0)
})

for (const kind of ["agent", "command"] as const) test(`service retains ${kind} recovery publication failure until exact retry`, async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  await completed(f.service, stop)
  const base = createAgentStore(f.root)
  let reject = true, retries = 0
  const store = { ...base,
    async writeAgent(value: Parameters<typeof base.writeAgent>[0], expected: Parameters<typeof base.writeAgent>[1]) {
      if (kind === "agent" && value.definition.agentId === stop.agentId) { retries++; if (reject) throw new Error("injected recovery agent sync failure") }
      await base.writeAgent(value, expected)
    },
    async writeCommand(value: Parameters<typeof base.writeCommand>[0], expected: Parameters<typeof base.writeCommand>[1]) {
      if (kind === "command" && value.commandId === stop.commandId) { retries++; if (reject) throw new Error("injected recovery command sync failure") }
      await base.writeCommand(value, expected)
    },
  }
  const service = await f.restart(undefined, store)
  const issue = (await service.list()).agents.find(view => view.record.version === 2 && view.record.definition.agentId === stop.agentId)
  assert.ok(issue && "unavailable" in issue && issue.unavailable)
  const restore = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, agentId: stop.agentId, environment: {} }
  await assert.rejects(service.restore(restore), { code: "INVALID_AGENT_STATE" })
  const pending = await service.command(stop.commandId, stop.handlerGeneration)
  assert.equal(pending.durability, "unverified")
  assert.ok(retries >= 2)
  reject = false
  assert.equal((await service.command(stop.commandId, stop.handlerGeneration)).durability, "verified")
  const repaired = (await service.list()).agents.find(view => view.record.version === 2 && view.record.definition.agentId === stop.agentId)
  assert.ok(repaired && "unavailable" in repaired && repaired.unavailable === null)
  await service.restore(restore)
  assert.equal((await completed(service, restore)).command.result?.outcome, "restored")
})

test("failed unspawned restore launch publication remains unavailable through an agent-record retry", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  await completed(f.service, stop)
  const previous = await f.store.readAgent(stop.agentId)
  if (!previous) throw new Error("missing stopped agent")
  const request = { commandId: randomUUID(), handlerGeneration: previous.launch.handlerGeneration, agentId: stop.agentId, environment: {} }
  const restoring = { ...previous, phase: "restoring" as const, launch: { ...previous.launch, providerGeneration: randomUUID(), launchAttemptId: randomUUID(), commandId: request.commandId }, failure: null }
  await f.store.writeCommand({ version: 2, hostId: f.context.paths.hostKey, commandId: request.commandId, handlerGeneration: request.handlerGeneration, op: "restore", input: projectRestoreInput(request), target: agentTuple(restoring), state: "pending", result: null }, null)
  await f.store.writeAgent(restoring, previous)
  const launchPath = join(f.root, "launches", restoring.launch.launchAttemptId + ".json")
  const bootId = f.context.adapter.bootId.bind(f.context.adapter), originalGeneration = f.context.state.handlerGeneration
  f.context.adapter.bootId = async () => { if (f.context.state.handlerGeneration !== originalGeneration) throw new Error("injected launch publication failure"); return bootId() }
  const service = await f.restart()
  const before = (await service.list()).agents.find(view => view.record.version === 2 && view.record.definition.agentId === stop.agentId)
  assert.equal(before && "unavailable" in before ? before.unavailable?.path : null, launchPath)
  assert.equal((await service.command(request.commandId, request.handlerGeneration)).durability, "unverified")
  const stillUnavailable = (await service.list()).agents.find(view => view.record.version === 2 && view.record.definition.agentId === stop.agentId)
  assert.equal(stillUnavailable && "unavailable" in stillUnavailable ? stillUnavailable.unavailable?.path : null, launchPath)
  f.context.adapter.bootId = bootId
  const conflictingOwner = randomUUID()
  await writeLaunchRecord(launchPath, { version: 2, owner: { kind: "agent", agentId: conflictingOwner, providerGeneration: restoring.launch.providerGeneration }, handlerGeneration: restoring.launch.handlerGeneration, launchAttemptId: restoring.launch.launchAttemptId, launchBootId: "boot-a", launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null })
  assert.equal((await service.command(request.commandId, request.handlerGeneration)).durability, "unverified")
  assert.equal(JSON.parse(await readFile(launchPath, "utf8")).owner.agentId, conflictingOwner)
  await rm(launchPath)
  assert.equal((await service.command(request.commandId, request.handlerGeneration)).durability, "verified")
  const repaired = (await service.list()).agents.find(view => view.record.version === 2 && view.record.definition.agentId === stop.agentId)
  assert.equal(repaired && "unavailable" in repaired ? repaired.unavailable : undefined, null)
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