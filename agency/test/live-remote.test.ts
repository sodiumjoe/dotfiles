import { fixtureBridgeSpawner } from "./fixtures/fixture-bridge.js"
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { randomUUID } from "node:crypto"
import { liveHandlerFixture } from "./live-support.js"
import { until } from "./control-support.js"
import { connectBridge } from "../src/bridge/ssh.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { runRuntimeEntryHelper } from "../src/entry/cli.js"
import { inspectHandlerGeneration } from "../src/platform/singleton.js"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import { parseHostReply } from "../src/hosts/protocol.js"

async function remote(t: import("node:test").TestContext) {
  const f = await liveHandlerFixture(t), record = await f.handler(), hostId = f.paths.hostKey, spawnBridge = await fixtureBridgeSpawner()
  const transport = await connectBridge({ hostId, hostname: "fixture" }, { action: "internal-runtime-bridge", requiredCapabilities: ["live-read", "live-wait"], processFactory: () => spawnBridge(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-remote.js", import.meta.url)), JSON.stringify({ root: f.paths.runtimeRoot, hostId, handlerGeneration: record.generation })], { stdio: ["pipe", "pipe", "pipe"] }) })
  t.after(() => transport.close())
  const call = async (args: string[], stdin?: string) => {
    let output = ""
    const code = await runControl([...args, "--host", hostId, "--json"], { ...productionControlDependencies(), ...(stdin === undefined ? {} : { stdin: Readable.from([Buffer.from(stdin)]) }), environment: async () => ({ paths: f.paths, adapter: f.adapter }), hostRoute: (_env, route) => transport.request(route.channel, route.payload), start: async () => { throw new Error("automatic startup forbidden") }, stdout: value => { output += value } })
    return { code, reply: parseHostReply(JSON.parse(output)) }
  }
  return { f, record, transport, call }
}

test("a remote session started, prompted, cancelled and stopped through the old request shapes is served by the live core", { timeout: 60000 }, async t => {
  const { f, record, transport, call } = await remote(t), commandId = randomUUID()
  const start = await call(["session", "start", "--input-json", JSON.stringify({ commandId, handlerGeneration: record.generation, cwd: f.workspace, backendId: "codex-acp" })])
  assert.equal(start.code, 0); assert.ok(start.reply.ok && start.reply.result.state === "command")
  const command = await until(async () => { const r = await call(["session", "command", commandId, "--input-json", JSON.stringify({ commandGeneration: record.generation })]); return r.reply.ok && r.reply.result.state === "session_command" && r.reply.result.receipt?.command.state === "completed" ? r.reply.result.receipt : undefined })
  assert.equal(command.command.result?.outcome, "started")
  const target = command.command.target!, submissionId = randomUUID()
  assert.equal((await call(["session", "submit", "--input-json", JSON.stringify({ target, submissionId, text: "held" })])).code, 0)
  await until(async () => (await f.providerRequests()).some(frame => frame.method === "session/prompt") ? true : undefined)
  assert.equal((await call(["session", "submission", "--input-json", JSON.stringify({ target, submissionId })])).code, 75)
  assert.equal((await call(["session", "inspect", target.agentId])).code, 0)
  const roster = await call(["roster", "list"])
  assert.ok(roster.reply.ok && roster.reply.result.state === "page")
  assert.deepEqual(roster.reply.result.agents.map(view => [view.record.version === 3 && view.record.definition.agentId, view.live]), [[target.agentId, true]])
  assert.equal((await call(["session", "cancel", "--input-json", JSON.stringify({ target, submissionId })])).code, 0)
  const completed = await until(async () => { const r = await call(["session", "submission", "--input-json", JSON.stringify({ target, submissionId })]); return r.code === 0 ? r : undefined })
  assert.ok(completed.reply.ok && completed.reply.result.state === "submission" && completed.reply.result.receipt?.stopReason === "cancelled")
  const stopId = randomUUID()
  assert.equal((await call(["session", "stop", "--input-json", JSON.stringify({ ...target, commandId: stopId })])).code, 0)
  await until(async () => (await call(["session", "command", stopId, "--input-json", JSON.stringify({ commandGeneration: record.generation })])).code === 0 ? true : undefined)
  assert.deepEqual((await f.agents()).map(row => [row.agentId, row.live]), [[target.agentId, null]])
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})

test("a remote excerpt and permission list are served by the live core", { timeout: 60000 }, async t => {
  const { f, transport, call } = await remote(t), { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  const excerpt = await call(["roster", "excerpt", agentId])
  assert.ok(excerpt.reply.ok && excerpt.reply.result.state === "excerpt")
  assert.deepEqual(excerpt.reply.result.turns, [{ role: "user", text: "hello" }, { role: "agent", text: "answer:hello" }])
  const permissions = await call(["permission", "list"])
  assert.ok(permissions.reply.ok && permissions.reply.result.state === "permissions")
  const stale = { agentId, handlerGeneration: (await f.handler()).generation, providerGeneration: randomUUID() }
  assert.equal((await call(["session", "stop", "--input-json", JSON.stringify({ ...stale, commandId: randomUUID() })])).reply.ok, false)
  assert.ok((await f.events()).some(event => event.type === "request_failed" && String(event.op).includes("stop") && event.agentId === agentId))
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})

test("a remote session receives one exact long Unicode prompt through stdin", { timeout: 60000 }, async t => {
  const { f, record, transport, call } = await remote(t), commandId = randomUUID()
  assert.equal((await call(["session", "start", "--input-json", JSON.stringify({ commandId, handlerGeneration: record.generation, cwd: f.workspace, backendId: "codex-acp" })])).code, 0)
  const command = await until(async () => { const r = await call(["session", "command", commandId, "--input-json", JSON.stringify({ commandGeneration: record.generation })]); return r.reply.ok && r.reply.result.state === "session_command" && r.reply.result.receipt?.command.state === "completed" ? r.reply.result.receipt.command : undefined })
  const target = command.target!, submissionId = randomUUID(), text = "stdin fixture λ🙂\n".repeat(100)
  assert.equal((await call(["session", "submit", "--input-json", "-"], JSON.stringify({ target, submissionId, text }))).code, 0)
  await until(async () => { const r = await call(["session", "submission", "--input-json", JSON.stringify({ target, submissionId })]); return r.code === 0 ? true : undefined })
  const prompts = (await f.providerRequests()).filter(frame => frame.method === "session/prompt")
  assert.equal(prompts.length, 1)
  assert.deepEqual((prompts[0]!.params as { prompt: unknown }).prompt, [{ type: "text", text }])
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})

test("a remote serves its live agents and a change doorbell", { timeout: 60000 }, async t => {
  const { f, transport } = await remote(t), { agentId } = await f.start()
  assert.ok(transport.hello.capabilities.includes("live-read") && transport.hello.capabilities.includes("live-wait"))
  const stopped = await f.start()
  await f.prompt(stopped.agentId, "hello")
  await f.stop(stopped.agentId)
  const list = await transport.request("live-read", { op: "agents" }) as { handlerGeneration: string; agents: Array<{ agentId: string }> }
  assert.equal(list.handlerGeneration, (await f.handler()).generation)
  assert.deepEqual(list.agents.map(row => row.agentId), [agentId])
  const wait = (after: string | null, waitMs: number) => transport.request("live-wait", { after, waitMs }, { timeoutMs: waitMs + 5000 }) as Promise<{ revision: string }>
  const first = (await wait(null, 8000)).revision
  const started = Date.now()
  assert.equal((await wait(first, 500)).revision, first)
  assert.ok(Date.now() - started >= 450)
  const changing = wait(first, 8000), since = Date.now()
  await f.start()
  assert.notEqual((await changing).revision, first)
  assert.ok(Date.now() - since < 7000)
  await assert.rejects(transport.request("live-read", { op: "stop", agentId }))
  await assert.rejects(transport.request("live-wait", { after: null, waitMs: 9000 }))
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})

test("a bridge closes when the Handler behind it stops", { timeout: 60000 }, async t => {
  const { f, transport } = await remote(t)
  await f.stopHandler()
  const closed = await Promise.race([transport.closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 10000))])
  assert.ok(closed, "the bridge stayed open after its Handler stopped")
  await f.restart()
  await f.verifyZeroSurvivors()
})

test("a remote serves excerpts, approvals and decisions on the request channel", { timeout: 60000 }, async t => {
  const { f, transport } = await remote(t), { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  assert.ok(transport.hello.capabilities.includes("live-request"))
  const excerpt = await transport.request("live-request", { op: "excerpt", agentId, turns: 4 }) as { ok: boolean; result: { turns: unknown[] } }
  assert.ok(excerpt.ok)
  assert.deepEqual(excerpt.result.turns, [{ role: "user", text: "hello" }, { role: "agent", text: "answer:hello" }])
  const permissions = await transport.request("live-request", { op: "permissions" }) as { ok: boolean; result: { state: string; snapshot: { hostId: string } } }
  assert.ok(permissions.ok)
  assert.deepEqual([permissions.result.state, permissions.result.snapshot.hostId], ["permissions", f.paths.hostKey])
  const handler = await f.handler()
  const ref = { hostId: f.paths.hostKey, target: { agentId, handlerGeneration: handler.generation, providerGeneration: randomUUID() }, permissionId: randomUUID(), revision: 1 }
  const decided = await transport.request("live-request", { op: "decide", ref, optionId: "allow" }) as { ok: boolean; result: { state: string; receipt: { state: string } } }
  assert.ok(decided.ok)
  assert.deepEqual([decided.result.state, decided.result.receipt.state], ["permission", "stale"])
  await assert.rejects(transport.request("live-request", { op: "stop", agentId }))
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})

test("the devbox entry helper attaches through its own Handler's bridge", { timeout: 60000 }, async t => {
  const { f, transport } = await remote(t), started = await f.start(), handler = await f.handler()
  const ref = { hostId: f.paths.hostKey, target: { agentId: started.agentId, handlerGeneration: handler.generation, providerGeneration: started.live!.providerGeneration } }
  const commandId = randomUUID()
  assert.equal((await transport.request("entry-open", { commandId, ref }) as { state: string }).state, "opened")
  const attached: string[][] = []
  const deps = { environment: async () => ({ paths: f.paths, adapter: f.adapter }), inspect: (env: { paths: typeof f.paths; adapter: typeof f.adapter }) => inspectHandlerGeneration(env.paths.runtimeRoot, env.adapter), connect: connectHandlerBridge, stderr: () => {} }
  assert.equal(await runRuntimeEntryHelper([commandId, "--target-json", JSON.stringify(ref)], deps, async (file, args) => { attached.push([file, ...args]); return 0 }), 0)
  assert.equal(attached[0]?.[0], "tmux")
  const other = { ...ref, target: { ...ref.target, providerGeneration: randomUUID() } }
  assert.equal(await runRuntimeEntryHelper([commandId, "--target-json", JSON.stringify(other)], deps, async () => 0), 75)
  transport.close(); await transport.closed; await f.verifyZeroSurvivors()
})