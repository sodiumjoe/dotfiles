import assert from "node:assert/strict"
import test from "node:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { acpFixture } from "./acp-support.js"
import { until } from "./control-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { PROTOCOL } from "../src/control/protocol.js"
import { createAgentStore } from "../src/agent/store.js"

const initialize = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true }, terminal: true } }

async function idleShutdown(f: Awaited<ReturnType<typeof acpFixture>>) {
  const generation = (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation
  return f.control({ protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, op: "shutdown", commandId: randomUUID(), stopAgents: true, requireIdle: true })
}

test("an idle-required shutdown refuses while a turn runs and leaves the agent usable", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const held = c.request("session/prompt", { sessionId: session.sessionId!, prompt: [{ type: "text", text: "held" }] })
  await until(async () => (await f.requests("codex-acp")).some(value => value.method === "session/prompt") ? true : undefined)
  const refused = await idleShutdown(f)
  assert.equal(refused.ok, false)
  assert.equal(refused.ok ? null : refused.error.code, "BUSY")
  await f.release("codex-acp")
  assert.equal((await held).stopReason, "end_turn")
  assert.equal((await c.request("session/prompt", { sessionId: session.sessionId!, prompt: [{ type: "text", text: "next" }] })).stopReason, "end_turn")
  const target = await f.tuple(String(session.sessionId))
  const accepted = await idleShutdown(f)
  assert.ok(accepted.ok)
  c.close()
  await f.waitHandlerExit()
  assert.equal((await createAgentStore(f.paths.persistentRoot).readAgent(target.agentId))?.phase, "stopped")
  await f.verifyZeroSurvivors()
})

test("an idle-required shutdown refuses while an agent is starting and doesn't abort it", async t => {
  const f = await acpFixture(t, { pauseAt: "session", selectionCatalog: true })
  const pending = await f.start({ mode: "read-only" })
  await until(async () => (await f.list()).agents.some(value => value.record.version === 3 && value.record.phase === "starting") ? true : undefined)
  const refused = await idleShutdown(f)
  assert.equal(refused.ok ? null : refused.error.code, "BUSY")
  await writeFile(join(f.root, "release-session"), "released", { mode: 0o600 })
  const started = await f.waitCompleted(pending)
  assert.equal(started.command.result?.outcome, "started")
  await f.waitCompleted(await f.stop(started.command.target!))
  await f.verifyZeroSurvivors()
})