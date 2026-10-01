import assert from "node:assert/strict"
import test from "node:test"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { agentHandlerFixture } from "./agent-support.js"

test("Handler starts an ambient agent and publishes version-two ownership", async t => {
  const f = await agentHandlerFixture(t)
  const accepted = await f.startAt(f.git.root)
  const ready = await f.waitCompleted(accepted)
  assert.equal(ready.command.result?.outcome, "started")
  const current = await f.currentAt(f.git.root)
  assert.equal(current.agents.length, 1)
  const agent = current.agents[0]!
  assert.equal(agent.record.definition.cwd, f.git.root)
  assert.equal(agent.launch?.version, 2)
  assert.equal(agent.launch?.phase, "active")
  await assert.rejects(lstat(join(f.paths.persistentRoot, "agents/provider-state")), { code: "ENOENT" })
  await f.stop(ready.command.target!)
  assert.deepEqual((await f.currentAt(f.git.root)).agents, [])
})

test("Handler current returns every exact-directory live agent", async t => {
  const f = await agentHandlerFixture(t)
  const first = await f.startAt(f.git.root), second = await f.startAt(f.git.root)
  const results = await Promise.all([f.waitCompleted(first), f.waitCompleted(second)])
  assert.ok(results.every(result => result.command.result?.outcome === "started"))
  assert.deepEqual((await f.currentAt(f.git.root)).agents.map(agent => agent.record.definition.agentId).sort(), results.map(result => result.command.target!.agentId).sort())
  assert.deepEqual((await f.currentAt(f.git.repo)).agents, [])
  await Promise.all(results.map(result => f.stop(result.command.target!)))
})