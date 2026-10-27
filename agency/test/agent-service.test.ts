import assert from "node:assert/strict"
import test from "node:test"
import { once } from "node:events"
import { createServer, createConnection, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentTuple } from "../src/agent/recovery.js"
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
}, 40000)

test("scalar prompt reports cancellation as failure without failing its provider", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  const prompt = f.service.prompt({ ...target, text: "challenge" })
  await f.promptEntered
  f.completePrompt(target.agentId, "", "cancelled")
  await assert.rejects(prompt, { code: "INCOMPLETE" })
  assert.equal((await f.service.current(f.workspace)).agents[0]!.record.phase, "ready")
  assert.equal(f.spawns(), 1)
})

test("shell-originated turns are visible to observers without transferring provider ownership", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  const seen: any[] = []
  const observed = await f.service.observe(target, (event: unknown) => seen.push(event))
  assert.equal(observed.snapshot.metadata.phase, "ready")
  assert.equal(observed.snapshot.metadata.cwd, f.workspace)
  await f.service.prompt({ ...target, text: "shell question" })
  assert.deepEqual(seen.filter(event => event.kind === "event").map(event => event.event.kind), ["submitted", "turn", "update", "turn"])
  assert.equal(seen.at(-1).event.state, "completed")
  observed.close()
  assert.equal((await f.service.current(f.workspace)).agents[0]!.record.phase, "ready")
})

test("attachment detach during a turn retains its receipt and rejects conflicting dispatch", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  const service = f.service, request = { submissionId: randomUUID(), text: "editor question", limits: { inputBytes: 262144, outputBytes: 786432, encodedTextBytes: 917504, allowEmptyAnswer: true } }
  const observed = await service.observe(target, () => { throw new Error("observer failed") })
  await service.submit(target, request)
  await f.promptEntered
  observed.close()
  await service.submit(target, request)
  await assert.rejects(service.submit(target, { ...request, text: "changed" }), { code: "COMMAND_CONFLICT" })
  await assert.rejects(service.submit(target, { ...request, submissionId: randomUUID() }), { code: "BUSY" })
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 1)
  f.completePrompt(target.agentId)
  await until(async () => (await service.submission(target, request.submissionId))?.state === "completed" ? true : undefined)
  const fresh = await service.observe(target, () => {})
  assert.equal(fresh.snapshot.currentTurn!.submissionId, request.submissionId)
  assert.equal(f.spawns(), 1)
  fresh.close()
})

test("cooperative cancellation preserves the provider and cannot cancel the next turn", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  const service = f.service, request = { submissionId: randomUUID(), text: "first", limits: { inputBytes: 262144, outputBytes: 786432, encodedTextBytes: 917504, allowEmptyAnswer: true } }
  await service.submit(target, request); await f.promptEntered
  await service.cancel(target, request.submissionId)
  await until(async () => (await service.submission(target, request.submissionId))?.state === "completed" ? true : undefined)
  const second = { ...request, submissionId: randomUUID(), text: "second" }
  await service.submit(target, second)
  await until(async () => f.methodHistory.filter(method => method === "session/prompt").length === 2 ? true : undefined)
  await service.cancel(target, request.submissionId)
  assert.equal((await service.submission(target, second.submissionId))!.state, "running")
  f.completePrompt(target.agentId)
  await until(async () => (await service.submission(target, second.submissionId))?.state === "completed" ? true : undefined)
  assert.equal((await f.service.current(f.workspace)).agents[0]!.record.phase, "ready")
})

test("cancellation submitted with a prompt reaches it after dispatch", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  const submissionId = randomUUID()
  const submitted = f.service.submitAcp(target, { submissionId, prompt: [{ type: "text", text: "pending" }] })
  const cancelled = f.service.cancel(target, submissionId)
  await Promise.all([submitted, cancelled])
  await f.promptEntered
  assert.equal(f.methodHistory.filter(method => method === "session/cancel").length, 1)
  assert.equal((await f.service.settledAcp(target, submissionId)).stopReason, "cancelled")
})

test("unmatched partial echoes retain provider stream order across requests", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  for (const text of ["abcdef", "xyz"]) await f.service.submitAcp(target, { submissionId: randomUUID(), prompt: [{ type: "text", text }] })
  await until(async () => f.methodHistory.filter(method => method === "session/prompt").length === 2 ? true : undefined)
  for (const text of ["a", "x", "b", "q"]) f.emitUpdate(target.agentId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } })
  const observation = await f.service.observe(target, () => {})
  assert.deepEqual(observation.snapshot.events.filter(event => event.kind === "update").map(event => event.kind === "update" && (event.update.content as { text: string }).text), ["a", "x", "b", "q"])
  observation.close()
})

test("an old unmatched echo completion cannot discard a newer echo matcher", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const submit = (index: number, text: string) => f.service.submitAcp(target, { submissionId: ids[index]!, prompt: [{ type: "text", text }] })
  await submit(0, "abcdef"); await submit(1, "xyz")
  await until(async () => f.methodHistory.filter(method => method === "session/prompt").length === 2 ? true : undefined)
  for (const text of ["a", "x", "q"]) f.emitUpdate(target.agentId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } })
  f.completePrompt(target.agentId, "", "end_turn", 1); await f.service.settledAcp(target, ids[1]!)
  await submit(2, "third")
  await until(async () => f.methodHistory.filter(method => method === "session/prompt").length === 3 ? true : undefined)
  f.completePrompt(target.agentId, "", "end_turn", 0); await f.service.settledAcp(target, ids[0]!)
  f.emitUpdate(target.agentId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "third" } })
  const observation = await f.service.observe(target, () => {})
  assert.deepEqual(observation.snapshot.events.filter(event => event.kind === "update").map(event => event.kind === "update" && (event.update.content as { text: string }).text), ["a", "x", "q"])
  observation.close()
})

test("stop closes the old projection and restored observers receive only the new generation", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!, service = f.service
  const seen: any[] = []
  await service.observe(target, (event: unknown) => seen.push(event))
  await completed(f.service, (await f.service.stop({ ...target, commandId: randomUUID() })).command)
  assert.equal(seen.at(-1).kind, "closed")
  assert.deepEqual(seen.filter(event => event.kind === "event" && event.event.kind === "lifecycle").map(event => event.event.phase), ["stopping", "stopped"])
  const restored = await completed(f.service, (await f.service.restore({ agentId: target.agentId, handlerGeneration: target.handlerGeneration, commandId: randomUUID(), environment: f.input.environment })).command)
  await assert.rejects(service.observe(target, () => {}), { code: "STALE_PROVIDER" })
  const observer = await service.observe(restored.command.target!, () => {})
  assert.equal(observer.snapshot.target.providerGeneration, restored.command.target!.providerGeneration)
  assert.ok(observer.snapshot.events.some((event: any) => event.kind === "update" && event.replay))
  observer.close()
})

