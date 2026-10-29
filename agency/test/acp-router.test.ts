import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { acpFixture } from "./acp-support.js"
import type { JsonObject } from "../src/agent/session-config.js"

const initialize = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true }, terminal: true } }
const meta = (backendId: string): JsonObject => ({ agency: { version: 1, commandId: randomUUID(), backendId } })

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