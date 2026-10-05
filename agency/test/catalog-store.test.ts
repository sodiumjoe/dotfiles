import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, link, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { createCatalogStore, type CatalogFileSystem } from "../src/catalog/store.js"
import { parseSnapshot, type CatalogSnapshot, type ProbeMeta, type RefreshCommand } from "../src/catalog/types.js"
import { privateRoot } from "./control-support.js"
import { createRetentionStore } from "../src/retention/store.js"

const hostId = "a".repeat(64), generation = randomUUID(), fingerprint = "b".repeat(64)
const snapshot = (): CatalogSnapshot => ({ version: 1, hostId, handlerGeneration: generation, snapshotId: randomUUID(), createdAt: 100, providers: [] })
const command = (): RefreshCommand => ({ version: 1, hostId, handlerGeneration: generation, commandId: randomUUID(), batchId: randomUUID(), fingerprints: [], attempts: [], state: "pending", snapshotId: null })
function meta(root: string, c: RefreshCommand): ProbeMeta {
  const attemptId = randomUUID()
  c.fingerprints.push({ providerId: "claude-agent-acp", fingerprint })
  c.attempts.push({ providerId: "claude-agent-acp", attemptId })
  return { version: 2, hostId, handlerGeneration: generation, commandId: c.commandId, providerId: "claude-agent-acp", attemptId, fingerprint, workPath: join(root, "catalog/work", attemptId) }
}
const launch = (m: ProbeMeta) => ({ version: 2, owner: { kind: "catalog-probe", providerId: m.providerId, commandId: m.commandId }, handlerGeneration: m.handlerGeneration, launchAttemptId: m.attemptId, launchBootId: "boot", launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null })

test("catalog inventory validates more than 4096 receipts without truncation", async t => {
  const root = await privateRoot(t), directory = join(root, "catalog", "commands")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const value of Array.from({ length: 4097 }, command)) await writeFile(join(directory, value.commandId + ".json"), JSON.stringify(value), { mode: 0o600 })
  const inventory = await createCatalogStore(root).inventory()
  assert.deepEqual(inventory.issues, [])
  assert.equal(inventory.commands.length, 4097)
})

test("two individually bounded provider payloads persist and retain their receipt snapshot", async t => {
  const root = await privateRoot(t), store = createCatalogStore(root), s = snapshot(), c = command()
  for (const providerId of ["claude-agent-acp", "codex-acp"] as const) s.providers.push({ providerId, fingerprint, verifiedAt: 100, verifiedHandlerGeneration: generation, providerVersion: null, providerVersionSource: "unknown", adapterVersion: "1", sdkVersion: null, error: null, models: Array.from({ length: 400 }, (_, i) => ({ providerId, modelId: String(i).padStart(3, "0"), resolvedModelId: null, displayName: "d".repeat(512), reasoning: { state: "values", values: ["a", "b", "c", "d"].map(v => v.repeat(200)) }, modes: { state: "unknown" }, availability: "advertised" })) })
  assert.ok(Buffer.byteLength(JSON.stringify(s)) > 1048576)
  for (const p of s.providers) assert.ok(Buffer.byteLength(JSON.stringify(p.models)) < 1048576)
  assert.deepEqual(parseSnapshot(s), s)
  await store.writeCommand(c, null)
  await store.writeSnapshot(s)
  await store.publishCurrent(s)
  await store.writeCommand({ ...c, state: "completed", snapshotId: s.snapshotId }, c)
  assert.deepEqual(await createCatalogStore(root).readCurrent(), s)
  assert.deepEqual((await store.inventory()).issues, [])
})

test("snapshots require explicit hash-bound publication and remain immutable", async t => {
  const root = await privateRoot(t), store = createCatalogStore(root), s = snapshot()
  assert.deepEqual(await store.inventory(), { launches: [], metadata: [], commands: [], issues: [] })
  assert.deepEqual(await readdir(root), [])
  await store.writeSnapshot(s)
  assert.equal(await store.readCurrent(), null)
  await store.publishCurrent(s)
  assert.deepEqual(await store.readCurrent(), s)
  await assert.rejects(store.writeSnapshot({ ...s, createdAt: 101 }), { code: "COMMAND_CONFLICT" })
  const path = join(root, "catalog/snapshots", s.snapshotId + ".json")
  await writeFile(path, JSON.stringify({ ...s, createdAt: 101 }))
  await assert.rejects(store.readCurrent(), { code: "INVALID_CATALOG" })
})

