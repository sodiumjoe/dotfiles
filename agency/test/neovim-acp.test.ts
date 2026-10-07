import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
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
test("new command discovers backends from a cold native client and selects without fast-event errors", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), e = await editorFixture(f)
  await run(e, `AgencyFixture.commands(); fixture_fast=false; vim.ui.select=function(items,opts,callback)
    fixture_fast=vim.in_fast_event(); if opts.prompt == "Agency backend" then fixture_backend_prompt=opts.prompt; callback(items[2]) else callback(items[1]) end
  end; vim.cmd('AgencyNew')`)
  await wait(e, "fixture_controller.snapshot() ~= nil")
  assert.equal(await e.lua("fixture_fast"), false)
  assert.equal(await e.lua("fixture_backend_prompt"), "Agency backend")
  assert.equal(await e.lua("vim.v.errmsg"), "")
  assert.deepEqual(await e.lua("fixture_notifications"), [])
  assert.equal((await f.inventory()).agents.length, 1)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/new").length, 0)
  assert.equal((await f.requests("claude-agent-acp")).filter(frame => frame.method === "session/new").length, 1)
  assert.equal((await f.requests("claude-agent-acp")).filter(frame => frame.method === "session/prompt").length, 0)
})

test("native command entry points toggle, inspect, attach, cancel, stop and restore isolated sessions", { timeout: 120000 }, async t => {
  const f = await acpFixture(t), e = await editorFixture(f)
  await run(e, "AgencyFixture.commands(); vim.cmd('AgencyCurrent')")
  await wait(e, "fixture_controller.snapshot() ~= nil")
  await run(e, "fixture_manager=require('agentic.session_registry').sessions[vim.api.nvim_get_current_tabpage()]")
  const sid = await ready(e), target = await f.tuple(sid)
  await run(e, "vim.cmd('AgencyCurrent')")
  assert.equal(await e.lua("fixture_manager.widget:is_open()"), false)
  await run(e, "vim.cmd('AgencyOpen')")
  assert.equal(await e.lua("fixture_manager.widget:is_open()"), true)
  assert.deepEqual(await f.tuple(sid), target)
  await run(e, "vim.cmd('AgencyInspect')")
  assert.equal(await e.lua("fixture_notifications[#fixture_notifications]"), "{}")
  await run(e, `Snacks={picker=function(opts) fixture_roster=opts; return {opts=opts,find=function() end,close=function() opts.on_close() end} end}; vim.cmd('Agency')`)
  await wait(e, "#fixture_roster.items == 1")
  assert.equal(await e.lua("fixture_roster.items[1].id"), sid.slice(7))
  await run(e, "fixture_roster.on_close(); require('sodium.agentic_sessions').show_picker(fixture_manager)")
  await wait(e, "fixture_roster.title == 'Select session to restore'")
  assert.equal(await e.lua("fixture_roster.items[1].session_id"), sid)
  await run(e, "vim.cmd('AgencyDetach')")
  assert.equal(await e.lua("fixture_controller.snapshot() == nil"), true)
  assert.deepEqual(await f.tuple(sid), target)
  await run(e, `vim.cmd(${JSON.stringify("AgencyAttach " + sid.slice(7))})`)
  await wait(e, "fixture_controller.snapshot() ~= nil")
  await run(e, "fixture_manager=require('agentic.session_registry').sessions[vim.api.nvim_get_current_tabpage()]")
  assert.equal(await ready(e), sid)
  await submit(e, "held"); await wait(e, "fixture_manager.is_generating")
  await run(e, "vim.cmd('AgencyCancel')"); await idle(e)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/cancel").length, 1)
  assert.deepEqual(await f.tuple(sid), target)
  await run(e, "vim.ui.select=function(items,opts,callback) fixture_stop_prompt=opts.prompt; callback('Keep running') end; vim.cmd('AgencyStop')")
  assert.match(String(await e.lua("fixture_stop_prompt")), /Stop Agency agent/)
  assert.deepEqual(await f.tuple(sid), target)
  await run(e, "vim.ui.select=function(items,opts,callback) callback('Stop') end; vim.cmd('AgencyStop')")
  await wait(e, "fixture_manager._agency_epoch > 1 and not fixture_manager.is_generating")
  const stopped = await f.current()
  assert.equal(stopped.agents.length, 0)
  await run(e, "vim.cmd('AgencyDetach')")
  await run(e, `vim.cmd(${JSON.stringify("AgencyRestore " + sid.slice(7))})`)
  await wait(e, "fixture_controller.snapshot() ~= nil")
  await run(e, "fixture_manager=require('agentic.session_registry').sessions[vim.api.nvim_get_current_tabpage()]")
  assert.equal(await ready(e), sid)
  const restored = await f.tuple(sid)
  assert.equal(restored.agentId, target.agentId)
  assert.notEqual(restored.providerGeneration, target.providerGeneration)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/prompt").length, 1)
  assert.equal(await e.lua("vim.v.errmsg"), "")
})

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
  assert.equal(launches.at(-1)?.params?.AGENCY_TEST_EDITOR_MARKER, "restored")
  assert.match(String(launches.at(-1)?.params?.NVIM), /\/editor-[a-f0-9-]+\.sock$/)
  assert.equal(launches.at(-1)?.params?.NVIM_SOCKET_PATH, launches.at(-1)?.params?.NVIM)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/load").length, 1)
})

