import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createConnection } from "node:net"
import { join } from "node:path"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { readFile, writeFile } from "node:fs/promises"
import { createAcpDecoder } from "../src/acp/protocol.js"
import { until } from "./control-support.js"
import { agentServiceFixture } from "./agent-support.js"
import { createAcpRouter } from "../src/acp/router.js"
import { agentTuple } from "../src/agent/recovery.js"
import test from "node:test"
import { acpFixture } from "./acp-support.js"
import type { JsonObject } from "../src/agent/session-config.js"

const initialize = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true }, terminal: true } }
const meta = (backendId: string): JsonObject => ({ agency: { version: 1, commandId: randomUUID(), backendId } })

test("initialize and list launch no backend and defer interactive authentication", async t => {
  const f = await acpFixture(t), c = await f.connect()
  const result = await c.request("initialize", initialize)
  assert.deepEqual(result.authMethods, [])
  assert.equal((result.agentCapabilities as JsonObject).loadSession, true)
  assert.deepEqual((result.agentCapabilities as JsonObject).promptCapabilities, { image: true, audio: false, embeddedContext: true })
  assert.deepEqual((await c.request("session/list", {})).sessions, [])
  await assert.rejects(c.request("authenticate", { methodId: "fixture-login" }), { code: "UNSUPPORTED_SESSION_FEATURE" })
  assert.equal((await f.requests("codex-acp")).length, 0)
  assert.equal((await f.requests("claude-agent-acp")).length, 0)
})

test("backend choices come from enabled Agency configuration without catalog qualification or spawning", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const choices = await c.request("agency/backends", {})
  assert.equal(choices.defaultBackendId, "codex-acp")
  assert.deepEqual((choices.backends as JsonObject[]).map(value => value.id), ["codex-acp", "claude-agent-acp"])
  assert.equal((await f.requests("codex-acp")).length, 0)
  assert.equal((await f.requests("claude-agent-acp")).length, 0)
})

test("one connection routes two colliding native session IDs without sharing backend configuration", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const a = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: meta("codex-acp") })
  const b = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: meta("claude-agent-acp") })
  assert.notEqual(a.sessionId, b.sessionId)
  assert.ok(String(a.sessionId).startsWith("agency:"))
  assert.ok(Array.isArray(a.configOptions)); assert.ok(b.models)
  await c.request("session/prompt", { sessionId: b.sessionId!, prompt: [{ type: "text", text: "second" }] })
  await c.request("session/prompt", { sessionId: a.sessionId!, prompt: [{ type: "image", data: "eA==", mimeType: "image/png" }] })
  await assert.rejects(c.request("session/prompt", { sessionId: b.sessionId!, prompt: [{ type: "image", data: "eA==", mimeType: "image/png" }] }), { code: "UNSUPPORTED_SESSION_FEATURE" })
  for (const backend of ["codex-acp", "claude-agent-acp"] as const) {
    const requests = await f.requests(backend)
    assert.equal(requests.filter(x => x.method === "session/prompt").length, 1)
    assert.equal(requests.find(x => x.method === "session/prompt")?.params?.sessionId, "native-session")
    const client = requests.find(x => x.method === "initialize")?.params?.clientCapabilities as JsonObject
    assert.deepEqual(client.fs, { readTextFile: false, writeTextFile: false }); assert.equal(client.terminal, false)
  }
})

test("restore requires explicit reattachment despite stable logical ID", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const s = await c.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const previous = await f.tuple(String(s.sessionId))
  await f.stopSession(String(s.sessionId)); await f.restoreSession(String(s.sessionId), { NVIM: "/new-editor" })
  await assert.rejects(c.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "stale" }] }), { code: "STALE_ATTACHMENT" })
  await assert.rejects(c.request("session/set_config_option", { sessionId: s.sessionId!, configId: "model", value: "model-b" }), { code: "STALE_ATTACHMENT" })
  await assert.rejects(c.request("session/cancel", { sessionId: s.sessionId!, _meta: { agency: { version: 1, turnId: randomUUID() } } }), { code: "STALE_ATTACHMENT" })
  await c.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  assert.notEqual((await f.tuple(String(s.sessionId))).providerGeneration, previous.providerGeneration)
  assert.equal((await f.requests("codex-acp")).filter(x => x.method === "session/prompt").length, 0)
})

