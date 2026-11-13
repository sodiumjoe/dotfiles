import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { acpFixture } from "./acp-support.js"
import { until } from "./control-support.js"
import { createAgentStore } from "../src/agent/store.js"

const initialize = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true }, terminal: true } }

test("the Handler records activity and the title, keeps them across stop and restore, and lists them", async t => {
  const f = await acpFixture(t), c = await f.connect(), store = createAgentStore(f.paths.persistentRoot)
  await c.request("initialize", initialize)
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const sessionId = String(session.sessionId), agentId = sessionId.slice(7)
  assert.equal((await store.readAgent(agentId))?.lastActivityAt, undefined)
  const before = new Date().toISOString()
  assert.equal((await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })).stopReason, "end_turn")
  const settled = await until(async () => {
    const record = await store.readAgent(agentId)
    return record?.title === "hello" && record.lastActivityAt && record.lastActivityAt >= before ? record : undefined
  })
  assert.ok(Number.isFinite(Date.parse(settled.lastActivityAt!)))
  c.close()
  await f.stopSession(sessionId)
  const stopped = await store.readAgent(agentId)
  assert.equal(stopped?.phase, "stopped")
  assert.ok(stopped?.lastActivityAt && stopped.lastActivityAt >= settled.lastActivityAt!)
  assert.equal(stopped?.title, "hello")
  const listing = await f.connect()
  await listing.request("initialize", initialize)
  const listed = ((await listing.request("session/list", {})).sessions as Array<Record<string, any>>).find(value => value.sessionId === sessionId)
  assert.ok(listed)
  assert.equal(listed.updatedAt, stopped?.lastActivityAt)
  assert.equal(listed.title, "hello")
  assert.equal(listed._meta.agency.model, (stopped?.settings.configValues?.model as string | undefined) ?? stopped?.settings.modelId ?? null)
  listing.close()
  await f.restoreSession(sessionId)
  const restored = await store.readAgent(agentId)
  assert.equal(restored?.title, "hello")
  assert.equal(restored?.lastActivityAt, stopped?.lastActivityAt)
  await f.stopSession(sessionId)
  await f.verifyZeroSurvivors()
})

test("an activity write does not break a configure that overlaps the end of a turn", async t => {
  const f = await acpFixture(t), c = await f.connect(), store = createAgentStore(f.paths.persistentRoot)
  await c.request("initialize", initialize)
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, commandId: randomUUID(), backendId: "claude-agent-acp" } } })
  const sessionId = String(session.sessionId), agentId = sessionId.slice(7)
  await writeFile(join(f.root, "pause-set-mode"), "pause", { mode: 0o600 })
  const turn = c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "held" }] })
  await until(async () => (await f.requests("claude-agent-acp")).some(value => value.method === "session/prompt") ? true : undefined)
  const submitted = await until(async () => (await store.readAgent(agentId))?.lastActivityAt)
  const mode = c.request("session/set_mode", { sessionId, modeId: "review" })
  await until(async () => await readFile(join(f.root, "at-set-mode"), "utf8").catch(() => undefined))
  await f.release("claude-agent-acp")
  assert.equal((await turn).stopReason, "end_turn")
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal((await store.readAgent(agentId))?.lastActivityAt, submitted)
  await writeFile(join(f.root, "release-set-mode"), "released", { mode: 0o600 })
  await mode
  assert.equal((await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })).stopReason, "end_turn")
  c.close()
  await f.stopSession(sessionId)
  await f.verifyZeroSurvivors()
})