for (const entry of ["new", "switch_provider", "new_session_with_provider"]) test(`fresh editor ${entry} selects only the model and applies configured defaults`, { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { selectionCatalog: true }), e = await editorFixture(f)
  const path = join(f.paths.persistentRoot, "catalog/backends.json")
  const config = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"))
  config.backends.find((backend: { id: string }) => backend.id === "codex-acp").initial = { modeId: "read-only", configValues: { reasoning_effort: "medium" } }
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  await run(e, `AgencyFixture.commands(); fixture_prompts={}; vim.ui.select=function(items,opts,callback)
    assert(not vim.in_fast_event()); fixture_prompts[#fixture_prompts+1]=opts.prompt
    if opts.prompt == 'Agency backend' then callback(items[1])
    elseif opts.prompt == 'Agency model' then callback(items[3]) end
  end; ${entry === "new" ? "fixture_controller.new()" : `require('agentic').${entry}()`}`)
  await wait(e, "fixture_controller.snapshot() ~= nil")
  assert.deepEqual(await e.lua("fixture_prompts"), ["Agency backend", "Agency model"])
  const records = await f.inventory()
  assert.equal(records.agents.length, 1)
  assert.equal(records.agents[0]!.settings.configValues?.model, "model-c")
  assert.equal(records.agents[0]!.settings.configValues?.reasoning_effort, "medium")
  assert.equal(records.agents[0]!.settings.configValues?.mode, "read-only")
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/new").length, 1)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/prompt").length, 0)
})

test("settings picker updates both attached editors while new sessions retain configured defaults", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), a = await editorFixture(f), b = await editorFixture(f)
  const sid = await start(a)
  await attach(f, b, sid)
  await run(a, "AgencyFixture.commands()")
  for (const [id, value] of [["reasoning_effort", "low"], ["mode", "read-only"]]) {
    await run(a, `fixture_settings_prompts={}; vim.ui.select=function(items,opts,callback)
      fixture_settings_prompts[#fixture_settings_prompts+1]=opts.prompt
      for _,item in ipairs(items) do
        if opts.prompt == 'Agency settings' and item.id == ${JSON.stringify(id)} then callback(item); return end
        if opts.prompt ~= 'Agency settings' and item.value == ${JSON.stringify(value)} then callback(item); return end
      end
      error('missing setting choice')
    end; vim.cmd('AgencySettings')`)
    const changed = `vim.tbl_contains(vim.tbl_map(function(option) return option.id == ${JSON.stringify(id)} and option.currentValue == ${JSON.stringify(value)} end,fixture_manager.config_options.options),true)`
    await wait(a, changed); await wait(b, changed)
    assert.equal((await a.lua("fixture_settings_prompts") as string[]).length, 2)
  }
  const records = await f.inventory()
  assert.equal(records.agents.length, 1)
  assert.equal(records.agents[0]!.settings.configValues?.reasoning_effort, "low")
  assert.equal(records.agents[0]!.settings.configValues?.mode, "read-only")
  await run(a, "fixture_controller.new(nil,{backend_id='codex-acp'}); fixture_manager=require('agentic.session_registry').sessions[vim.api.nvim_get_current_tabpage()]")
  const next = await ready(a)
  assert.notEqual(next, sid)
  assert.equal(await a.lua("fixture_manager.config_options:get_mode_id()"), "agent-full-access")
  assert.equal(await a.lua("fixture_manager.config_options.options[2].currentValue"), "high")
  assert.equal((await f.inventory()).agents.length, 2)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/prompt").length, 0)
})

