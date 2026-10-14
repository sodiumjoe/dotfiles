import { createAgentStore } from "../src/agent/store.js"
import { createHostRuntimeClient } from "../src/hosts/runtime.js"
import { fixtureLaunch, fixtureSpawn } from "./fixtures/ownership.js"
import { runtimeNetwork } from "./host-runtime-support.js"
import { taskMcpPeer } from "./task-test-support.js"
import { taskToolDescriptor } from "../src/tasks/mcp.js"
import { createTaskStore } from "../src/tasks/store.js"
import { createTaskService } from "../src/tasks/service.js"
import { TaskError } from "../src/tasks/types.js"
import { createHostTaskClient } from "../src/tasks/client.js"
import { waitForTask } from "../src/tasks/wait.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { acpFixture } from "./acp-support.js"
import { until, fileExists } from "./control-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { connectBridge } from "../src/bridge/ssh.js"
import { TASK_PROTOCOL, parseTaskReply } from "../src/tasks/protocol.js"

for (const tasks of ["hold", "reject"] as const) test(`task initialization ${tasks} preserves core and advertised capabilities`, { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { tasks, coordination: "reject" })
  await until(async () => await fileExists(join(f.root, "tasks-entered")) ? true : undefined)
  const record = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json")), hostId = f.paths.hostKey
  const transport = await connectBridge({ inventoryId: randomUUID(), hostId, hostname: "fixture", agyPath: "/opt/agy", loginShell: "/bin/sh" }, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read", "task-read", "task-write"], processFactory: () => spawn(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-remote.js", import.meta.url)), JSON.stringify({ root: f.paths.runtimeRoot, hostId, handlerGeneration: record.generation })], { stdio: ["pipe", "pipe", "pipe"] }) })
  t.after(() => transport.close())
  const taskId = randomUUID(), request = { protocol: TASK_PROTOCOL, requestId: randomUUID(), hostId, handlerGeneration: record.generation, op: "inspect", taskId }
  const call = async () => parseTaskReply(await transport.request("task-read", request))
  const unavailable = await call(); assert.ok(!unavailable.ok); assert.equal(unavailable.error.code, "TASKS_UNAVAILABLE")
  const peer = await f.connect(), initialized = await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  assert.equal(initialized.protocolVersion, 1)
  peer.close()
  if (tasks === "hold") {
    await writeFile(join(f.root, "release-tasks"), "released", { mode: 0o600 })
    const missing = await until(async () => { const reply = await call(); return !reply.ok && reply.error.code === "TASK_NOT_FOUND" ? reply : undefined })
    assert.ok(!missing.ok)
  }
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})

