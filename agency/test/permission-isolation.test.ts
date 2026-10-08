import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentServiceFixture, agentHandlerFixture } from "./agent-support.js"
import { createPermissionRouting } from "../src/orchestration/permission-routing.js"
import { createJournal } from "../src/orchestration/journal.js"
import { privateRoot } from "./control-support.js"

for (const operation of ["retainedRead", "append"]) test("permission initialization isolates journal " + operation + " failure", async t => {
  const root = await privateRoot(t), hostId = "a".repeat(64), handlerGeneration = randomUUID(), journal = createJournal(root, undefined, Date.now, { kind: "permissions", hostId })
  const routing = createPermissionRouting({ root, hostId, handlerGeneration, journal: { ...journal, [operation]: async () => { throw new Error("permission store failure") } } })
  await routing.initialize()
  assert.equal(routing.status().available, false)
  await assert.rejects(routing.snapshot(), /PERMISSIONS_UNAVAILABLE/)
  await assert.rejects(routing.decide(randomUUID(), { hostId, target: { agentId: randomUUID(), handlerGeneration, providerGeneration: randomUUID() }, permissionId: randomUUID(), revision: 1 }, "allow"), /PERMISSIONS_UNAVAILABLE/)
})

test("permission journal corruption preserves ordinary Handler inventory and explicit restore", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t), started = await f.waitCompleted(await f.start()), agentId = started.command.target!.agentId
  await f.waitCompleted(await f.stop(started.command.target!)); await f.crashHandler()
  const entries = join(f.paths.persistentRoot, "orchestration", "permissions", f.paths.hostKey, "journal", "entries"), names = await readdir(entries)
  assert.ok(names.length > 0)
  const path = join(entries, names[0]!); assert.ok((await readFile(path, "utf8")).length > 0)
  await writeFile(path, "{", { mode: 0o600 })
  await f.restart()
  const inventory = await f.list(); assert.ok(inventory.agents.some(agent => agent.record.version === 3 && agent.record.definition.agentId === agentId))
  assert.ok(inventory.issues.some(issue => issue.message.includes("PERMISSIONS_UNAVAILABLE")))
  const restored = await f.waitCompleted(await f.restore(agentId)); assert.equal(restored.command.result!.outcome, "restored")
  assert.equal((await f.page({ limit: 100, activeOnly: true })).agents.length, 1)
  await f.waitCompleted(await f.stop(restored.command.target!)); await f.verifyZeroSurvivors()
})

test("unavailable permission storage does not hide an ordinary origin snapshot", async t => {
  const f = await agentServiceFixture(t), { createHostCoordination } = await import("../src/handler/host-coordination.js"), { createBureauPermissions } = await import("../src/bureau/permissions.js")
  f.service.permissionRouting.snapshot = async () => { throw new Error("PERMISSIONS_UNAVAILABLE") }
  const coordination = await createHostCoordination({ root: f.root, runtimeRoot: f.root, hostId: f.context.paths.hostKey, agents: f.service, coordinator: async () => { throw new Error("offline") } })
  t.after(() => coordination.close())
  const snapshot = await coordination.origin.snapshot()
  assert.equal(snapshot.hostId, f.context.paths.hostKey); assert.equal(snapshot.permissions, undefined)
  const permissions = createBureauPermissions({ root: f.root, hosts: [coordination.origin], enabled: () => true })
  assert.equal((await permissions.snapshot()).unavailable.length, 1)
})