test("lost frontend response never resubmits accepted input", async t => {
  const f = await acpFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", initialize); await b.request("initialize", initialize)
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "held" }] }).catch(() => null)
  await a.nextState("running"); a.close()
  await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  await b.nextState("running"); await f.release("codex-acp"); await pending; await b.nextState("idle")
  assert.equal((await f.requests("codex-acp")).filter(x => x.method === "session/prompt").length, 1)
  assert.equal((await f.requests("codex-acp")).filter(x => x.method === "session/new").length, 1)
  assert.equal((await f.requests("codex-acp")).filter(x => x.method === "session/load").length, 0)
})

test("setters publish authoritative configuration to both attachments and preserve it on load", async t => {
  const f = await acpFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", initialize); await b.request("initialize", initialize)
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  a.drain("agency/session_state"); b.drain("agency/session_state")
  await a.request("session/set_config_option", { sessionId: s.sessionId!, configId: "model", value: "model-b" })
  const state = await b.nextState("idle"), config = state.configuration as JsonObject
  assert.equal((config.configOptions as JsonObject[]).find(value => value.id === "model")?.currentValue, "model-b")
  assert.ok((a.drain("agency/session_state")[0]?.configuration as JsonObject).revision as number > 0)
  const loaded = await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  assert.equal((loaded.configOptions as JsonObject[]).find(value => value.id === "model")?.currentValue, "model-b")
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/load").length, 0)
})

test("replay precedes live output without gaps and retains accepted user origin metadata", async t => {
  const f = await acpFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", initialize); await b.request("initialize", initialize)
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] }), submissionId = randomUUID()
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "held" }], _meta: { agency: { version: 1, submissionId }, other: "preserved" } })
  await a.nextState("running")
  const loaded = await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  const replay = b.drain("session/update"), attachment = (loaded._meta as JsonObject).agency as JsonObject
  assert.equal(replay.length, 1)
  assert.equal((replay[0]?._meta as JsonObject).other, "preserved")
  const echo = (replay[0]?._meta as JsonObject).agency as JsonObject
  assert.equal(echo.submissionId, submissionId); assert.equal(echo.replay, true); assert.equal(typeof echo.originConnectionId, "string")
  assert.equal(attachment.turnId, submissionId)
  await f.release("codex-acp"); await pending; await b.nextState("idle")
  const live = await b.next("session/update"), sequence = ((live._meta as JsonObject).agency as JsonObject)
  assert.equal(sequence.replay, false); assert.ok(Number(sequence.seq) > Number(attachment.lastSeq))
})

test("history truncation never changes current configuration or submits replay as a prompt", async t => {
  const f = await acpFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", initialize); await b.request("initialize", initialize)
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  await a.request("session/set_config_option", { sessionId: s.sessionId!, configId: "model", value: "model-b" })
  await a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "history" }] })
  const loaded = await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  const info = (loaded._meta as JsonObject).agency as JsonObject, replay = b.drain("session/update")
  assert.equal(info.historyTruncated, true); assert.ok(Number(info.firstSeq) > 1)
  assert.equal(replay.length, 8191)
  const sequences = replay.map(value => Number(((value._meta as JsonObject).agency as JsonObject).seq))
  assert.equal(new Set(sequences).size, sequences.length)
  assert.equal(sequences.at(-1), Number(info.lastSeq) - 1)
  assert.equal((loaded.configOptions as JsonObject[]).find(value => value.id === "model")?.currentValue, "model-b")
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/prompt").length, 1)
})