test("Handler shutdown completes while task initialization remains held", { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { tasks: "hold", coordination: "hold" })
  await until(async () => await fileExists(join(f.root, "tasks-entered")) ? true : undefined)
  await f.verifyZeroSurvivors()
})
test("routed Handler task reports through its configured local helper with relay absent", { timeout: 90000 }, async t => {
  const f = await acpFixture(t, { coordination: "hold" }), record = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json")), hostId = f.paths.hostKey
  const local = await connectHandlerBridge({ root: f.paths.runtimeRoot, hostId, handlerGeneration: record.generation }); t.after(() => local.close())
  const owner = createHostTaskClient({ localHostId: hostId, route: (route, signal) => local.request(route.channel, route.payload, { ...(signal ? { signal } : {}) }) }); t.after(() => owner.close())
  const taskId = randomUUID(), ref = { hostId, taskId }
  await until(async () => { try { await owner.inspect(ref) } catch (error) { return error instanceof TaskError && error.code === "TASK_NOT_FOUND" ? true : undefined } })
  const net = await runtimeNetwork(t), laptop = await net.add("laptop", "1"), source = await net.add("source", "2"), target = await net.add("owner", "a", record.generation)
  for (const node of [source, target]) node.bridge.register(["runtime-read"], async () => ({}))
  target.bridge.register(["task-read", "task-write"], ({ channel, payload, signal }) => local.request(channel, payload, { signal }))
  laptop.hosts.push(source.enrollment, target.enrollment)
  await laptop.router.request({ hostId: source.enrollment.hostId, channel: "host-identity", payload: {} })
  let output = ""
  const code = await runControl(["task", "create", "--host", hostId, "--json", "--input-json", JSON.stringify({ taskId, description: "real worker", cwd: f.workspace, backendId: "codex-acp", text: "held", nativeParams: { mcpServers: [{ name: "external", command: "/bin/false", args: [], env: [] }] } })], { ...productionControlDependencies(), environment: async () => ({ paths: { hostKey: source.enrollment.hostId, persistentRoot: source.root, runtimeRoot: source.root, handlerSocketPath: join(source.root, "handler.sock") }, adapter: f.adapter }), inspect: async () => ({ disposition: "live", record: { phase: "ready", generation: source.generation } } as never), hostInventory: () => ({ list: async () => [], enroll: async () => { throw new Error("forbidden") } }), stdout: v => { output = v } })
  assert.equal(code, 0, output)
  await until(async () => (await f.requests("codex-acp")).some(frame => frame.method === "session/prompt") ? true : undefined)
  const session = (await f.requests("codex-acp")).find(frame => frame.method === "session/new")!
  const servers = session.params!.mcpServers as any[], descriptor = servers.find(server => server.name === "agency_tasks")
  assert.deepEqual(descriptor, taskToolDescriptor(ref)); const configured = descriptor as { command: string; args: string[]; env: Array<{ name: string; value: string }> }; assert.equal(servers[0].name, "external"); assert.equal(servers.length, 2)
  laptop.router.close()
  const helper = spawn(configured.command, [fileURLToPath(new URL("./fixtures/task-tools.js", import.meta.url)), ...configured.args, JSON.stringify(f.paths)], { env: { ...process.env, ...Object.fromEntries(configured.env.map((item: any) => [item.name, item.value])) }, stdio: ["pipe", "pipe", "pipe"] })
  await fixtureSpawn(fixtureLaunch("task-tools"), helper.pid)
  await appendFile(join(f.root, "tools-helpers.jsonl"), JSON.stringify({ pid: helper.pid }) + "\n", { mode: 0o600 })
  const exited = new Promise<number | null>(resolve => helper.once("exit", resolve)), peer = taskMcpPeer(helper.stdout, helper.stdin)
  t.after(async () => { peer.close(); helper.kill(); await exited })
  await peer.initialize()
  const published = await peer.call("agency_task_report", { report: { outcome: "completed", summary: "worker-local report" } }); assert.equal(published.isError, false)
  const files = await readdir(join(f.paths.persistentRoot, "tasks", taskId)); assert.deepEqual(files.sort(), ["record.json", "report.json"])
  const fresh = await connectHandlerBridge({ root: f.paths.runtimeRoot, hostId, handlerGeneration: record.generation }), client = createHostTaskClient({ localHostId: hostId, route: (r, signal) => fresh.request(r.channel, r.payload, { ...(signal ? { signal } : {}) }) })
  t.after(() => { client.close(); fresh.close() })
  const first = await waitForTask(client, ref, { timeoutMs: 0 }); assert.equal(first.state, "reported"); assert.deepEqual(await waitForTask(client, ref, { timeoutMs: 0 }), first)
  const second = await client.create(hostId, { taskId: randomUUID(), description: "cancel wait", cwd: f.workspace, backendId: "codex-acp", text: "held" })
  await until(async () => (await client.inspect(second.ref)).runtime === "running" ? true : undefined)
  const controller = new AbortController(), waiting = waitForTask(client, second.ref, { timeoutMs: 60000, signal: controller.signal }); controller.abort(); assert.equal((await waiting).state, "cancelled")
  const target2 = (await client.inspect(second.ref)).record.session!, runtime = createHostRuntimeClient({ localHostId: hostId, route: (r, signal) => fresh.request(r.channel, r.payload, { ...(signal ? { signal } : {}) }) })
  const inspected = await runtime.session(hostId, { op: "agent_session_inspect", agentId: target2.agentId }); assert.ok(inspected.state === "session" && inspected.agent?.live)
  for (const task of [ref, second.ref]) {
    const target = (await client.inspect(task)).record.session!
    await runtime.session(hostId, { op: "agent_stop", input: { ...target, commandId: randomUUID() } })
  }
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/new").length, 2)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/prompt").length, 2)
  peer.close(); assert.equal(await exited, 0); assert.equal(await f.observe(helper.pid!), null)
  local.close(); fresh.close(); await f.verifyZeroSurvivors()
})

