import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { createTmuxEditorMechanics } from "../src/entry/editor.js"

const execute = promisify(execFile)

test("an entry tmux session keeps its identity, so a second open finds it", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "agy-entry-")), editor = join(root, "editor")
  await writeFile(editor, "#!/bin/sh\nexec sleep 30\n"); await chmod(editor, 0o700)
  const run = async (file: string, args: string[]) => (await execute(file, file === "tmux" ? ["-f", "/dev/null", ...args] : args, { timeout: 10000 })).stdout.trim()
  t.after(async () => { await run("tmux", ["-S", join(root, "entry-tmux.sock"), "kill-server"]).catch(() => undefined); await rm(root, { recursive: true, force: true }) })
  const driver = createTmuxEditorMechanics({ runtimeRoot: root, editor, run })
  const ref = { hostId: "a".repeat(64), target: { agentId: "00000000-0000-4000-8000-000000000001", handlerGeneration: "00000000-0000-4000-8000-000000000002", providerGeneration: "00000000-0000-4000-8000-000000000003" } }
  const first = await driver.ensure({ ref, editor: null })
  assert.deepEqual(await driver.ensure({ ref, editor: null }), first)
})