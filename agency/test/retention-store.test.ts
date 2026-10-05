import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, link, lstat, mkdir, open, readFile, rename, rmdir, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { createRetentionStore, type RetentionFileSystem } from "../src/retention/store.js"
import { privateRoot } from "./control-support.js"

const host = "a".repeat(64)
async function fixture(t: Parameters<typeof privateRoot>[0]) {
  const root = await privateRoot(t), attempt = randomUUID(), snapshot = "catalog/snapshots/" + randomUUID() + ".json", work = "catalog/work/" + attempt
  await mkdir(join(root, "catalog/snapshots"), { recursive: true, mode: 0o700 })
  await mkdir(join(root, work, "child"), { recursive: true, mode: 0o700 })
  await writeFile(join(root, work, "child/data"), "work", { mode: 0o600 })
  await writeFile(join(root, snapshot), "{}", { mode: 0o600 })
  return { root, snapshot, work, paths: [snapshot, work] }
}

test("an unlink followed by failure resumes from the durable intent", async t => {
  const f = await fixture(t)
  let fail = true
  const store = createRetentionStore(f.root, host, randomUUID(), { open, rename, rmdir, async unlink(path) {
    await unlink(path)
    if (fail && path === join(f.root, f.snapshot)) throw new Error("after unlink")
  } })
  await store.prepare({ paths: f.paths, launches: [], handlers: [] })
  const removed: string[] = []
  await assert.rejects(store.resume({ authorize: async () => undefined, removed: entry => { removed.push(entry.path) } }))
  assert.ok(removed.includes(f.snapshot))
  assert.notEqual(await store.pending(), null)
  fail = false
  const reopened = createRetentionStore(f.root, host, randomUUID())
  await reopened.resume({ authorize: async () => undefined, removed: () => undefined })
  assert.equal(await reopened.pending(), null)
  await assert.rejects(lstat(join(f.root, f.snapshot)), { code: "ENOENT" })
  await assert.rejects(lstat(join(f.root, f.work)), { code: "ENOENT" })
})

test("every publication, removal and sync boundary is restartable", async t => {
  for (const stage of ["file-sync", "rename", "after-rename", "intent-sync", "work", "work-sync", "rmdir", "receipt", "receipt-sync", "intent-unlink", "intent-removed-sync"]) await t.test(stage, async t => {
    const f = await fixture(t)
    let fail = true, markerRemoved = false, attempted = false
    const fault = (name: string) => { if (fail && name === stage) { attempted = true; throw new Error(stage) } }
    const fs: RetentionFileSystem = {
      open: (async (...args: Parameters<typeof open>) => {
        const h = await open(...args)
        return new Proxy(h, { get(target, key) {
          if (key === "sync") return async () => {
            const path = String(args[0]), flags = Number(args[1])
            if (!(flags & constants.O_DIRECTORY)) fault("file-sync")
            if (path === join(f.root, "retention")) fault(markerRemoved ? "intent-removed-sync" : "intent-sync")
            if (path.endsWith("child")) fault("work-sync")
            if (path.endsWith("snapshots")) fault("receipt-sync")
            await target.sync()
          }
          const value = Reflect.get(target, key, target)
          return typeof value === "function" ? value.bind(target) : value
        } }) as FileHandle
      }) as typeof open,
      async rename(from, to) { fault("rename"); await rename(from, to); fault("after-rename") },
      async unlink(path) { fault(String(path).endsWith("pending.json") ? "intent-unlink" : String(path).includes("/work/") ? "work" : "receipt"); await unlink(path); if (String(path).endsWith("pending.json")) markerRemoved = true },
      async rmdir(path) { fault("rmdir"); await rmdir(path) },
    }
    const store = createRetentionStore(f.root, host, randomUUID(), fs)
    try { await store.prepare({ paths: f.paths, launches: [], handlers: [] }); await store.resume({ authorize: async () => undefined, removed: () => undefined }) }
    catch { assert.ok(attempted) }
    assert.ok(attempted)
    if (["file-sync", "rename", "after-rename", "intent-sync"].includes(stage)) assert.equal(await readFile(join(f.root, f.snapshot), "utf8"), "{}")
    fail = false
    const reopened = createRetentionStore(f.root, host, randomUUID())
    if (!await reopened.pending()) {
      if (!markerRemoved) await reopened.prepare({ paths: f.paths, launches: [], handlers: [] })
    }
    await reopened.resume({ authorize: async () => undefined, removed: () => undefined })
    assert.equal(await reopened.pending(), null)
    await assert.rejects(lstat(join(f.root, f.snapshot)), { code: "ENOENT" })
  })
})

