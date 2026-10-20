import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { createHostTaskClient, TaskOutcomeUnknown } from "../src/tasks/client.js"
import { createTaskStore } from "../src/tasks/store.js"
import { createTaskService } from "../src/tasks/service.js"
import { registerTaskEndpoint } from "../src/tasks/endpoint.js"
import { waitForTask } from "../src/tasks/wait.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import { runtimeNetwork } from "./host-runtime-support.js"
import { sampleTaskRecord, taskHost } from "./task-test-support.js"
import { TASK_PROTOCOL, parseTaskRequest, type TaskRequest } from "../src/tasks/protocol.js"
import { BRIDGE_FRAME_BYTES } from "../src/bridge/protocol.js"

for (const relay of [false, true]) test(`task mutations survive lost replies over ${relay ? "A-laptop-B" : "direct"} routes`, async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), net = await runtimeNetwork(t)
  const laptop = await net.add("laptop", "1"), a = await net.add("worker-a", "2"), b = await net.add("worker-b", "a", f.service.handlerGeneration)
  for (const node of [laptop, a, b]) node.bridge.register(["runtime-read"], async () => ({}))
  const store = createTaskStore({ root: f.context.paths.persistentRoot, hostId: taskHost }); await store.initialize()
  const tasks = createTaskService({ store, runtime: f.service, hostId: taskHost, generation: b.generation, environment: () => f.input.environment }); t.after(() => tasks.close())
  registerTaskEndpoint({ bridge: b.bridge, service: () => tasks, hostId: taskHost, generation: b.generation, ready: () => true })
  laptop.hosts.push(a.enrollment, b.enrollment); if (!relay) a.hosts.push(b.enrollment)
  if (relay) await laptop.router.request({ hostId: a.enrollment.hostId, channel: "host-identity", payload: {} })
  let drop = true, writes = 0
  const client = createHostTaskClient({ localHostId: a.enrollment.hostId, route: async (route, signal) => { const result = await a.router.request(route, signal); if (route.channel === "task-write") { writes++; if (drop) throw new Error("lost reply") }; return result } })
  const input = { taskId: randomUUID(), description: "remote worker", cwd: f.workspace, backendId: "codex-acp" as const, text: "held" }, ref = { hostId: taskHost, taskId: input.taskId }
  await assert.rejects(client.create(taskHost, input), e => e instanceof TaskOutcomeUnknown && e.ref.taskId === ref.taskId)
  await f.promptEntered
  await until(async () => { const value = await client.inspect(ref); return value.runtime === "running" && value.record.status === "running" ? true : undefined })
  const before = await readdir(join(f.context.paths.persistentRoot, "tasks", ref.taskId)), controller = new AbortController()
  assert.deepEqual(before, ["record.json"])
  const waiting = waitForTask(client, ref, { timeoutMs: 60000, signal: controller.signal }); controller.abort()
  assert.equal((await waiting).state, "cancelled"); const target = (await tasks.inspect(ref.taskId)).record.session!
  assert.equal((await f.service.sessionRecord(target.agentId))!.live, true)
  await assert.rejects(client.report(ref, { outcome: "completed", summary: "saved" }), TaskOutcomeUnknown)
  drop = false
  const first = await waitForTask(client, ref, { timeoutMs: 0 }); assert.equal(first.state, "reported")
  assert.deepEqual(await waitForTask(client, ref, { timeoutMs: 0 }), first)
  assert.equal(writes, 2); assert.equal(f.spawns(), 1); assert.equal(f.methodHistory.filter(v => v === "session/prompt").length, 1)
  assert.deepEqual(await readdir(join(f.context.paths.persistentRoot, "tasks", ref.taskId)), [...before, "report.json"].sort())
  if (relay) laptop.router.close()
  await tasks.report(ref.taskId, { outcome: "completed", summary: "offline correction" })
  const fresh = await b.connect(b.enrollment)
  const local = createHostTaskClient({ localHostId: taskHost, route: (r, signal) => fresh.request(r.channel, r.payload, { ...(signal ? { signal } : {}) }) })
  assert.equal((await local.inspect(ref)).report!.summary, "offline correction"); local.close(); fresh.close(); client.close()
})
for (const change of ["host", "generation", "request", "task", "rejection"]) test(`strict task client checks ${change}`, async () => {
  const record = sampleTaskRecord(), ref = record.ref, generation = randomUUID()
  const client = createHostTaskClient({ localHostId: taskHost, route: async route => {
    if (route.channel === "host-identity") return { hostId: taskHost, handlerGeneration: generation }
    const r = route.payload as TaskRequest, reply: any = { protocol: r.protocol, requestId: r.requestId, hostId: taskHost, handlerGeneration: generation, op: r.op, ok: true, result: { ref, record, report: null, runtime: "starting", issue: null } }
    if (change === "host") reply.hostId = "b".repeat(64)
    if (change === "generation") reply.handlerGeneration = randomUUID()
    if (change === "request") reply.requestId = randomUUID()
    if (change === "task") reply.result = { ...reply.result, ref: { ...ref, taskId: randomUUID() } }
    if (change === "rejection") return { protocol: r.protocol, requestId: r.requestId, hostId: taskHost, handlerGeneration: generation, op: r.op, ok: false, error: { code: "TASK_EXISTS", message: "Task ID is already reserved; inspect the existing task", ref } }
    return reply
  } })
  const request = { taskId: ref.taskId, description: "x", cwd: "/tmp", backendId: "codex-acp" as const, text: "x" }
  if (change === "rejection") await assert.rejects(client.create(taskHost, request), { code: "TASK_EXISTS" })
  else await assert.rejects(client.create(taskHost, request), e => e instanceof TaskOutcomeUnknown && e.ref.taskId === ref.taskId)
})
test("serialized escaped request boundary is exact and oversized client input sends nothing", async () => {
  const input = { taskId: randomUUID(), description: "boundary", cwd: "/tmp", backendId: "codex-acp" as const, text: "x", nativeParams: { extra: "" } }
  const request = { protocol: TASK_PROTOCOL, requestId: randomUUID(), hostId: taskHost, handlerGeneration: randomUUID(), op: "create", input }
  const spare = BRIDGE_FRAME_BYTES - 4096 - Buffer.byteLength(JSON.stringify(request))
  input.nativeParams.extra = "\\".repeat(Math.floor(spare / 2)) + (spare % 2 ? "λ" : "")
  if (spare % 2) input.nativeParams.extra = input.nativeParams.extra.slice(0, -1) + "x"
  assert.equal(Buffer.byteLength(JSON.stringify(request)), BRIDGE_FRAME_BYTES - 4096)
  assert.equal(parseTaskRequest(request).op, "create")
  input.nativeParams.extra += "x"
  assert.throws(() => parseTaskRequest(request), { code: "INPUT_TOO_LARGE" })
  let sends = 0
  const client = createHostTaskClient({ localHostId: taskHost, route: async () => { sends++; throw new Error("sent") } })
  await assert.rejects(client.create(taskHost, { ...input, nativeParams: { extra: '"'.repeat(BRIDGE_FRAME_BYTES) } }), { code: "INPUT_TOO_LARGE" })
  assert.equal(sends, 0)
})