test("invalid client parameters cannot fail the bound provider", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const s = await c.request("session/new", { cwd: f.workspace, mcpServers: [] })
  await assert.rejects(c.request("unknown", {}), { code: -32601 })
  await assert.rejects(c.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: 12 }] }), { code: -32602 })
  await assert.rejects(c.request("session/prompt", { sessionId: "native-session", prompt: [{ type: "text", text: "invalid" }] }), { code: -32602 })
  await assert.rejects(c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, backendId: "codex-acp", inheritSessionId: s.sessionId! } } }), { code: -32602 })
  assert.equal((await c.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "valid" }] })).stopReason, "end_turn")
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/prompt").length, 1)
})

test("duplicate pending connection IDs cannot dispatch another mutation or receive two responses", async t => {
  const f = await acpFixture(t), socket = createConnection(join(f.paths.runtimeRoot, "acp.sock")), frames: JsonObject[] = []
  t.after(() => socket.destroy())
  const decoder = createAcpDecoder(frame => frames.push(frame), error => assert.fail(String(error)))
  socket.on("data", bytes => decoder.feed(bytes))
  const send = (frame: JsonObject) => socket.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n")
  send({ method: "agency/connect", params: { environment: f.environment, handlerGeneration: (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation } })
  send({ id: 1, method: "initialize", params: initialize }); await until(async () => frames.find(value => value.id === 1))
  send({ id: 2, method: "session/new", params: { cwd: f.workspace, mcpServers: [] } })
  const s = (await until(async () => frames.find(value => value.id === 2))).result as JsonObject
  send({ id: 3, method: "session/prompt", params: { sessionId: s.sessionId!, prompt: [{ type: "text", text: "held" }] } })
  await until(async () => frames.find(value => value.method === "agency/session_state" && (value.params as JsonObject).state === "running"))
  send({ id: 3, method: "session/set_config_option", params: { sessionId: s.sessionId!, configId: "model", value: "model-b" } })
  const failure = await until(async () => frames.find(value => value.id === 3))
  assert.equal((failure.error as JsonObject).code, -32600)
  await f.release("codex-acp")
  await until(async () => frames.find(value => value.method === "agency/session_state" && (value.params as JsonObject).state === "idle" && frames.indexOf(value) > frames.indexOf(failure)))
  assert.equal(frames.filter(value => value.id === 3).length, 1)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/set_config_option").length, 0)
})

test("explicit cancellation targets a previous turn ID without cancelling the current turn", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const s = await c.request("session/new", { cwd: f.workspace, mcpServers: [] }), previous = randomUUID()
  await c.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "first" }], _meta: { agency: { version: 1, submissionId: previous } } })
  const pending = c.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "held" }] })
  await c.nextState("running")
  await c.request("session/cancel", { sessionId: s.sessionId!, _meta: { agency: { version: 1, turnId: previous } } })
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/cancel").length, 0)
  await c.request("session/cancel", { sessionId: s.sessionId! }); assert.equal((await pending).stopReason, "cancelled")
})

test("matching provider user echo is collapsed while unrelated provider context remains replayable", async t => {
  const f = await acpFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", initialize); await b.request("initialize", initialize)
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  await a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "echo" }] })
  await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  const chunks = b.drain("session/update").filter(value => (value.update as JsonObject).sessionUpdate === "user_message_chunk")
  assert.deepEqual(chunks.map(value => ((value.update as JsonObject).content as JsonObject).text), ["echo", "provider context"])
})