test("provider failure publishes the accepted turn failure before releasing its observers", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!, service = f.service
  const seen: any[] = []
  await service.observe(target, (event: unknown) => seen.push(event))
  await service.submit(target, { submissionId: randomUUID(), text: "first", limits: { inputBytes: 262144, outputBytes: 786432, encodedTextBytes: 917504, allowEmptyAnswer: true } })
  await f.promptEntered
  f.fault(target.agentId)
  await until(async () => seen.at(-1)?.kind === "closed" ? true : undefined)
  assert.ok(seen.some(event => event.kind === "event" && event.event.kind === "turn" && event.event.state === "failed"))
  await assert.rejects(service.observe(target, () => {}), { code: "NOT_READY" })
})

for (const crashed of [false, true]) test(`restore retains identity and rotates launch after ${crashed ? "crash" : "stop"}`, async t => {
  const f = await agentServiceFixture(t)
  const started = await completed(f.service, (await f.service.start(f.input)).command)
  const before = (await f.service.list()).agents[0]!.record
  assert.equal(before.version, 3)
  if (before.version !== 3) throw new Error()
  let service = f.service
  if (crashed) service = await f.restart()
  else {
    const stop = { ...started.command.target!, commandId: randomUUID() }
    await service.stop(stop); await completed(service, stop)
  }
  const recovered = (await service.list()).agents[0]!.record
  assert.equal(recovered.phase, crashed ? "interrupted" : "stopped")
  assert.doesNotThrow(() => service.assertOrdinaryShutdownSafe())
  const restoringEnvironment = { PATH: "/restoring/bin", SECRET: "new-secret" }
  const request = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, agentId: before.definition.agentId, environment: restoringEnvironment }
  await service.restore(request)
  const done = await completed(service, request)
  assert.equal(done.command.result?.outcome, "restored")
  const restored = (await service.list()).agents[0]!.record
  if (restored.version !== 3) throw new Error()
  assert.deepEqual(restored.definition, before.definition)
  assert.equal(restored.session!.sessionId, before.session!.sessionId)
  assert.notEqual(restored.launch!.providerGeneration, before.launch!.providerGeneration)
  assert.notEqual(restored.launch!.launchAttemptId, before.launch!.launchAttemptId)
  assert.notEqual(restored.launch!.commandId, before.launch!.commandId)
  assert.equal(f.spawnOptions.at(-1)!.cwd, before.definition.cwd)
  const { NVIM, NVIM_SOCKET_PATH, ...environment } = f.spawnOptions.at(-1)!.env!
  assert.deepEqual(environment, { ...restoringEnvironment, CODEX_PATH: f.profile.executable })
  assert.match(NVIM!, /\/editor-[a-f0-9-]+\.sock$/)
  assert.equal(NVIM_SOCKET_PATH, NVIM)
  assert.deepEqual(f.methodHistory.filter(method => method === "session/new" || method === "session/load"), ["session/new", "session/load"])
  assert.equal(JSON.stringify(done).includes("new-secret"), false)
  await assert.rejects(service.restore({ ...request, environment: { SECRET: "changed" } }), { code: "COMMAND_CONFLICT" })
  assert.equal((await service.command(f.input.commandId, f.input.handlerGeneration)).command.result?.outcome, "started")
  await service.freezeAndDrain(true)
})

for (const callerOverride of [false, true]) test(`Codex start and Restore use the profile launcher with ${callerOverride ? "a conflicting" : "no"} caller override`, async t => {
  const defaults = Object.freeze({ CODEX_PATH: "/stale/backend-codex", MODEL_PROVIDER: "backend", DEFAULT_ONLY: "retained" })
  const f = await agentServiceFixture(t, { nativeLauncher: "codex wrapper with spaces", backendEnvironment: defaults })
  const environment = Object.freeze({ PATH: "/caller/bin", MODEL_PROVIDER: "caller", EMPTY: "", ...(callerOverride ? { CODEX_PATH: "/stale/caller-codex" } : {}) })
  const originalEnvironment = { ...environment }, originalDefaults = { ...defaults }
  const started = await completed(f.service, (await f.service.start({ ...f.input, environment })).command)
  assert.equal(started.command.result?.outcome, "started")
  const { NVIM: startNvim, NVIM_SOCKET_PATH: startSocket, ...startEnvironment } = f.spawnOptions[0]!.env!
  assert.deepEqual(startEnvironment, { PATH: "/caller/bin", MODEL_PROVIDER: "caller", EMPTY: "", DEFAULT_ONLY: "retained", CODEX_PATH: join(f.root, "codex wrapper with spaces") })
  assert.equal(startNvim, startSocket)
  const stop = { ...started.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  const restoreEnvironment = Object.freeze({ PATH: "/restore/bin", MODEL_PROVIDER: "restore", ...(callerOverride ? { CODEX_PATH: "/stale/restore-codex" } : {}) })
  const originalRestore = { ...restoreEnvironment }
  const request = { commandId: randomUUID(), handlerGeneration: f.input.handlerGeneration, agentId: started.command.target!.agentId, environment: restoreEnvironment }
  const restored = await completed(f.service, (await f.service.restore(request)).command)
  assert.equal(restored.command.result?.outcome, "restored")
  assert.notEqual(restored.command.target!.providerGeneration, started.command.target!.providerGeneration)
  assert.equal(restored.command.result!.session!.sessionId, started.command.result!.session!.sessionId)
  const { NVIM: restoreNvim, NVIM_SOCKET_PATH: restoreSocket, ...restoredEnvironment } = f.spawnOptions.at(-1)!.env!
  assert.deepEqual(restoredEnvironment, { PATH: "/restore/bin", MODEL_PROVIDER: "restore", DEFAULT_ONLY: "retained", CODEX_PATH: join(f.root, "codex wrapper with spaces") })
  assert.equal(restoreNvim, restoreSocket)
  assert.deepEqual(f.methodHistory.filter(method => method === "session/new" || method === "session/load"), ["session/new", "session/load"])
  assert.deepEqual(environment, originalEnvironment)
  assert.deepEqual(restoreEnvironment, originalRestore)
  assert.deepEqual(defaults, originalDefaults)
  await f.service.freezeAndDrain(true)
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
  if (agent.record.version !== 3) throw new Error()
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
  await assert.rejects(f.service.prompt({ ...target, text: "concurrent" }), { code: "BUSY" })
  f.completePrompt(target.agentId, "first answer")
  assert.equal((await first).text, "first answer")
  const second = f.service.prompt({ ...target, text: "second" })
  await until(async () => f.methodHistory.filter(method => method === "session/prompt").length === 2 ? true : undefined)
  f.completePrompt(target.agentId, "second answer")
  assert.equal((await second).text, "second answer")
})

test("catalog refresh during a prompt does not invalidate its live session", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  const pending = f.service.prompt({ ...target, text: "continue" })
  await f.promptEntered
  await f.changeCatalog("refresh")
  f.completePrompt(target.agentId, "retained answer")
  assert.equal((await pending).text, "retained answer")
  const record = (await f.service.list()).agents[0]!.record
  assert.equal(record.version === 3 && record.phase, "ready")
})

