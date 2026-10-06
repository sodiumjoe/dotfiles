import assert from "node:assert/strict"
import test from "node:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { acpFixture, editorFixture, type AcpFixture, type EditorFixture } from "./acp-support.js"
import type { ProviderId } from "../src/catalog/types.js"
import type { JsonObject } from "../src/agent/session-config.js"

const run = (e: EditorFixture, source: string) => e.lua(`(function() ${source}; return true end)()`)
const wait = async (e: EditorFixture, condition: string) => assert.equal(await e.lua(`vim.wait(10000, function() return ${condition} end)`), true, condition)
async function ready(e: EditorFixture) {
  await wait(e, "fixture_manager.session_id ~= nil and not fixture_manager._is_restoring_session")
  await run(e, "fixture_ready = false; fixture_manager:on_session_ready(function() fixture_ready = true end)")
  await wait(e, "fixture_ready")
  return String(await e.lua("fixture_manager.session_id"))
}
async function start(e: EditorFixture, backend?: ProviderId) {
  await run(e, `AgencyFixture.new({cwd=vim.fn.getcwd(),backend_id=${backend ? JSON.stringify(backend) : "nil"}})`)
  return ready(e)
}
async function attach(f: AcpFixture, e: EditorFixture, sid: string) {
  const record = (await f.inventory()).agents.find(record => record.definition.agentId === sid.slice(7))!
  assert.ok(record)
  await run(e, `AgencyFixture.open(vim.json.decode(${JSON.stringify(JSON.stringify({ record, live: true }))}))`)
  assert.equal(await ready(e), sid)
}
async function submit(e: EditorFixture, text: string) {
  await run(e, `fixture_manager._is_first_message=false; assert(fixture_manager:_handle_input_submit(${JSON.stringify(text)}))`)
}
const idle = (e: EditorFixture) => wait(e, "not fixture_manager.is_generating")
const pending = (e: EditorFixture) => wait(e, "fixture_manager.permission_manager:has_pending()")
const decide = (e: EditorFixture, option: string) => run(e, `fixture_manager.permission_manager:resolve('fixture-tool',${JSON.stringify(option)})`)
const transcript = (e: EditorFixture) => e.lua("vim.api.nvim_buf_get_lines(fixture_manager.widget.buf_nrs.chat,0,-1,false)") as Promise<string[]>
const decisions = async (f: AcpFixture, backend: ProviderId = "codex-acp") => (await f.requests(backend)).filter(frame => frame.result?.outcome)
async function hold(e: EditorFixture, kind: "prompt" | "attachment") {
  await run(e, `fixture_client=fixture_manager.agent; local original=fixture_client._handle_message; fixture_original_message=original; fixture_hold_kind=${JSON.stringify(kind)}; fixture_permission_count=0; fixture_client._handle_message=function(self,message)
    if message.method=='session/request_permission' then fixture_permission_count=fixture_permission_count+1 end
    if fixture_hold_kind and message.result and ((fixture_hold_kind=='prompt' and message.result.stopReason) or (fixture_hold_kind=='attachment' and message.result._meta and message.result._meta.agency)) then
      fixture_held=message; fixture_hold_kind=nil; return
    end
    return original(self,message)
  end`)
}
async function release(e: EditorFixture) {
  await run(e, "local message=fixture_held; fixture_held=nil; fixture_original_message(fixture_client,message)")
}

test("destroying an in-flight native create detaches its eventual remote attachment", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), e = await editorFixture(f), peer = await f.connect()
  await peer.request("initialize", { protocolVersion: 1 })
  await start(e); await hold(e, "attachment"); await submit(e, "/new")
  await wait(e, "fixture_held ~= nil")
  const sid = String(await e.lua("fixture_held.result.sessionId"))
  await e.closeTab(); await release(e)
  await run(e, "fixture_barrier=false; fixture_client:_send_request('agency/backends',{},function() fixture_barrier=true end)")
  await wait(e, "fixture_barrier")
  await peer.request("session/load", { sessionId: sid, cwd: f.workspace, mcpServers: [] })
  const turn = peer.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "permission" }] })
  const offered = await peer.next("session/request_permission")
  await run(e, "fixture_barrier=false; fixture_client:_send_request('agency/backends',{},function() fixture_barrier=true end)")
  await wait(e, "fixture_barrier")
  const count = await e.lua("fixture_permission_count")
  peer.respond(offered.id, { outcome: { outcome: "selected", optionId: "allow-once" } }); await turn
  assert.equal(count, 0)
})

