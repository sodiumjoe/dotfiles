import assert from "node:assert/strict"
import test from "node:test"
import type { JsonObject } from "../src/agent/session-config.js"
import { liveHandlerFixture } from "./live-support.js"

const selected = (optionId: string): JsonObject => ({ outcome: { outcome: "selected", optionId } })
const frames = async (f: Awaited<ReturnType<typeof liveHandlerFixture>>) => (await f.providerRequests("codex-acp")) as JsonObject[]

test("multi-line shell titles reach clients unchanged", async t => {
  const f = await liveHandlerFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission-multiline" }] })
  const request = await a.next("session/request_permission")
  assert.equal((request.params.toolCall as JsonObject).title, "python3 - <<'EOF'\n\tprint(1)\nEOF")
  a.respond(request.id, selected("allow-once"))
  assert.equal((await pending).stopReason, "end_turn")
  await f.verifyZeroSurvivors()
})

test("permission requested after the turn ends reaches clients without failing the session", async t => {
  const f = await liveHandlerFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  assert.equal((await a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission-after-turn" }] })).stopReason, "end_turn")
  const request = await a.next("session/request_permission")
  assert.equal((request.params.toolCall as JsonObject).toolCallId, "after-turn-tool")
  a.respond(request.id, selected("allow-once"))
  const decided = async () => (await frames(f)).filter(frame => frame.id === "after-turn").map(frame => frame.result)
  for (let attempt = 0; attempt < 200 && !(await decided()).length; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(await decided(), [selected("allow-once")])
  assert.equal((await a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "plain" }] })).stopReason, "end_turn")
  await f.verifyZeroSurvivors()
})

test("malformed permission requests are declined without failing the session", async t => {
  const f = await liveHandlerFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  assert.equal((await a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission-malformed" }] })).stopReason, "end_turn")
  assert.deepEqual((await frames(f)).filter(frame => (frame.result as JsonObject | undefined)?.outcome).map(frame => (frame.result as JsonObject).outcome), [{ outcome: "selected", optionId: "reject-once" }])
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] })
  a.respond((await a.next("session/request_permission")).id, selected("allow-once"))
  assert.equal((await pending).stopReason, "end_turn")
  await f.verifyZeroSurvivors()
})

test("the roster shows pending approvals and attached editors for a live agent", async t => {
  const f = await liveHandlerFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", { protocolVersion: 1 }); await b.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] }), sessionId = String(s.sessionId)
  await b.request("session/load", { sessionId, cwd: f.workspace, mcpServers: [] })
  const live = async () => ((await a.request("agency/roster", {})).agents as JsonObject[]).find(row => row.agentId === sessionId.slice(7))!.live as JsonObject
  assert.deepEqual([(await live()).pendingApprovals, (await live()).editors], [0, 2])
  const pending = a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "permission" }] })
  const request = await a.next("session/request_permission"); await b.next("session/request_permission")
  assert.equal((await live()).pendingApprovals, 1)
  a.respond(request.id, selected("allow-once"))
  assert.equal((await pending).stopReason, "end_turn")
  assert.equal((await live()).pendingApprovals, 0)
  await f.verifyZeroSurvivors()
})