test("catalog refresh before a prompt does not invalidate its live session", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  await f.changeCatalog("refresh")
  assert.equal((await f.service.prompt({ ...target, text: "continue" })).text, "answer:continue")
  const record = (await f.service.list()).agents[0]!.record
  assert.equal(record.version === 3 && record.phase, "ready")
})

test("external history edits are diagnostic during inspection without changing current owners", async t => {
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
  assert.equal(listed.agents.some(view => view.record.version === 3 && view.record.definition.agentId === healthy.command.target!.agentId), true)
  assert.ok(listed.issues.length > 0)
  await writeFile(damagedPath, saved); await rm(unknownPath)
  assert.ok((await f.service.list()).issues.length > 0)
})

test("a cached receipt remains available after an external command edit", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const commandPath = join(f.root, "agents/commands", f.input.commandId + ".json"), saved = await readFile(commandPath)
  await writeFile(commandPath, "{}", { mode: 0o600 })
  const listed = await f.service.list(), view = listed.agents.find(agent => agent.record.version === 3 && agent.record.definition.agentId === ready.command.target!.agentId)
  assert.ok(listed.issues.length > 0)
  assert.equal(view?.record.version, 3)
  if (view?.record.version !== 3) throw new Error("missing agent view")
  assert.equal(view && "unavailable" in view ? view.unavailable : undefined, null)
  assert.equal((await f.service.prompt({ ...ready.command.target!, text: "continue" })).stopReason, "end_turn")
  const unrelated = { ...f.input, commandId: randomUUID() }
  const started = await completed(f.service, (await f.service.start(unrelated)).command)
  assert.equal(started.command.result?.outcome, "started")
  assert.equal((await f.service.prompt({ ...started.command.target!, text: "healthy" })).stopReason, "end_turn")
  const unrelatedStop = { ...started.command.target!, commandId: randomUUID() }
  await f.service.stop(unrelatedStop)
  assert.equal((await completed(f.service, unrelatedStop)).command.result?.outcome, "stopped")
  await writeFile(commandPath, saved)
  const repaired = (await f.service.list()).agents.find(agent => agent.record.version === 3 && agent.record.definition.agentId === ready.command.target!.agentId)
  assert.equal(repaired && "unavailable" in repaired ? repaired.unavailable : undefined, null)
})

test("list frames a mismatched owned launch beside a healthy agent and clears it on repair", async t => {
  const f = await agentServiceFixture(t)
  const damaged = await completed(f.service, (await f.service.start(f.input)).command)
  const healthy = await completed(f.service, (await f.service.start({ ...f.input, commandId: randomUUID() })).command)
  const record = await f.store.readAgent(damaged.command.target!.agentId)
  const entry = f.context.mutations.accepted.find(value => value.record.launchAttemptId === record?.launch?.launchAttemptId)
  if (!entry || entry.record.version !== 2 || entry.record.owner.kind !== "agent") throw new Error("missing owned launch")
  const original = structuredClone(entry.record), mismatched = { ...entry.record, owner: { ...entry.record.owner, agentId: randomUUID() } }
  await writeLaunchRecord(entry.path, mismatched); entry.record = mismatched
  const listed = await f.service.list()
  const parsed = parseAgentReply({ protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: f.input.handlerGeneration, ok: true, result: listed })
  assert.ok(parsed.ok && parsed.result.state === "agents")
  const affected = parsed.result.agents.find(view => view.record.version === 3 && view.record.definition.agentId === damaged.command.target!.agentId)
  const independent = parsed.result.agents.find(view => view.record.version === 3 && view.record.definition.agentId === healthy.command.target!.agentId)
  assert.equal(affected?.launch, null)
  assert.equal(affected && "unavailable" in affected ? affected.unavailable?.path : null, entry.path)
  assert.equal(independent?.launch?.phase, "active")
  await writeLaunchRecord(entry.path, original); entry.record = original
  const repaired = (await f.service.list()).agents.find(view => view.record.version === 3 && view.record.definition.agentId === damaged.command.target!.agentId)
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
  const repaired = (await f.service.list()).agents.find(agent => agent.record.version === 3 && agent.record.definition.agentId === target.agentId)
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
  assert.equal(recovered.record.phase, "interrupted")
  assert.equal(recovered.cleanup, "unknown")
  const retry = { ...request, commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration }
  await restarted.restore(retry)
  assert.equal((await completed(restarted, retry)).command.result?.outcome, "restored")
  assert.equal(f.methodHistory.filter(method => method === "session/new").length, 1)
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 0)
})

test("an unresolved historical launch permits explicit restore with a new owner", async t => {
  const f = await agentServiceFixture(t)
  const first = await completed(f.service, (await f.service.start(f.input)).command)
  const second = await completed(f.service, (await f.service.start({ ...f.input, commandId: randomUUID() })).command)
  const restarted = await f.restart(first.command.target!.agentId)
  const list = await restarted.list()
  assert.deepEqual(list.issues, [])
  assert.equal(list.agents.find(agent => agent.record.version === 3 && agent.record.definition.agentId === first.command.target!.agentId)!.record.phase, "interrupted")
  const request = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, agentId: first.command.target!.agentId, environment: {} }
  await restarted.restore(request)
  assert.equal((await completed(restarted, request)).command.result?.outcome, "restored")
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
  await until(async () => (await f.service.sessionRecord(target.agentId))?.record.phase === "stopped" ? true : undefined)
  assert.deepEqual(f.retired(), [])
  const restore = { commandId: randomUUID(), handlerGeneration: f.input.handlerGeneration, agentId: target.agentId, environment: {} }
  await f.service.restore(restore)
  const restored = await completed(f.service, restore)
  assert.deepEqual(f.retired(), [])
  f.failStopReceipt(false)
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  assert.deepEqual(f.retired(), [{ agentId: target.agentId, commandId: f.input.commandId }])
  assert.equal((await f.service.prompt({ ...restored.command.target!, text: "still running" })).text, "answer:still running")
  assert.equal((await f.service.list()).agents[0]!.record.phase, "ready")
})