test("expired failed worker retirement preserves task record and report bytes", { timeout: 90000 }, async t => {
  const f = await acpFixture(t, { pauseAt: "session", coordination: "reject" }), record = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json")), hostId = f.paths.hostKey
  const local = await connectHandlerBridge({ root: f.paths.runtimeRoot, hostId, handlerGeneration: record.generation }); t.after(() => local.close())
  const client = createHostTaskClient({ localHostId: hostId, route: (r, signal) => local.request(r.channel, r.payload, { ...(signal ? { signal } : {}) }) })
  const ref = { hostId, taskId: randomUUID() }
  await until(async () => { try { await client.inspect(ref) } catch (error) { return error instanceof TaskError && error.code === "TASK_NOT_FOUND" ? true : undefined } })
  await client.create(hostId, { taskId: ref.taskId, description: "failed startup", cwd: f.workspace, backendId: "codex-acp", text: "never submitted" })
  await f.waitBarrier()
  const agent = (await f.inventory()).agents[0]!; assert.ok(agent.launch)
  await f.killProvider({ agentId: agent.definition.agentId, handlerGeneration: agent.launch.handlerGeneration, providerGeneration: agent.launch.providerGeneration })
  await until(async () => (await client.inspect(ref)).runtime === "failed" ? true : undefined)
  await client.report(ref, { outcome: "failed", summary: "startup failed" })
  const directory = join(f.paths.persistentRoot, "tasks", ref.taskId), before = await Promise.all([readFile(join(directory, "record.json")), readFile(join(directory, "report.json"))])
  client.close(); local.close(); await f.crashHandler()
  const runtimeStore = createAgentStore(f.paths.persistentRoot), failed = await runtimeStore.readAgent(agent.definition.agentId)
  assert.ok(failed && failed.version === 3); assert.equal(failed.session, null); assert.equal(failed.configurationState.verification.kind, "unknown")
  await runtimeStore.writeAgent({ ...failed, configurationState: { ...failed.configurationState, verification: { kind: "verified" } } }, failed)
  await f.restart({ nativeAcp: true, coordination: "reject", retentionNow: Date.now() + 8 * 86400000 })
  assert.equal((await f.inventory()).agents.some(value => value.definition.agentId === agent.definition.agentId), false)
  assert.deepEqual(await Promise.all([readFile(join(directory, "record.json")), readFile(join(directory, "report.json"))]), before)
  const store = createTaskStore({ root: f.paths.persistentRoot, hostId }); await store.initialize()
  const forbidden = async (): Promise<never> => { throw new Error("runtime access after report") }
  const restored = createTaskService({ store, hostId, generation: randomUUID(), environment: () => ({}), runtime: { beginSession: forbidden, submit: forbidden, commandReceipt: forbidden, submission: forbidden, sessionRecord: forbidden } })
  assert.deepEqual((await restored.inspect(ref.taskId)).report, { outcome: "failed", summary: "startup failed" }); await restored.close()
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/prompt").length, 0)
  await f.verifyZeroSurvivors()
})