test("commands bind immutable requests, exact expected transitions and receipt snapshots", async t => {
  const root = await privateRoot(t), store = createCatalogStore(root), c = command(), s = snapshot()
  await store.writeCommand(c, null)
  await store.writeCommand(c, null)
  await assert.rejects(store.writeCommand({ ...c, batchId: randomUUID() }, c), { code: "COMMAND_CONFLICT" })
  await assert.rejects(store.writeCommand({ ...c, state: "completed", snapshotId: s.snapshotId }, c))
  await store.writeSnapshot(s)
  await store.publishCurrent(s)
  const done: RefreshCommand = { ...c, state: "completed", snapshotId: s.snapshotId }
  await store.writeCommand(done, c)
  await store.writeCommand(done, c)
  assert.deepEqual(await store.readCommand(c.commandId), done)
  await assert.rejects(store.writeCommand(c, done), { code: "COMMAND_CONFLICT" })
  const interrupted = command()
  await store.writeCommand(interrupted, null)
  await store.writeCommand({ ...interrupted, state: "interrupted" }, interrupted)
  await assert.rejects(store.writeCommand(interrupted, null), { code: "COMMAND_CONFLICT" })
})

test("publication failures retain exact evidence and retries repeat durable barriers", async t => {
  for (const stage of ["mkdir", "parent-sync", "file-sync", "rename", "after-rename", "directory-sync"]) await t.test(stage, async t => {
    const root = await privateRoot(t), s = snapshot()
    let fail = true, barriers = 0
    const fs: CatalogFileSystem = {
      mkdir: (async (...args: Parameters<typeof mkdir>) => { if (fail && stage === "mkdir") throw new Error(stage); return mkdir(...args) }) as typeof mkdir,
      rm,
      rename: async (...args) => { if (fail && stage === "rename") throw new Error(stage); await rename(...args); if (fail && stage === "after-rename") throw new Error(stage) },
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode)
        return new Proxy(handle, { get(target, key) {
          if (key === "sync") return async () => {
            barriers++
            if (fail && ((stage === "file-sync" && !(flags & constants.O_DIRECTORY)) || (stage === "parent-sync" && path === root) || (stage === "directory-sync" && path.endsWith("snapshots")))) throw new Error(stage)
            await target.sync()
          }
          const value = Reflect.get(target, key, target)
          return typeof value === "function" ? value.bind(target) : value
        } }) as FileHandle
      },
    }
    const store = createCatalogStore(root, fs)
    await assert.rejects(store.writeSnapshot(s))
    const visible = await store.readSnapshot(s.snapshotId)
    assert.deepEqual(visible, ["after-rename", "directory-sync"].includes(stage) ? s : null)
    fail = false
    const before = barriers
    await store.writeSnapshot(s)
    assert.ok(barriers - before >= 3)
    assert.deepEqual(await store.readSnapshot(s.snapshotId), s)
    const first = barriers
    await store.writeSnapshot(s)
    assert.ok(barriers - first >= 3)
  })
})

test("inventory binds probe attribution without entering checkout launches", async t => {
  const root = await privateRoot(t), store = createCatalogStore(root), c = command(), m = meta(root, c)
  await store.writeCommand(c, null)
  await store.writeProbeMeta(m)
  assert.ok((await store.inventory()).issues.length > 0)
  const directory = join(root, "catalog/probe-launches")
  await mkdir(directory, { mode: 0o700 })
  const path = join(directory, m.attemptId + ".json"), record = launch(m)
  await writeFile(path, JSON.stringify(record), { mode: 0o600 })
  assert.deepEqual((await store.inventory()).issues, [])
  assert.deepEqual((await store.inventory()).launches, [{ path, record }])
  assert.equal((await readdir(root)).includes("launches"), false)
  for (const change of [{ extra: true }, { handlerGeneration: randomUUID() }, { agentId: randomUUID() }, { checkoutId: "checkout" }]) {
    await writeFile(path, JSON.stringify({ ...record, ...change }))
    assert.ok((await store.inventory()).issues.length > 0)
  }
  await writeFile(path, JSON.stringify(record))
  await unlink(join(root, "catalog/probe-meta", m.attemptId + ".json"))
  assert.ok((await store.inventory()).issues.length > 0)
})