test("terminal lifecycle releases its transient operation after durable cleanup", async t => {
  const f = await agentServiceFixture(t), request = { ...f.input, environment: { PATH: "/bin", SECRET_TOKEN: "ephemeral" } }
  const started = await completed(f.service, (await f.service.start(request)).command)
  assert.deepEqual(f.retired(), [])
  const before = f.spawns(), stop = { ...started.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  assert.deepEqual(f.retired(), [{ agentId: started.command.target!.agentId, commandId: f.input.commandId }])
  assert.equal((await f.service.start(request)).command.state, "completed")
  assert.equal(f.spawns(), before)
})

test("failed pre-ready lifecycle releases its transient operation after cleanup and receipt durability", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" })
  const accepted = await f.service.start(f.input)
  await f.entered
  f.failInitialize(true)
  f.release()
  const failed = await completed(f.service, accepted.command)
  assert.equal(failed.command.result?.outcome, "failed")
  assert.deepEqual(f.retired(), [{ agentId: failed.command.target!.agentId, commandId: f.input.commandId }])
})

test("terminal record directory durability blocks retirement until exact retry", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  f.failTerminal(true)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  await until(async () => f.terminalFailures() ? true : undefined)
  assert.deepEqual(f.retired(), [])
  f.failTerminal(false)
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  assert.equal(f.retired().length, 1)
})

test("terminal stop receipt durability blocks retirement until exact retry", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  f.failStopReceipt(true)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  await until(async () => (await f.service.sessionRecord(stop.agentId))?.record.phase === "stopped" ? true : undefined)
  assert.deepEqual(f.retired(), [])
  f.failStopReceipt(false)
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  assert.equal(f.retired().length, 1)
})

for (const retry of ["command", "stop", "shutdown"] as const) test(`durable stop receipt repair through ${retry} permits forced shutdown`, async t => {
  const f = await agentServiceFixture(t)
  t.after(() => f.failReceipt(false))
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  f.failReceipt(true)
  await f.service.stop(stop)
  await until(async () => {
    const receipt = await f.service.commandReceipt(stop.commandId, stop.handlerGeneration)
    return receipt?.command.state === "completed" && receipt.durability === "unverified" ? receipt : undefined
  })
  assert.ok(f.receiptFailures() > 0)
  await assert.rejects(f.service.freezeAndDrain(true), { code: "INCOMPLETE" })
  assert.equal(f.context.mutations.accepted[0]!.record.phase, "cleanup_verified")
  assert.deepEqual(f.retired(), [])
  const signal = f.context.adapter.signalGroup
  let furtherSignals = 0
  f.context.adapter.signalGroup = async (group, kind) => { furtherSignals++; await signal(group, kind) }
  f.failReceipt(false)
  if (retry === "command") assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  else if (retry === "stop") {
    const receipt = await f.service.stop(stop)
    assert.equal(receipt.command.result?.outcome, "stopped")
    assert.equal(receipt.durability, "verified")
  }
  await f.service.freezeAndDrain(true)
  await f.service.verifyDischarged()
  assert.equal(f.retired().length, 1)
  assert.equal(furtherSignals, 0)
})

test("failed start receipt durability blocks retirement until exact retry", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" })
  f.failReceipt(true)
  await f.service.start(f.input)
  await f.entered
  f.failInitialize(true)
  f.release()
  const receipt = await until(async () => {
    const value = await f.service.commandReceipt(f.input.commandId, f.input.handlerGeneration)
    return value?.command.state === "completed" ? value : undefined
  })
  assert.equal(receipt.durability, "unverified")
  assert.equal((await f.store.readCommand(f.input.commandId))?.state, "completed")
  assert.deepEqual(f.retired(), [])
  f.failReceipt(false)
  assert.equal((await completed(f.service, f.input)).command.result?.outcome, "failed")
  assert.equal(f.retired().length, 1)
})

for (const kind of ["failed start", "recoverable restore"] as const) test(`${kind} terminal publication before rename is repaired by exact retry`, async t => {
  const f = await agentServiceFixture(t, kind === "failed start" ? { pause: "spawn" } : {})
  let request: Pick<StartRequest, "commandId" | "handlerGeneration">
  let predecessor: "starting" | "restoring"
  if (kind === "failed start") {
    f.failTerminalBeforeRename(true)
    request = (await f.service.start(f.input)).command
    predecessor = "starting"
    await f.entered
    f.failInitialize(true)
    f.release()
  } else {
    const ready = await completed(f.service, (await f.service.start(f.input)).command)
    const stop = { ...ready.command.target!, commandId: randomUUID() }
    await f.service.stop(stop)
    await completed(f.service, stop)
    f.loadBehavior("invalid-params")
    f.failTerminalBeforeRename(true)
    request = { commandId: randomUUID(), handlerGeneration: f.input.handlerGeneration }
    await f.service.restore({ ...request, agentId: stop.agentId, environment: {} })
    predecessor = "restoring"
  }
  await until(async () => f.terminalWriteFailures() ? true : undefined)
  const target = (await f.service.command(request.commandId, request.handlerGeneration)).command.target!
  assert.equal((await f.store.readAgent(target.agentId))?.phase, predecessor)
  assert.equal((await f.service.command(request.commandId, request.handlerGeneration)).durability, "unverified")
  const retiredBeforeRepair = kind === "failed start" ? 0 : 1
  assert.equal(f.retired().length, retiredBeforeRepair)
  f.failTerminalBeforeRename(false)
  const repaired = await completed(f.service, request)
  assert.equal(repaired.command.result?.outcome, "failed")
  assert.equal((await f.store.readAgent(target.agentId))?.phase, kind === "failed start" ? "failed" : "recoverable")
  assert.equal(f.retired().length, retiredBeforeRepair + 1)
})

