import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHostInventory, parseHostEnrollment } from "../src/hosts/inventory.js"
import { createInventoryStore } from "../src/hosts/inventory-store.js"
import { privateRoot } from "./control-support.js"

const enrollment = () => ({ inventoryId: randomUUID(), hostId: "a".repeat(64), hostname: "devbox-a", agyPath: "/opt/agency/agy", loginShell: "/bin/sh" })

test("existing enrollment bytes survive malformed coordination settings", async t => {
  const root = await privateRoot(t), value = enrollment(), directory = join(root, "bureau", "hosts")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, value.inventoryId + ".json")
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  await writeFile(join(root, "bureau", "settings.json"), "{", { mode: 0o600 })
  const before = await readFile(path), inventory = createHostInventory(root)
  assert.deepEqual(await inventory.list(), [value])
  await assert.rejects(inventory.enroll({ ...value, hostId: "b".repeat(64) }), /HOST_IDENTITY_CHANGED/)
  assert.deepEqual(await readFile(path), before)
})

test("enrollment remains immutable and refuses hostname and host identity conflicts", async t => {
  const root = await privateRoot(t), value = enrollment(), inventory = createHostInventory(root)
  await inventory.enroll(value)
  await inventory.enroll(value)
  assert.deepEqual(await createHostInventory(root).list(), [value])
  await assert.rejects(inventory.enroll({ ...value, hostname: "replacement" }), /CONFLICT/)
  await assert.rejects(inventory.enroll({ ...value, inventoryId: randomUUID(), hostId: "b".repeat(64) }), /HOSTNAME_CONFLICT/)
  await assert.rejects(inventory.enroll({ ...value, inventoryId: randomUUID(), hostname: "other" }), /HOST_IDENTITY_CONFLICT/)
  assert.throws(() => parseHostEnrollment({ ...value, environment: {} }))
  assert.equal((await stat(join(root, "bureau", "hosts"))).mode & 0o777, 0o700)
  assert.equal((await stat(join(root, "bureau", "hosts", value.inventoryId + ".json"))).mode & 0o777, 0o600)
})

test("inventory rejects symlinks, malformed content and unsafe names", async t => {
  const root = await privateRoot(t), value = enrollment(), inventory = createHostInventory(root)
  await inventory.enroll(value)
  const directory = join(root, "bureau", "hosts"), key = value.inventoryId + ".json"
  const store = createInventoryStore(root)
  for (const name of ["../settings.json", "hosts/a.json", "bad.json", "."]) await assert.rejects(store.read(name))
  await symlink(join(directory, key), join(directory, randomUUID() + ".json"))
  await assert.rejects(inventory.list())
  const second = await privateRoot(t), secondValue = enrollment()
  await createHostInventory(second).enroll(secondValue)
  const path = join(second, "bureau", "hosts", secondValue.inventoryId + ".json")
  await writeFile(path, "{", { mode: 0o600 })
  await assert.rejects(createHostInventory(second).list())
  await writeFile(path, JSON.stringify(secondValue))
  await chmod(path, 0o644)
  await assert.rejects(createHostInventory(second).list())
})

test("inventory detects accepted file replacement and preserves prior bytes on failed publication", async t => {
  const root = await privateRoot(t), value = enrollment(), store = createInventoryStore(root)
  const key = value.inventoryId + ".json"
  await store.publish(key, value)
  const before = await readFile(join(root, "bureau", "hosts", key))
  await assert.rejects(store.publish(key, { ...value, hostname: "changed" }), /CONFLICT/)
  const failing = createInventoryStore(root, { rename: async () => { throw new Error("INJECTED_RENAME") } })
  await assert.rejects(failing.publish(randomUUID() + ".json", value), /INJECTED_RENAME/)
  assert.deepEqual(await readFile(join(root, "bureau", "hosts", key)), before)
  const replacement = join(root, "replacement")
  await writeFile(replacement, before, { mode: 0o600 })
  await rename(replacement, join(root, "bureau", "hosts", key))
  await assert.rejects(store.read(key), /STATE_REPLACED/)
})