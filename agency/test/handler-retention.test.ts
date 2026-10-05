import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentHandlerFixture } from "./agent-support.js"
import { createCatalogStore } from "../src/catalog/store.js"
import { createRetentionStore } from "../src/retention/store.js"
import { writeLaunchRecord } from "../src/platform/private-state.js"
import type { RefreshCommand } from "../src/catalog/types.js"
import type { CleanupPhase } from "./retention-support.js"
import { controlFixture, until } from "./control-support.js"
import { readShutdownReceipt } from "../src/handler/receipt.js"

async function disposableProbe(f: Awaited<ReturnType<typeof agentHandlerFixture>>, generation: string) {
  const store = createCatalogStore(f.paths.persistentRoot), attemptId = randomUUID(), commandId = randomUUID(), snapshotId = randomUUID()
  const pending: RefreshCommand = { version: 1, hostId: f.paths.hostKey, handlerGeneration: generation, commandId, batchId: randomUUID(), fingerprints: [{ providerId: "codex-acp", fingerprint: "b".repeat(64) }], attempts: [{ providerId: "codex-acp", attemptId }], state: "pending", snapshotId: null }
  await store.writeAutomatic(pending, null)
  await store.writeSnapshot({ version: 1, hostId: f.paths.hostKey, handlerGeneration: generation, snapshotId, createdAt: 100, providers: [] })
  await store.writeAutomatic({ ...pending, state: "completed", snapshotId }, pending)
  const workPath = join(f.paths.persistentRoot, "catalog/work", attemptId)
  await store.writeProbeMeta({ version: 3, receiptKind: "automatic", hostId: f.paths.hostKey, handlerGeneration: generation, commandId, providerId: "codex-acp", attemptId, fingerprint: "b".repeat(64), workPath })
  await mkdir(workPath, { recursive: true, mode: 0o700 }); await writeFile(join(workPath, "result.json"), "{}", { mode: 0o600 })
  await mkdir(join(f.paths.persistentRoot, "catalog/probe-launches"), { recursive: true, mode: 0o700 })
  await writeLaunchRecord(join(f.paths.persistentRoot, "catalog/probe-launches", attemptId + ".json"), { version: 2, owner: { kind: "catalog-probe", providerId: "codex-acp", commandId }, handlerGeneration: generation, launchAttemptId: attemptId, launchBootId: "fixture-no-process", launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null })
  assert.deepEqual((await store.inventory()).issues, [])
  return { commandId, attemptId, snapshotId }
}

test("retired Handler history compacts while native restore remains available", async t => {
  const f = await agentHandlerFixture(t), first = await f.waitCompleted(await f.start())
  const agentId = first.command.target!.agentId, sessionId = first.command.result!.session!.sessionId, intermediate: string[] = []
  let target = first.command.target!
  for (let index = 0; index < 3; index++) {
    await f.waitCompleted(await f.stop(target))
    const restored = await f.waitCompleted(await f.restore(agentId))
    target = restored.command.target!; intermediate.push(restored.command.commandId)
  }
  const stopped = await f.waitCompleted(await f.stop(target)), historical = (await f.inventory()).commands
  await f.list(); await f.crashHandler(); await f.restart()
  const inventory = await f.inventory()
  assert.deepEqual(inventory.issues, [])
  assert.equal(inventory.agents.length, 1)
  assert.equal(inventory.agents[0]!.session!.sessionId, sessionId)
  assert.deepEqual(new Set(inventory.commands.map(c => c.commandId)), new Set([first.command.commandId, intermediate.at(-1)!]))
  const beforeRetries = await f.providerRequests(), count = f.providerCount()
  for (const command of [first.command, historical.find(command => command.commandId === intermediate[0])!, stopped.command]) {
    await assert.rejects(f.retryOperation(command), { code: "STALE_HANDLER" })
  }
  assert.deepEqual((await f.retry(first.command)).command, first.command)
  assert.deepEqual((await f.retry(historical.find(command => command.commandId === intermediate.at(-1))!)).command, inventory.commands.find(command => command.commandId === intermediate.at(-1)))
  for (const command of [historical.find(command => command.commandId === intermediate[0])!, stopped.command]) await assert.rejects(f.retry(command), { code: "UNAVAILABLE" })
  assert.deepEqual(await f.providerRequests(), beforeRetries); assert.equal(f.providerCount(), count)
  const restored = await f.waitCompleted(await f.restore(agentId))
  assert.equal(restored.command.result!.session!.sessionId, sessionId)
  assert.equal((await f.providerRequests()).filter(r => r.method === "session/new").length, 1)
})

