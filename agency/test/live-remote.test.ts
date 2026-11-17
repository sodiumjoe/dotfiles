import { fixtureBridgeSpawner } from "./fixtures/fixture-bridge.js"
import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { liveHandlerFixture } from "./live-support.js"
import { until } from "./control-support.js"
import { connectBridge } from "../src/bridge/ssh.js"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import { parseHostReply } from "../src/hosts/protocol.js"

async function remote(t: import("node:test").TestContext) {
  const f = await liveHandlerFixture(t), record = await f.handler(), hostId = f.paths.hostKey, spawnBridge = await fixtureBridgeSpawner()
  const transport = await connectBridge({ hostId, hostname: "fixture" }, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read", "runtime-write"], processFactory: () => spawnBridge(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-remote.js", import.meta.url)), JSON.stringify({ root: f.paths.runtimeRoot, hostId, handlerGeneration: record.generation })], { stdio: ["pipe", "pipe", "pipe"] }) })
  t.after(() => transport.close())
  const call = async (args: string[]) => {
    let output = ""
    const code = await runControl([...args, "--host", hostId, "--json"], { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), hostRoute: (_env, route) => transport.request(route.channel, route.payload), start: async () => { throw new Error("automatic startup forbidden") }, stdout: value => { output += value } })
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