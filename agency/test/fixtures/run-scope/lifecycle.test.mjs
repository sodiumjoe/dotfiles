import test from "node:test"
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
const base = pathToFileURL(process.env.AGENCY_FIXTURE_DIST + "/")
const { controlFixture, until } = await import(new URL("test/control-support.js", base))
const { acpFixture, editorFixture } = await import(new URL("test/acp-support.js", base))
const { signalFixturePid, fixtureRuntime } = await import(new URL("test/fixtures/fixture-spawn.js", base))
test("retained lifecycle failure", async t => {
  const mode = process.env.AGENCY_LIFECYCLE_CASE
  if (mode === "control-body") {
    const f = await controlFixture(t)
    await f.start()
    console.log("lifecycle-root=" + f.root)
  } else {
    const f = await acpFixture(t), editor = await editorFixture(f)
    await editor.lua("AgencyFixture.adapter_probe('early')")
    console.log("lifecycle-root=" + f.root)
    if (mode === "editor-report-stall") {
      await editor.lua("(function() AgencyFixture.close_all = function() vim.uv.sleep(20000); return true end; return true end)()")
      const started = Date.now()
      await assert.rejects(editor.exit(), /deadline|timed out|Command failed/)
      const elapsedMs = Date.now() - started
      assert.throws(() => process.kill(editor.pid, 0), { code: "ESRCH" })
      const launch = (await fixtureRuntime()).scope.snapshot().launches.find(value => value.pid === editor.pid)
      assert.equal(launch.close, true)
      assert.ok(elapsedMs < 15000, "editor cleanup exceeded 15000 ms: " + elapsedMs)
      console.log("editor-cleanup=" + JSON.stringify({ elapsedMs, pid: editor.pid, close: launch.close }))
      return
    }
    if (mode === "editor-complete-failure") {
      await assert.rejects(editor.lua("(function() AgencyFixture.system({vim.env.AGENCY_FIXTURE_NODE,'-e','setTimeout(()=>process.exit(0),200)'},{},function() end); return AgencyFixture.complete() end)()"), /Outstanding editor control command/)
      await new Promise(resolve => setTimeout(resolve, 500))
      return
    }
    if (mode === "editor-death") {
      await signalFixturePid(editor.pid, "SIGKILL")
      await until(async () => { try { process.kill(editor.pid, 0); return undefined } catch (error) { if (error.code === "ESRCH") return true; throw error } })
      return
    }
  }
  assert.fail("deliberate lifecycle body failure")
})