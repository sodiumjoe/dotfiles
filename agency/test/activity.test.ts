import assert from "node:assert/strict"
import test from "node:test"
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