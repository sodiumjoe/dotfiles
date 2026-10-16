import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import { sampleTaskRecord, taskHost } from "./task-test-support.js"
import { createTaskStore } from "../src/tasks/store.js"
import { createTaskService, type TaskRuntime } from "../src/tasks/service.js"
import { parseTaskReply, TASK_PROTOCOL } from "../src/tasks/protocol.js"
import type { TaskObservation } from "../src/tasks/types.js"
import { runningTaskSession } from "./task-readiness-support.js"

test("session-dependent readiness requires a recorded tuple", async () => {
  const record = sampleTaskRecord()
  const value: TaskObservation = { ref: record.ref, record, report: null, runtime: "running", issue: null }
  assert.equal(runningTaskSession(value), undefined)
  const session = { agentId: randomUUID(), handlerGeneration: record.launch.handlerGeneration, providerGeneration: randomUUID() }
  const ready = { ...value, record: { ...record, session } }
  assert.equal(runningTaskSession(ready), ready)
  for (const runtime of ["starting", "idle", "failed", "interrupted", "unknown"] as const) {
    assert.equal(runningTaskSession({ ...ready, runtime }), undefined)
  }
  await assert.rejects(until(async () => runningTaskSession(value), 35), /fixture observation timed out/)
})

test("inspection can observe running after capturing a null-session record", { timeout: 30000 }, async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const generation = f.context.state.handlerGeneration
  const base = createTaskStore({ root: f.context.paths.persistentRoot, hostId: taskHost })
  await base.initialize()
  let reservations = 0, recordWrites = 0
  const store = { ...base,
    reserve: async (record: Parameters<typeof base.reserve>[0]) => { reservations++; return base.reserve(record) },
    writeRecord: async (record: Parameters<typeof base.writeRecord>[0]) => { recordWrites++; return base.writeRecord(record) },
  }
  const beginEntered = Promise.withResolvers<void>(), beginRelease = Promise.withResolvers<void>()
  const readEntered = Promise.withResolvers<void>(), readRelease = Promise.withResolvers<void>()
  let capture = true, launches = 0, submissions = 0
  const runtime: TaskRuntime = {
    ...f.service,
    beginSession: async request => {
      launches++; beginEntered.resolve(); await beginRelease.promise
      return f.service.beginSession(request)
    },
    commandReceipt: async (commandId, commandGeneration) => {
      if (capture) { capture = false; readEntered.resolve(); await readRelease.promise }
      return f.service.commandReceipt(commandId, commandGeneration)
    },
    submit: async (target, request) => { submissions++; return f.service.submit(target, request) },
  }
  const tasks = createTaskService({ store, hostId: taskHost, generation, runtime, environment: () => f.input.environment })
  try {
    const taskId = randomUUID()
    await tasks.create({ taskId, description: "controlled observation", cwd: f.input.cwd, backendId: "codex-acp", text: "held" })
    await beginEntered.promise
    const inspection = tasks.inspect(taskId)
    await readEntered.promise
    beginRelease.resolve()
    await f.promptEntered
    const published = await until(async () => { const value = await store.read(taskId); return value?.status === "running" ? value : undefined })
    assert.ok(published.session)
    const path = join(f.context.paths.persistentRoot, "tasks", taskId, "record.json")
    const before = await readFile(path, "utf8")
    const mutationsBefore = { reservations, recordWrites }
    assert.deepEqual(mutationsBefore, { reservations: 1, recordWrites: 2 })
    readRelease.resolve()
    const captured = await inspection
    assert.equal(captured.runtime, "running")
    assert.equal(captured.record.status, "starting")
    assert.equal(captured.record.session, null)
    assert.equal(runningTaskSession(captured), undefined)
    const parsed = parseTaskReply({ protocol: TASK_PROTOCOL, requestId: randomUUID(), hostId: taskHost, handlerGeneration: generation, op: "inspect", ok: true, result: captured })
    assert.ok(parsed.ok)
    assert.equal(parsed.result.record.session, null)
    const current = await tasks.inspect(taskId)
    assert.equal(current.runtime, "running")
    assert.deepEqual(current.record.session, published.session)
    assert.equal(runningTaskSession(current), current)
    assert.equal(await readFile(path, "utf8"), before)
    assert.deepEqual({ reservations, recordWrites }, mutationsBefore)
    assert.equal(launches, 1); assert.equal(submissions, 1)
    assert.equal(f.spawns(), 1)
    assert.equal(f.methodHistory.filter(method => method === "session/new").length, 1)
    assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 1)
  } finally {
    beginRelease.resolve(); readRelease.resolve(); await tasks.close()
  }
})