test("events arriving during atomic snapshot handoff are flushed after replay before the load response", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), service = f.service
  const record = await service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: { cwd: f.workspace, mcpServers: [] } }), target = agentTuple(record)!, sessionId = "agency:" + target.agentId
  const submissionId = randomUUID()
  await service.submitAcp(target, { submissionId, prompt: [{ type: "text", text: "held" }] }); await f.promptEntered
  const captured = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), frames: JsonObject[] = []
  const router = createAcpRouter({ service: { ...service, async observeSession(...args) { const observation = await service.observeSession(...args); captured.resolve(); await release.promise; return observation } }, connectionId: randomUUID(), send: frame => frames.push(frame) })
  t.after(() => router.close())
  await router.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })
  const load = router.receive({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd: f.workspace, mcpServers: [] } })
  await captured.promise; f.completePrompt(target.agentId, "racing answer"); await service.settledAcp(target, submissionId); release.resolve(); await load
  const updates = frames.filter(frame => frame.method === "session/update").map(frame => frame.params as JsonObject)
  assert.equal(updates.length, 2)
  assert.equal((((updates[0]!._meta as JsonObject).agency as JsonObject).replay), true)
  assert.equal((((updates[1]!._meta as JsonObject).agency as JsonObject).replay), false)
  assert.equal(((updates[1]!.update as JsonObject).content as JsonObject).text, "racing answer")
  assert.equal((frames.at(-1)!.result as JsonObject)._meta && (((frames.at(-1)!.result as JsonObject)._meta as JsonObject).agency as JsonObject).turnId, null)
  assert.equal(frames.at(-1)!.id, 2)
})

test("a partial echo prefix is preserved if later provider context does not match accepted input", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const s = await c.request("session/new", { cwd: f.workspace, mcpServers: [] })
  await c.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "echo-mismatch" }] })
  assert.deepEqual(c.drain("session/update").filter(value => (value.update as JsonObject).sessionUpdate === "user_message_chunk").map(value => ((value.update as JsonObject).content as JsonObject).text), ["echo-mismatch", "echo-", "different"])
})

test("omitted cancellation pins the turn at receipt before asynchronous validation", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), service = f.service
  const record = await service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: { cwd: f.workspace, mcpServers: [] } }), target = agentTuple(record)!, sessionId = "agency:" + target.agentId
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), frames: JsonObject[] = []
  let hold = false
  const router = createAcpRouter({ service: { ...service, async sessionSnapshot(target) { if (hold) { hold = false; entered.resolve(); await release.promise }; return service.sessionSnapshot(target) } }, connectionId: randomUUID(), send: frame => frames.push(frame) })
  t.after(() => { release.resolve(); router.close() })
  await router.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })
  await router.receive({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd: f.workspace, mcpServers: [] } })
  const first = router.receive({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "first" }] } })
  await f.promptEntered; hold = true
  const cancel = router.receive({ jsonrpc: "2.0", id: 4, method: "session/cancel", params: { sessionId } })
  await entered.promise; f.completePrompt(target.agentId); await first
  const submissionId = randomUUID(), second = router.receive({ jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "second" }], _meta: { agency: { version: 1, submissionId } } } })
  await until(async () => f.methodHistory.filter(method => method === "session/prompt").length === 2 ? true : undefined)
  release.resolve(); await cancel
  assert.equal((await service.submission(target, submissionId))?.state, "running")
  f.completePrompt(target.agentId); await second
  assert.equal((frames.find(frame => frame.id === 5)!.result as JsonObject).stopReason, "end_turn")
})

test("an unavailable configured default does not silently launch an available alternative", async t => {
  const f = await acpFixture(t), path = join(f.paths.persistentRoot, "catalog/providers.json"), profiles = JSON.parse(await readFile(path, "utf8"))
  profiles.providers[0].enabled = false
  await writeFile(path, JSON.stringify(profiles), { mode: 0o600 })
  const c = await f.connect()
  await c.request("initialize", initialize)
  await assert.rejects(c.request("session/new", { cwd: f.workspace, mcpServers: [] }), { code: "UNAVAILABLE" })
  assert.equal((await f.requests("claude-agent-acp")).length, 0)
  const s = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: meta("claude-agent-acp") })
  assert.ok(s.models)
})

