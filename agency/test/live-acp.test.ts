import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { liveHandlerFixture } from "./live-support.js"
import { until } from "./control-support.js"
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
  assert.deepEqual((backends.backends as JsonObject[]).map(backend => [backend.id, backend.discovery, (backend.models as JsonObject[]).map(model => model.id)]), [["codex-acp", "fresh", ["model-a"]], ["claude-agent-acp", "fresh", ["model-a", "legacy-b"]]])
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
test("two outstanding prompts share one cancellation and leave the session reusable", async t => {
  const f = await liveHandlerFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [] }), sessionId = String(session.sessionId)
  const a = c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "held" }] })
  const b = c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "held" }] })
  await until(async () => (await f.providerRequests()).filter(value => value.method === "session/prompt").length === 2 ? true : undefined)
  c.notify("session/cancel", { sessionId })
  assert.deepEqual(await Promise.all([a, b]), [{ stopReason: "cancelled" }, { stopReason: "cancelled" }])
  assert.equal((await f.providerRequests()).filter(value => value.method === "session/cancel").length, 1)
  assert.equal((await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "next" }] })).stopReason, "end_turn")
  await f.verifyZeroSurvivors()
})

test("provider errors keep their data and permit a later prompt", async t => {
  const f = await liveHandlerFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [] }), sessionId = String(session.sessionId)
  await assert.rejects(c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "provider-busy" }] }), { code: -32042, message: "Provider busy", data: { retry: true } })
  assert.equal((await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "next" }] })).stopReason, "end_turn")
  await f.verifyZeroSurvivors()
})

test("one connection routes two agents of different backends without sharing their configuration", async t => {
  const f = await liveHandlerFixture(t), c = await f.connect()
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true }, terminal: true } })
  const a = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, backendId: "codex-acp" } } })
  const b = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, backendId: "claude-agent-acp" } } })
  assert.notEqual(a.sessionId, b.sessionId)
  await c.request("session/prompt", { sessionId: b.sessionId!, prompt: [{ type: "text", text: "second" }] })
  await c.request("session/prompt", { sessionId: a.sessionId!, prompt: [{ type: "image", data: "eA==", mimeType: "image/png" }] })
  await assert.rejects(c.request("session/prompt", { sessionId: b.sessionId!, prompt: [{ type: "image", data: "eA==", mimeType: "image/png" }] }))
  for (const backend of ["codex-acp", "claude-agent-acp"] as const) {
    const requests = await f.providerRequests(backend)
    assert.equal(requests.filter(x => x.method === "session/prompt").length, 1)
    const client = requests.find(x => x.method === "initialize")?.params?.clientCapabilities as JsonObject
    assert.deepEqual(client.fs, { readTextFile: false, writeTextFile: false }); assert.equal(client.terminal, false)
  }
  await f.verifyZeroSurvivors()
})

test("a Claude mode change applies during a running turn", async t => {
  const f = await liveHandlerFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, backendId: "claude-agent-acp" } } }), sessionId = String(session.sessionId)
  const pending = c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "held" }] })
  await until(async () => (await f.providerRequests("claude-agent-acp")).some(value => value.method === "session/prompt") ? true : undefined)
  await c.request("session/set_mode", { sessionId, modeId: "review" })
  await f.releasePrompts()
  assert.equal((await pending).stopReason, "end_turn")
  assert.ok((await f.providerRequests("claude-agent-acp")).some(value => value.method === "session/set_mode" && value.params?.modeId === "review"))
  await f.verifyZeroSurvivors()
})

test("replay precedes live output without gaps and keeps the accepted prompt's metadata", async t => {
  const f = await liveHandlerFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", initialize); await b.request("initialize", initialize)
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] }), submissionId = randomUUID()
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "held" }], _meta: { agency: { version: 1, submissionId }, other: "preserved" } })
  await a.nextState("running")
  const loaded = await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  const replay = b.drain("session/update"), attachment = agency(loaded)
  assert.equal(replay.length, 1)
  assert.equal((replay[0]?._meta as JsonObject).other, "preserved")
  const echo = agency(replay[0]!)
  assert.equal(echo.submissionId, submissionId); assert.equal(echo.replay, true); assert.equal(typeof echo.originConnectionId, "string")
  assert.equal(attachment.turnId, submissionId)
  await f.releasePrompts(); await pending; await b.nextState("idle")
  const sequence = agency(await b.next("session/update"))
  assert.equal(sequence.replay, false); assert.ok(Number(sequence.seq) > Number(attachment.lastSeq))
  await f.verifyZeroSurvivors()
})
test("an editor's combined Codex model ID reaches the provider unchanged", async t => {
  const f = await liveHandlerFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, backendId: "codex-acp", selection: { modelId: "model-a[high]", modeId: "read-only" } } } })
  assert.ok((await f.providerRequests()).some(value => value.method === "session/set_model" && value.params?.modelId === "model-a[high]"))
  await f.verifyZeroSurvivors()
})
test("the editor reads an excerpt over its connection", async t => {
  const f = await liveHandlerFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  const turns = [{ role: "user", text: "hello" }, { role: "agent", text: "answer:hello" }]
  assert.deepEqual((await c.request("agency/excerpt", { agentId })).turns, turns)
  await assert.rejects(c.request("agency/excerpt", { agentId, turns: 9 }), (error: { data?: { agency?: { code?: string } } }) => error.data?.agency?.code === "INVALID")
  await assert.rejects(c.request("agency/excerpt", { agentId: "00000000-0000-4000-8000-000000000999" }), (error: { data?: { agency?: { code?: string } } }) => error.data?.agency?.code === "NOT_FOUND")
  await f.stop(agentId)
  assert.deepEqual((await c.request("agency/excerpt", { agentId })).turns, turns)
  await f.verifyZeroSurvivors()
})

test("the editor stops an agent over its connection", async t => {
  const f = await liveHandlerFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  const stopped = await c.request("agency/stop", { agentId })
  assert.equal(stopped.state, "agent")
  assert.equal((stopped.agent as JsonObject).live, null)
  assert.equal(((await c.request("agency/stop", { agentId })).agent as JsonObject).live, null)
  await assert.rejects(c.request("agency/stop", { agentId: "00000000-0000-4000-8000-000000000999" }), (error: { data?: { agency?: { code?: string } } }) => error.data?.agency?.code === "NOT_FOUND")
  await f.verifyZeroSurvivors()
})