for (const stage of ["Agency settings", "Agency Reasoning"]) test(`settings picker discards ${stage} after same-ID loading`, { timeout: 60000 }, async t => {
  const f = await acpFixture(t), e = await editorFixture(f)
  const sid = await start(e)
  await run(e, `AgencyFixture.commands(); vim.ui.select=function(items,opts,callback)
    if opts.prompt == ${JSON.stringify(stage)} then fixture_setting_choice=function() callback(items[2]) end
    else for _,item in ipairs(items) do if item.id == 'reasoning_effort' then callback(item); return end end end
  end; vim.cmd('AgencySettings')`)
  await wait(e, "fixture_setting_choice ~= nil")
  await run(e, `fixture_manager:load_acp_session(${JSON.stringify(sid)},'Reloaded')`)
  await ready(e)
  await run(e, "fixture_setting_choice(); vim.wait(100,function() return false end)")
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/set_config_option").length, 0)
  assert.equal((await f.inventory()).agents.length, 1)
})

test("fresh saved-session picker labels legacy and disabled backends and rejects before restoration", { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { legacyCount: 1 }), e = await editorFixture(f)
  const peer = await f.connect()
  await peer.request("initialize", { protocolVersion: 1 })
  const disabled = await peer.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, backendId: "claude-agent-acp" } } })
  await f.stopSession(String(disabled.sessionId))
  await start(e, "codex-acp")
  const path = join(f.paths.persistentRoot, "catalog/backends.json"), backends = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"))
  backends.backends = backends.backends.filter((backend: { id: string }) => backend.id === "codex-acp")
  await writeFile(path, JSON.stringify(backends), { mode: 0o600 })
  await run(e, `AgencyFixture.commands(); picker_spec=nil; Snacks={picker=function(opts) picker_spec=opts end}; confirms=0; vim.ui.select=function() confirms=confirms+1 end
    require('sodium.agentic_sessions').show_picker(fixture_manager)`)
  await wait(e, "picker_spec ~= nil")
  const legacy = await e.lua("(function() for _,item in ipairs(picker_spec.items) do if item.unavailable_reason == 'Legacy record (version 1)' then return item end end end)()") as { unavailable: boolean; text: string }
  assert.equal(legacy.unavailable, true)
  assert.match(legacy.text, /Unavailable/)
  await run(e, `for _,item in ipairs(picker_spec.items) do if item.unavailable then
    assert(table.concat(require('sodium.agentic_sessions').preview_lines(item),' '):find('Unavailable',1,true))
    local row=''; for _,part in ipairs(picker_spec.format(item)) do row=row..part[1] end; assert(row:find('Unavailable',1,true))
    picker_spec.confirm({close=function() end},item)
  end end`)
  assert.equal(await e.lua("confirms"), 0)
  assert.equal((await f.inventory()).agents.length, 2)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/load").length, 0)
})

for (const stage of ["Agency backend", "Agency model"]) test(`fresh editor supersession invalidates the pending ${stage} callback`, { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { selectionCatalog: true }), e = await editorFixture(f)
  const sid = await start(e, "codex-acp")
  await run(e, `AgencyFixture.commands(); held_choice=nil; vim.ui.select=function(items,opts,callback)
    if opts.prompt == ${JSON.stringify(stage)} then held_choice=function() callback(items[2]) end
    elseif opts.prompt == 'Agency backend' then callback(items[1])
    elseif opts.prompt == 'Agency model' then callback(items[3])
    else callback(items[2]) end
  end; fixture_controller.new()`)
  await wait(e, "held_choice ~= nil")
  assert.equal((await f.inventory()).agents.length, 1)
  await run(e, "fixture_controller.current(); held_choice(); vim.wait(100,function() return false end)")
  assert.equal((await f.inventory()).agents.length, 1)
  assert.equal(await e.lua("fixture_manager.session_id"), sid)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/prompt").length, 0)
})

test("fresh saved history remains visible when every configured adapter is incompatible", { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { legacyCount: 1 }), e = await editorFixture(f)
  await start(e, "codex-acp")
  for (const [directory, name] of [["profile", "@agentclientprotocol/codex-acp"], ["secondary", "@agentclientprotocol/claude-agent-acp"]])
    await writeFile(join(f.root, directory!, "adapter.json"), JSON.stringify({ name, version: "99.0.0", main: "agent-provider.js" }), { mode: 0o600 })
  await run(e, `AgencyFixture.commands(); picker_spec=nil; Snacks={picker=function(opts) picker_spec=opts end}; confirms=0; vim.ui.select=function() confirms=confirms+1 end
    require('sodium.agentic_sessions').show_picker(fixture_manager)`)
  await wait(e, "picker_spec ~= nil")
  assert.equal(await e.lua("#picker_spec.items"), 2)
  await run(e, `for _,item in ipairs(picker_spec.items) do
    assert(item.unavailable); assert(item.text:find('Unavailable',1,true)); picker_spec.confirm({close=function() end},item)
  end`)
  assert.equal(await e.lua("confirms"), 0)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/new").length, 1)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/prompt").length, 0)
})

