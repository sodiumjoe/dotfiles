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