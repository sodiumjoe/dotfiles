import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { inventoryLaunches, summarizeLaunches, verifyInventory } from "../src/handler/inventory.js"
import { writeLaunchRecord } from "../src/platform/private-state.js"
import { privateRoot, launch } from "./control-support.js"

test("inventory preserves incomplete and semantically invalid launch evidence", async t => {
  const root = await privateRoot(t), first = launch(), second = launch({ phase: "active" })
  await writeLaunchRecord(join(root, `${first.launchAttemptId}.json`), first)
  await writeFile(join(root, `${second.launchAttemptId}.json`), JSON.stringify(second), { mode: 0o600 })
  const entries = await inventoryLaunches(root)
  assert.deepEqual(entries.map(e => e.record).sort((a, b) => a.launchAttemptId.localeCompare(b.launchAttemptId)), [first, second].sort((a, b) => a.launchAttemptId.localeCompare(b.launchAttemptId)))
  assert.equal(summarizeLaunches(entries.map(e => e.record))[0]!.checkoutId, "checkout-a")
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