test("changed targets never acquire a retirement overlay or deletion authorization", async t => {
  for (const change of ["bytes", "inode", "symlink", "ancestor", "hardlink", "mode", "child"]) await t.test(change, async t => {
    const f = await fixture(t), store = createRetentionStore(f.root, host, randomUUID()), sentinel = join(f.root, "sentinel")
    await writeFile(sentinel, "outside", { mode: 0o600 })
    await store.prepare({ paths: f.paths, launches: [], handlers: [] })
    const path = join(f.root, f.snapshot)
    if (change === "bytes") await writeFile(path, "changed")
    if (change === "inode") { await rename(path, path + ".old"); await writeFile(path, "{}", { mode: 0o600 }) }
    if (change === "symlink") { await unlink(path); await symlink(sentinel, path) }
    if (change === "ancestor") { await rename(join(f.root, "catalog/snapshots"), join(f.root, "saved")); await symlink(join(f.root, "saved"), join(f.root, "catalog/snapshots")) }
    if (change === "hardlink") await link(path, path + ".link")
    if (change === "mode") await chmod(path, 0o644)
    if (change === "child") await writeFile(join(f.root, f.work, "unknown"), "unknown", { mode: 0o600 })
    await assert.rejects(store.view.validate())
    assert.equal(store.view.hides(f.snapshot), false)
    await assert.rejects(store.resume({ authorize: async () => undefined, removed: () => undefined }))
    assert.equal(await readFile(sentinel, "utf8"), "outside")
  })
})

test("authorization is rechecked before clearing the intent", async t => {
  const f = await fixture(t), store = createRetentionStore(f.root, host, randomUUID())
  await store.prepare({ paths: f.paths, launches: [], handlers: [] })
  let calls = 0
  await assert.rejects(store.resume({ authorize: async () => { if (++calls === 2) throw new Error("new surviving reference") }, removed: () => undefined }))
  assert.equal(calls, 2)
  assert.notEqual(await store.pending(), null)
})

test("changed identity witnesses and refused authorization retain all targets", async t => {
  for (const field of ["uid", "dev", "mode"] as const) await t.test(field, async t => {
    const f = await fixture(t), store = createRetentionStore(f.root, host, randomUUID())
    await store.prepare({ paths: f.paths, launches: [], handlers: [] })
    const marker = join(f.root, "retention/pending.json"), intent = JSON.parse(await readFile(marker, "utf8"))
    intent.entries[0][field] = field === "dev" ? "999999" : field === "uid" ? process.getuid!() + 1 : 0o100644
    await writeFile(marker, JSON.stringify(intent))
    await assert.rejects(createRetentionStore(f.root, host, randomUUID()).view.validate())
    assert.equal(await readFile(join(f.root, f.snapshot), "utf8"), "{}")
  })
  const f = await fixture(t), store = createRetentionStore(f.root, host, randomUUID())
  await store.prepare({ paths: f.paths, launches: [], handlers: [] })
  await assert.rejects(store.resume({ authorize: async () => { throw new Error("surviving reference") }, removed: () => assert.fail("unauthorized removal") }))
  assert.equal(await readFile(join(f.root, f.snapshot), "utf8"), "{}")
})

test("an oversized work group is retained without publishing a partial intent", async t => {
  const f = await fixture(t), store = createRetentionStore(f.root, host, randomUUID())
  for (let n = 0; n < 4000; n++) await writeFile(join(f.root, f.work, "data-" + n), "data", { mode: 0o600 })
  await assert.rejects(store.prepare({ paths: f.paths, launches: [], handlers: [] }), /1 MiB/)
  assert.equal(await store.pending(), null)
  assert.equal(await readFile(join(f.root, f.work, "data-3999"), "utf8"), "data")
})

test("unsafe paths and malformed or oversized intents fail closed", async t => {
  const f = await fixture(t)
  for (const path of ["/tmp/outside", "catalog/../sentinel", "catalog//snapshots/a", "agents/provider-state/data", "catalog/work/not-uuid/file", "catalog\\snapshots\\data", "shutdown/invalid.json"]) {
    await assert.rejects(createRetentionStore(f.root, host, randomUUID()).prepare({ paths: [path], launches: [], handlers: [] }))
  }
  const store = createRetentionStore(f.root, host, randomUUID())
  await store.prepare({ paths: f.paths, launches: [], handlers: [] })
  const marker = join(f.root, "retention/pending.json"), original = JSON.parse(await readFile(marker, "utf8"))
  for (const value of [{ ...original, version: 2 }, { ...original, extra: true }, { ...original, hostId: "b".repeat(64) }, { ...original, entries: [original.entries[0], original.entries[0]] }]) {
    await writeFile(marker, JSON.stringify(value))
    await assert.rejects(createRetentionStore(f.root, host, randomUUID()).view.validate())
  }
  await writeFile(marker, " ".repeat(1048577))
  await assert.rejects(store.pending())
})