test("stop repairs a retained terminal transition before changing its predecessor", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn", pauseCleanup: true })
  f.failTerminalBeforeRename(true)
  const accepted = await f.service.start(f.input)
  await f.entered
  f.failInitialize(true)
  f.release()
  await until(async () => f.terminalWriteFailures() ? true : undefined)
  const target = accepted.command.target!, stop = { ...target, commandId: randomUUID() }
  await f.cleanupEntered
  await assert.rejects(f.service.stop({ ...stop, commandId: randomUUID() }), { code: "CLEANUP_UNVERIFIED" })
  f.releaseCleanup()
  await until(async () => (await f.service.commandReceipt(f.input.commandId, f.input.handlerGeneration))?.command.state === "completed" ? true : undefined)
  assert.equal((await f.store.readAgent(target.agentId))?.phase, "starting")
  f.failTerminalBeforeRename(false)
  await f.service.stop(stop)
  const observed = await until(async () => {
    const command = await f.service.command(stop.commandId, stop.handlerGeneration), record = await f.store.readAgent(target.agentId)
    return command.command.state === "completed" || record?.phase === "stopping" ? { command, record } : undefined
  })
  assert.equal(observed.command.command.result?.outcome, "stopped")
  assert.equal(observed.record?.phase, "failed")
  assert.equal((await completed(f.service, f.input)).command.result?.outcome, "failed")
  assert.deepEqual(f.retired(), [{ agentId: target.agentId, commandId: f.input.commandId }])
})

test("start persists a version-three definition and digest without environment values", async t => {
  const f = await agentServiceFixture(t)
  const request = { ...f.input, environment: { ...f.input.environment, SECRET_TOKEN: "not-for-state" } }
  const accepted = await f.service.start(request)
  assert.equal(accepted.command.version, 3)
  assert.equal(accepted.command.op, "start")
  assert.equal(JSON.stringify(accepted.command).includes("SECRET_TOKEN"), false)
  assert.equal(JSON.stringify(accepted.command).includes("not-for-state"), false)
  const ready = await completed(f.service, request)
  assert.equal(ready.command.result?.outcome, "started")
  const agent = (await f.service.current(request.cwd)).agents[0]!
  assert.equal(agent.record.version, 3)
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

test("historical inspection neither repairs durability nor contributes to current discharge", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  const agentPath = join(f.root, "agents/records", stop.agentId + ".json"), commandPath = join(f.root, "agents/commands", stop.commandId + ".json")
  const before = [await readFile(agentPath), await readFile(commandPath)]
  const store = { ...f.store,
    async writeAgent() { throw new Error("historical agent write") },
    async writeCommand() { throw new Error("historical command write") },
    async verifyDurability() { throw new Error("historical durability repair") },
  }
  const service = await f.restart(undefined, store)
  assert.equal((await service.sessionRecord(stop.agentId))?.record.phase, "stopped")
  assert.equal((await service.command(stop.commandId, stop.handlerGeneration)).command.state, "completed")
  await service.page({ limit: 20 }); await service.list()
  service.assertOrdinaryShutdownSafe()
  await service.freezeAndDrain(false); await service.verifyDischarged()
  assert.deepEqual([await readFile(agentPath), await readFile(commandPath)], before)
})

test("historical unspawned restore remains interrupted without manufacturing cleanup evidence", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  const previous = (await f.store.readAgent(stop.agentId))!
  const commandId = randomUUID(), restoring = { ...previous, phase: "restoring" as const, launch: { ...previous.launch!, providerGeneration: randomUUID(), launchAttemptId: randomUUID(), commandId }, failure: null }
  const request = { commandId, handlerGeneration: previous.launch!.handlerGeneration, agentId: stop.agentId, environment: {} }
  await f.store.writeCommand({ version: 2, hostId: f.context.paths.hostKey, commandId, handlerGeneration: request.handlerGeneration, op: "restore", input: projectRestoreInput(request), target: agentTuple(restoring), state: "pending", result: null }, null)
  await f.store.writeAgent(restoring, previous)
  const service = await f.restart()
  const history = await service.sessionRecord(stop.agentId)
  assert.equal(history?.record.phase, "interrupted")
  assert.equal(history?.cleanup, "unknown")
  assert.equal((await service.command(commandId, request.handlerGeneration)).command.state, "interrupted")
  assert.equal((await f.store.readCommand(commandId))?.state, "pending")
  assert.equal((await f.store.readAgent(stop.agentId))?.phase, "restoring")
  await assert.rejects(readFile(join(f.root, "launches", restoring.launch.launchAttemptId + ".json")), { code: "ENOENT" })
  await service.freezeAndDrain(false); await service.verifyDischarged()
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

test("admitted launches retain captured configuration and the next launch observes edits", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn" })
  const first = await f.service.start(f.input)
  await f.entered
  assert.equal(f.evidenceCalls(), 1)
  await writeFile(f.config, "{\"changed\":true}", { mode: 0o600 })
  f.release()
  assert.equal((await completed(f.service, f.input)).command.result?.outcome, "started")
  const second = await completed(f.service, (await f.service.start({ ...f.input, commandId: randomUUID() })).command)
  const a = await f.store.readAgent(first.command.target!.agentId), b = await f.store.readAgent(second.command.target!.agentId)
  assert.notEqual(a!.launch!.configuration.fingerprint, b!.launch!.configuration.fingerprint)
  assert.equal(f.evidenceCalls(), 2)
  await f.service.backendChoices(); await f.service.acpCapabilities()
  assert.equal(f.evidenceCalls(), 2)
})

test("uncertain completed receipt is repaired without repeating a provider launch", async t => {
  const f = await agentServiceFixture(t)
  f.failReceipt(true)
  await f.service.start(f.input)
  await until(async () => f.receiptFailures() > 0 ? true : undefined)
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

test("stop revokes editor channels before publishing its receipt", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), service = f.service
  const record = await service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: { NVIM: "/stale", NVIM_SOCKET_PATH: "/also-stale" }, nativeParams: { cwd: f.workspace, mcpServers: [] } })
  const target = agentTuple(record)!, broker = f.spawnOptions.at(-1)!.env!.NVIM!, editorPath = join(f.root, "editor-test.sock")
  assert.equal(f.spawnOptions.at(-1)!.env!.NVIM_SOCKET_PATH, broker); assert.notEqual(broker, "/stale")
  const connections: Socket[] = [], editor = createServer(socket => { connections.push(socket); socket.on("error", () => {}); socket.pipe(socket) })
  editor.listen(editorPath); await once(editor, "listening")
  t.after(() => { for (const socket of connections) socket.destroy(); editor.close() })
  const attachment = randomUUID(), submissionId = randomUUID()
  service.attachEditor(target, "editor", editorPath, attachment)
  await service.submitAcp(target, { submissionId, prompt: [{ type: "text", text: "held" }], originConnectionId: "editor", originAttachment: attachment })
  await f.promptEntered
  const socket = createConnection(broker)
  socket.on("error", () => {}); t.after(() => socket.destroy())
  await once(socket, "connect")
  const echoed = once(socket, "data"); socket.write("connected"); await echoed
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), writeCommand = f.store.writeCommand.bind(f.store)
  f.store.writeCommand = async (next, previous) => { if (next.op === "stop" && next.state === "pending") { entered.resolve(); await release.promise }; return writeCommand(next, previous) }
  t.after(() => release.resolve())
  const stopping = service.stop({ ...target, commandId: randomUUID() })
  await entered.promise
  try { await until(async () => socket.destroyed ? true : undefined, 1000) }
  finally { release.resolve(); await stopping }
  assert.equal(socket.destroyed, true)
})

