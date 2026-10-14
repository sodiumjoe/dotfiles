import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentServiceFixture } from "./agent-support.js"
import { privateRoot, until } from "./control-support.js"
import { sampleTaskRecord, taskHost } from "./task-test-support.js"
import { createTaskStore } from "../src/tasks/store.js"
import { createTaskService, type TaskRuntime } from "../src/tasks/service.js"
import type { TaskCreateInput, TaskRecord } from "../src/tasks/types.js"
import { waitForTask } from "../src/tasks/wait.js"
import { AgentError, agentFailure, type CommandView } from "../src/agent/types.js"

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

for (const stage of ["launch", "submit"] as const) test(`persisted ${stage} rejection remains failed across restart without runtime history`, async t => {
  const root = await privateRoot(t), store = createTaskStore({ root, hostId: taskHost }); await store.initialize()
  const generation = randomUUID(), target = { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() }
  let launches = 0, submissions = 0, restoredCalls = 0
  const runtime: TaskRuntime = { ...inertRuntime(), beginSession: async request => {
    launches++
    if (stage === "launch") throw new AgentError("MODEL_UNAVAILABLE")
    return { state: "command", durability: "verified", command: { version: 3, hostId: taskHost, commandId: request.commandId, handlerGeneration: generation, op: "start", input: {}, agentId: target.agentId, target, state: "completed", result: { outcome: "started", target, failure: null, session: { sessionId: "native", protocolVersion: 1 } } } }
  }, submit: async () => { submissions++; throw new AgentError("BUSY") } }
  const tasks = createTaskService({ store, hostId: taskHost, generation, runtime, environment: () => ({}) }); t.after(() => tasks.close())
  const request = input(root), ref = (await tasks.create(request)).ref
  await until(async () => (await store.read(request.taskId))?.status === "failed" ? true : undefined)
  assert.equal((await waitForTask({ inspect: ref => tasks.inspect(ref.taskId) }, ref, { timeoutMs: 0 })).state, "failed")
  await tasks.close()
  const recordPath = join(root, "tasks", ref.taskId, "record.json"), before = await readFile(recordPath)
  const forbidden = async (): Promise<never> => { restoredCalls++; throw new Error("runtime access after retained failure") }
  const restored = createTaskService({ store, hostId: taskHost, generation: randomUUID(), environment: () => ({}), runtime: { beginSession: forbidden, submit: forbidden, commandReceipt: forbidden, submission: forbidden, sessionRecord: forbidden } }); t.after(() => restored.close())
  assert.equal((await restored.inspect(ref.taskId)).runtime, "failed")
  for (let i = 0; i < 2; i++) assert.equal((await waitForTask({ inspect: ref => restored.inspect(ref.taskId) }, ref, { timeoutMs: 0 })).state, "failed")
  assert.deepEqual(await readFile(recordPath), before)
  await store.writeReport(ref.taskId, { outcome: "completed", summary: "retained report wins" })
  const reported = await waitForTask({ inspect: ref => restored.inspect(ref.taskId) }, ref, { timeoutMs: 0 })
  assert.equal(reported.state, "reported"); assert.ok("observation" in reported); assert.equal(reported.observation.report!.summary, "retained report wins")
  assert.deepEqual(await readFile(recordPath), before)
  assert.equal(launches, 1); assert.equal(submissions, stage === "submit" ? 1 : 0); assert.equal(restoredCalls, 0)
})

for (const backend of ["absent", "disabled"] as const) test(`definite ${backend} backend rejection ends the task without launching a provider`, async t => {
  const f = await agentServiceFixture(t), store = createTaskStore({ root: f.context.paths.persistentRoot, hostId: taskHost }); await store.initialize()
  if (backend === "disabled") await writeFile(join(f.root, "catalog", "providers.json"), JSON.stringify({ version: 1, providers: [{ ...f.profile, enabled: false }] }), { mode: 0o600 })
  const tasks = createTaskService({ store, hostId: taskHost, generation: f.context.state.handlerGeneration, runtime: f.service, environment: () => f.input.environment }); t.after(() => tasks.close())
  const request = { ...input(f.workspace), backendId: backend === "absent" ? "claude-agent-acp" as const : "codex-acp" as const }, ref = (await tasks.create(request)).ref
  const record = await until(async () => { const value = await store.read(ref.taskId); return value && ["failed", "unknown"].includes(value.status) ? value : undefined })
  assert.equal(record.status, "failed"); assert.equal(record.issue!.code, "UNAVAILABLE")
  for (let i = 0; i < 2; i++) assert.equal((await waitForTask({ inspect: ref => tasks.inspect(ref.taskId) }, ref, { timeoutMs: 0 })).state, "failed")
  assert.equal(f.spawns(), 0)
})

