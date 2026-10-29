import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHostInventory, parseHostEnrollment } from "../src/hosts/inventory.js"
import { createInventoryStore } from "../src/hosts/inventory-store.js"
import { privateRoot } from "./control-support.js"

const enrollment = () => ({ hostId: "a".repeat(64), hostname: "devbox-a" })

test("legacy enrollment bytes survive listing and repeat enrollment", async t => {
  const root = await privateRoot(t), value = enrollment(), directory = join(root, "bureau", "hosts")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, randomUUID() + ".json")
  await writeFile(path, JSON.stringify({ ...value, inventoryId: randomUUID(), agyPath: "/old/agy", loginShell: "/bin/sh" }), { mode: 0o600 })
  await writeFile(join(root, "bureau", "settings.json"), "{", { mode: 0o600 })
  const before = await readFile(path), inventory = createHostInventory(root)
  assert.deepEqual(await inventory.list(), [value])
  await inventory.enroll(value)
  await assert.rejects(inventory.enroll({ ...value, hostId: "b".repeat(64) }), /HOST_IDENTITY_CHANGED/)
  assert.deepEqual(await readFile(path), before)
  assert.equal((await readdir(directory)).length, 1)
})

test("enrollment stores only hostname and host ID and refuses conflicting identities", async t => {
  const root = await privateRoot(t), value = enrollment(), inventory = createHostInventory(root)
  await inventory.enroll(value)
  await inventory.enroll(value)
  await createHostInventory(root).enroll(value)
  assert.deepEqual(await createHostInventory(root).list(), [value])
  await assert.rejects(inventory.enroll({ ...value, hostname: "replacement" }), /HOST_IDENTITY_CONFLICT/)
  await assert.rejects(inventory.enroll({ ...value, hostId: "b".repeat(64) }), /HOST_IDENTITY_CHANGED/)
  for (const extra of [{ environment: {} }, { inventoryId: randomUUID() }, { agyPath: "/opt/agy" }, { loginShell: "/bin/sh" }]) assert.throws(() => parseHostEnrollment({ ...value, ...extra }))
  const directory = join(root, "bureau", "hosts"), path = join(directory, value.hostId + ".json")
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), value)
  assert.equal((await readdir(directory)).length, 1)
  await inventory.enroll({ hostname: "devbox-b", hostId: "b".repeat(64) })
  assert.equal((await inventory.list()).length, 2)
})

test("inventory rejects symlinks, malformed content and unsafe names", async t => {
  const root = await privateRoot(t), value = enrollment(), inventory = createHostInventory(root)
  await inventory.enroll(value)
  const directory = join(root, "bureau", "hosts"), key = value.hostId + ".json"
  const store = createInventoryStore(root)
  for (const name of ["../settings.json", "hosts/a.json", "bad.json", "."]) await assert.rejects(store.read(name))
  await symlink(join(directory, key), join(directory, randomUUID() + ".json"))
  await assert.rejects(inventory.list())
  const second = await privateRoot(t), secondValue = enrollment()
  await createHostInventory(second).enroll(secondValue)
  const path = join(second, "bureau", "hosts", secondValue.hostId + ".json")
  await writeFile(path, "{", { mode: 0o600 })
  await assert.rejects(createHostInventory(second).list())
  await writeFile(path, JSON.stringify(secondValue))
  await chmod(path, 0o644)
  await assert.rejects(createHostInventory(second).list())
})

test("inventory rejects mismatched host filenames and duplicate legacy identities", async t => {
  const root = await privateRoot(t), value = enrollment(), store = createInventoryStore(root)
  await store.publish("b".repeat(64) + ".json", value)
  await assert.rejects(createHostInventory(root).list(), /HOST_IDENTITY_CHANGED/)
  const second = await privateRoot(t), otherStore = createInventoryStore(second)
  await otherStore.publish(randomUUID() + ".json", value)
  await otherStore.publish(randomUUID() + ".json", value)
  await assert.rejects(createHostInventory(second).list(), /HOST_IDENTITY_CONFLICT/)
})

test("inventory detects accepted file replacement and preserves prior bytes on failed publication", async t => {
  const root = await privateRoot(t), value = enrollment(), store = createInventoryStore(root)
  const key = value.hostId + ".json"
  await store.publish(key, value)
  const before = await readFile(join(root, "bureau", "hosts", key))
  await assert.rejects(store.publish(key, { ...value, hostname: "changed" }), /CONFLICT/)
  const failing = createInventoryStore(root, { link: async () => { throw new Error("INJECTED_LINK") } })
  await assert.rejects(failing.publish(randomUUID() + ".json", value), /INJECTED_LINK/)
  assert.deepEqual(await readFile(join(root, "bureau", "hosts", key)), before)
  const replacement = join(root, "replacement")
  await writeFile(replacement, before, { mode: 0o600 })
  await rename(replacement, join(root, "bureau", "hosts", key))
  await assert.rejects(store.read(key), /STATE_REPLACED/)
})


test("a concurrent publisher cannot overwrite a different enrollment", async t => {
  const { link } = await import("node:fs/promises")
  const root = await privateRoot(t), value = enrollment(), key = value.hostId + ".json", other = { ...value, hostname: "other" }
  const store = createInventoryStore(root, { link: async (source, target) => {
    await createInventoryStore(root).publish(key, other)
    await link(source, target)
  } })
  await assert.rejects(store.publish(key, value), /COMMAND_CONFLICT/)
  assert.deepEqual(await createHostInventory(root).list(), [other])
})