test("malformed MCP descriptors reject before launching or attaching a session", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  await assert.rejects(c.request("session/new", { cwd: f.workspace, mcpServers: [{ name: "invalid", command: "tool", args: "invalid", env: [] }] }), { code: -32602 })
  assert.equal((await f.requests("codex-acp")).length, 0)
  const s = await c.request("session/new", { cwd: f.workspace, mcpServers: [] })
  await assert.rejects(c.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [{ name: "invalid" }] }), { code: -32602 })
})

test("invalid list cursors are rejected instead of silently returning a different page", async t => {
  const f = await agentServiceFixture(t), frames: JsonObject[] = []
  const router = createAcpRouter({ service: f.service, connectionId: randomUUID(), send: frame => frames.push(frame) })
  t.after(() => router.close())
  await router.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })
  await router.receive({ jsonrpc: "2.0", id: 2, method: "session/list", params: { cursor: "invalid cursor" } })
  assert.ok(frames.at(-1)!.error, "invalid cursor was silently accepted")
  assert.equal((frames.at(-1)!.error as JsonObject).code, -32602)
})

test("loading one session does not require the bounded whole-inventory reply", async t => {
  const f = await agentServiceFixture(t), service = f.service, frames: JsonObject[] = []
  const record = await service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: { cwd: f.workspace, mcpServers: [] } }), sessionId = "agency:" + record.definition.agentId
  const router = createAcpRouter({ service: { ...service, async list() { throw new Error("whole inventory exceeds transport bound") } }, connectionId: randomUUID(), send: frame => frames.push(frame) })
  t.after(() => router.close())
  await router.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })
  await router.receive({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd: f.workspace, mcpServers: [] } })
  assert.ok(frames.at(-1)!.result, "single-session attachment depends on a whole-inventory reply")
  assert.equal((frames.at(-1)!.result as JsonObject).sessionId, sessionId)
})

test("invalid parameter envelopes return invalid params without abandoning the connection", async t => {
  const f = await agentServiceFixture(t), frames: JsonObject[] = []
  const router = createAcpRouter({ service: f.service, connectionId: randomUUID(), send: frame => frames.push(frame) })
  t.after(() => router.close())
  await router.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })
  await router.receive({ jsonrpc: "2.0", id: 2, method: "session/list", params: [] })
  assert.equal((frames.at(-1)!.error as JsonObject)?.code, -32602)
  await router.receive({ jsonrpc: "2.0", id: 3, method: "session/list", params: {} })
  assert.ok(frames.at(-1)!.result)
})

test("a generation invalidated during replay cannot report a successful attachment", async t => {
  const f = await agentServiceFixture(t), service = f.service, frames: JsonObject[] = []
  const record = await service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: { cwd: f.workspace, mcpServers: [] } }), target = agentTuple(record)!, sessionId = "agency:" + target.agentId
  const router = createAcpRouter({ service: { ...service, async observeSession(...args) {
    const observed = await service.observeSession(...args)
    const commandId = randomUUID()
    await service.stop({ ...target, commandId })
    await until(async () => (await service.command(commandId, target.handlerGeneration)).command.state === "completed" ? true : undefined)
    return observed
  } }, connectionId: randomUUID(), send: frame => frames.push(frame) })
  t.after(() => router.close())
  await router.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })
  await router.receive({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd: f.workspace, mcpServers: [] } })
  assert.equal((((frames.at(-1)!.error as JsonObject)?.data as JsonObject)?.agency as JsonObject)?.code, "STALE_ATTACHMENT")
})

test("new-session inheritance uses the current binding backend instead of the default", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const first = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: meta("claude-agent-acp") })
  const second = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, inheritSessionId: first.sessionId! } } })
  assert.equal(((second._meta as JsonObject).agency as JsonObject).backendId, "claude-agent-acp")
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal((await f.requests("codex-acp")).length, 0)
})

