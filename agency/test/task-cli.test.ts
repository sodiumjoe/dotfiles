import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { agentServiceFixture } from "./agent-support.js"
import { runtimeNetwork } from "./host-runtime-support.js"
import { createTaskStore } from "../src/tasks/store.js"
import { createTaskService } from "../src/tasks/service.js"
import { registerTaskEndpoint } from "../src/tasks/endpoint.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { runControl } from "../src/cli/control.js"
import { runTaskClient } from "../src/tasks/cli.js"
import { unavailableControlDependencies } from "./control-support.js"
import { sampleTaskRecord, taskHost } from "./task-test-support.js"

test("task CLI validates its own namespace before opening access", async () => {
  let opened = 0, output = ""
  const deps = { ...unavailableControlDependencies(), environment: async (): Promise<never> => { opened++; throw new Error("opened") }, stdout: (v: string) => { output = v } }
  const base = ["task", "inspect", randomUUID()]
  for (const args of [[...base], [...base, "--local", "--host", taskHost], [...base, "--local", "--json", "--json"], [...base, "--local", "--input-json", "{}"], ["task", "wait", randomUUID(), "--local", "--input-json", '{"timeoutMs":60001}'], ["task", "create", "--local", "--input-json", "{" ]]) {
    assert.equal(await runControl([...args, ...(args.includes("--json") ? [] : ["--json"])], deps), 64)
    assert.equal(JSON.parse(output).protocol, "agency-task/1")
  }
  assert.equal(opened, 0)
})
test("task CLI cancellation is bounded and emits its task reference", async () => {
  const controller = new AbortController(); controller.abort(); let output = ""
  const code = await runTaskClient(["task", "inspect", sampleTaskRecord().ref.taskId, "--host", taskHost, "--json"], { ...unavailableControlDependencies(), signal: controller.signal, stdout: v => { output = v } })
  assert.equal(code, 130); assert.equal(JSON.parse(output).error.code, "CANCELLED"); assert.equal(JSON.parse(output).error.ref.hostId, taskHost)
})
test("public task CLI routes through production access, helper, relay and owner", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), network = await runtimeNetwork(t)
  const laptop = await network.add("laptop", "1"), source = await network.add("source", "2"), owner = await network.add("owner", "a", f.service.handlerGeneration)
  source.bridge.register(["runtime-read"], async () => ({})); owner.bridge.register(["runtime-read"], async () => ({}))
  const store = createTaskStore({ root: f.context.paths.persistentRoot, hostId: taskHost }); await store.initialize()
  const tasks = createTaskService({ store, runtime: f.service, hostId: taskHost, generation: owner.generation, environment: () => f.input.environment }); t.after(() => tasks.close())
  registerTaskEndpoint({ bridge: owner.bridge, service: () => tasks, hostId: taskHost, generation: owner.generation, ready: () => true })
  laptop.hosts.push(source.enrollment, owner.enrollment)
  await laptop.router.request({ hostId: source.enrollment.hostId, channel: "host-identity", payload: {} })
  let output = ""
  const deps = { ...unavailableControlDependencies(), environment: async () => ({ paths: { hostKey: source.enrollment.hostId, persistentRoot: source.root, runtimeRoot: source.root, handlerSocketPath: source.root + "/handler.sock" }, adapter: {} as never }), inspect: async () => ({ disposition: "live", record: { phase: "ready", generation: source.generation } } as never), hostInventory: () => ({ list: async () => [], enroll: async () => { throw new Error("forbidden") } }), stdout: (v: string) => { output = v } }
  const taskId = randomUUID(), input = { taskId, description: "routed", cwd: f.workspace, backendId: "codex-acp", text: "held" }
  const call = async (args: string[]) => { const code = await runControl(["task", ...args, "--host", taskHost, "--json"], deps); return { code, reply: JSON.parse(output) } }
  assert.equal((await call(["create", "--input-json", JSON.stringify(input)])).code, 0); await f.promptEntered
  assert.equal((await call(["inspect", taskId])).reply.result.runtime, "running")
  assert.equal((await call(["wait", taskId, "--input-json", '{"timeoutMs":0}'])).code, 75)
  const connection = await connectHandlerBridge({ root: source.root, hostId: source.enrollment.hostId, handlerGeneration: source.generation }); t.after(() => connection.close())
  for (const channel of ["task-write", "create", "report"]) await assert.rejects(connection.request("host-route-read", { hostId: taskHost, channel, payload: {} }), /UNSUPPORTED_CAPABILITY/)
  await tasks.report(taskId, { outcome: "failed", summary: "explicit failure" })
  assert.equal((await call(["inspect", taskId])).code, 0); assert.equal((await call(["wait", taskId, "--input-json", '{"timeoutMs":0}'])).code, 75)
  await tasks.report(taskId, { outcome: "completed", summary: "done" })
  assert.equal((await call(["wait", taskId, "--input-json", '{"timeoutMs":0}'])).code, 0)
  assert.equal((await call(["inspect", randomUUID()])).code, 69)
  assert.equal((await call(["create", "--input-json", JSON.stringify(input)])).code, 75)
  assert.equal(f.spawns(), 1)
  assert.equal(process.listenerCount("SIGINT"), 0); assert.equal(process.listenerCount("SIGTERM"), 0)
})