test("unsafe records and malformed UTF-8 fail closed while large remnant inventories remain valid", async t => {
  const root = await privateRoot(t), store = createCatalogStore(root), c = command()
  await store.writeCommand(c, null)
  const dir = join(root, "catalog/commands"), path = join(dir, c.commandId + ".json"), original = await readFile(path)
  for (const bytes of [Buffer.from([0xff]), Buffer.alloc(1048577, 32), Buffer.from(JSON.stringify({ ...c, extra: 1 })), Buffer.from(JSON.stringify({ ...c, commandId: randomUUID() }))]) {
    await writeFile(path, bytes)
    await assert.rejects(store.readCommand(c.commandId))
    assert.ok((await store.inventory()).issues.length > 0)
  }
  await writeFile(path, original)
  await chmod(path, 0o644)
  await assert.rejects(store.readCommand(c.commandId))
  await chmod(path, 0o600)
  await link(path, path + "-link")
  await assert.rejects(store.readCommand(c.commandId))
  await unlink(path + "-link")
  const remnant = join(dir, `.${randomUUID()}.json.${randomUUID()}.tmp`)
  await writeFile(remnant, "uncommitted", { mode: 0o600 })
  assert.deepEqual((await store.inventory()).issues, [])
  await chmod(dir, 0o755)
  assert.ok((await store.inventory()).issues.length > 0)
  await chmod(dir, 0o700)
  await Promise.all(Array.from({ length: 4096 }, (_, i) => writeFile(join(dir, `.${randomUUID()}.json.${randomUUID()}.tmp`), String(i), { mode: 0o600 })))
  assert.deepEqual((await store.inventory()).issues, [])
})

test("one probe metadata issue does not prevent an unrelated command write", async t => {
  const root = await privateRoot(t), store = createCatalogStore(root), first = command(), m = meta(root, first)
  await store.writeCommand(first, null)
  await store.writeProbeMeta(m)
  const launches = join(root, "catalog/probe-launches")
  await mkdir(launches, { mode: 0o700 })
  await writeFile(join(launches, m.attemptId + ".json"), JSON.stringify(launch(m)), { mode: 0o600 })
  assert.deepEqual((await store.inventory()).issues, [])
  await writeFile(join(root, "catalog/probe-meta", m.attemptId + ".json"), "{", { mode: 0o600 })
  const second = command()
  await store.writeCommand(second, null)
  assert.deepEqual(await store.readCommand(second.commandId), second)
  assert.deepEqual((await store.inventory()).issues, [`probe-meta/${m.attemptId}.json`, `probe-launches/${m.attemptId}.json`])
})

test("historical probe identities remain unique while new metadata writes require version two", async t => {
  const root = await privateRoot(t), store = createCatalogStore(root), first = command(), second = command(), a = meta(root, first), b = meta(root, second)
  const agentId = randomUUID(), leaseId = randomUUID()
  await store.writeCommand(first, null); await store.writeCommand(second, null)
  await mkdir(join(root, "catalog/probe-meta"), { mode: 0o700 })
  await mkdir(join(root, "catalog/probe-launches"), { mode: 0o700 })
  for (const m of [a, b]) {
    const legacy = { ...m, version: 1, agentId, leaseId }
    await assert.rejects(store.writeProbeMeta(legacy as unknown as ProbeMeta), { code: "INVALID_CATALOG" })
    await writeFile(join(root, "catalog/probe-meta", m.attemptId + ".json"), JSON.stringify(legacy), { mode: 0o600 })
    await writeFile(join(root, "catalog/probe-launches", m.attemptId + ".json"), JSON.stringify({ version: 1, checkoutId: `catalog-v1:${m.providerId}:${m.fingerprint}`, agentId, leaseId, handlerGeneration: m.handlerGeneration, launchAttemptId: m.attemptId, launchBootId: "boot", launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null }), { mode: 0o600 })
  }
  assert.equal((await store.inventory()).issues.filter(issue => issue === `probe-meta/${a.attemptId}.json` || issue === `probe-meta/${b.attemptId}.json`).length, 1)
})

