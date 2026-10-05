import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises"
import { createRetentionStore } from "../src/retention/store.js"
import { forgetRemovedLaunch, MutationQueue, refreshLaunchState, type HandlerMutations } from "../src/handler/mutations.js"
import type { HandlerStatus } from "../src/control/protocol.js"
import { join } from "node:path"
import test from "node:test"
import { inventoryLaunches, inventoryLaunchState, summarizeLaunches, verifyInventory } from "../src/handler/inventory.js"
import { writeLaunchRecord } from "../src/platform/private-state.js"
import { privateRoot, launch } from "./control-support.js"

test("launch retirement forgets only exact authorized paths", async t => {
  const root = await privateRoot(t), directory = join(root, "launches"), a = launch(), b = launch()
  await mkdir(directory, { mode: 0o700 })
  for (const record of [a, b]) await writeLaunchRecord(join(directory, record.launchAttemptId + ".json"), record)
  const retention = createRetentionStore(root, "a".repeat(64), randomUUID())
  const mutations: HandlerMutations = { root, retirement: retention.view, queue: new MutationQueue(), accepted: await inventoryLaunches(directory) }
  const state: HandlerStatus = { hostId: "a".repeat(64), handlerGeneration: randomUUID(), phase: "ready", capabilities: ["status", "doctor", "shutdown"], launches: [], reconciliation: { classified: 0, total: 0, uncertain: 0 } }
  const path = "launches/" + a.launchAttemptId + ".json"
  await retention.prepare({ paths: [path], launches: [{ path, record: a }], handlers: [] })
  await refreshLaunchState(state, mutations, directory)
  assert.equal(mutations.issues!.length, 0)
  await retention.resume({ authorize: async () => undefined, removed: entry => forgetRemovedLaunch(mutations, entry) })
  await refreshLaunchState(state, mutations, directory)
  assert.equal(mutations.issues!.length, 0)
  await unlink(join(directory, b.launchAttemptId + ".json"))
  await refreshLaunchState(state, mutations, directory)
  assert.equal(mutations.issues![0]!.launchAttemptId, b.launchAttemptId)
})

test("inventory preserves incomplete and semantically invalid launch evidence", async t => {
  const root = await privateRoot(t), first = launch(), second = launch({ phase: "active" })
  await writeLaunchRecord(join(root, `${first.launchAttemptId}.json`), first)
  await writeFile(join(root, `${second.launchAttemptId}.json`), JSON.stringify(second), { mode: 0o600 })
  const entries = await inventoryLaunches(root)
  assert.deepEqual(entries.map(e => e.record).sort((a, b) => a.launchAttemptId.localeCompare(b.launchAttemptId)), [first, second].sort((a, b) => a.launchAttemptId.localeCompare(b.launchAttemptId)))
  assert.deepEqual(summarizeLaunches(entries.map(e => e.record)).find(e => e.launchAttemptId === first.launchAttemptId)?.owner, { kind: "legacy-agent", id: "agent-a", handlerGeneration: first.handlerGeneration })
  await verifyInventory(root, entries)
  await writeLaunchRecord(join(root, `${first.launchAttemptId}.json`), { ...first, checkoutId: "changed" })
  await assert.rejects(verifyInventory(root, entries), /RETAINED_INVENTORY_CHANGED/)
})

for (const variant of ["symlink", "directory", "public", "malformed", "mismatch", "unknown", "duplicate"]) test(`inventory rejects ${variant} without rewriting evidence`, async t => {
  const root = await privateRoot(t), record = launch(), path = join(root, `${record.launchAttemptId}.json`)
  await writeLaunchRecord(path, record)
  if (variant === "symlink") await symlink(path, join(root, `${randomUUID()}.json`))
  if (variant === "directory") await mkdir(join(root, `${randomUUID()}.json`))
  if (variant === "public") await chmod(path, 0o644)
  if (variant === "malformed") await writeFile(path, "{")
  if (variant === "mismatch" || variant === "duplicate") await writeFile(join(root, `${randomUUID()}.json`), JSON.stringify(record), { mode: 0o600 })
  if (variant === "unknown") await writeFile(join(root, "other"), "x", { mode: 0o600 })
  const before = await readFile(path)
  await assert.rejects(inventoryLaunches(root))
  assert.deepEqual(await readFile(path), before)
})

test("private atomic remnants are retained but never treated as committed launches", async t => {
  const root = await privateRoot(t), path = join(root, `.${randomUUID()}.json.${randomUUID()}.tmp`)
  await writeFile(path, "incomplete", { mode: 0o600 })
  assert.deepEqual(await inventoryLaunches(root), [])
  assert.equal(await readFile(path, "utf8"), "incomplete")
  await chmod(path, 0o644)
  await assert.rejects(inventoryLaunches(root))
})

test("verification detects a new launch after classification", async t => {
  const root = await privateRoot(t), record = launch()
  await writeLaunchRecord(join(root, `${record.launchAttemptId}.json`), record)
  await assert.rejects(verifyInventory(root, []), /RETAINED_INVENTORY_CHANGED/)
})

test("inventory reports a malformed UUID entry beside a valid launch", async t => {
  const root = await privateRoot(t), record = launch(), malformedAttemptId = randomUUID()
  await writeLaunchRecord(join(root, `${record.launchAttemptId}.json`), record)
  await writeFile(join(root, `${malformedAttemptId}.json`), "{", { mode: 0o600 })
  const inventory = await inventoryLaunchState(root)
  assert.equal(inventory.records.length, 1)
  assert.equal(inventory.issues.length, 1)
  assert.equal(inventory.issues[0]!.launchAttemptId, malformedAttemptId)
})