for (const expanded of [false, true]) test("long permission labels " + (expanded ? "beyond the former cap" : "from the synthetic adapter fixture") + " reach a native decision and leave the ready provider healthy", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!, submissionId = randomUUID()
  const request = JSON.parse(await readFile(new URL("../../test/fixtures/codex-long-permission.json", import.meta.url), "utf8"))
  if (expanded) request.options[2].name = "é".repeat(65537)
  await f.service.submit(target, { submissionId, text: "request permission", limits: { inputBytes: 262144, outputBytes: 786432, encodedTextBytes: 917504, allowEmptyAnswer: true } })
  await f.promptEntered
  f.requestPermission(target.agentId, "long-permission", request)
  const offer = await until(async () => {
    const pending = (await f.service.permissions.snapshot()).pending[0]
    const record = (await f.service.list()).agents.find(agent => agent.record.version === 3 && agent.record.definition.agentId === target.agentId)!.record
    assert.notEqual(record.phase, "failed")
    return pending
  })
  assert.deepEqual(offer.options, request.options); assert.deepEqual(offer.subject, request.toolCall)
  assert.equal((await f.service.permissions.decide(randomUUID(), offer.ref, "allow_once")).state, "applied")
  assert.deepEqual(f.permissionReplies(target.agentId), [{ jsonrpc: "2.0", id: "long-permission", result: { outcome: { outcome: "selected", optionId: "allow_once" } } }])
  f.completePrompt(target.agentId)
  await f.service.settledAcp(target, submissionId)
  assert.equal((await f.service.current(f.input.cwd)).agents[0]!.record.phase, "ready")
  await completed(f.service, (await f.service.stop({ ...target, commandId: randomUUID() })).command)
  assert.equal((await f.service.list()).agents[0]!.cleanup, "verified")
})

for (const retry of [false, true]) test("permission failure provenance survives " + (retry ? "publication retry and restart" : "cleanup and restart"), async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!, seen: any[] = []
  await f.service.observe(target, event => seen.push(event))
  await f.service.submit(target, { submissionId: randomUUID(), text: "invalid label", limits: { inputBytes: 262144, outputBytes: 786432, encodedTextBytes: 917504, allowEmptyAnswer: true } })
  await f.promptEntered
  if (retry) f.failTerminalBeforeRename(true)
  f.requestPermission(target.agentId, "invalid-label", { sessionId: "fixture-session", toolCall: { toolCallId: "tool", title: "Edit" }, options: [{ optionId: "allow", name: "invalid\u0000label", kind: "allow_once" }] })
  if (retry) {
    await until(async () => f.terminalWriteFailures() > 0 ? true : undefined)
    f.failTerminalBeforeRename(false)
    await f.service.command(f.input.commandId, f.input.handlerGeneration)
  }
  const view = await until(async () => { const value = (await f.service.list()).agents[0]!; return value.record.phase === "failed" && value.cleanup === "verified" ? value : undefined })
  const expected = { code: "INVALID_PROTOCOL", message: "invalid protocol", diagnostic: { boundary: "permission_request", causeCode: "INVALID_PROTOCOL" } }
  assert.deepEqual(view.record.failure, expected)
  assert.deepEqual(seen.find(event => event.kind === "event" && event.event.kind === "lifecycle" && event.event.phase === "failed")?.event.failure, expected)
  assert.equal((await f.service.permissions.snapshot()).pending.length, 0)
  assert.deepEqual(f.permissionReplies(target.agentId), [])
  assert.deepEqual((await f.store.readAgent(target.agentId))!.failure, expected)
  const restarted = await f.restart()
  assert.deepEqual((await restarted.list()).agents[0]!.record.failure, expected)
})

test("provider process diagnostic survives owner fault forwarding and service restart", async t => {
  const f = await agentServiceFixture(t), ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  f.emitStderr(target.agentId, Buffer.from("warn\n")); f.exit(target.agentId)
  const view = await until(async () => { const value = (await f.service.list()).agents[0]!; return value.record.phase === "failed" && value.cleanup === "verified" ? value : undefined })
  const expected = { code: "STARTUP_FAILED", message: "startup failed", diagnostic: { boundary: "provider_process", event: "exit", causeCode: null, exitCode: 1, signal: null, stderrBytes: 5, stderrTailBase64: Buffer.from("warn\n").toString("base64") } }
  assert.deepEqual(view.record.failure, expected)
  assert.deepEqual((await (await f.restart()).list()).agents[0]!.record.failure, expected)
})

test("startup diagnostic receipt retains the first child exit through initialization and restart", async t => {
  const f = await agentServiceFixture(t, { exitDuringInitialize: true }), accepted = await f.service.start(f.input), failed = await completed(f.service, accepted.command)
  const expected = { code: "STARTUP_FAILED", message: "startup failed", diagnostic: { boundary: "provider_process", event: "exit", causeCode: null, exitCode: 7, signal: "SIGABRT", stderrBytes: 0, stderrTailBase64: "" } }
  assert.equal(failed.command.result!.outcome, "failed")
  assert.deepEqual(failed.command.result!.failure, expected)
  assert.deepEqual((await f.service.list()).agents[0]!.record.failure, expected)
  assert.equal((await f.service.list()).agents[0]!.cleanup, "verified")
  const restarted = await f.restart()
  assert.deepEqual((await restarted.command(accepted.command.commandId, accepted.command.handlerGeneration)).command.result!.failure, expected)
})