for (const operation of ["receipt-read", "receipt-failure", "submit"] as const) test(`unavailable ${operation} distinguishes unknown reads from terminal rejection`, async t => {
  const root = await privateRoot(t), store = createTaskStore({ root, hostId: taskHost }); await store.initialize()
  const generation = randomUUID(), target = { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() }
  let launches = 0, submissions = 0
  const command = (commandId: string, pending: boolean): CommandView => ({ state: "command", durability: "verified", command: { version: 3, hostId: taskHost, commandId, handlerGeneration: generation, op: "start", input: {}, agentId: target.agentId, target, state: pending ? "pending" : "completed", result: pending ? null : { outcome: "started", target, failure: null, session: { sessionId: "native", protocolVersion: 1 } } } })
  const runtime: TaskRuntime = { ...inertRuntime(), beginSession: async request => { launches++; return command(request.commandId, operation !== "submit") }, commandReceipt: async commandId => {
    if (operation === "receipt-read") throw new AgentError("UNAVAILABLE")
    const view = command(commandId, false)
    return { ...view, command: { ...view.command, result: { outcome: "failed", target, failure: agentFailure(new AgentError("UNAVAILABLE")), session: null } } }
  }, submit: async () => { submissions++; throw new AgentError("UNAVAILABLE") } }
  const tasks = createTaskService({ store, hostId: taskHost, generation, runtime, environment: () => ({}) }); t.after(() => tasks.close())
  const ref = (await tasks.create(input(root))).ref
  const record = await until(async () => { const value = await store.read(ref.taskId); return value && ["failed", "unknown"].includes(value.status) ? value : undefined })
  assert.equal(record.status, operation === "receipt-read" ? "unknown" : "failed")
  assert.equal(record.issue!.code, operation === "receipt-read" ? "OUTCOME_UNKNOWN" : "UNAVAILABLE")
  assert.equal((await waitForTask({ inspect: ref => tasks.inspect(ref.taskId) }, ref, { timeoutMs: 0 })).state, operation === "receipt-read" ? "pending" : "failed")
  assert.equal(launches, 1); assert.equal(submissions, operation === "submit" ? 1 : 0)
})

for (const code of ["INCOMPLETE", "CLEANUP_UNVERIFIED"] as const) test(`verified terminal ${code} receipt remains a known failure after restart`, async t => {
  const root = await privateRoot(t), store = createTaskStore({ root, hostId: taskHost }); await store.initialize()
  const generation = randomUUID(), agentId = randomUUID()
  const runtime: TaskRuntime = { ...inertRuntime(), beginSession: async request => ({ state: "command", durability: "verified", command: { version: 3, hostId: taskHost, commandId: request.commandId, handlerGeneration: generation, op: "start", input: {}, agentId, target: null, state: "completed", result: { outcome: "failed", target: null, failure: agentFailure(new AgentError(code)), session: null } } }) }
  const tasks = createTaskService({ store, hostId: taskHost, generation, runtime, environment: () => ({}) }); t.after(() => tasks.close())
  const ref = (await tasks.create(input(root))).ref
  const record = await until(async () => { const value = await store.read(ref.taskId); return value && ["failed", "unknown"].includes(value.status) ? value : undefined })
  assert.equal(record.status, "failed"); assert.equal(record.issue!.code, code)
  await tasks.close()
  const restored = createTaskService({ store, hostId: taskHost, generation: randomUUID(), runtime: inertRuntime(), environment: () => ({}) }); t.after(() => restored.close())
  assert.equal((await waitForTask({ inspect: ref => restored.inspect(ref.taskId) }, ref, { timeoutMs: 0 })).state, "failed")
})