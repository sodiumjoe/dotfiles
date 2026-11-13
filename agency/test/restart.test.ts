import assert from "node:assert/strict"
import test from "node:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { acpFixture } from "./acp-support.js"
import { until, fileExists } from "./control-support.js"
import { runControl, productionControlDependencies, type ControlDependencies } from "../src/cli/control.js"
import { runRestart } from "../src/cli/restart.js"
import { inspectHandlerGeneration } from "../src/platform/singleton.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { PROTOCOL } from "../src/control/protocol.js"

type Fixture = Awaited<ReturnType<typeof acpFixture>>
const initialize = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true }, terminal: true } }
const meta = (backendId: string) => ({ agency: { version: 1, commandId: randomUUID(), backendId } })

function dependencies(f: Fixture, sink: { output: string; progress: string }): ControlDependencies {
  const production = productionControlDependencies()
  return { ...production, environment: async () => ({ paths: f.paths, adapter: f.adapter }), cwd: () => f.workspace,
    start: async () => {
      const current = await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter)
      if (current?.disposition === "live" && current.record.phase === "ready") return current
      await f.restart({ nativeAcp: true })
      const started = await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter)
      assert.ok(started)
      return started
    },
    stdout: value => { sink.output += value }, stderr: value => { sink.progress += value } }
}

async function restart(f: Fixture, args: string[], run: typeof runControl = runControl) {
  const sink = { output: "", progress: "" }
  const code = await runRestart(["restart", ...args, "--json"], dependencies(f, sink), run)
  return { code, reply: JSON.parse(sink.output), progress: sink.progress }
}

async function session(f: Fixture, backendId = "codex-acp") {
  const c = await f.connect()
  await c.request("initialize", initialize)
  const created = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: meta(backendId) })
  return { c, sessionId: String(created.sessionId) }
}

test("restart waits for a running turn, then restores the agent under a new Handler", async t => {
  const f = await acpFixture(t), { c, sessionId } = await session(f), before = await f.tuple(sessionId)
  const held = c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "held" }] }).catch(() => null)
  await until(async () => (await f.requests("codex-acp")).some(value => value.method === "session/prompt") ? true : undefined)
  const busy = await restart(f, ["--timeout", "1"])
  assert.equal(busy.code, 75)
  assert.equal(busy.reply.error.code, "BUSY")
  assert.deepEqual(await f.tuple(sessionId), before)
  const restarting = restart(f, ["--timeout", "30"])
  await f.release("codex-acp")
  await held
  const done = await restarting
  assert.equal(done.code, 0, done.progress)
  assert.equal(done.reply.result.restarted, true)
  assert.deepEqual(done.reply.result.agents, [{ agentId: before.agentId, outcome: "restored", failure: null }])
  const after = await f.tuple(sessionId)
  assert.notEqual(after.handlerGeneration, before.handlerGeneration)
  assert.equal(await fileExists(join(f.paths.persistentRoot, "restart-pending.json")), false)
  c.close()
  await f.stopSession(sessionId)
  await f.verifyZeroSurvivors()
})

test("a turn admitted between the idle check and the shutdown is not aborted, and the restart completes afterward", async t => {
  const f = await acpFixture(t), { c, sessionId } = await session(f), before = await f.tuple(sessionId)
  const pending = join(f.paths.persistentRoot, "restart-pending.json")
  let shutdowns = 0
  const between: { pending: boolean; tuple: typeof before; live: boolean | undefined }[] = []
  const done = await restart(f, ["--timeout", "30"], async (argv, deps) => {
    if (argv[0] === "shutdown" && ++shutdowns === 1) {
      deps.stdout(JSON.stringify({ protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: before.handlerGeneration, ok: false, error: { code: "BUSY", message: "agent " + before.agentId + " is running a turn" } }) + "\n")
      return 75
    }
    if (argv[0] === "agent" && argv[1] === "list" && shutdowns === 1 && !between.length) {
      const view = (await f.list()).agents.find(value => value.record.version === 3 && value.record.definition.agentId === before.agentId)
      between.push({ pending: await fileExists(pending), tuple: await f.tuple(sessionId), live: view?.live })
    }
    return runControl(argv, deps)
  })
  assert.equal(done.code, 0, done.progress)
  assert.equal(shutdowns, 2)
  assert.equal(between.length, 1)
  assert.deepEqual(between[0], { pending: false, tuple: before, live: true })
  assert.equal(done.reply.result.restarted, true)
  assert.deepEqual(done.reply.result.agents, [{ agentId: before.agentId, outcome: "restored", failure: null }])
  assert.notEqual((await f.tuple(sessionId)).handlerGeneration, before.handlerGeneration)
  assert.equal(await fileExists(pending), false)
  c.close()
  await f.stopSession(sessionId)
  await f.verifyZeroSurvivors()
})