test("restarting an editor keeps its agent in the roster beside another live agent", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), a = await editorFixture(f), b = await editorFixture(f)
  const sid = await start(a), other = await start(b), target = await f.tuple(sid)
  await submit(a, "Repair picker window layout"); await idle(a)
  await a.exit()
  const c = await editorFixture(f)
  await run(c, `AgencyFixture.commands(); Snacks={picker=function(opts)
    fixture_roster=opts; return {opts=opts,find=function() end,close=function() opts.on_close() end}
  end}; vim.cmd('Agency')`)
  await wait(c, "fixture_roster ~= nil and #fixture_roster.items == 2")
  const ids = await c.lua("vim.tbl_map(function(item) return item.id end, fixture_roster.items)") as string[]
  assert.ok(ids.includes(sid.slice(7))); assert.ok(ids.includes(other.slice(7)))
  assert.equal(await c.lua(`(function() for _,item in ipairs(fixture_roster.items) do if item.id == ${JSON.stringify(sid.slice(7))} then return item.text:find('Repair picker window layout',1,true) == 1 end end end)()`), true)
  await run(c, `for _,item in ipairs(fixture_roster.items) do if item.id == ${JSON.stringify(sid.slice(7))} then
    fixture_roster.confirm({close=function() fixture_roster.on_close() end},item)
  end end`)
  await wait(c, `fixture_controller.snapshot() ~= nil and fixture_controller.snapshot().target.agentId == ${JSON.stringify(sid.slice(7))}`)
  assert.deepEqual(await f.tuple(sid), target)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/new").length, 2)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/cancel").length, 0)
})

test("new-session model selection exposes cached models after discovery failure in a fresh editor", { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { selectionCatalog: true, catalogState: "failed" }), e = await editorFixture(f)
  await run(e, `AgencyFixture.commands(); fixture_model_labels={}; vim.ui.select=function(items,opts,callback)
    if opts.prompt == 'Agency backend' then callback(items[1])
    elseif opts.prompt:find('Agency model',1,true) then
      fixture_model_prompt=opts.prompt
      for _,item in ipairs(items) do fixture_model_labels[#fixture_model_labels+1]=opts.format_item(item) end
      callback(items[3])
    else callback(items[1]) end
  end; vim.cmd('AgencyNew')`)
  await wait(e, "fixture_controller.snapshot() ~= nil")
  assert.match(String(await e.lua("fixture_model_prompt")), /cached; Provider discovery failed/)
  assert.ok((await e.lua("fixture_model_labels") as string[]).includes("Model C (cached)"))
  const manager = "require('agentic.session_registry').sessions[vim.api.nvim_get_current_tabpage()]"
  assert.equal(await e.lua(`${manager}.config_options:get_model_id()`), "model-c")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/new").length, 1)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/prompt").length, 0)
})

test("warm roster reuses native ACP with no CLI and reports query latency", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), e = await editorFixture(f)
  const sid = await start(e)
  await run(e, "AgencyFixture.commands(); fixture_original_client=fixture_manager.agent; fixture_endpoint_pid=fixture_manager.agent.transport.pid; fixture_original_system=vim.system; vim.system=function() error('roster spawned CLI') end")
  try {
    await run(e, `fixture_roster_times={}; fixture_roster_error=nil; local function query()
      local began=vim.uv.hrtime()
      fixture_controller.page({active=true,allow_issues=true},function(err,result)
        if err then fixture_roster_error=err; return end
        fixture_roster_result=result
        fixture_roster_times[#fixture_roster_times+1]=(vim.uv.hrtime()-began)/1000000
        if #fixture_roster_times < 20 then query() end
      end)
    end; query()`)
    await wait(e, "#fixture_roster_times == 20 or fixture_roster_error ~= nil")
    assert.equal(await e.lua("fixture_roster_error"), null)
    assert.equal(await e.lua("fixture_roster_result.agents[1].record.definition.agentId"), sid.slice(7))
    assert.equal(await e.lua("fixture_original_client == require('agentic.acp.agent_instance')._instances.agency"), true)
    assert.equal(await e.lua("fixture_endpoint_pid == fixture_original_client.transport.pid"), true)
    assert.deepEqual(await e.lua("fixture_notifications"), [])
    const times = (await e.lua("fixture_roster_times") as number[]).sort((a, b) => a - b)
    t.diagnostic(`warm Neovim ACP roster ms: median=${times[10]!.toFixed(3)} range=${times[0]!.toFixed(3)}..${times[19]!.toFixed(3)}`)
  } finally { await run(e, "vim.system=fixture_original_system") }
})

