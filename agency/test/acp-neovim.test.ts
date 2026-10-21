import assert from "node:assert/strict"
import test from "node:test"
import { acpFixture, editorFixture } from "./acp-support.js"
import { fixtureRuntime } from "./fixtures/fixture-spawn.js"

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

test("installed editor transport retains native handles and reports unavailable callbacks", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), editor = await editorFixture(f)
  assert.equal(await editor.lua("AgencyFixture.global_spawn_unchanged()"), true)
  assert.equal(await editor.lua("AgencyFixture.adapter_probe('early')"), true)
  assert.equal(await editor.lua("AgencyFixture.adapter_probe('failure')"), true)
  assert.equal(await editor.lua("AgencyFixture.adapter_probe('stop')"), true)
  assert.equal(await editor.lua("AgencyFixture.adapter_probe('closed')"), true)
  const registry = await editor.lua("AgencyFixture.registry()") as any
  assert.ok(registry.launches.some((item: any) => item.error !== null && item.pid === null))
  assert.ok(registry.launches.some((item: any) => item.exit !== null))
  assert.ok(registry.launches.some((item: any) => item.unavailable === "editor-handle-closed" && item.exit === null && item.close === null))
  assert.ok(registry.stops.some((item: any) => item.outcome === "delivered" || item.outcome === "already-absent"))
  assert.ok(registry.infrastructure.every((item: any) => item.reaped === true))
  assert.equal(registry.infrastructure.filter((item: any) => item.action === "capture").length, 3)
  await editor.exit()
})

for (const mode of ["timeout", "dispose"]) test("editor control keeps native completion output and routes " + mode + " stops", { timeout: 60000 }, async t => {
  const f = await acpFixture(t), editor = await editorFixture(f)
  assert.equal(await editor.lua(`(function()
    _G.system_result = nil
    local facade = AgencyFixture.system({vim.env.AGENCY_FIXTURE_NODE, "-e", "process.stdout.write('out');process.stderr.write('err')"}, {text=true}, function(value) system_result=value end)
    assert(type(facade.kill)=="function" and facade.pid==nil)
    assert(vim.wait(5000,function() return system_result~=nil end,10))
    assert(system_result.code==0 and system_result.stdout=="out" and system_result.stderr=="err")
    local ok = pcall(AgencyFixture.system, {"/missing-agency-control"}, {}, function() end)
    assert(not ok)
    return true
  end)()`), true)
  let registry = await editor.lua("AgencyFixture.registry()") as any
  assert.ok(registry.commands.some((item: any) => item.stdout === "out" && item.stderr === "err" && item.code === 0))
  {
    assert.equal(await editor.lua(`(function()
      _G.control_result = nil
      local control = require("sodium.agency.control").new({system=function(_,opts,callback)
        return AgencyFixture.system({vim.env.AGENCY_FIXTURE_NODE,"-e","setInterval(()=>{},1000)"},opts,callback)
      end})
      control.command({"status"},{timeout_ms=${mode === "timeout" ? 100 : 10000}},function(err) control_result=err end)
      ${mode === "dispose" ? "control.close()" : ""}
      assert(vim.wait(5000,function() for _,v in ipairs(AgencyFixture.registry().launches) do if v.reporting=="editor-control" and v.exit==vim.NIL and v.error==vim.NIL then return false end end; return true end,10))
      AgencyFixture.flush()
      return true
    end)()`), true)
  }
  registry = await editor.lua("AgencyFixture.registry()") as any
  assert.ok(registry.stops.some((item: any) => item.signal === "SIGTERM" && item.outcome === "delivered"))
  await editor.exit()
})

for (const mode of ["control-body", "editor-body", "editor-death", "editor-complete-failure", "editor-report-stall"]) test("nested fixture retains evidence after " + mode, { timeout: 60000 }, async () => {
  const { execFile } = await import("node:child_process")
  const { mkdtemp, readFile, readdir } = await import("node:fs/promises")
  const { fileURLToPath } = await import("node:url")
  const { join } = await import("node:path")
  const root = await mkdtemp("/tmp/agv-"), runId = crypto.randomUUID()
  ;(await fixtureRuntime()).scope.artifact(root)
  const entry = fileURLToPath(new URL("../../test/fixtures/run-scope/lifecycle.test.mjs", import.meta.url))
  const env = { ...process.env, AGENCY_LIFECYCLE_CASE: mode, AGENCY_FIXTURE_DIST: fileURLToPath(new URL("../", import.meta.url)), AGENCY_TEST_WORKER_RUN: JSON.stringify({ runId, workerFiles: [entry], runRoot: root, revision: "stage5" }) }
  delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT
  delete (env as NodeJS.ProcessEnv).AGENCY_FIXTURE_CONNECTION
  const result = await new Promise<{code: number; stdout: string; stderr: string}>((resolve, reject) => execFile(process.execPath, ["--import=" + new URL("./fixtures/run-boundary.js", import.meta.url).href, "--test", entry], { env, timeout: 45000, maxBuffer: 1048576 }, (error, stdout, stderr) => {
    if (error && (typeof error.code !== "number" || error.killed || error.signal)) reject(error)
    else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr })
  }))
  assert.notEqual(result.code, 0, result.stdout + result.stderr)
  const retained = /lifecycle-root=(\/[^\s]+)/.exec(result.stdout)?.[1]
  assert.ok(retained, result.stdout + result.stderr)
  const boundaries = await readdir(join(root, "workers"))
  assert.equal(boundaries.length, 1)
  const boundary = JSON.parse(await readFile(join(root, "workers", boundaries[0]!), "utf8"))
  assert.equal(boundary.result.state, ["editor-death", "editor-complete-failure", "editor-report-stall"].includes(mode) ? "incomplete" : "settled", JSON.stringify(boundary.result.failures))
  assert.ok(boundary.result.artifacts.includes(retained))
  if (mode === "editor-report-stall") {
    const cleanup = JSON.parse(/editor-cleanup=([^\n]+)/.exec(result.stdout)![1]!)
    assert.equal(cleanup.close, true)
    assert.ok(cleanup.elapsedMs < 15000)
    const editor = boundary.result.launches.find((item: any) => item.pid === cleanup.pid)
    assert.equal(editor.close, true)
    assert.deepEqual(editor.exit, { code: null, signal: "SIGKILL" })
    assert.match(boundary.result.failures.join(";"), /source|complete|lost/)
  }
  if (mode === "editor-complete-failure") {
    assert.match(boundary.result.failures.join(";"), /Outstanding editor control command/)
    assert.ok(boundary.result.launches.some((item: any) => item.reporting === "editor-control" && item.exit === null && item.absent === true))
  }
  if (mode !== "editor-death") assert.ok(boundary.result.launches.every((item: any) => item.absent === true))
  const adapter = process.platform === "darwin" ? (await import("../src/platform/darwin.js")).createDarwinAdapter() : (await import("../src/platform/linux.js")).createLinuxAdapter()
  const { until } = await import("./control-support.js")
  for (const item of boundary.result.launches) if (item.pid) await until(async () => await adapter.readProcess(item.pid) === null && (await adapter.readGroup(item.pid)).length === 0 ? true : undefined, 5000)
  if (mode !== "control-body") {
    const editor = (await readdir(retained)).find(name => name.startsWith("editor-"))!
    const registry = JSON.parse(await readFile(join(retained, editor, "registry.json"), "utf8"))
    assert.ok(registry.launches.some((item: any) => item.reporting === "editor-endpoint" && item.exit !== null))
  }
})