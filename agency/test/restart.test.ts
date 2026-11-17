import assert from "node:assert/strict"
import test from "node:test"
import { rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { liveHandlerFixture } from "./live-support.js"
import { fileExists, until } from "./control-support.js"
import { runControl, productionControlDependencies, type ControlDependencies } from "../src/cli/control.js"
import { runRestart } from "../src/cli/restart.js"
import { inspectHandlerGeneration } from "../src/platform/singleton.js"
import { createAgentIndex } from "../src/agent/agent-index.js"
import { writeHandlerRecord } from "../src/platform/private-state.js"
import type { JsonObject } from "../src/agent/session-config.js"

type Fixture = Awaited<ReturnType<typeof liveHandlerFixture>>
const initialize = { protocolVersion: 1, clientCapabilities: {} }

function dependencies(f: Fixture, sink: { output: string; progress: string }): ControlDependencies {
  return { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), cwd: () => f.workspace,
    start: async () => {
      const current = await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter)
      if (current?.disposition === "live" && current.record.phase === "ready") return current
      await f.restart()
      return (await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter))!
    },
    stdout: value => { sink.output += value }, stderr: value => { sink.progress += value } }
}

async function restart(f: Fixture, args: string[]) {
  const sink = { output: "", progress: "" }
  const code = await runRestart(["restart", ...args, "--json"], dependencies(f, sink), runControl)
  return { code, reply: JSON.parse(sink.output), progress: sink.progress }
}

test("restart waits for a running turn, then hands the agent to the new Handler with its mode, where an editor finds it live", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  await f.set(agentId, "mode", "read-only")
  await f.prompt(agentId, "hello")
  await f.pausePrompts()
  const held = f.prompt(agentId, "slow")
  await f.waitPrompt()
  const busy = await restart(f, ["--timeout", "1"])
  assert.deepEqual([busy.code, busy.reply.error.code], [75, "BUSY"])
  const before = await f.handler()
  const restarting = restart(f, ["--timeout", "30"])
  await f.releasePrompts()
  await held
  const done = await restarting
  assert.equal(done.code, 0, done.progress)
  assert.deepEqual([done.reply.result.restarted, done.reply.result.fromGeneration, done.reply.result.agents], [true, before.generation, [{ agentId, outcome: "restored", failure: null }]])
  assert.notEqual(done.reply.result.toGeneration, before.generation)
  assert.deepEqual((await f.agents()).map(row => [row.agentId, row.live?.activity, row.live?.mode]), [[agentId, "idle", "read-only"]])
  const editor = await f.connect()
  await editor.request("initialize", initialize)
  const loaded = await editor.request("session/load", { sessionId: "agency:" + agentId, cwd: f.workspace, mcpServers: [] })
  assert.equal(((loaded._meta as JsonObject).agency as JsonObject & { binding: JsonObject }).binding.handlerGeneration, done.reply.result.toGeneration)
  await f.verifyZeroSurvivors()
})

test("restart with no live agents replaces the Handler, and --resume from an older editor does nothing", async t => {
  const f = await liveHandlerFixture(t), before = await f.handler()
  const resumed = await restart(f, ["--resume"])
  assert.deepEqual([resumed.code, resumed.reply.result.restarted, resumed.reply.result.resumed], [0, false, false])
  assert.equal((await f.handler()).generation, before.generation)
  await writeFile(join(f.paths.persistentRoot, "restart-pending.json"), JSON.stringify({ version: 1, fromGeneration: before.generation, agentIds: [before.generation] }), { mode: 0o600 })
  const done = await restart(f, [])
  assert.deepEqual([done.code, done.reply.result.restarted, done.reply.result.agents], [0, true, []])
  assert.notEqual((await f.handler()).generation, before.generation)
  assert.equal(await fileExists(join(f.paths.persistentRoot, "restart-pending.json")), false)
  await f.verifyZeroSurvivors()
})

