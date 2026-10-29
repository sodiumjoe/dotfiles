import assert from "node:assert/strict"
import test from "node:test"
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