import assert from "node:assert/strict"
import { test } from "node:test"
import { PassThrough } from "node:stream"
import { randomUUID } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { serveMcp } from "../src/mcp/server.js"
import { createTaskToolBindings, taskToolSchemas, taskToolDescriptor } from "../src/tasks/mcp.js"
import { createHostTaskClient } from "../src/tasks/client.js"
import { createTaskStore } from "../src/tasks/store.js"
import { createTaskService } from "../src/tasks/service.js"
import { registerTaskEndpoint } from "../src/tasks/endpoint.js"
import { TASK_REPORT_BYTES } from "../src/tasks/types.js"
import { taskMcpPeer, taskHost } from "./task-test-support.js"
import { runtimeNetwork } from "./host-runtime-support.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"

test("ordinary task MCP tools compose native configuration, explicit reports and repeatable waits", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), network = await runtimeNetwork(t), node = await network.add("owner", "a", f.service.handlerGeneration)
  const store = createTaskStore({ root: f.context.paths.persistentRoot, hostId: taskHost }); await store.initialize()
  const tasks = createTaskService({ store, runtime: f.service, hostId: taskHost, generation: node.generation, environment: () => f.input.environment, descriptor: taskToolDescriptor }); t.after(() => tasks.close())
  registerTaskEndpoint({ bridge: node.bridge, service: () => tasks, hostId: taskHost, generation: node.generation, ready: () => true })
  const client = createHostTaskClient({ localHostId: taskHost, route: (r, signal) => node.router.request(r, signal) }); t.after(() => client.close())
  const taskId = randomUUID(), ref = { hostId: taskHost, taskId }, bindings = createTaskToolBindings({ client, defaultRef: ref })
  const input = new PassThrough(), output = new PassThrough(), serving = serveMcp({ input, output, schemas: taskToolSchemas, call: bindings.call, serverInfo: { name: "agency_tasks", version: "1.0.0" } }), peer = taskMcpPeer(output, input)
  t.after(async () => { peer.close(); await serving })
  assert.equal((await peer.initialize()).serverInfo.name, "agency_tasks")
  const listed = await peer.request("tools/list").result
  assert.deepEqual(listed.tools.map((tool: any) => tool.name).sort(), ["agency_task_create", "agency_task_inspect", "agency_task_report", "agency_task_wait"].sort())
  const request = { taskId, description: "MCP task", cwd: f.workspace, backendId: "codex-acp", text: "held", nativeParams: { mcpServers: [{ name: "external", command: "/bin/false", args: [], env: [] }] } }
  assert.equal((await peer.call("agency_task_create", { hostId: taskHost, input: request })).isError, false); await f.promptEntered
  const native = f.methodHistory.filter(x => x === "session/new"); assert.equal(native.length, 1)
  const pending = peer.request("tools/call", { name: "agency_task_wait", arguments: { ref, timeoutMs: 60000 } })
  peer.notify("notifications/cancelled", { requestId: pending.id })
  assert.equal(JSON.parse((await pending.result).content[0].text).state, "cancelled")
  assert.equal((await f.service.sessionRecord((await client.inspect(ref)).record.session!.agentId))!.live, true)
  for (const outcome of ["failed", "blocked", "completed"]) {
    const result = await peer.call("agency_task_report", { report: { outcome, summary: outcome } }); assert.equal(result.isError, false)
    const first = await peer.call("agency_task_wait", { ref, timeoutMs: 0 }); assert.equal(first.isError, false)
    assert.deepEqual(await peer.call("agency_task_wait", { ref, timeoutMs: 0 }), first)
  }
  assert.equal((await peer.call("agency_task_report", { ref: { ...ref, taskId: randomUUID() }, report: { outcome: "completed", summary: "forged" } })).isError, true)
  assert.equal((await peer.call("agency_task_wait", { ref, timeoutMs: 1, waitId: randomUUID() })).isError, true)
  assert.equal((await peer.call("agency_task_wait", { ref, timeoutMs: 60001 })).isError, true)
  assert.equal((await peer.call("agency_task_create", { hostId: taskHost, input: { ...request, taskId: randomUUID(), nativeParams: { mcpServers: [taskToolDescriptor(ref)] } } })).isError, true)
  assert.equal(f.spawns(), 1)
  assert.deepEqual((await readdir(join(f.context.paths.persistentRoot, "tasks"))), [taskId])
  const maximum = { outcome: "completed", summary: 'λ"\\\n'.repeat(20000) }
  maximum.summary += "x".repeat(TASK_REPORT_BYTES - Buffer.byteLength(JSON.stringify(maximum)))
  assert.equal(Buffer.byteLength(JSON.stringify(maximum)), TASK_REPORT_BYTES)
  const big = await peer.call("agency_task_report", { report: maximum }); assert.equal(big.isError, false); assert.deepEqual(JSON.parse(big.content[0].text).report, maximum)
  assert.deepEqual(JSON.parse((await peer.call("agency_task_inspect", { ref })).content[0].text).report, maximum)
  const replacements = await Promise.all([peer.call("agency_task_report", { report: { outcome: "completed", summary: "first", issues: ["old"] } }), peer.call("agency_task_report", { report: { outcome: "completed", summary: "second" } })])
  assert.ok(replacements.every(x => !x.isError)); assert.deepEqual((await client.inspect(ref)).report, { outcome: "completed", summary: "second" })
  assert.equal(f.methodHistory.filter(x => x === "session/prompt").length, 1)
  peer.close(); await serving
})

test("MCP EOF aborts request-local waits and unavailability retains its reference", async () => {
  let signal: AbortSignal | undefined
  const client = { create: async (): Promise<never> => { throw new Error("offline") }, report: async (): Promise<never> => { throw new Error("offline") }, inspect: async (_ref: any, s?: AbortSignal): Promise<never> => { signal = s; return new Promise(() => {}) }, close() {} }
  const bindings = createTaskToolBindings({ client }), input = new PassThrough(), output = new PassThrough(), serving = serveMcp({ input, output, schemas: taskToolSchemas, call: bindings.call, serverInfo: { name: "tasks", version: "1" } }), peer = taskMcpPeer(output, input)
  await peer.initialize(); const ref = { hostId: taskHost, taskId: randomUUID() }
  const request = peer.request("tools/call", { name: "agency_task_wait", arguments: { ref, timeoutMs: 60000 } })
  await until(async () => signal ? true : undefined); peer.close(); await serving
  assert.equal(signal!.aborted, true); assert.equal(JSON.parse((await request.result).content[0].text).state, "cancelled")
  const offline = createTaskToolBindings({ client: { ...client, inspect: async () => { throw new Error("offline") } } })
  const result = await offline.call("agency_task_inspect", { ref }); assert.equal(result.isError, true); assert.deepEqual(JSON.parse(result.content[0]!.text).error.ref, ref)
})