import assert from "node:assert/strict"
import test from "node:test"
import { acpFixture, editorFixture } from "./acp-support.js"

test("a fresh native editor loads an existing logical agent without creating or canceling a conversation", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), peer = await f.connect()
  await peer.request("initialize", { protocolVersion: 1 })
  const created = await peer.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const record = (await f.inventory()).agents[0]!
  const editor = await editorFixture(f)
  await editor.lua(`(function() _G.fixture_manager = require("sodium.agency.agentic").open(vim.json.decode(${JSON.stringify(JSON.stringify({ record, live: true }))})); return true end)()`)
  assert.equal(await editor.lua(`vim.wait(10000, function() return fixture_manager.session_id == ${JSON.stringify(created.sessionId)} end)`), true)
  assert.equal(await editor.lua(`fixture_manager.session_state._provider_name`), "codex-acp")
  assert.equal(await editor.lua(`fixture_manager.config_options:get_mode_id()`), "agent-full-access")
  await editor.exit()
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/new").length, 1)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/cancel").length, 0)
  assert.ok((await f.inventory()).agents[0]!.phase === "ready")
  await f.stopSession(String(created.sessionId))
})