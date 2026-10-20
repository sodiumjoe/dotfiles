import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { createHandlerBridge } from "../src/bridge/server.js"
import { registerTaskEndpoint } from "../src/tasks/endpoint.js"
import { TASK_PROTOCOL, parseTaskReply, validateTaskReply, type TaskRequest } from "../src/tasks/protocol.js"
import { createTaskStore } from "../src/tasks/store.js"
import { createTaskService, type TaskService } from "../src/tasks/service.js"
import { privateRoot } from "./control-support.js"
import { sampleTaskRecord, taskHost } from "./task-test-support.js"

test("task endpoint rejects wrong channels and stale identities before effects and remains stable across initialization", async t => {
  const root = await privateRoot(t), generation = randomUUID(), store = createTaskStore({ root, hostId: taskHost }); await store.initialize()
  const record = sampleTaskRecord(); await store.reserve(record)
  const bridge = await createHandlerBridge({ root, identity: { hostId: taskHost, handlerGeneration: generation } }); t.after(() => bridge.close())
  let service: TaskService | undefined, ready = true
  registerTaskEndpoint({ bridge, hostId: taskHost, generation, ready: () => ready, service: () => service })
  const request: TaskRequest = { protocol: TASK_PROTOCOL, requestId: randomUUID(), hostId: taskHost, handlerGeneration: generation, op: "inspect", taskId: record.ref.taskId }
  const send = async (channel: string, value: unknown) => parseTaskReply(await bridge.dispatch(channel, value, new AbortController().signal))
  const unavailable = await send("task-read", request)
  assert.ok(!unavailable.ok); assert.equal(unavailable.error.code, "TASKS_UNAVAILABLE"); assert.deepEqual(unavailable.error.ref, record.ref)
  service = createTaskService({ store, hostId: taskHost, generation, runtime: { beginSession: async () => { throw new Error("forbidden") }, commandReceipt: async () => null, submit: async () => { throw new Error("forbidden") }, submission: async () => null, sessionRecord: async () => null }, environment: () => ({}) })
  t.after(() => service!.close())
  const observed = await send("task-read", request); assert.ok(observed.ok); validateTaskReply(observed, request)
  for (const [changed, code] of [[{ hostId: "b".repeat(64) }, "STALE_HOST"], [{ handlerGeneration: randomUUID() }, "STALE_HANDLER"]] as const) {
    const reply = await send("task-read", { ...request, ...changed }); assert.ok(!reply.ok); assert.equal(reply.error.code, code)
  }
  const mutation = { ...request, op: "report", report: { outcome: "completed", summary: "forbidden" } }
  assert.equal((await send("task-read", mutation)).ok, false); assert.equal(await store.readReport(record.ref.taskId), null)
  ready = false
  const notReady = await send("task-write", mutation); assert.ok(!notReady.ok); assert.equal(notReady.error.code, "NOT_READY")
  assert.throws(() => validateTaskReply({ ...observed, requestId: randomUUID() }, request))
  assert.throws(() => parseTaskReply({ ...observed, result: { ...observed.result, report: { outcome: "yes" } } }))
})