test("pre-creation choices carry configured defaults and advertised model-specific settings without spawning", async t => {
  const f = await acpFixture(t, { selectionCatalog: true }), c = await f.connect()
  await c.request("initialize", initialize)
  const choices = await c.request("agency/backends", {})
  const backend = (choices.backends as JsonObject[]).find(value => value.id === "codex-acp")!
  assert.equal(backend.discovery, "fresh")
  assert.deepEqual(backend.defaults, {})
  const model = (backend.models as JsonObject[]).find(value => value.id === "model-c")!
  assert.deepEqual(model.selection, { configValues: { model: "model-c" } })
  assert.deepEqual((model.settings as JsonObject[])[0]!.values, [{ value: "medium", name: "medium" }, { value: "minimal", name: "minimal" }])
  assert.equal((await f.inventory()).agents.length, 0)
  assert.equal((await f.requests("codex-acp")).length, 0)
})

test("changed catalog configuration exposes only labeled configured defaults without replacing the backend", async t => {
  const f = await acpFixture(t, { selectionCatalog: true }), c = await f.connect()
  await c.request("initialize", initialize)
  await writeFile(join(f.root, "profile/declared.json"), "changed", { mode: 0o600 })
  const backend = ((await c.request("agency/backends", {})).backends as JsonObject[]).find(value => value.id === "codex-acp")!
  assert.equal(backend.discovery, "unavailable")
  assert.deepEqual(backend.models, [])
  assert.deepEqual(backend.defaults, {})
  assert.equal((await f.inventory()).agents.length, 0)
})

test("raw selected models work beside composite legacy IDs and validate reasoning after changing model", async t => {
  const f = await acpFixture(t, { selectionCatalog: true }), c = await f.connect()
  await c.request("initialize", initialize)
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: {
    agency: { version: 1, backendId: "codex-acp", selection: { configValues: { reasoning_effort: "medium", model: "model-c", mode: "read-only" } } }
  } })
  const configuration = ((session._meta as JsonObject).agency as JsonObject).configuration as JsonObject
  const options = configuration.configOptions as JsonObject[]
  assert.equal(options.find(value => value.id === "model")!.currentValue, "model-c")
  assert.equal(options.find(value => value.id === "reasoning_effort")!.currentValue, "medium")
  assert.equal(options.find(value => value.id === "mode")!.currentValue, "read-only")
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/new").length, 1)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/prompt").length, 0)
})

test("legacy saved history remains visible with stable pagination and cwd filtering", async t => {
  const f = await acpFixture(t, { legacyCount: 101 }), c = await f.connect()
  await c.request("initialize", initialize)
  await c.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const all: JsonObject[] = []
  let cursor: string | undefined
  do {
    const page = await c.request("session/list", cursor ? { cursor } : {})
    all.push(...page.sessions as JsonObject[])
    cursor = page.nextCursor as string | undefined
  } while (cursor)
  assert.equal(all.length, 102)
  assert.equal(new Set(all.map(value => value.sessionId)).size, 102)
  const historical = all.filter(value => ((value._meta as JsonObject).agency as JsonObject).recordVersion === 1)
  assert.equal(historical.length, 101)
  const saved = historical[0]!
  assert.equal(((saved._meta as JsonObject).agency as JsonObject).unavailable, true)
  assert.equal(((saved._meta as JsonObject).agency as JsonObject).backendId, undefined)
  assert.equal(((saved._meta as JsonObject).agency as JsonObject).nativeSessionId, undefined)
  assert.equal(saved.cwd, f.otherWorkspace)
  await assert.rejects(c.request("session/load", { sessionId: saved.sessionId!, cwd: saved.cwd!, mcpServers: [] }), { code: "UNAVAILABLE" })
  await assert.rejects(f.restore(String(saved.sessionId).slice(7)), { code: "NOT_READY" })
  const local = await c.request("session/list", { cwd: f.workspace })
  assert.equal((local.sessions as JsonObject[]).length, 1)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/new").length, 1)
})