test("restart reports a handed-off agent the new Handler could not restore, and leaves it stopped", async t => {
  const f = await liveHandlerFixture(t), kept = await f.start(), lost = await f.start()
  await f.prompt(kept.agentId, "hello"); await f.prompt(lost.agentId, "hello")
  const entry = await until(async () => (await createAgentIndex(f.paths.persistentRoot).list()).find(value => value.agentId === lost.agentId))
  await rm(join(f.homes, "codex/sessions/2026/11/14", "rollout-2026-11-14T10-00-00-" + entry!.nativeSessionId + ".jsonl"))
  const done = await restart(f, [])
  assert.equal(done.code, 0, done.progress)
  const outcomes = new Map((done.reply.result.agents as Array<{ agentId: string; outcome: string; failure: { code: string } | null }>).map(agent => [agent.agentId, agent]))
  assert.deepEqual([outcomes.get(kept.agentId)?.outcome, outcomes.get(lost.agentId)?.outcome, outcomes.get(lost.agentId)?.failure?.code], ["restored", "failed", "NOT_FOUND"])
  const rows = new Map((await f.agents()).map(row => [row.agentId, row.live]))
  assert.deepEqual([rows.get(kept.agentId)?.activity, rows.get(lost.agentId)], ["idle", null])
  await f.verifyZeroSurvivors()
})

test("restart reports the handoff even when another client started the new Handler first", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  const sink = { output: "", progress: "" }
  const run: typeof runControl = async (argv, deps) => {
    const code = await runControl(argv, deps)
    if (argv[0] === "shutdown" && code === 0) await f.restart()
    return code
  }
  const code = await runRestart(["restart", "--json"], dependencies(f, sink), run)
  const reply = JSON.parse(sink.output)
  assert.equal(code, 0, sink.progress)
  assert.deepEqual(reply.result.agents, [{ agentId, outcome: "restored", failure: null }])
  assert.equal((await f.agents())[0]?.live?.activity, "idle")
  await f.verifyZeroSurvivors()
})

test("restart keeps waiting through a failed roster read and reports a live agent that was not handed off", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start(), unprompted = await f.start()
  await f.prompt(agentId, "hello")
  await f.pauseSessions()
  const sink = { output: "", progress: "" }
  let shutdown = false, failed = false
  const run: typeof runControl = async (argv, deps) => {
    if (argv[0] === "agents" && shutdown && !failed) { failed = true; deps.stdout(JSON.stringify({ protocol: "agency-request/1", ok: false, error: { code: "UNAVAILABLE", message: "fixture read failure" } }) + "\n"); return 69 }
    const code = await runControl(argv, deps)
    if (argv[0] === "shutdown" && code === 0) shutdown = true
    return code
  }
  const restarting = runRestart(["restart", "--json"], dependencies(f, sink), run)
  await f.waitSession()
  await f.releaseSessions()
  assert.equal(await restarting, 0, sink.progress)
  const outcomes = new Map((JSON.parse(sink.output).result.agents as Array<{ agentId: string; outcome: string }>).map(agent => [agent.agentId, agent.outcome]))
  assert.equal(failed, true)
  assert.deepEqual([outcomes.get(agentId), outcomes.get(unprompted.agentId)], ["restored", "failed"])
  await f.verifyZeroSurvivors()
})

test("restart against a Handler that rejects the handoff shutdown names the manual step", async t => {
  const f = await liveHandlerFixture(t), sink = { output: "", progress: "" }
  const run: typeof runControl = async (argv, deps) => {
    if (argv[0] === "shutdown") { deps.stdout(JSON.stringify({ protocol: "agency-control/2", ok: false, error: { code: "INVALID_PROTOCOL", message: "unknown field requireIdle" } }) + "\n"); return 65 }
    return runControl(argv, deps)
  }
  const code = await runRestart(["restart", "--json"], dependencies(f, sink), run)
  const reply = JSON.parse(sink.output)
  assert.notEqual(code, 0)
  assert.equal(reply.error.code, "INVALID_PROTOCOL")
  assert.match(reply.error.message, /agy shutdown --stop-agents/)
  await f.verifyZeroSurvivors()
})

test("a Handler record left by a crash whose PID now belongs to another process does not block the next start", async t => {
  const f = await liveHandlerFixture(t), before = await f.handler()
  await f.crashHandler()
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })
  t.after(() => { other.kill("SIGKILL") })
  assert.ok(other.pid && await f.observe(other.pid))
  const birth = before.process!.birth, start = Number(birth.slice(0, birth.indexOf(":")))
  await writeHandlerRecord(join(f.paths.runtimeRoot, "handler.json"), { ...before, process: { ...before.process!, pid: other.pid, birth: start - 100 + birth.slice(birth.indexOf(":")) } })
  await f.restart()
  const after = await f.handler()
  assert.notEqual(after.generation, before.generation)
  assert.equal(after.phase, "ready")
  await f.verifyZeroSurvivors()
})