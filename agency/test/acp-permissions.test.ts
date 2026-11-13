import assert from "node:assert/strict"
import test from "node:test"
import type { JsonObject } from "../src/agent/session-config.js"
import { acpFixture } from "./acp-support.js"

const selected = (optionId: string): JsonObject => ({ outcome: { outcome: "selected", optionId } })

test("real provider receives exactly one racing shared decision", async t => {
  const f = await acpFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", { protocolVersion: 1 }); await b.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] })
  const ar = await a.next("session/request_permission"), br = await b.next("session/request_permission")
  a.respond(ar.id, selected("allow-once")); b.respond(br.id, selected("reject-once"))
  assert.equal((await pending).stopReason, "end_turn")
  const withdrawn = await b.next("agency/permission_withdrawn")
  assert.equal(withdrawn.requestId, br.id)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 1)
})

test("multi-line shell titles reach clients unchanged", async t => {
  const f = await acpFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission-multiline" }] })
  const request = await a.next("session/request_permission")
  assert.equal((request.params.toolCall as JsonObject).title, "python3 - <<'EOF'\n\tprint(1)\nEOF")
  a.respond(request.id, selected("allow-once"))
  assert.equal((await pending).stopReason, "end_turn")
})

test("permission requested after the turn ends reaches clients without failing the session", async t => {
  const f = await acpFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  assert.equal((await a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission-after-turn" }] })).stopReason, "end_turn")
  const request = await a.next("session/request_permission")
  assert.equal((request.params.toolCall as JsonObject).toolCallId, "after-turn-tool")
  a.respond(request.id, selected("allow-once"))
  const decided = async () => (await f.requests("codex-acp")).filter(frame => frame.id === "after-turn").map(frame => frame.result)
  for (let attempt = 0; attempt < 200 && !(await decided()).length; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(await decided(), [selected("allow-once")])
  assert.equal((await a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "plain" }] })).stopReason, "end_turn")
})

test("malformed permission requests are declined without failing the session", async t => {
  const f = await acpFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  assert.equal((await a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission-malformed" }] })).stopReason, "end_turn")
  assert.deepEqual((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).map(frame => frame.result!.outcome), [{ outcome: "selected", optionId: "reject-once" }])
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] })
  a.respond((await a.next("session/request_permission")).id, selected("allow-once"))
  assert.equal((await pending).stopReason, "end_turn")
})