test("provider editor RPC follows the submitting attachment across editor replacement", { timeout: 120000 }, async t => {
  const f = await acpFixture(t), a = await editorFixture(f), b = await editorFixture(f)
  const sid = await start(a), target = await f.tuple(sid)
  const environment = (await f.requests("codex-acp")).find(frame => frame.method === "fixture/environment")!.params!
  const broker = String(environment.NVIM)
  assert.equal(environment.NVIM_SOCKET_PATH, broker)
  assert.notEqual(broker, await a.lua("vim.v.servername"))
  const rpc = async () => Number((await promisify(execFile)(process.env.NVIM_TEST_EXECUTABLE ?? "/opt/homebrew/bin/nvim", ["--server", broker, "--remote-expr", "getpid()"], { timeout: 5000 })).stdout.trim())
  await assert.rejects(rpc())
  await submit(a, "permission"); await pending(a)
  assert.equal(await rpc(), a.pid)
  await attach(f, b, sid); await pending(b)
  assert.equal(await rpc(), a.pid)
  const first = String(await a.lua("fixture_manager._agency_local_submission"))
  await run(b, `fixture_busy=nil; fixture_duplicate=nil; fixture_manager.agent:_send_request('session/prompt',
    {sessionId=fixture_manager.session_id,prompt={{type='text',text='busy'}},_meta={agency={version=1,submissionId=${JSON.stringify(randomUUID())},editor=vim.v.servername}}},
    function(_,err) fixture_busy=err end); fixture_manager.agent:_send_request('session/prompt',
    {sessionId=fixture_manager.session_id,prompt={{type='text',text='permission'}},_meta={agency={version=1,submissionId=${JSON.stringify(first)},editor=vim.v.servername}}},
    function(_,err) fixture_duplicate=err or false end)`)
  await wait(b, "fixture_busy ~= nil")
  assert.equal(await rpc(), a.pid)
  await run(a, "fixture_manager.agent:stop_generation(fixture_manager.session_id)"); await idle(a); await idle(b)
  await wait(b, "fixture_duplicate ~= nil")
  assert.equal(await b.lua("fixture_duplicate"), false)
  await assert.rejects(rpc())
  await submit(b, "permission"); await pending(a); await pending(b)
  assert.equal(await rpc(), b.pid)
  await run(b, "fixture_manager:destroy()")
  await run(a, "fixture_barrier=false; fixture_manager.agent:_send_request('agency/backends',{},function() fixture_barrier=true end)")
  await wait(a, "fixture_barrier"); await assert.rejects(rpc())
  await run(a, "fixture_manager.agent:stop_generation(fixture_manager.session_id)"); await idle(a)
  await submit(a, "permission"); await pending(a)
  assert.equal(await rpc(), a.pid)
  await run(a, "fixture_manager:load_acp_session(fixture_manager.session_id)"); await ready(a)
  await assert.rejects(rpc())
  await run(a, "fixture_manager.agent:stop_generation(fixture_manager.session_id)"); await idle(a)
  await a.exit()
  const c = await editorFixture(f)
  await attach(f, c, sid); await submit(c, "permission"); await pending(c)
  assert.equal(await rpc(), c.pid)
  assert.deepEqual(await f.tuple(sid), target)
  const launches = (await f.requests("codex-acp")).filter(frame => frame.method === "fixture/environment")
  assert.equal(launches.length, 1); assert.equal(launches[0]!.params!.NVIM, broker)
  const prompts = (await f.requests("codex-acp")).filter(frame => frame.method === "session/prompt")
  for (const prompt of prompts) assert.equal((prompt.params!._meta as JsonObject | undefined)?.agency, undefined)
  const peer = await f.connect(); await peer.request("initialize", { protocolVersion: 1 })
  await peer.request("session/load", { sessionId: sid, cwd: f.workspace, mcpServers: [] })
  const replay = JSON.stringify(peer.drain("session/update"))
  assert.equal(replay.includes(String(await c.lua("vim.v.servername"))), false)
  await f.stopSession(sid); await assert.rejects(rpc())
})