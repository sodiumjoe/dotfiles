import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, link, mkdir, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { resolveCheckout } from "../src/checkout/identity.js"
import { inventoryAdmissions, readAdmission, writeAdmission, type AdmissionRecord } from "../src/checkout/records.js"
import { classifyCheckout } from "../src/checkout/admission.js"
import { gitFixture, testHostId } from "./checkout-support.js"
import { privateRoot, launch } from "./control-support.js"

async function fixture(t: test.TestContext) {
  const root = await privateRoot(t), git = await gitFixture(t), checkout = await resolveCheckout(git.repo, testHostId)
  const value: AdmissionRecord = { version: 1, checkout, agentId: randomUUID(), leaseId: randomUUID(), handlerGeneration: randomUUID(), launchAttemptId: randomUUID() }
  const record = launch({ checkoutId: checkout.checkoutId, agentId: value.agentId, leaseId: value.leaseId, handlerGeneration: value.handlerGeneration, launchAttemptId: value.launchAttemptId, launchAttempted: false, phase: "launch_pending", provider: null, reason: null })
  const entries = [{ path: join(root, "launches", `${record.launchAttemptId}.json`), record }]
  return { root, git, checkout, value, record, entries, path: join(root, "admissions", `${record.launchAttemptId}.json`) }
}

test("immutable admission evidence classifies occupancy without supplying release authority", { timeout: 20000 }, async t => {
  const f = await fixture(t)
  assert.deepEqual(await inventoryAdmissions(f.root), { records: [], issues: [] })
  await writeAdmission(f.root, f.value)
  assert.deepEqual(await readAdmission(f.root, f.value.launchAttemptId), f.value)
  await assert.rejects(writeAdmission(f.root, { ...f.value, agentId: randomUUID() }), /conflict/i)
  const inventory = await inventoryAdmissions(f.root)
  assert.equal(classifyCheckout(f.checkout, f.entries, inventory).state, "leased")
  assert.equal(classifyCheckout(f.checkout, [], inventory).state, "unavailable")
  assert.equal(classifyCheckout(f.checkout, f.entries, { records: [], issues: [] }).state, "unavailable")
  const linked = await resolveCheckout(f.git.linked, testHostId)
  f.record.phase = "quarantined"; f.record.reason = "ambiguous"
  assert.equal(classifyCheckout(f.checkout, f.entries, inventory).state, "quarantined")
  assert.equal(classifyCheckout(linked, f.entries, inventory).state, "available")
  f.record.phase = "cleanup_verified"; f.record.reason = null
  assert.equal(classifyCheckout(f.checkout, f.entries, inventory).state, "available")
  assert.equal(classifyCheckout(linked, f.entries, { records: [], issues: [] }).state, "available")
})

test("unattributable history, mismatched pairs, wrong hosts and reused IDs block globally", { timeout: 20000 }, async t => {
  const f = await fixture(t), inventory = { records: [f.value], issues: [] }
  for (const changes of [{ leaseId: randomUUID() }, { agentId: randomUUID() }, { handlerGeneration: randomUUID() }, { checkoutId: "legacy" }]) {
    assert.equal(classifyCheckout(f.checkout, [{ ...f.entries[0]!, record: { ...f.record, ...changes } }], inventory).state, "unavailable")
  }
  assert.equal(classifyCheckout({ ...f.checkout, hostId: "b".repeat(64) }, f.entries, inventory).state, "unavailable")
  for (const key of ["agentId", "leaseId", "launchAttemptId"] as const) {
    const record = launch({ phase: "cleanup_verified", launchAttempted: false, [key]: f.record[key] })
    assert.equal(classifyCheckout(f.checkout, [...f.entries, { path: "/legacy", record }], inventory).state, "unavailable")
  }
})

