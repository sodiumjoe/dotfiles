import assert from "node:assert/strict"
import test from "node:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isImplicitDisabledCodexFastMode } from "../src/agent/session-config.js"
import { agentHandlerFixture } from "./agent-support.js"

test("Handler editor queries preserve active directory scope and historical stop receipts", async t => {
  const f = await agentHandlerFixture(t)
  const choices = await f.choices()
  assert.ok(choices.choices.length > 0)
  assert.equal(choices.choices[0]!.selection.permissionProfile, "fixture-deny-v1")
  const ready = await f.waitCompleted(await f.start())
  const page = await f.page({ limit: 100, cwd: f.workspace, activeOnly: true })
  assert.equal(page.agents.length, 1)
  assert.equal(page.agents[0]!.record.phase, "ready")
  assert.deepEqual((await f.page({ limit: 100, cwd: f.otherWorkspace, activeOnly: true })).agents, [])
  const stopped = await f.waitCompleted(await f.stop(ready.command.target!))
  assert.equal(stopped.command.result?.outcome, "stopped")
  assert.equal((await f.list()).agents[0]!.launch?.phase, "cleanup_verified")
  assert.deepEqual((await f.page({ limit: 100, activeOnly: true })).agents, [])
  const restored = await f.waitCompleted(await f.restore(ready.command.target!.agentId))
  assert.notEqual(restored.command.target!.providerGeneration, ready.command.target!.providerGeneration)
  const historical = await f.command(stopped.command.commandId, stopped.command.handlerGeneration)
  assert.deepEqual(historical.command.target, ready.command.target)
  assert.equal(historical.command.result?.outcome, "stopped")
  await f.waitCompleted(await f.stop(restored.command.target!))
  await f.verifyZeroSurvivors()
})

test("Restore preserves native identity when disabled Codex fast mode disappears", async t => {
  const f = await agentHandlerFixture(t, { providerScenario: "restore-fast-mode" })
  await writeFile(join(f.root, "fast-mode.json"), JSON.stringify({ savedValue: "off" }), { mode: 0o600 })
  const ready = await f.waitCompleted(await f.start())
  assert.equal(ready.command.result?.outcome, "started")
  assert.equal((await f.current()).agents[0]!.record.settings.configValues?.["fast-mode"], "off")
  await f.waitCompleted(await f.stop(ready.command.target!))
  const restored = await f.waitCompleted(await f.restore(ready.command.target!.agentId))
  assert.equal(restored.command.result?.outcome, "restored")
  assert.equal(restored.command.target!.agentId, ready.command.target!.agentId)
  assert.notEqual(restored.command.target!.providerGeneration, ready.command.target!.providerGeneration)
  assert.equal(restored.command.result?.session?.sessionId, ready.command.result?.session?.sessionId)
  assert.equal((await f.current()).agents[0]!.record.settings.configValues?.["fast-mode"], undefined)
  await f.waitCompleted(await f.stop(restored.command.target!))
  assert.ok((await f.list()).agents.every(agent => agent.launch?.phase === "cleanup_verified"))
  await f.verifyZeroSurvivors()
})

for (const [name, fast, outcome] of [
  ["boolean disabled fast mode", { savedValue: false }, "restored"],
  ["enabled fast mode", { savedValue: "on" }, "failed"],
  ["missing permission mode", { savedValue: "off", drop: ["mode"] }, "failed"],
  ["missing model", { savedValue: "off", drop: ["model"] }, "failed"],
  ["missing effort", { savedValue: "off", drop: ["reasoning"] }, "failed"],
  ["unknown loaded configuration", { savedValue: "off", omitConfiguration: true }, "failed"],
  ["still exposed native fast mode", { savedValue: "off", loadedValue: "on" }, "restored"],
] as const) test("Restore handles " + name + " without discarding required settings", async t => {
  const f = await agentHandlerFixture(t, { providerScenario: "restore-fast-mode" })
  await writeFile(join(f.root, "fast-mode.json"), JSON.stringify(fast), { mode: 0o600 })
  const ready = await f.waitCompleted(await f.start())
  assert.equal(ready.command.result?.outcome, "started")
  await f.waitCompleted(await f.stop(ready.command.target!))
  const restored = await f.waitCompleted(await f.restore(ready.command.target!.agentId))
  assert.equal(restored.command.result?.outcome, outcome)
  if (outcome === "failed") assert.equal(restored.command.result?.failure?.code, "SESSION_INPUT_REQUIRED")
  else {
    assert.equal(restored.command.result?.session?.sessionId, ready.command.result?.session?.sessionId)
    const settings = (await f.current()).agents[0]!.record.settings
    assert.equal(settings.configValues?.["fast-mode"], "loadedValue" in fast ? fast.loadedValue : undefined)
    await f.waitCompleted(await f.stop(restored.command.target!))
  }
  assert.ok((await f.list()).agents.every(agent => agent.launch?.phase === "cleanup_verified"))
  await f.verifyZeroSurvivors()
})

test("disabled-fast omission requires known Codex absence and no unresolved setting obligation", () => {
  const empty = new Set<string>(), blocked = new Set(["fast-mode"])
  const result = { configOptions: [] }
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", "off", result, empty, empty), true)
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", false, result, empty, empty), true)
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", "off", result, blocked, empty), false)
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", "off", result, empty, blocked), false)
  assert.equal(isImplicitDisabledCodexFastMode("claude-agent-acp", "fast-mode", "off", result, empty, empty), false)
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", "off", {}, empty, empty), false)
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", "off", { configOptions: [{ id: "fast-mode", type: "unknown" }] }, empty, empty), false)
  for (const value of ["on", true, undefined]) assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", value, result, empty, empty), false)
  for (const key of ["model", "mode", "reasoning_effort", "another-option"]) assert.equal(isImplicitDisabledCodexFastMode("codex-acp", key, "off", result, empty, empty), false)
})