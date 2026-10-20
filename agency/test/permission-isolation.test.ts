import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentHandlerFixture } from "./agent-support.js"

test("malformed legacy permission history preserves current permissions, inventory and explicit restore", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t), started = await f.waitCompleted(await f.start()), agentId = started.command.target!.agentId
  await f.waitCompleted(await f.stop(started.command.target!)); await f.crashHandler()
  const entries = join(f.paths.persistentRoot, "orchestration", "permissions", f.paths.hostKey, "journal", "entries")
  await mkdir(entries, { recursive: true, mode: 0o700 })
  const path = join(entries, "old.json"); await writeFile(path, "{", { mode: 0o600 })
  await f.restart()
  const inventory = await f.list(); assert.ok(inventory.agents.some(agent => agent.record.version === 3 && agent.record.definition.agentId === agentId))
  assert.equal(inventory.issues.some(issue => issue.message.includes("PERMISSIONS_UNAVAILABLE")), false)
  const permissions = await f.human({ op: "agent_permissions" })
  assert.ok(permissions.state === "permissions"); assert.deepEqual(permissions.snapshot.pending, []); assert.deepEqual(permissions.snapshot.receipts, [])
  assert.equal(await readFile(path, "utf8"), "{")
  const restored = await f.waitCompleted(await f.restore(agentId)); assert.equal(restored.command.result!.outcome, "restored")
  assert.equal((await f.page({ limit: 100, activeOnly: true })).agents.length, 1)
  await f.waitCompleted(await f.stop(restored.command.target!)); await f.verifyZeroSurvivors()
})