for (const catalogState of ["missing", "stale", "prior-generation", "failed"] as const) test(`${catalogState} catalog preserves defaults and labels reusable model evidence before creation`, async t => {
  const f = await acpFixture(t, { selectionCatalog: true, catalogState }), c = await f.connect()
  await c.request("initialize", initialize)
  const path = join(f.paths.persistentRoot, "catalog/backends.json")
  const config = JSON.parse(await readFile(path, "utf8"))
  config.backends[0].initial = { modeId: "agent-full-access", configValues: { reasoning_effort: "high" } }
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  const backend = ((await c.request("agency/backends", {})).backends as JsonObject[]).find(value => value.id === "codex-acp")!
  assert.equal(backend.discovery, catalogState === "missing" ? "unavailable" : "cached")
  const models = backend.models as JsonObject[]
  if (catalogState === "missing") assert.deepEqual(models, [])
  else assert.ok(models.some(model => model.id === "model-c"))
  if (catalogState === "failed") assert.equal(backend.discoveryError, "Provider discovery failed")
  assert.deepEqual(backend.defaults, { modeId: "agent-full-access", configValues: { reasoning_effort: "high" } })
  assert.equal((await f.inventory()).agents.length, 0)
  assert.equal((await f.requests("codex-acp")).length, 0)
  await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, backendId: "codex-acp", selection: backend.defaults! } } })
  assert.equal((await f.inventory()).agents.length, 1)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/prompt").length, 0)
})

test("explicit modern selections override conflicting configured legacy model and mode defaults", async t => {
  const f = await acpFixture(t, { selectionCatalog: true }), c = await f.connect()
  await c.request("initialize", initialize)
  const path = join(f.paths.persistentRoot, "catalog/backends.json"), config = JSON.parse(await readFile(path, "utf8"))
  config.backends[0].initial = { modelId: "model-a[high]", modeId: "read-only", configValues: { reasoning_effort: "high" } }
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  const s = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, backendId: "codex-acp", selection: {
    configValues: { model: "model-c", reasoning_effort: "medium", mode: "agent-full-access" }
  } } } })
  const options = (((s._meta as JsonObject).agency as JsonObject).configuration as JsonObject).configOptions as JsonObject[]
  assert.equal(options.find(value => value.id === "model")!.currentValue, "model-c")
  assert.equal(options.find(value => value.id === "mode")!.currentValue, "agent-full-access")
})

test("incompatible enabled backends do not block compatible choices or change the configured default", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  await writeFile(join(f.root, "secondary/adapter.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "99.0.0", main: "agent-provider.js" }), { mode: 0o600 })
  const compatible = await c.request("agency/backends", {})
  assert.equal(compatible.defaultBackendId, "codex-acp")
  assert.deepEqual((compatible.backends as JsonObject[]).map(value => value.id), ["codex-acp"])
  await writeFile(join(f.root, "profile/adapter.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "99.0.0", main: "agent-provider.js" }), { mode: 0o600 })
  assert.deepEqual(await c.request("agency/backends", {}), { defaultBackendId: "codex-acp", backends: [] })
  assert.equal((await f.requests("codex-acp")).length, 0)
  assert.equal((await f.requests("claude-agent-acp")).length, 0)
})

test("active and saved session listings use the first request title after the creating client disconnects", async t => {
  const f = await acpFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", initialize); await b.request("initialize", initialize)
  const created = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  await a.request("session/prompt", { sessionId: created.sessionId!, prompt: [{ type: "text", text: "Repair picker window layout" }] })
  a.close()
  const listed = await b.request("session/list", {})
  assert.equal((listed.sessions as JsonObject[]).find(value => value.sessionId === created.sessionId)?.title, "Repair picker window layout")
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/new").length, 1)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/prompt").length, 1)
})

test("ACP roster returns full active memory pages without authoritative page reads", async t => {
  const f = await agentServiceFixture(t), frames: JsonObject[] = []
  const router = createAcpRouter({ service: f.service, connectionId: randomUUID(), send: frame => frames.push(frame) })
  t.after(() => router.close())
  await router.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })
  const started = await f.service.start(f.input)
  await until(async () => (await f.service.command(f.input.commandId, f.input.handlerGeneration)).command.state === "completed" ? true : undefined)
  const failure = t.mock.method(f.store, "inventory", async () => { throw new Error("authoritative read") })
  try {
    await router.receive({ jsonrpc: "2.0", id: 2, method: "agency/roster", params: { limit: 100 } })
    const page = frames.find(frame => frame.id === 2)!.result as JsonObject
    assert.ok(page)
    assert.equal(page.handlerGeneration, f.input.handlerGeneration)
    assert.equal(page.state, "page")
    const agents = page.agents as JsonObject[]
    assert.equal(agents.length, 1)
    assert.deepEqual(agentTuple((agents[0]!.record as unknown) as Parameters<typeof agentTuple>[0]), started.command.target)
    for (const params of [{ limit: 100, activeOnly: false }, { limit: 101 }, { limit: 100, extra: true }]) {
      await router.receive({ jsonrpc: "2.0", id: 3, method: "agency/roster", params })
      assert.equal((frames.at(-1)!.error as JsonObject).code, -32602)
    }
  } finally { failure.mock.restore() }
})