test("malformed admission fields never become lease evidence", { timeout: 20000 }, async t => {
  const f = await fixture(t)
  await writeAdmission(f.root, f.value)
  const variants = [
    { ...f.value, extra: true }, { ...f.value, version: 2 }, { ...f.value, leaseId: "../outside" }, { ...f.value, launchAttemptId: randomUUID() },
    { ...f.value, checkout: { ...f.checkout, checkoutId: "checkout-v1:" + "0".repeat(64) } },
    { ...f.value, checkout: { ...f.checkout, root: { ...f.checkout.root, device: "01" } } },
    { ...f.value, checkout: { ...f.checkout, gitDirectory: { ...f.checkout.gitDirectory, path: "/a/../b" } } },
    { ...f.value, checkout: { ...f.checkout, ancestors: [] } },
    { ...f.value, checkout: { ...f.checkout, hostId: "wrong" } },
  ]
  const invalid = [Buffer.from("{"), Buffer.from([255]), Buffer.alloc(1024 * 1024 + 1, 32), ...variants.map(value => Buffer.from(JSON.stringify(value)))]
  for (const bytes of invalid) {
    await writeFile(f.path, bytes)
    await assert.rejects(readAdmission(f.root, f.value.launchAttemptId))
    assert.ok((await inventoryAdmissions(f.root)).issues.length > 0)
    assert.deepEqual(await readFile(f.path), bytes)
  }
})

test("unsafe files and unknown entries are retained; private atomic remnants are not committed", { timeout: 20000 }, async t => {
  const f = await fixture(t)
  await writeAdmission(f.root, f.value)
  await chmod(f.path, 0o644)
  await assert.rejects(readAdmission(f.root, f.value.launchAttemptId))
  await chmod(f.path, 0o600)
  const hardlink = join(f.root, "hardlink")
  await link(f.path, hardlink)
  await assert.rejects(readAdmission(f.root, f.value.launchAttemptId))
  await rm(hardlink)
  const id = randomUUID(), alias = join(f.root, "admissions", `${id}.json`)
  await symlink(f.path, alias)
  await assert.rejects(readAdmission(f.root, id))
  assert.ok((await inventoryAdmissions(f.root)).issues.length > 0)
  await rm(alias)
  const remnant = join(f.root, "admissions", `.${randomUUID()}.json.${randomUUID()}.tmp`)
  await writeFile(remnant, "partial", { mode: 0o600 })
  assert.equal((await inventoryAdmissions(f.root)).issues.length, 0)
  await writeFile(join(f.root, "admissions", "unknown"), "unknown", { mode: 0o600 })
  assert.equal((await inventoryAdmissions(f.root)).issues.length, 1)
  assert.equal(await readFile(remnant, "utf8"), "partial")
  await assert.rejects(readAdmission(f.root, "../outside"))
})

test("unsafe admission directory does not become an empty inventory", { timeout: 20000 }, async t => {
  const f = await fixture(t), outside = join(f.root, "outside")
  await mkdir(outside, { mode: 0o700 })
  await symlink(outside, join(f.root, "admissions"))
  assert.equal((await inventoryAdmissions(f.root)).issues.length, 1)
  await assert.rejects(readAdmission(f.root, f.value.launchAttemptId))
})

test("publication failures preserve visible evidence and retries repeat all durability barriers", { timeout: 20000 }, async t => {
  const f = await fixture(t)
  await assert.rejects(writeAdmission(f.root, f.value, { open, rm, rename: async () => { throw new Error("rename failure") } }), /rename failure/)
  assert.equal(await readAdmission(f.root, f.value.launchAttemptId), null)
  await assert.rejects(writeAdmission(f.root, f.value, { rm, rename, open: async (path, flags, mode) => {
    if (path === join(f.root, "admissions") && flags === (constants.O_RDONLY | constants.O_DIRECTORY)) throw new Error("directory failure")
    return open(path, flags, mode)
  } }), /directory failure/)
  assert.deepEqual(await readAdmission(f.root, f.value.launchAttemptId), f.value)
  const synced: string[] = []
  await writeAdmission(f.root, f.value, { rename, rm, open: async (path, flags, mode) => {
    if (flags === (constants.O_RDONLY | constants.O_DIRECTORY)) synced.push(path)
    return open(path, flags, mode)
  } })
  assert.deepEqual(synced, [f.root, join(f.root, "admissions")])
  const other = await privateRoot(t)
  await assert.rejects(writeAdmission(other, f.value, { rename, rm, open: async (path, flags, mode) => {
    if (path === other) throw new Error("parent failure")
    return open(path, flags, mode)
  } }), /parent failure/)
  assert.equal(await readAdmission(other, f.value.launchAttemptId), null)
  await writeAdmission(other, f.value)
  assert.deepEqual(await readAdmission(other, f.value.launchAttemptId), f.value)
})