test("delayed native prompt and load callbacks cannot clear a new turn after same-ID restoration", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), e = await editorFixture(f)
  const sid = await start(e)
  await hold(e, "prompt"); await submit(e, "first"); await wait(e, "fixture_held ~= nil")
  await f.stopSession(sid); await f.restoreSession(sid)
  await run(e, `fixture_manager:load_acp_session(${JSON.stringify(sid)},'Restored')`); await ready(e)
  await submit(e, "held"); await wait(e, "fixture_manager.is_generating")
  await release(e)
  assert.equal(await e.lua("fixture_manager.is_generating"), true)
  await f.release("codex-acp"); await idle(e)
  await hold(e, "attachment")
  await run(e, `fixture_manager:load_acp_session(${JSON.stringify(sid)},'Delayed')`); await wait(e, "fixture_held ~= nil")
  await run(e, `fixture_manager:load_acp_session(${JSON.stringify(sid)},'Current')`); await ready(e)
  await submit(e, "permission"); await pending(e)
  const turn = await e.lua("fixture_manager._agency_turn_id")
  await release(e)
  assert.equal(await e.lua("fixture_manager.is_generating"), true)
  assert.equal(await e.lua("fixture_manager._agency_turn_id"), turn)
  assert.equal(await e.lua("fixture_manager.permission_manager:has_pending()"), true)
  await decide(e, "allow-once"); await idle(e)
})

test("explicit Codex import and restore loads native identity with fresh environment and no transcript prompt", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), peer = await f.connect(), native = randomUUID()
  await peer.request("initialize", { protocolVersion: 1 })
  const imported = await peer.request("agency/import", { backendId: "codex-acp", nativeSessionId: native, cwd: f.workspace, commandId: randomUUID() })
  const sid = String(imported.sessionId)
  await f.restoreSession(sid, { AGENCY_TEST_EDITOR_MARKER: "import-restore" })
  const e = await editorFixture(f)
  await attach(f, e, sid)
  assert.equal((await f.inventory()).agents.length, 1)
  const frames = await f.requests("codex-acp")
  assert.equal(frames.filter(frame => frame.method === "session/new").length, 0)
  assert.equal(frames.filter(frame => frame.method === "session/prompt").length, 0)
  assert.equal(frames.find(frame => frame.method === "session/load")?.params?.sessionId, native)
  assert.equal(frames.find(frame => frame.method === "fixture/environment")?.params?.AGENCY_TEST_EDITOR_MARKER, "import-restore")
})

test("two fresh native editors race offered permission options and clear both real UIs", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), a = await editorFixture(f), b = await editorFixture(f)
  assert.notEqual(a.pid, b.pid)
  const sid = await start(a)
  await attach(f, b, sid)
  await submit(a, "permission")
  await pending(a); await pending(b)
  for (const editor of [a, b]) assert.match((await transcript(editor)).join("\n"), /Fixture write/)
  await Promise.all([decide(a, "allow-once"), decide(b, "reject-once")])
  await idle(a); await idle(b)
  for (const editor of [a, b]) assert.equal(await editor.lua("fixture_manager.permission_manager:has_pending()"), false)
  const replies = await decisions(f)
  assert.equal(replies.length, 1)
  assert.ok(["allow-once", "reject-once"].includes(String((replies[0]!.result!.outcome as JsonObject).optionId)))
  for (const editor of [a, b]) assert.match((await transcript(editor)).join("\n"), /answer:permission/)
})

test("closing the submitting editor and then every editor preserves a permission for later attachment", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), a = await editorFixture(f), b = await editorFixture(f)
  const sid = await start(a), target = await f.tuple(sid)
  await attach(f, b, sid); await submit(a, "permission"); await pending(a); await pending(b)
  await a.exit()
  assert.equal(await b.lua("fixture_manager.is_generating"), true)
  assert.equal((await decisions(f)).length, 0)
  await b.exit()
  assert.deepEqual(await f.tuple(sid), target)
  const c = await editorFixture(f)
  await attach(f, c, sid); await pending(c)
  assert.equal(await c.lua("fixture_manager.is_generating"), true)
  await decide(c, "allow-once"); await idle(c)
  assert.equal((await decisions(f)).length, 1)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/prompt").length, 1)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/cancel").length, 0)
})