test("a load superseded during permission attachment cannot replace the newer binding", async t => {
  const f = await agentServiceFixture(t), service = f.service, frames: JsonObject[] = []
  const record = await service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: { cwd: f.workspace, mcpServers: [] } })
  const sessionId = "agency:" + record.definition.agentId, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let hold = true
  const router = createAcpRouter({ service: { ...service, async attachPermissions(...args) {
    if (hold) { hold = false; entered.resolve(); await release.promise }
    return service.attachPermissions(...args)
  } }, connectionId: randomUUID(), send: frame => frames.push(frame) })
  t.after(() => { release.resolve(); router.close() })
  await router.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })
  const params = { sessionId, cwd: f.workspace, mcpServers: [] }
  const obsolete = router.receive({ jsonrpc: "2.0", id: 2, method: "session/load", params })
  await entered.promise
  await router.receive({ jsonrpc: "2.0", id: 3, method: "session/load", params })
  release.resolve(); await obsolete
  assert.ok(frames.find(frame => frame.id === 3)?.result)
  assert.equal((((frames.find(frame => frame.id === 2)?.error as JsonObject)?.data as JsonObject)?.agency as JsonObject)?.code, "STALE_ATTACHMENT")
  await router.receive({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "still attached" }] } })
  assert.ok(frames.find(frame => frame.id === 4)?.result)
})

test("a prompt validated against a replaced attachment cannot be accepted", async t => {
  const f = await agentServiceFixture(t), service = f.service, frames: JsonObject[] = []
  const record = await service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: { cwd: f.workspace, mcpServers: [] } })
  const sessionId = "agency:" + record.definition.agentId, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let hold = false
  const router = createAcpRouter({ service: { ...service, async sessionSnapshot(target) {
    if (hold) { hold = false; entered.resolve(); await release.promise }
    return service.sessionSnapshot(target)
  } }, connectionId: randomUUID(), send: frame => frames.push(frame) })
  t.after(() => { release.resolve(); router.close() })
  await router.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })
  const params = { sessionId, cwd: f.workspace, mcpServers: [] }
  await router.receive({ jsonrpc: "2.0", id: 2, method: "session/load", params })
  hold = true
  const obsolete = router.receive({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "obsolete" }] } })
  await entered.promise
  await router.receive({ jsonrpc: "2.0", id: 4, method: "session/load", params })
  release.resolve(); await obsolete
  assert.equal((((frames.find(frame => frame.id === 3)?.error as JsonObject)?.data as JsonObject)?.agency as JsonObject)?.code, "STALE_ATTACHMENT")
  assert.equal(f.methodHistory.filter(method => method === "session/prompt").length, 0)
})