import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { createConnection, createServer } from "node:net"
import { join } from "node:path"
import { Readable } from "node:stream"
import { liveHandlerFixture } from "./live-support.js"
import { runControl, productionControlDependencies, type ControlDependencies } from "../src/cli/control.js"
import { inspectHandlerGeneration } from "../src/platform/singleton.js"
import { exchangeLive } from "../src/live/protocol.js"
import { PRE_LIVE_HANDLER } from "../src/live/errors.js"

type Fixture = Awaited<ReturnType<typeof liveHandlerFixture>>
function cli(f: Fixture, start: ControlDependencies["start"] = async () => (await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter))!) {
  return async (args: string[], stdin?: string) => {
    let output = "", errors = ""
    const code = await runControl([...args, "--json"], { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), start, cwd: () => f.workspace, homes: () => ({ codexHome: join(f.homes, "codex"), claudeHome: join(f.homes, "claude") }),
      ...(stdin === undefined ? {} : { stdin: Readable.from([Buffer.from(stdin)]) }), stdout: value => { output += value }, stderr: value => { errors += value } })
    return { code, reply: JSON.parse(output), errors }
  }
}

test("the CLI starts, prompts, sets, stops, restores and forgets an agent, and reports failures in one shape", async t => {
  const f = await liveHandlerFixture(t), run = cli(f), agentId = randomUUID()
  const started = await run(["start", "--backend", "codex-acp", "--agent", agentId, "--mode", "read-only"])
  assert.equal(started.code, 0)
  assert.deepEqual([started.reply.protocol, started.reply.result.agent.agentId, started.reply.result.agent.live.mode], ["agency-request/1", agentId, "read-only"])
  assert.equal((await run(["prompt", agentId], "hello")).reply.result.text, "answer:hello")
  assert.equal((await run(["set", agentId, "model", "model-b"])).reply.result.agent.live.model, "model-b")
  assert.deepEqual((await run(["agents"])).reply.result.agents.map((row: { agentId: string }) => row.agentId), [agentId])
  assert.equal((await run(["stop", agentId])).reply.result.agent.live, null)
  assert.deepEqual((await run(["excerpt", agentId])).reply.result.turns, [{ role: "user", text: "hello" }, { role: "agent", text: "answer:hello" }])
  assert.equal((await run(["restore", agentId])).reply.result.agent.live.activity, "idle")
  const conflict = await run(["start", "--backend", "codex-acp", "--agent", agentId, "--cwd", f.otherWorkspace])
  assert.deepEqual([conflict.code, conflict.reply.ok, conflict.reply.error.code], [64, false, "INVALID"])
  assert.equal(conflict.errors, conflict.reply.error.message + "\n")
  assert.deepEqual([(await run(["forget", agentId])).reply.error.code, (await run(["stop", agentId])).code], ["INVALID", 0])
  assert.deepEqual((await run(["forget", agentId])).reply.result, { state: "forgotten", agentId })
  assert.equal((await run(["set", agentId])).code, 64)
  assert.equal((await run(["restore", agentId])).code, 66)
  const log = (await run(["log", "--agent", agentId])).reply.result.events.map((event: { type: string }) => event.type)
  assert.ok(log.includes("agent_started") && log.includes("settings_changed") && log.includes("agent_forgotten") && log.includes("request_failed"))
  await f.verifyZeroSurvivors()
})

test("with no Handler running, the CLI lists agents, reads excerpts and the log, and treats a stop as done", async t => {
  const f = await liveHandlerFixture(t), run = cli(f, async () => { throw new Error("automatic startup forbidden") }), { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  await f.stopHandler()
  const agents = await run(["agents"])
  assert.deepEqual([agents.code, agents.reply.result.handlerGeneration, agents.reply.result.agents.map((row: { agentId: string; live: unknown; title: string }) => [row.agentId, row.live, row.title])], [0, null, [[agentId, null, "hello"]]])
  assert.equal((await run(["excerpt", agentId])).reply.result.source, "history")
  assert.equal((await run(["stop", agentId])).reply.result.agent.agentId, agentId)
  assert.equal((await run(["set", agentId, "model", "model-b"])).reply.error.code, "UNAVAILABLE")
  assert.ok((await run(["log"])).reply.result.events.some((event: { type: string }) => event.type === "handler_stopped"))
  await f.verifyZeroSurvivors()
})

test("against a Handler that closes request sockets unanswered, the CLI names the one-time upgrade step", async t => {
  const f = await liveHandlerFixture(t), path = join(f.root, "old.sock"), old = createServer(socket => socket.destroy())
  await new Promise<void>(resolve => old.listen(path, resolve))
  t.after(() => new Promise<void>(resolve => old.close(() => resolve())))
  const run = async (args: string[]) => {
    let output = "", errors = ""
    const code = await runControl([...args, "--json"], { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), start: async () => (await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter))!, cwd: () => f.workspace,
      callLive: (_env, request, timeoutMs) => exchangeLive(createConnection(path), request, timeoutMs), stdout: value => { output += value }, stderr: value => { errors += value } })
    return { code, reply: JSON.parse(output), errors }
  }
  for (const args of [["agents"], ["start"], ["models"]]) {
    const result = await run(args)
    assert.equal(result.code, 69)
    assert.deepEqual(result.reply.error, { code: "UNAVAILABLE", message: PRE_LIVE_HANDLER })
    assert.match(result.errors, /:AgencyReload/)
  }
})

test("agy delegate outside an Agency agent fails as INVALID", async t => {
  const saved = process.env.AGENCY_AGENT_ID
  delete process.env.AGENCY_AGENT_ID
  t.after(() => { if (saved === undefined) delete process.env.AGENCY_AGENT_ID; else process.env.AGENCY_AGENT_ID = saved })
  const f = await liveHandlerFixture(t), result = await cli(f)(["delegate", "list"])
  assert.deepEqual([result.code, result.reply.ok, result.reply.error.code, result.reply.error.message], [64, false, "INVALID", "agy delegate must run inside an Agency agent"])
})