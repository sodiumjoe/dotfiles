import assert from "node:assert/strict"
import test from "node:test"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { liveHandlerFixture } from "./live-support.js"
import { until } from "./control-support.js"
import { createAgentIndex } from "../src/agent/agent-index.js"

test("a setting changes through the provider, repeating it changes nothing, and an unoffered value fails INVALID", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  const changed = await f.set(agentId, "model", "model-b")
  assert.equal(changed.live?.model, "model-b")
  assert.deepEqual(await f.set(agentId, "model", "model-b"), changed)
  assert.deepEqual(await f.failure(f.set(agentId, "model", "model-z")), { code: "INVALID", message: "model model-z is not offered; offered: model-a, model-b, model-c" })
  assert.equal((await f.failure(f.set(agentId, "colour", "blue"))).code, "INVALID")
  assert.equal((await f.set(agentId, "mode", "read-only")).live?.mode, "read-only")
  assert.deepEqual((await f.providerRequests()).filter(frame => frame.method === "session/set_config_option").map(frame => [frame.params?.configId, frame.params?.value]), [["model", "model-b"], ["mode", "read-only"]])
  assert.deepEqual((await f.events()).filter(event => event.type === "settings_changed").map(event => [event.setting, event.before, event.after]), [["model", "model-a", "model-b"], ["mode", "agent-full-access", "read-only"]])
  await f.verifyZeroSurvivors()
})

test("a setting change during a turn fails BUSY, except a Claude mode change", async t => {
  const f = await liveHandlerFixture(t), codex = await f.start(), claude = await f.start({ backendId: "claude-agent-acp" })
  const heldCodex = f.prompt(codex.agentId, "held"), heldClaude = f.prompt(claude.agentId, "held")
  await until(async () => (await f.providerRequests()).some(frame => frame.method === "session/prompt") && (await f.providerRequests("claude-agent-acp")).some(frame => frame.method === "session/prompt") ? true : undefined)
  assert.deepEqual(await f.failure(f.set(codex.agentId, "model", "model-b")), { code: "BUSY", message: "agent " + codex.agentId + " is running a turn" })
  assert.equal((await f.set(claude.agentId, "mode", "review")).live?.mode, "review")
  await f.releasePrompts()
  await Promise.all([heldCodex, heldClaude])
  assert.equal((await f.set(codex.agentId, "model", "model-b")).live?.model, "model-b")
  await f.verifyZeroSurvivors()
})

test("a restored agent gets back the model and mode recorded in its session file, and a recorded value it no longer offers is logged", async t => {
  const f = await liveHandlerFixture(t), codex = await f.start(), claude = await f.start({ backendId: "claude-agent-acp" })
  await f.set(codex.agentId, "model", "model-b"); await f.set(codex.agentId, "mode", "read-only")
  await f.set(claude.agentId, "model", "legacy-b"); await f.set(claude.agentId, "mode", "review")
  await f.prompt(codex.agentId, "hello"); await f.prompt(claude.agentId, "hello")
  await f.stop(codex.agentId); await f.stop(claude.agentId)
  const restored = await f.restore(codex.agentId)
  assert.deepEqual([restored.live?.model, restored.live?.mode], ["model-b", "read-only"])
  const [entry] = (await createAgentIndex(f.paths.persistentRoot).list()).filter(value => value.agentId === claude.agentId)
  await appendFile(join(f.homes, "claude/projects", f.workspace.replace(/[^A-Za-z0-9]/g, "-"), entry!.nativeSessionId + ".jsonl"), JSON.stringify({ type: "user", permissionMode: "plan", message: { role: "user", content: "later" } }) + "\n")
  const again = await f.restore(claude.agentId)
  assert.deepEqual([again.live?.model, again.live?.mode], ["legacy-b", "normal"])
  const skipped = (await f.events()).filter(event => event.type === "setting_not_restored")
  assert.deepEqual(skipped.map(event => [event.agentId, event.setting, event.value, event.code]), [[claude.agentId, "mode", "plan", "INVALID"]])
  await f.verifyZeroSurvivors()
})