test("tab close, session switch and endpoint termination detach without cancelling providers", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), a = await editorFixture(f)
  const sid = await start(a), target = await f.tuple(sid)
  await submit(a, "held"); await wait(a, "fixture_manager.is_generating")
  await a.closeTab()
  const b = await editorFixture(f)
  await attach(f, b, sid)
  assert.equal(await b.lua("fixture_manager.is_generating"), true)
  const second = await start(b, "claude-agent-acp")
  await run(b, `fixture_manager:load_acp_session(${JSON.stringify(sid)}, 'Codex')`)
  await ready(b)
  await run(b, "fixture_manager.agent.transport:stop()")
  await wait(b, "fixture_manager.agent.state ~= 'ready'")
  assert.deepEqual(await f.tuple(sid), target)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/cancel").length, 0)
  assert.equal((await f.requests("claude-agent-acp")).filter(frame => frame.method === "session/cancel").length, 0)
  await f.release("codex-acp")
  await f.stopSession(sid); await f.stopSession(second)
})

test("either native editor cancels the shared turn while a delayed old decision cannot affect the next", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), a = await editorFixture(f), b = await editorFixture(f)
  const sid = await start(a)
  await attach(f, b, sid); await submit(a, "permission"); await pending(a); await pending(b)
  await run(a, "stale_decision = fixture_manager.permission_manager.pending['fixture-tool'].callback")
  await run(b, "fixture_manager.agent:stop_generation(fixture_manager.session_id)")
  await idle(a); await idle(b)
  assert.equal(await a.lua("fixture_manager.permission_manager:has_pending()"), false)
  await submit(b, "permission"); await pending(a); await pending(b)
  await run(a, "stale_decision('allow-once')")
  assert.equal((await decisions(f)).length, 0)
  await run(a, "fixture_manager.agent:stop_generation(fixture_manager.session_id)")
  await idle(a); await idle(b)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/cancel").length, 2)
})

test("cached native client isolates colliding backend IDs, defaults and fresh launch environment", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), e = await editorFixture(f)
  await run(e, "vim.env.AGENCY_TEST_EDITOR_MARKER='first'")
  const codex = await start(e)
  assert.equal(await e.lua("fixture_manager.config_options:get_mode_id()"), "agent-full-access")
  await run(e, "first_client=fixture_manager.agent; vim.env.AGENCY_TEST_EDITOR_MARKER='second'")
  const claude = await start(e, "claude-agent-acp")
  assert.equal(await e.lua("fixture_manager.agent == first_client"), true)
  assert.equal(await e.lua("fixture_manager.config_options:get_model_id()"), "legacy-a")
  assert.equal(await e.lua("fixture_manager.config_options:get_mode_id()"), "normal")
  await submit(e, "/new")
  await wait(e, `fixture_manager.session_id ~= nil and fixture_manager.session_id ~= ${JSON.stringify(claude)}`)
  assert.equal(await e.lua("fixture_manager.session_state._provider_name"), "claude-agent-acp")
  const records = (await f.inventory()).agents
  assert.equal(records.length, 3)
  assert.notEqual(codex, claude)
  assert.deepEqual(records.map(record => record.session?.sessionId), ["native-session", "native-session", "native-session"])
  const markers = async (backend: ProviderId) => (await f.requests(backend)).filter(frame => frame.method === "fixture/environment").map(frame => frame.params?.AGENCY_TEST_EDITOR_MARKER)
  assert.deepEqual(await markers("codex-acp"), ["first"])
  assert.deepEqual(await markers("claude-agent-acp"), ["second", "second"])
})

test("active replay and provider echoes render once and never enter the next native prompt", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), a = await editorFixture(f), b = await editorFixture(f)
  const sid = await start(a)
  await submit(a, "held"); await wait(a, "fixture_manager.is_generating")
  await attach(f, b, sid)
  assert.equal(await b.lua("fixture_manager.is_generating"), true)
  for (const editor of [a, b]) assert.equal((await transcript(editor)).filter(line => line === "held").length, 1)
  await f.release("codex-acp"); await idle(a); await idle(b)
  await submit(a, "echo"); await idle(a); await idle(b)
  for (const editor of [a, b]) {
    const lines = await transcript(editor)
    assert.equal(lines.filter(line => line === "echo").length, 1)
    assert.ok(lines.includes("provider context"))
  }
  await submit(b, "next"); await idle(b)
  const prompts = (await f.requests("codex-acp")).filter(frame => frame.method === "session/prompt")
  assert.deepEqual(prompts.at(-1)?.params?.prompt, [{ type: "text", text: "next" }])
  assert.equal(prompts.length, 3)
  assert.equal((await f.inventory()).agents.length, 1)
})

