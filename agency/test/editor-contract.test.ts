import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
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

test("the editor's Lua validation accepts the real ACP roster, excerpt, transcript and stop replies and the restart reply", async t => {
  const nvim = await run("nvim", ["--version"]).then(() => true, () => false)
  if (!nvim) { t.skip("nvim is not on PATH, so the editor contract cannot be checked"); return }
  const f = await liveHandlerFixture(t)
  const { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  await f.start()
  const scratch = await f.start()
  const c = await f.connect()
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const acp = {
    "agency/roster": JSON.stringify(await c.request("agency/roster", {})),
    "agency/excerpt": JSON.stringify(await c.request("agency/excerpt", { agentId })),
    "agency/transcript": JSON.stringify(await c.request("agency/transcript", { agentId })),
    "agency/stop": JSON.stringify(await c.request("agency/stop", { agentId: scratch.agentId })),
    "agency/remotes": JSON.stringify(await c.request("agency/remotes", {})),
    "agency/approvals": JSON.stringify(await c.request("agency/approvals", {})),
    "agency/decide": JSON.stringify(await c.request("agency/decide", { ref: { hostId: f.paths.hostKey, target: { agentId, handlerGeneration: (await f.handler()).generation, providerGeneration: randomUUID() }, permissionId: randomUUID(), revision: 1 }, optionId: "allow" })),
    "agency/entry": JSON.stringify(await c.request("agency/entry", { commandId: randomUUID(), hostId: f.paths.hostKey, target: { agentId: scratch.agentId, handlerGeneration: scratch.live!.handlerGeneration, providerGeneration: scratch.live!.providerGeneration } })),
  }
  let restarted = ""
  const restartDeps = { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), cwd: () => f.workspace, stdout: (value: string) => { restarted += value }, stderr: () => {},
    start: async () => { const current = await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter); if (current?.disposition === "live" && current.record.phase === "ready") return current; await f.restart(); return (await inspectHandlerGeneration(f.paths.runtimeRoot, f.adapter))! } }
  assert.equal(await runRestart(["restart", "--json"], restartDeps, runControl), 0)
  assert.deepEqual(JSON.parse(restarted).result.agents.map((agent: { outcome: string }) => agent.outcome), ["restored", "failed"])
  assert.ok(JSON.parse(restarted).ok, restarted)
  const payload = join(f.root, "editor-contract.json")
  await writeFile(payload, JSON.stringify({ cli: [{ argv: ["restart", "--json"], output: restarted }], acp }), { mode: 0o600 })
  const result = await run("nvim", ["--clean", "--headless", "-l", join(root, "agency/test/fixtures/editor-contract.lua"), root, payload]).catch((error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }))
  assert.equal(result.stdout.trim(), "contract ok", result.stderr)
  await f.verifyZeroSurvivors()
})