for (const phase of ["intent", "work", "receipt", "snapshot", "metadata", "launch", "intent-removed"] satisfies CleanupPhase[]) test("cleanup crash at " + phase + " resumes without losing native restore", { timeout: 90000 }, async t => {
  const f = await agentHandlerFixture(t), first = await f.waitCompleted(await f.start()), target = first.command.target!
  await f.waitCompleted(await f.stop(target)); await f.list(); await f.crashHandler()
  const seeded = await disposableProbe(f, target.handlerGeneration)
  const sentinels = [join(f.root, "qualification.json"), join(f.root, "home/native-session"), join(f.paths.persistentRoot, "agents/provider-state", target.agentId, "session")]
  for (const path of sentinels) { await mkdir(join(path, ".."), { recursive: true, mode: 0o700 }); await writeFile(path, "retained", { mode: 0o600 }) }
  const restarting = f.restart({ cleanupPauseAt: phase }).then(() => null, error => error)
  await f.waitCleanupBarrier()
  assert.equal(JSON.parse(await readFile(join(f.root, "cleanup-barrier.json"), "utf8")).name, phase)
  await f.crashHandler(); assert.ok(await restarting)
  await f.restart()
  const inventory = await f.inventory(), catalog = await createCatalogStore(f.paths.persistentRoot).inventory()
  assert.deepEqual(inventory.issues, []); assert.deepEqual(catalog.issues, [])
  assert.equal(await createRetentionStore(f.paths.persistentRoot, f.paths.hostKey, randomUUID()).pending(), null)
  assert.equal(catalog.automatic.length, 0); assert.equal(catalog.metadata.length, 0); assert.equal(catalog.launches.length, 0)
  assert.equal(catalog.snapshots.some(value => value.snapshotId === seeded.snapshotId), false)
  for (const path of sentinels) assert.equal(await readFile(path, "utf8"), "retained")
  const restored = await f.waitCompleted(await f.restore(target.agentId))
  assert.equal(restored.command.result!.session!.sessionId, first.command.result!.session!.sessionId)
  assert.equal((await f.providerRequests()).filter(request => request.method === "session/new").length, 1)
})

test("failed cleanup remains diagnostic while an unrelated native agent completes a prompt", { timeout: 90000 }, async t => {
  const f = await agentHandlerFixture(t), first = await f.waitCompleted(await f.start()), target = first.command.target!
  await f.waitCompleted(await f.stop(target)); await f.list(); await f.crashHandler()
  await disposableProbe(f, target.handlerGeneration)
  await f.restart({ cleanupFailAt: "work" })
  assert.ok((await f.list()).issues.some(issue => issue.path.endsWith("retention/pending.json")))
  assert.deepEqual((await f.inventory()).issues, [])
  const unrelated = await f.waitCompleted(await f.start())
  assert.equal((await f.prompt(unrelated.command.target!, "cleanup failure isolation")).text, "answer:cleanup failure isolation")
  await f.waitCompleted(await f.stop(unrelated.command.target!)); await f.list(); await f.crashHandler(); await f.restart()
  assert.deepEqual((await f.list()).issues, [])
  assert.equal(await createRetentionStore(f.paths.persistentRoot, f.paths.hostKey, randomUUID()).pending(), null)
  assert.deepEqual(await readdir(join(f.paths.persistentRoot, "catalog/work")), [])
})

test("removed retired shutdown retries cannot drain the replacement Handler", { timeout: 60000 }, async t => {
  const f = await controlFixture(t), first = await f.start(), commandId = randomUUID()
  const request = { protocol: "agency-control/2" as const, requestId: randomUUID(), handlerGeneration: first.record.generation, op: "shutdown" as const, commandId, stopAgents: true }
  assert.ok((await f.call(request)).ok)
  await until(async () => await f.observe(first.record.process!.pid) === null ? true : undefined)
  const replacement = await f.start()
  assert.equal(await readShutdownReceipt(f.paths.persistentRoot, commandId), null)
  await assert.rejects(f.call(request), { code: "STALE_HANDLER" })
  const status = await f.call()
  assert.ok(status.ok && "phase" in status.result && status.result.phase === "ready")
  assert.equal(status.handlerGeneration, replacement.record.generation)
})

test("startup preserves large legacy receipt inventory and malformed evidence after entry 4096", { timeout: 120000 }, async t => {
  const f = await agentHandlerFixture(t), first = await f.waitCompleted(await f.start()), target = first.command.target!
  await f.waitCompleted(await f.stop(target)); await f.list(); await f.crashHandler()
  const directory = join(f.paths.persistentRoot, "catalog/commands")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (let offset = 0; offset < 4097; offset += 64) await Promise.all(Array.from({ length: Math.min(64, 4097 - offset) }, (_, n) => {
    const commandId = (offset + n + 1).toString(16).padStart(8, "0") + "-0000-4000-8000-000000000000"
    return writeFile(join(directory, commandId + ".json"), JSON.stringify({ version: 1, hostId: f.paths.hostKey, handlerGeneration: target.handlerGeneration, commandId, batchId: commandId, fingerprints: [], attempts: [], state: "interrupted", snapshotId: null }), { mode: 0o600 })
  }))
  const malformed = "ffffffff-ffff-4fff-8fff-ffffffffffff.json"
  await writeFile(join(directory, malformed), "{}", { mode: 0o600 })
  await f.restart()
  const catalog = await createCatalogStore(f.paths.persistentRoot).inventory()
  assert.equal(catalog.commands.length, 4097)
  assert.ok(catalog.issues.includes("commands/" + malformed))
  assert.equal(await readFile(join(directory, malformed), "utf8"), "{}")
  assert.equal((await f.list()).agents.length, 1)
  await writeFile(join(f.root, "large-inventory-evidence.json"), JSON.stringify({ valid: catalog.commands.length, issues: catalog.issues }), { mode: 0o600 })
  await unlink(join(directory, malformed))
})