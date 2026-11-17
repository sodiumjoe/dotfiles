import assert from "node:assert/strict"
import test from "node:test"
import { liveHandlerFixture } from "./live-support.js"
import type { JsonObject } from "../src/agent/session-config.js"

const initialize = { protocolVersion: 1, clientCapabilities: {} }
const agency = (value: JsonObject): JsonObject => (value._meta as JsonObject).agency as JsonObject

test("an editor creates an agent the Handler names, sees its prompt once without the provider's echo, and changes a setting", async t => {
  const f = await liveHandlerFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const created = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, backendId: "codex-acp" } } })
  const sessionId = String(created.sessionId), binding = agency(created).binding as JsonObject
  assert.match(sessionId, /^agency:[0-9a-f-]{36}$/)
  assert.equal(binding.agentId, sessionId.slice(7))
  assert.equal((await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "echo" }] })).stopReason, "end_turn")
  const users = c.drain("session/update").filter(update => (update.update as JsonObject).sessionUpdate === "user_message_chunk")
  assert.deepEqual(users.map(update => ((update.update as JsonObject).content as JsonObject).text), ["echo", "provider context"])
  await c.request("session/set_config_option", { sessionId, configId: "model", value: "model-b" })
  assert.equal((await f.agents())[0]?.live?.model, "model-b")
  await f.verifyZeroSurvivors()
})

test("loading a stopped agent restores it with the loading editor's environment", async t => {
  const f = await liveHandlerFixture(t), first = await f.connect({ AGENCY_TEST_EDITOR_MARKER: "first" })
  await first.request("initialize", initialize)
  const created = await first.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const sessionId = String(created.sessionId), before = agency(created).binding as JsonObject
  await first.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })
  await f.stop(sessionId.slice(7))
  assert.equal((await first.nextState("unavailable")).sessionId, sessionId)
  const second = await f.connect({ AGENCY_TEST_EDITOR_MARKER: "second" })
  await second.request("initialize", initialize)
  const loaded = await second.request("session/load", { sessionId, cwd: f.workspace, mcpServers: [] })
  const after = agency(loaded).binding as JsonObject
  assert.equal(after.agentId, before.agentId)
  assert.notEqual(after.providerGeneration, before.providerGeneration)
  const markers = (await f.providerRequests()).filter(frame => frame.method === "fixture/environment").map(frame => frame.params?.AGENCY_TEST_EDITOR_MARKER)
  assert.deepEqual(markers, ["first", "second"])
  assert.equal((await second.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] })).stopReason, "end_turn")
  await f.verifyZeroSurvivors()
})

test("the editor reads the roster and the model choices over its connection", async t => {
  const f = await liveHandlerFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const stopped = await f.start()
  await f.prompt(stopped.agentId, "hello"); await f.stop(stopped.agentId)
  const running = await f.start({ backendId: "claude-agent-acp" })
  const roster = await c.request("agency/roster", {})
  assert.equal(roster.handlerGeneration, (await f.handler()).generation)
  assert.deepEqual((roster.agents as JsonObject[]).map(row => [row.agentId, row.title, (row.live as JsonObject | null)?.activity ?? null]), [[stopped.agentId, "hello", null], [running.agentId, null, "idle"]])
  const backends = await c.request("agency/backends", {})
  assert.equal(backends.defaultBackendId, "codex-acp")
  assert.deepEqual((backends.backends as JsonObject[]).map(backend => [backend.id, backend.discovery, (backend.models as JsonObject[]).map(model => model.id)]), [["codex-acp", "fresh", ["model-a"]], ["claude-agent-acp", "fresh", ["model-a"]]])
  await f.verifyZeroSurvivors()
})

test("a permission request reaches every attached editor and exactly one decision reaches the provider", async t => {
  const f = await liveHandlerFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", initialize); await b.request("initialize", initialize)
  const created = await a.request("session/new", { cwd: f.workspace, mcpServers: [] }), sessionId = String(created.sessionId)
  await b.request("session/load", { sessionId, cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "permission" }] })
  const first = await a.next("session/request_permission"), second = await b.next("session/request_permission")
  a.respond(first.id, { outcome: { outcome: "selected", optionId: "allow-once" } }); b.respond(second.id, { outcome: { outcome: "selected", optionId: "reject-once" } })
  assert.equal((await pending).stopReason, "end_turn")
  assert.equal((await b.next("agency/permission_withdrawn")).requestId, second.id)
  assert.equal((await f.providerRequests()).filter(frame => (frame as JsonObject).result !== undefined).length, 1)
  const logged = (await f.events()).filter(event => event.agentId === sessionId.slice(7)).map(event => event.type)
  assert.ok(logged.includes("permission_requested") && logged.includes("permission_decided"))
  await f.verifyZeroSurvivors()
})

test("an editor that loads an agent while it is being restored shares that restore", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  await f.stop(agentId)
  await f.pauseSessions()
  const restoring = f.restore(agentId)
  await f.waitSession()
  const c = await f.connect()
  await c.request("initialize", initialize)
  const loading = c.request("session/load", { sessionId: "agency:" + agentId, cwd: f.workspace, mcpServers: [] })
  await f.releaseSessions()
  assert.equal((agency(await loading).binding as JsonObject).agentId, agentId)
  await restoring
  assert.equal((await f.providerRequests()).filter(frame => frame.method === "session/load").length, 1)
  await f.verifyZeroSurvivors()
})