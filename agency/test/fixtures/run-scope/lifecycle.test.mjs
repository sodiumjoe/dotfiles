import test from "node:test"
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
const base = pathToFileURL(process.env.AGENCY_FIXTURE_DIST + "/")
const { controlFixture, until } = await import(new URL("test/control-support.js", base))
const { acpFixture, editorFixture } = await import(new URL("test/acp-support.js", base))
const { signalFixturePid } = await import(new URL("test/fixtures/fixture-spawn.js", base))
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
    if (mode === "editor-death") {
      await signalFixturePid(editor.pid, "SIGKILL")
      await until(async () => { try { process.kill(editor.pid, 0); return undefined } catch (error) { if (error.code === "ESRCH") return true; throw error } })
      return
    }
  }
  assert.fail("deliberate lifecycle body failure")
})