test("restart with no live agents still replaces the Handler", async t => {
  const f = await acpFixture(t)
  const before = (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation
  const done = await restart(f, [])
  assert.equal(done.code, 0, done.progress)
  assert.deepEqual(done.reply.result.agents, [])
  assert.notEqual(done.reply.result.toGeneration, before)
  await f.verifyZeroSurvivors()
})

test("one failing restore doesn't prevent the others", async t => {
  const f = await acpFixture(t)
  const codex = await session(f, "codex-acp"), claude = await session(f, "claude-agent-acp")
  const codexTarget = await f.tuple(codex.sessionId), claudeTarget = await f.tuple(claude.sessionId)
  const done = await restart(f, [], async (argv, deps) => {
    if (argv[0] === "status" && (await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter))?.disposition !== "live") await writeFile(join(f.root, "claude-agent-acp-native.json"), "{", { mode: 0o600 })
    return runControl(argv, deps)
  })
  assert.equal(done.code, 0, done.progress)
  const outcomes = Object.fromEntries(done.reply.result.agents.map((agent: { agentId: string; outcome: string }) => [agent.agentId, agent.outcome]))
  assert.deepEqual(outcomes, { [codexTarget.agentId]: "restored", [claudeTarget.agentId]: "failed" })
  assert.equal((await f.list()).agents.find(value => value.record.version === 3 && value.record.definition.agentId === claudeTarget.agentId)?.record.phase, "recoverable")
  const saved = JSON.parse(await readFile(join(f.paths.persistentRoot, "restart-pending.json"), "utf8"))
  assert.deepEqual(saved.agentIds, [claudeTarget.agentId])
  codex.c.close(); claude.c.close()
  await f.stopSession(codex.sessionId)
  await f.verifyZeroSurvivors()
})

test("resume restores agents from a pending restore once, and rejects a corrupt file", async t => {
  const f = await acpFixture(t), { c, sessionId } = await session(f), target = await f.tuple(sessionId)
  c.close()
  await f.stopSession(sessionId)
  const pending = join(f.paths.persistentRoot, "restart-pending.json")
  await writeFile(pending, JSON.stringify({ version: 1, fromGeneration: target.handlerGeneration, agentIds: [target.agentId] }), { mode: 0o600 })
  const resumed = await restart(f, ["--resume"])
  assert.equal(resumed.code, 0, resumed.progress)
  assert.equal(resumed.reply.result.resumed, true)
  assert.deepEqual(resumed.reply.result.agents, [{ agentId: target.agentId, outcome: "restored", failure: null }])
  assert.equal(await fileExists(pending), false)
  const again = await restart(f, ["--resume"])
  assert.equal(again.reply.result.resumed, false)
  await writeFile(pending, "{", { mode: 0o600 })
  const corrupt = await restart(f, ["--resume"])
  assert.equal(corrupt.reply.error.code, "INVALID_PROTOCOL")
  assert.match(corrupt.reply.error.message, /restart-pending\.json/)
  assert.equal(await readFile(pending, "utf8"), "{")
  await f.stopSession(sessionId)
  await f.verifyZeroSurvivors()
})