test("permission inspection does not hold the runtime mutation queue", async t => {
  const f = await agentServiceFixture(t), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const target = { agentId: randomUUID(), handlerGeneration: f.service.handlerGeneration, providerGeneration: randomUUID() }
  const ref = await f.service.permissions.open(target, { toolCall: { toolCallId: "tool", title: "Execute" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }, f.workspace, async () => { entered.resolve(); await gate.promise })
  const decision = f.service.permissions.decide(randomUUID(), ref, "allow")
  await entered.promise
  try {
    const ready = await completed(f.service, (await f.service.start(f.input)).command)
    await completed(f.service, (await f.service.stop({ ...ready.command.target!, commandId: randomUUID() })).command)
    assert.equal((await f.service.permissions.snapshot()).pending.length, 0)
  } finally { gate.resolve(); await decision }
})

test("closing with live permissions withdraws editors and closes the service", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), ready = await completed(f.service, (await f.service.start(f.input)).command), target = ready.command.target!
  const turn = f.service.prompt({ ...target, text: "permission" }); void turn.catch(() => undefined)
  await f.promptEntered
  const frames: Record<string, unknown>[] = []
  await f.service.attachPermissions(target, { connectionId: "closing-editor", send: frame => { frames.push(frame) } })
  f.requestPermission(target.agentId, "closing-request", { sessionId: "fixture-session", toolCall: { toolCallId: "tool", title: "Execute" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] })
  await until(async () => (await f.service.permissions.snapshot()).pending.length ? true : undefined)
  assert.doesNotThrow(() => f.service.close())
  assert.ok(frames.some(frame => frame.method === "agency/permission_withdrawn"))
  await assert.rejects(f.service.permissions.snapshot(), { code: "UNAVAILABLE" })
})

function settlementGate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("live cleanup is consumed without duplicate platform observations", async t => {
  let context: Awaited<ReturnType<typeof agentServiceFixture>>["context"]
  let saved: typeof context.adapter | undefined
  const f = await agentServiceFixture(t, { cleanupOverride: async (_agentId, cleanup) => {
    const record = await cleanup()
    saved ??= { ...context.adapter }
    const forbidden = async (): Promise<never> => { throw new Error("duplicate service observation") }
    context.adapter.readProcess = forbidden; context.adapter.readGroup = forbidden; context.adapter.signalGroup = forbidden
    return record
  } })
  context = f.context
  t.after(() => { if (saved) Object.assign(context.adapter, saved) })
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop)
  assert.equal((await completed(f.service, stop)).command.result?.outcome, "stopped")
  if (saved) Object.assign(context.adapter, saved)
})

test("forced shutdown treats an aborted prompt as settled after verified cleanup", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const pending = f.service.prompt({ ...ready.command.target!, text: "challenge" })
  const rejected = assert.rejects(pending, { code: "STARTUP_FAILED" })
  await f.promptEntered
  await f.service.freezeAndDrain(true)
  await rejected
  await f.service.verifyDischarged()
  assert.equal(f.context.mutations.accepted[0]!.record.phase, "cleanup_verified")
})

test("shutdown settles another held owner before reporting a cleanup failure", async t => {
  const secondEntered = settlementGate(), secondReleased = settlementGate(), firstAttempted = settlementGate()
  let firstId = "", secondId = "", fail = true
  const f = await agentServiceFixture(t, { cleanupOverride: async (agentId, cleanup) => {
    if (agentId === firstId && fail) { firstAttempted.resolve(); throw new Error("CLEANUP_UNVERIFIED") }
    if (agentId === secondId && fail) { secondEntered.resolve(); await secondReleased.promise }
    return cleanup()
  } })
  t.after(() => { fail = false; secondReleased.resolve() })
  firstId = (await completed(f.service, (await f.service.start(f.input)).command)).command.target!.agentId
  secondId = (await completed(f.service, (await f.service.start({ ...f.input, commandId: randomUUID() })).command)).command.target!.agentId
  let settled = false
  const pending = f.service.freezeAndDrain(true)
  void pending.then(() => { settled = true }, () => { settled = true })
  await firstAttempted.promise; await secondEntered.promise
  assert.equal(settled, false)
  secondReleased.resolve()
  await assert.rejects(pending, { code: "INCOMPLETE" })
  assert.equal((await f.store.readAgent(secondId))!.phase, "stopped")
  assert.equal(f.context.mutations.accepted.find(entry => entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === firstId)!.record.phase, "active")
  fail = false
})

test("forged owner result cannot authorize stopped publication", async t => {
  let forge = true
  const f = await agentServiceFixture(t, { cleanupOverride: async (_agentId, cleanup) => {
    const record = await cleanup()
    return forge ? { ...record, handlerGeneration: randomUUID() } : record
  } })
  t.after(() => { forge = false })
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  await assert.rejects(f.service.freezeAndDrain(true), { code: "INCOMPLETE" })
  assert.notEqual((await f.store.readAgent(ready.command.target!.agentId))!.phase, "stopped")
  forge = false
})

test("shutdown waits for timed-out physical admission and prevents its spawn", async t => {
  const f = await agentServiceFixture(t, { pauseCommand: true })
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const accepted = f.service.start(f.input)
  const rejected = assert.rejects(accepted, { code: "STARTUP_TIMEOUT" })
  await f.commandEntered
  t.mock.timers.tick(5001)
  await rejected
  assert.throws(() => f.service.assertOrdinaryShutdownSafe(), { code: "ACTIVE_AGENTS" })
  let settled = false
  const pending = f.service.freezeAndDrain(true)
  void pending.then(() => { settled = true }, () => { settled = true })
  for (let n = 0; n < 16; n++) await Promise.resolve()
  assert.equal(settled, false)
  f.release()
  await assert.rejects(pending, { code: "INCOMPLETE" })
  assert.equal(f.spawns(), 0)
})

test("shutdown does not inventory retained state before stopping live owners", async t => {
  const f = await agentServiceFixture(t)
  await completed(f.service, (await f.service.start(f.input)).command)
  const inventory = f.store.inventory
  f.store.inventory = async () => { throw new Error("pre-drain verification") }
  await f.service.freezeAndDrain(true)
  assert.ok(f.cleanupCalls() > 0)
  f.store.inventory = inventory
})

test("unspawned restore without an owner retains its stopped native session", async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command)
  const stop = { ...ready.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  f.failOwner(true)
  const request = { commandId: randomUUID(), handlerGeneration: stop.handlerGeneration, agentId: stop.agentId, environment: {} }
  await f.service.restore(request)
  const result = await completed(f.service, request)
  assert.equal(result.command.result?.outcome, "failed")
  const record = await f.store.readAgent(stop.agentId)
  assert.equal(record!.phase, "recoverable")
  assert.deepEqual(record!.session, ready.command.result!.session)
  assert.equal(f.spawns(), 1)
})

test("ordinary agent operations use initialized state without inventory scans", async t => {
  const f = await agentServiceFixture(t)
  await f.service.page({ limit: 20 })
  f.store.inventory = async () => { throw new Error("unexpected inventory") }
  const command = await completed(f.service, (await f.service.start(f.input)).command)
  const target = command.command.target!
  assert.equal(command.command.result?.outcome, "started")
  assert.equal((await f.service.commandReceipt(f.input.commandId, f.input.handlerGeneration))?.command.state, "completed")
  assert.equal((await f.service.sessionRecord(target.agentId))?.live, true)
  assert.equal((await f.service.current(f.workspace)).agents.length, 1)
  assert.equal((await f.service.page({ limit: 20 })).agents.length, 1)
  assert.equal((await f.service.list()).agents.length, 1)
  assert.equal((await f.service.prompt({ ...target, text: "continue" })).stopReason, "end_turn")
  await f.service.freezeAndDrain(true)
})