test("accepted command disappearance cannot be silently replaced by a later write", async t => {
  const root = await privateRoot(t), store = createCatalogStore(root), c = command()
  await store.writeCommand(c, null)
  await unlink(join(root, "catalog/commands", c.commandId + ".json"))
  await assert.rejects(store.writeCommand({ ...c, state: "interrupted" }, c))
  assert.equal(await store.readCommand(c.commandId), null)
})

test("inventories reject cross-record host, generation, and reused probe identities", async t => {
  const root = await privateRoot(t), store = createCatalogStore(root), c = command(), m = meta(root, c)
  await store.writeCommand(c, null)
  await store.writeProbeMeta(m)
  const dir = join(root, "catalog/probe-launches")
  await mkdir(dir, { mode: 0o700 })
  await writeFile(join(dir, m.attemptId + ".json"), JSON.stringify(launch(m)), { mode: 0o600 })
  const path = join(root, "catalog/probe-meta", m.attemptId + ".json")
  for (const change of [{ hostId: "c".repeat(64) }, { handlerGeneration: randomUUID() }, { workPath: root }]) {
    await writeFile(path, JSON.stringify({ ...m, ...change }))
    assert.ok((await store.inventory()).issues.length > 0)
  }
  await writeFile(path, JSON.stringify(m))
  const other = command(), otherMeta = meta(root, other)
  await createCatalogStore(root).writeCommand(other, null)
  await createCatalogStore(root).writeProbeMeta(otherMeta)
  await writeFile(join(dir, otherMeta.attemptId + ".json"), JSON.stringify({ ...launch(otherMeta), owner: { kind: "catalog-probe", providerId: otherMeta.providerId, commandId: m.commandId } }), { mode: 0o600 })
  assert.ok((await store.inventory()).issues.length > 0)
})

test("a completed pointer does not complete a command after its durability failure", async t => {
  const root = await privateRoot(t), c = command(), s = snapshot()
  let fail = false
  const store = createCatalogStore(root, { open, mkdir, rm, rename: async (from, to) => {
    if (fail && String(to).endsWith(c.commandId + ".json")) throw new Error("command publication")
    await rename(from, to)
  } })
  await store.writeCommand(c, null)
  await store.writeSnapshot(s)
  await store.publishCurrent(s)
  fail = true
  const completed: RefreshCommand = { ...c, state: "completed", snapshotId: s.snapshotId }
  await assert.rejects(store.writeCommand(completed, c))
  assert.deepEqual(await store.readCurrent(), s)
  assert.equal((await store.readCommand(c.commandId))!.state, "pending")
  fail = false
  await store.writeCommand(completed, c)
  assert.equal((await store.readCommand(c.commandId))!.state, "completed")
})

test("current-pointer temporary files must be private regular single-link entries", async t => {
  const root = await privateRoot(t), store = createCatalogStore(root)
  await store.writeSnapshot(snapshot())
  const path = join(root, "catalog", `.current.json.${randomUUID()}.tmp`)
  await writeFile(path, "retained", { mode: 0o600 })
  assert.deepEqual((await store.inventory()).issues, [])
  await chmod(path, 0o644)
  assert.ok((await store.inventory()).issues.length > 0)
})

test("authorized snapshot retirement preserves detection of unrelated external disappearance", async t => {
  const root = await privateRoot(t), retention = createRetentionStore(root, hostId, generation)
  const store = createCatalogStore(root, undefined, retention.view), a = snapshot(), b = snapshot()
  await store.writeSnapshot(a); await store.writeSnapshot(b)
  assert.deepEqual((await store.inventory()).issues, [])
  const path = "catalog/snapshots/" + a.snapshotId + ".json"
  await retention.prepare({ paths: [path], launches: [], handlers: [] })
  assert.deepEqual((await store.inventory()).issues, [])
  await retention.resume({ authorize: async () => undefined, removed: entry => store.forgetRemoved(entry) })
  assert.deepEqual((await store.inventory()).issues, [])
  await unlink(join(root, "catalog/snapshots", b.snapshotId + ".json"))
  assert.ok((await store.inventory()).issues.length > 0)
})