test("a plain restart first restores agents left by an interrupted restart", async t => {
  const f = await acpFixture(t), { c, sessionId } = await session(f), target = await f.tuple(sessionId)
  c.close()
  await f.stopSession(sessionId)
  await writeFile(join(f.paths.persistentRoot, "restart-pending.json"), JSON.stringify({ version: 1, fromGeneration: target.handlerGeneration, agentIds: [target.agentId] }), { mode: 0o600 })
  const done = await restart(f, [])
  assert.equal(done.code, 0, done.progress)
  assert.deepEqual(done.reply.result.agents, [{ agentId: target.agentId, outcome: "restored", failure: null }])
  const after = await f.tuple(sessionId)
  assert.notEqual(after.providerGeneration, target.providerGeneration)
  await f.stopSession(sessionId)
  await f.verifyZeroSurvivors()
})

test("a plain restart carries a retryable failed restore into the new snapshot and drops an agent with no record", async t => {
  const f = await acpFixture(t), { c, sessionId } = await session(f, "claude-agent-acp"), target = await f.tuple(sessionId)
  c.close()
  await f.stopSession(sessionId)
  const pending = join(f.paths.persistentRoot, "restart-pending.json"), missing = randomUUID()
  await writeFile(pending, JSON.stringify({ version: 1, fromGeneration: target.handlerGeneration, agentIds: [target.agentId, missing] }), { mode: 0o600 })
  await writeFile(join(f.root, "claude-agent-acp-native.json"), "{", { mode: 0o600 })
  const before = (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation
  const done = await restart(f, [])
  assert.equal(done.code, 0, done.progress)
  assert.equal(done.reply.result.restarted, true)
  assert.notEqual(done.reply.result.toGeneration, before)
  assert.deepEqual(done.reply.result.agents.map((agent: { agentId: string; outcome: string }) => [agent.agentId, agent.outcome]), [[target.agentId, "failed"]])
  const saved = JSON.parse(await readFile(pending, "utf8"))
  assert.deepEqual(saved, { version: 1, fromGeneration: before, agentIds: [target.agentId] })
  await writeFile(join(f.root, "claude-agent-acp-native.json"), "{}", { mode: 0o600 })
  const resumed = await restart(f, ["--resume"])
  assert.equal(resumed.code, 0, resumed.progress)
  assert.deepEqual(resumed.reply.result.agents, [{ agentId: target.agentId, outcome: "restored", failure: null }])
  assert.equal(await fileExists(pending), false)
  await f.stopSession(sessionId)
  await f.verifyZeroSurvivors()
})

test("an incomplete shutdown restores the stopped agents, and an old Handler is left running with upgrade instructions", async t => {
  const f = await acpFixture(t), { c, sessionId } = await session(f)
  const fake = (code: string) => async (argv: readonly string[], deps: ControlDependencies) => {
    if (argv[0] !== "shutdown") return runControl(argv, deps)
    if (code === "INCOMPLETE") await f.stopSession(sessionId)
    const generation = (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation
    deps.stdout(JSON.stringify({ protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, ok: false, error: { code, message: "fixture" } }) + "\n")
    return 75
  }
  const incomplete = await restart(f, [], fake("INCOMPLETE"))
  assert.equal(incomplete.reply.error.code, "INCOMPLETE")
  assert.match(incomplete.reply.error.message, /1 stopped agents restored/)
  const view = (await f.list()).agents.find(value => value.record.version === 3 && value.record.definition.agentId === (sessionId.slice(7)))
  assert.ok(view?.live)
  const old = await restart(f, [], async (argv, deps) => {
    if (argv[0] === "shutdown") throw new Error("an old Handler must not receive a shutdown")
    if (argv[0] !== "status") return runControl(argv, deps)
    let output = ""
    const exit = await runControl(argv, { ...deps, stdout: text => { output += text } })
    const envelope = JSON.parse(output)
    delete envelope.result.distDigest
    deps.stdout(JSON.stringify(envelope) + "\n")
    return exit
  })
  assert.equal(old.reply.error.code, "INCOMPLETE")
  assert.match(old.reply.error.message, /agy restart --resume/)
  const saved = JSON.parse(await readFile(join(f.paths.persistentRoot, "restart-pending.json"), "utf8"))
  assert.deepEqual(saved.agentIds, [sessionId.slice(7)])
  assert.ok((await f.list()).agents.find(value => value.record.version === 3 && value.record.definition.agentId === sessionId.slice(7))?.live)
  c.close()
  await f.stopSession(sessionId)
  await f.verifyZeroSurvivors()
})