test("startup expiry settles its receipt and preserves unrelated sessions and late cleanup", async t => {
  const released = Promise.withResolvers<void>()
  t.after(() => released.resolve())
  let targetId = "", held = false
  const f = await agentServiceFixture(t, { cleanupOverride: async (agentId, cleanup) => { if (held && agentId === targetId) await released.promise; return cleanup() } })
  const first = await completed(f.service, (await f.service.start(f.input)).command)
  targetId = first.command.target!.agentId
  const stop = { ...first.command.target!, commandId: randomUUID() }
  await f.service.stop(stop); await completed(f.service, stop)
  const healthy = await completed(f.service, (await f.service.start({ ...f.input, commandId: randomUUID() })).command)
  f.pauseRestore("ready"); held = true
  const request = { commandId: randomUUID(), handlerGeneration: f.input.handlerGeneration, agentId: targetId, environment: {} }
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await f.service.restore(request); await f.restoreEntered
  t.mock.timers.tick(40000); t.mock.timers.reset()
  const failed = await until(async () => { const receipt = await f.service.commandReceipt(request.commandId, request.handlerGeneration); return receipt?.command.state === "completed" ? receipt : undefined }, 1500)
  assert.equal(failed.command.result?.failure?.code, "STARTUP_TIMEOUT")
  assert.equal((await f.service.sessionRecord(targetId))?.cleanup, "unverified")
  assert.equal((await f.service.prompt({ ...healthy.command.target!, text: "continue" })).stopReason, "end_turn")
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const draining = f.service.freezeAndDrain(true)
  const incomplete = assert.rejects(draining, { code: "INCOMPLETE" })
  t.mock.timers.tick(40000); t.mock.timers.reset()
  await incomplete
  held = false; released.resolve(); f.release()
  await until(async () => (await f.service.sessionRecord(targetId))?.cleanup === "verified" ? true : undefined)
  assert.notEqual((await f.service.sessionRecord(targetId))?.record.phase, "ready")
})

test("timed-out shutdown cannot capture a prompt admitted after resume", async t => {
  const released = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  t.after(() => released.resolve())
  let targetId = ""
  const f = await agentServiceFixture(t, { prompt: "hang", cleanupOverride: async (agentId, cleanup) => { if (agentId === targetId) { entered.resolve(); await released.promise }; return cleanup() } })
  const first = await completed(f.service, (await f.service.start(f.input)).command)
  targetId = first.command.target!.agentId
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const incomplete = assert.rejects(f.service.freezeAndDrain(true), { code: "INCOMPLETE" })
  await entered.promise
  t.mock.timers.tick(40000); t.mock.timers.reset()
  await incomplete
  f.service.resume()
  const next = await completed(f.service, (await f.service.start({ ...f.input, commandId: randomUUID() })).command)
  const target = next.command.target!, submissionId = randomUUID()
  await f.service.submit(target, { submissionId, text: "continue", limits: { inputBytes: 262144, outputBytes: 786432, encodedTextBytes: 917504, allowEmptyAnswer: true } }); await f.promptEntered
  released.resolve()
  await until(async () => (await f.store.inventory()).commands.some(command => command.op === "stop" && command.target?.agentId === targetId && command.state === "completed") ? true : undefined)
  for (let n = 0; n < 16; n++) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal((await f.service.submission(target, submissionId))?.state, "running")
  f.completePrompt(target.agentId)
  await until(async () => (await f.service.submission(target, submissionId))?.state === "completed" ? true : undefined)
  assert.equal((await f.service.sessionRecord(target.agentId))?.record.phase, "ready")
})

test("initialization and fresh admissions do not inventory historical state", async t => {
  const f = await agentServiceFixture(t)
  const unavailable = { ...f.store, async inventory(): Promise<never> { throw new Error("historical inventory must be explicit") } }
  const service = await f.restart(undefined, unavailable)
  const request = { ...f.input, commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration }
  const ready = await completed(service, (await service.start(request)).command)
  assert.equal(ready.command.result?.outcome, "started")
  await completed(service, (await service.stop({ ...ready.command.target!, commandId: randomUUID() })).command)
  await service.freezeAndDrain(true)
  await service.verifyDischarged()
})

for (const malformed of [false, true]) test(`incomplete historical retirement ${malformed ? "marker" : "object"} does not block fresh work or discharge`, async t => {
  const f = await agentServiceFixture(t)
  const ready = await completed(f.service, (await f.service.start(f.input)).command), agentId = ready.command.target!.agentId
  const service = await f.restart(), marker = join(f.root, "retention/pending.json")
  await mkdir(join(f.root, "retention"), { mode: 0o700 })
  const bytes = malformed ? "{" : JSON.stringify({ version: 1, entries: [{ path: "agents/records/" + agentId + ".json" }] })
  await writeFile(marker, bytes, { mode: 0o600 })
  await assert.rejects(service.sessionRecord(agentId), { code: "INVALID_AGENT_STATE" })
  assert.ok((await service.page({ limit: 100 })).issues.some(issue => issue.message.includes("INCOMPLETE_HISTORY")))
  const next = { ...f.input, commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration }
  await service.start(next)
  assert.equal((await completed(service, next)).command.result?.outcome, "started")
  await service.freezeAndDrain(true); await service.verifyDischarged()
  assert.equal(await readFile(marker, "utf8"), bytes)
})

test("a missing command named by pending retirement cannot be reused or reported absent", async t => {
  const f = await agentServiceFixture(t), marker = join(f.root, "retention/pending.json")
  await mkdir(join(f.root, "retention"), { mode: 0o700 })
  const bytes = JSON.stringify({ version: 1, entries: [{ path: "agents/commands/" + f.input.commandId + ".json" }] })
  await writeFile(marker, bytes, { mode: 0o600 })
  await assert.rejects(f.service.start(f.input), { code: "INVALID_AGENT_STATE" })
  await assert.rejects(f.service.commandReceipt(f.input.commandId, f.input.handlerGeneration), { code: "INVALID_AGENT_STATE" })
  assert.equal(f.spawns(), 0)
  assert.equal(await f.store.readCommand(f.input.commandId), null)
  await f.service.freezeAndDrain(true); await f.service.verifyDischarged()
  assert.equal(await readFile(marker, "utf8"), bytes)
})