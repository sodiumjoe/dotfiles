import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { liveHandlerFixture } from "./live-support.js"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import { runRestart } from "../src/cli/restart.js"
import { inspectHandlerGeneration } from "../src/platform/singleton.js"

const run = promisify(execFile), root = fileURLToPath(new URL("../../../", import.meta.url))

test("the editor's Lua validation accepts the real agents, start, stop, restore and restart replies and the ACP roster reply", async t => {
  const nvim = await run("nvim", ["--version"]).then(() => true, () => false)
  if (!nvim) { t.skip("nvim is not on PATH, so the editor contract cannot be checked"); return }
  const f = await liveHandlerFixture(t), cli: Array<{ argv: string[]; output: string }> = []
  const agy = async (argv: string[]): Promise<Record<string, any>> => {
    let output = ""
    await runControl([...argv, "--json"], { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), start: async () => (await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter))!, cwd: () => f.workspace,
      homes: () => ({ codexHome: join(f.homes, "codex"), claudeHome: join(f.homes, "claude") }), stdout: value => { output += value }, stderr: () => {} })
    cli.push({ argv, output })
    return JSON.parse(output)
  }
  const started = await agy(["start"]), agentId = started.result.agent.agentId as string
  await f.prompt(agentId, "hello")
  await f.start()
  await agy(["agents"])
  await agy(["stop", agentId])
  await agy(["agents"])
  await agy(["restore", agentId])
  const c = await f.connect()
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const roster = await c.request("agency/roster", {})
  let restarted = ""
  const restartDeps = { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), cwd: () => f.workspace, stdout: (value: string) => { restarted += value }, stderr: () => {},
    start: async () => { const current = await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter); if (current?.disposition === "live" && current.record.phase === "ready") return current; await f.restart(); return (await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter))! } }
  assert.equal(await runRestart(["restart", "--json"], restartDeps, runControl), 0)
  cli.push({ argv: ["restart", "--json"], output: restarted })
  assert.deepEqual(JSON.parse(restarted).result.agents.map((agent: { outcome: string }) => agent.outcome), ["restored", "failed"])
  assert.ok(cli.every(item => JSON.parse(item.output).ok), cli.map(item => item.output).join("\n"))
  const payload = join(f.root, "editor-contract.json")
  await writeFile(payload, JSON.stringify({ cli, roster: JSON.stringify(roster) }), { mode: 0o600 })
  const result = await run("nvim", ["--clean", "--headless", "-l", join(root, "agency/test/fixtures/editor-contract.lua"), root, payload]).catch((error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }))
  assert.equal(result.stdout.trim(), "contract ok", result.stderr)
  await f.verifyZeroSurvivors()
})