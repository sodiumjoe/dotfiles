import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { agentServiceFixture } from "./agent-support.js"
import { privateRoot, until } from "./control-support.js"
import { sampleTaskRecord, taskHost } from "./task-test-support.js"
import { createTaskStore } from "../src/tasks/store.js"
import { createTaskService, type TaskRuntime } from "../src/tasks/service.js"
import type { TaskCreateInput, TaskRecord } from "../src/tasks/types.js"
import { AgentError, type CommandView } from "../src/agent/types.js"

const input = (cwd: string): TaskCreateInput => ({ taskId: randomUUID(), description: "inspect fixture", cwd, backendId: "codex-acp", text: "held" })
const unused = async (): Promise<never> => { throw new Error("unexpected runtime mutation") }
function inertRuntime(): TaskRuntime { return { beginSession: unused, commandReceipt: async () => null, submit: unused, submission: async () => null, sessionRecord: async () => null } }

test("task adapter launches and submits one ordinary native session and retains explicit reports", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), generation = f.context.state.handlerGeneration
  const store = createTaskStore({ root: f.context.paths.persistentRoot, hostId: taskHost }); await store.initialize()
  const tasks = createTaskService({ store, hostId: taskHost, generation, runtime: f.service, environment: () => f.input.environment })
  t.after(() => tasks.close())
  const request = { ...input(f.input.cwd), parent: { hostId: "b".repeat(64), taskId: randomUUID() }, nativeParams: { mcpServers: [{ name: "user", command: "/bin/false", args: [], env: [] }] } }
  const admitted = await tasks.create(request)
  assert.deepEqual(admitted.ref, { hostId: taskHost, taskId: request.taskId })
  await f.promptEntered
  const observed = await tasks.inspect(request.taskId)
  assert.equal(observed.runtime, "running"); assert.equal(observed.report, null)
  await tasks.report(request.taskId, { outcome: "blocked", summary: "old", issues: ["old issue"] })
  await tasks.report(request.taskId, { outcome: "completed", summary: "explicit report" })
  assert.deepEqual((await tasks.inspect(request.taskId)).report, { outcome: "completed", summary: "explicit report" })
  assert.equal(f.spawns(), 1)
  assert.equal(f.methodHistory.filter(method => method === "session/new").length, 1)
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 1)
  const persisted = await readFile(join(f.context.paths.persistentRoot, "tasks", request.taskId, "record.json"), "utf8")
  assert.ok(!persisted.includes('"text"')); assert.ok(!persisted.includes('"mcpServers"'))
  const restored = createTaskService({ store, hostId: taskHost, generation: randomUUID(), runtime: inertRuntime(), environment: () => ({}) })
  assert.equal((await restored.inspect(request.taskId)).report!.summary, "explicit report")
  await restored.close()
})

test("ordinary end_turn remains pending until an explicit report", async t => {
  const f = await agentServiceFixture(t), store = createTaskStore({ root: f.context.paths.persistentRoot, hostId: taskHost }); await store.initialize()
  const tasks = createTaskService({ store, hostId: taskHost, generation: f.context.state.handlerGeneration, runtime: f.service, environment: () => f.input.environment })
  t.after(() => tasks.close())
  const request = input(f.input.cwd); await tasks.create(request)
  await until(async () => (await tasks.inspect(request.taskId)).runtime === "idle" ? true : undefined)
  assert.equal((await tasks.inspect(request.taskId)).report, null)
})

test("invalid transient input and duplicate reservations admit no second worker", async t => {
  const root = await privateRoot(t), store = createTaskStore({ root, hostId: taskHost }); await store.initialize()
  let launches = 0
  const runtime = { ...inertRuntime(), beginSession: async () => { launches++; throw new AgentError("MODEL_UNAVAILABLE") } }
  const tasks = createTaskService({ store, hostId: taskHost, generation: randomUUID(), runtime, environment: () => ({}) })
  t.after(() => tasks.close())
  for (const request of [{ ...input(root), text: "" }, { ...input(root), nativeParams: { cwd: "/wrong" } }, { ...input(root), description: "x".repeat(16385) }, { ...input(root), nativeParams: { mcpServers: [], extra: "\"".repeat(600000) } }]) await assert.rejects(tasks.create(request))
  assert.deepEqual(await readdir(join(root, "tasks")), []); assert.equal(launches, 0)
  const request = input(root); await tasks.create(request)
  await assert.rejects(tasks.create(request), { code: "TASK_EXISTS" })
  await until(async () => (await tasks.inspect(request.taskId)).record.status === "failed" ? true : undefined)
  assert.equal(launches, 1)
})

