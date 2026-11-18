import assert from "node:assert/strict"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createHostInventory } from "../src/hosts/inventory.js"

const alpha = { hostId: "a".repeat(64), hostname: "alpha.example" }, beta = { hostId: "b".repeat(64), hostname: "beta.example" }
async function root(t: { after(fn: () => Promise<void>): void }) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "agency-inventory-")))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test("a forgotten host leaves the list for this and a fresh inventory, and can be enrolled again", async t => {
  const path = await root(t), inventory = createHostInventory(path)
  await inventory.enroll(alpha); await inventory.enroll(beta)
  assert.deepEqual(await inventory.list(), [alpha, beta])
  await inventory.forget(alpha.hostId)
  assert.deepEqual(await inventory.list(), [beta])
  assert.deepEqual(await createHostInventory(path).list(), [beta])
  await inventory.forget(alpha.hostId)
  await inventory.forget("c".repeat(64))
  await inventory.enroll(alpha)
  assert.deepEqual(await inventory.list(), [alpha, beta])
  assert.deepEqual(await createHostInventory(path).list(), [alpha, beta])
})

test("lists running alongside a removal never fail", async t => {
  const path = await root(t), inventory = createHostInventory(path)
  await inventory.enroll(alpha); await inventory.enroll(beta)
  const before = Array.from({ length: 20 }, () => inventory.list())
  const removal = inventory.forget(alpha.hostId)
  const after = Array.from({ length: 20 }, () => inventory.list())
  const [early, late] = [await Promise.all(before), await Promise.all(after)]
  await removal
  for (const hosts of early) assert.deepEqual(hosts, [alpha, beta])
  for (const hosts of late) assert.deepEqual(hosts, [beta])
  await inventory.enroll(alpha)
  assert.deepEqual(await inventory.list(), [alpha, beta])
})

test("forgetting a host on an empty inventory does nothing", async t => {
  const inventory = createHostInventory(await root(t))
  await inventory.forget(alpha.hostId)
  assert.deepEqual(await inventory.list(), [])
})