test("fresh native attachment retains authoritative config after display history truncation", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), peer = await f.connect()
  await peer.request("initialize", { protocolVersion: 1 })
  const created = await peer.request("session/new", { cwd: f.workspace, mcpServers: [] }), sid = String(created.sessionId)
  await peer.request("session/set_config_option", { sessionId: sid, configId: "model", value: "model-b" })
  await peer.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "history" }] })
  const e = await editorFixture(f)
  await attach(f, e, sid)
  assert.equal(await e.lua("fixture_manager.config_options:get_model_id()"), "model-b")
  assert.ok((await transcript(e)).some(line => /history.*truncated/i.test(line)), "retained history truncation must be visible")
  await submit(e, "next"); await idle(e)
  const prompts = (await f.requests("codex-acp")).filter(frame => frame.method === "session/prompt")
  assert.equal(prompts.length, 2)
  assert.deepEqual(prompts.at(-1)?.params?.prompt, [{ type: "text", text: "next" }])
})

test("native configuration changes propagate to both editors and reconnect preserves them", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), a = await editorFixture(f), b = await editorFixture(f)
  const sid = await start(a)
  await attach(f, b, sid)
  await run(a, "setter_done=false; fixture_manager.agent:set_config_option({sessionId=fixture_manager.session_id,configId='model',value='model-b'},function(_,err) assert(not err); setter_done=true end)")
  await wait(a, "setter_done"); await wait(b, "fixture_manager.config_options:get_model_id() == 'model-b'")
  assert.equal(await a.lua("fixture_manager.config_options:get_model_id()"), "model-b")
  await b.exit()
  const c = await editorFixture(f)
  await attach(f, c, sid)
  assert.equal(await c.lua("fixture_manager.config_options:get_model_id()"), "model-b")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/set_config_option").length, 1)
})

test("provider failure clears native requests while an independent backend stays usable", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), a = await editorFixture(f), b = await editorFixture(f)
  const sid = await start(a)
  await attach(f, b, sid); await submit(a, "permission"); await pending(a); await pending(b)
  const independent = await editorFixture(f)
  await start(independent, "claude-agent-acp")
  await writeFile(join(f.root, "fail-permission"), "fail", { mode: 0o600 })
  await idle(a); await idle(b)
  for (const editor of [a, b]) assert.equal(await editor.lua("fixture_manager.permission_manager:has_pending()"), false)
  assert.equal((await decisions(f)).length, 0)
  await submit(independent, "survives"); await idle(independent)
  assert.match((await transcript(independent)).join("\n"), /answer:survives/)
})

test("stale native mutations cannot target a restored generation until explicit load", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), e = await editorFixture(f)
  const sid = await start(e), previous = await f.tuple(sid)
  await submit(e, "permission"); await pending(e)
  await run(e, "old_decision=fixture_manager.permission_manager.pending['fixture-tool'].callback; old_turn=fixture_manager._agency_turn_id")
  await f.stopSession(sid); await idle(e)
  await f.restoreSession(sid, { AGENCY_TEST_EDITOR_MARKER: "restored", NVIM: "/fixture-restored" })
  assert.notEqual((await f.tuple(sid)).providerGeneration, previous.providerGeneration)
  await run(e, "old_decision('allow-once'); fixture_manager.agent:stop_generation(fixture_manager.session_id); fixture_manager.agent:set_config_option({sessionId=fixture_manager.session_id,configId='model',value='model-b'},function(_,err) stale_setter=err end)")
  await wait(e, "stale_setter ~= nil")
  assert.equal((await decisions(f)).length, 0)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/set_config_option").length, 0)
  await run(e, `fixture_manager:load_acp_session(${JSON.stringify(sid)},'Restored')`); await ready(e)
  await submit(e, "fresh"); await idle(e)
  const launches = (await f.requests("codex-acp")).filter(frame => frame.method === "fixture/environment")
  assert.deepEqual(launches.at(-1)?.params, { AGENCY_TEST_EDITOR_MARKER: "restored", NVIM: "/fixture-restored" })
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/load").length, 1)
})