for (const kind of ["lost-launch", "unverified", "missing", "failed-submit", "lost-submit", "incomplete", "shutdown"] as const) test(`one-shot task pipeline stops at ${kind}`, async t => {
  const root = await privateRoot(t), store = createTaskStore({ root, hostId: taskHost }); await store.initialize()
  const generation = randomUUID(), target = { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() }
  let launches = 0, submissions = 0
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const command = (id: string): CommandView => ({ state: "command", durability: kind === "unverified" ? "unverified" : "verified", command: { version: 3, hostId: taskHost, commandId: id, handlerGeneration: generation, op: "start", input: {}, agentId: target.agentId, target, state: "completed", result: { outcome: "started", target, failure: null, session: { sessionId: "native", protocolVersion: 1 } } } })
  const runtime: TaskRuntime = { ...inertRuntime(), beginSession: async request => {
    launches++; entered.resolve()
    if (kind === "lost-launch") throw new Error("reply lost")
    if (kind === "incomplete") throw new AgentError("INCOMPLETE")
    if (kind === "shutdown") await gate.promise
    return kind === "missing" ? { ...command(request.commandId), command: { ...command(request.commandId).command, state: "pending", result: null } } : command(request.commandId)
  }, submit: async () => { submissions++; if (kind === "failed-submit") throw new AgentError("BUSY"); throw new Error("reply lost") } }
  const tasks = createTaskService({ store, hostId: taskHost, generation, runtime, environment: () => ({}) }); t.after(() => tasks.close())
  const request = input(root); await tasks.create(request); await entered.promise
  if (kind === "shutdown") { await tasks.close(); gate.resolve() }
  else await until(async () => ["unknown", "failed"].includes((await tasks.inspect(request.taskId)).record.status) ? true : undefined)
  assert.equal((await tasks.inspect(request.taskId)).record.status, kind === "failed-submit" ? "failed" : kind === "shutdown" ? "starting" : "unknown")
  assert.equal(launches, 1); assert.equal(submissions, kind === "failed-submit" || kind === "lost-submit" ? 1 : 0)
  const recreated = createTaskService({ store, hostId: taskHost, generation, runtime: inertRuntime(), environment: () => ({}) })
  assert.equal((await recreated.inspect(request.taskId)).report, null); await recreated.close()
})

test("report survives failed record publication, background updates and missing runtime history", async t => {
  const root = await privateRoot(t), base = createTaskStore({ root, hostId: taskHost }); await base.initialize()
  let fail = false
  const store = { ...base, async writeRecord(record: TaskRecord) { if (fail) throw new Error("injected record publication"); await base.writeRecord(record) } }
  const record = sampleTaskRecord(); await store.reserve(record)
  const tasks = createTaskService({ store, hostId: taskHost, generation: record.launch.handlerGeneration, runtime: inertRuntime(), environment: () => ({}) })
  t.after(() => tasks.close())
  fail = true
  await assert.rejects(tasks.report(record.ref.taskId, { outcome: "completed", summary: "retained" }), { code: "TASK_INCOMPLETE" })
  assert.equal((await tasks.inspect(record.ref.taskId)).report!.summary, "retained")
  const recreated = createTaskService({ store: base, hostId: taskHost, generation: randomUUID(), runtime: inertRuntime(), environment: () => ({}) })
  assert.equal((await recreated.inspect(record.ref.taskId)).report!.summary, "retained"); await recreated.close()
})

test("inspection refuses replacement generations, distinguishes exact failures and never repairs retained state", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), base = createTaskStore({ root: f.context.paths.persistentRoot, hostId: taskHost }); await base.initialize()
  const tasks = createTaskService({ store: base, hostId: taskHost, generation: f.context.state.handlerGeneration, runtime: f.service, environment: () => f.input.environment }); t.after(() => tasks.close())
  const request = input(f.input.cwd); await tasks.create(request); await f.promptEntered
  const record = await until(async () => { const r = await base.read(request.taskId); return r?.status === "running" ? r : undefined })
  const original = (await f.service.sessionRecord(record.session!.agentId))!
  for (const phase of ["failed", "interrupted", "recoverable", "missing", "replaced"] as const) {
    const runtime: TaskRuntime = { ...inertRuntime(), sessionRecord: async () => phase === "missing" ? null : { ...original, record: { ...original.record, phase: phase === "replaced" ? "ready" : phase, launch: { ...original.record.launch!, providerGeneration: phase === "replaced" ? randomUUID() : record.session!.providerGeneration } } } }
    const reader = createTaskService({ store: base, hostId: taskHost, generation: record.launch.handlerGeneration, runtime, environment: () => ({}) })
    assert.equal((await reader.inspect(request.taskId)).runtime, phase === "failed" || phase === "interrupted" ? phase : "unknown")
    assert.deepEqual(await base.read(request.taskId), record)
    await reader.close()
  }
})

test("report queued behind launch publication is preserved by later submission updates", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), base = createTaskStore({ root: f.context.paths.persistentRoot, hostId: taskHost }); await base.initialize()
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  const store = { ...base, async writeRecord(record: TaskRecord) { if (record.stage === "submit") { entered.resolve(); await released.promise }; await base.writeRecord(record) } }
  const tasks = createTaskService({ store, hostId: taskHost, generation: f.context.state.handlerGeneration, runtime: f.service, environment: () => f.input.environment }); t.after(() => tasks.close()); t.after(() => released.resolve())
  const request = input(f.input.cwd); await tasks.create(request); await entered.promise
  const published = tasks.report(request.taskId, { outcome: "completed", summary: "early report" })
  released.resolve(); await published; await f.promptEntered
  await until(async () => (await base.read(request.taskId))?.stage === null ? true : undefined)
  assert.equal((await base.read(request.taskId))!.status, "reported")
  assert.equal((await tasks.inspect(request.taskId)).report!.summary, "early report")
})

test("failed post-admission task publication prevents initial submission and shutdown bounds held writes", async t => {
  const f = await agentServiceFixture(t), base = createTaskStore({ root: f.context.paths.persistentRoot, hostId: taskHost }); await base.initialize()
  const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>()
  const store = { ...base, async writeRecord(record: TaskRecord) { if (record.stage === "submit") { entered.resolve(); await held.promise }; throw new Error("publication failure") } }
  const tasks = createTaskService({ store, hostId: taskHost, generation: f.context.state.handlerGeneration, runtime: f.service, environment: () => f.input.environment })
  const request = input(f.input.cwd); await tasks.create(request); await entered.promise
  await tasks.close(); held.resolve()
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 0)
  const reader = createTaskService({ store: base, hostId: taskHost, generation: f.context.state.handlerGeneration, runtime: inertRuntime(), environment: () => ({}) })
  assert.equal((await reader.inspect(request.taskId)).runtime, "unknown"); await reader.close()
})