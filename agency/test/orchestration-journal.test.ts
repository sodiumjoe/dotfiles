import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { readdir, readFile, writeFile, rename, rm, mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { coreFixture } from "./orchestration-support.js"

const week = 7 * 24 * 60 * 60 * 1000

test("journal exact retries survive restart and reject changed content", async t => {
  const f = await coreFixture(t)
  const first = await f.journal.append(f.input.eventId, "report", f.input.report)
  f.restart()
  assert.deepEqual(await f.journal.append(f.input.eventId, "report", { git: null, validation: [], issues: [], summary: f.input.report.summary, status: "completed" }), first)
  await assert.rejects(f.journal.append(f.input.eventId, "report", { ...f.input.report, status: "failed" }), /CONFLICT/)
  assert.equal((await f.journal.read(0, 256)).lastSeq, 1)
})

test("out-of-order acknowledgment cannot reclaim an earlier hole", async t => {
  const f = await coreFixture(t)
  const a = await f.journal.append(randomUUID(), "report", f.input.report)
  const b = await f.journal.append(randomUUID(), "report", f.input.report)
  await f.journal.acknowledge("bureau", b)
  f.clock.advance(week + 1); f.restart()
  await f.journal.compact(f.clock.now())
  assert.equal(await f.journal.watermark("bureau"), 0)
  assert.deepEqual((await f.journal.read(0, 256)).entries, [a, b])
  await f.journal.acknowledge("bureau", a)
  assert.equal(await f.journal.watermark("bureau"), 2)
  await f.journal.compact(f.clock.now()); f.restart()
  await assert.rejects(f.journal.read(0, 256), error => error instanceof Error && error.message.includes("CURSOR_EXPIRED"))
  assert.equal((await f.journal.read(2, 256)).checkpoint, 2)
  assert.deepEqual(await f.journal.append(a.eventId, a.kind, a.payload), a)
  await assert.rejects(f.journal.append(a.eventId, "report", { ...f.input.report, summary: "different" }), /CONFLICT/)
})

test("acknowledgment requires exact event, cursor and digest", async t => {
  const f = await coreFixture(t), a = await f.journal.append(randomUUID(), "report", f.input.report)
  for (const bad of [{ ...a, digest: "0".repeat(64) }, { ...a, seq: 2 }, { ...a, eventId: randomUUID() }]) await assert.rejects(f.journal.acknowledge("bureau", bad))
  assert.equal(await f.journal.watermark("bureau"), 0)
})

test("journal rejects unknown kinds, extra fields and bounded report violations", async t => {
  const f = await coreFixture(t)
  await assert.rejects(f.journal.append(randomUUID(), "unknown", {}))
  for (const report of [
    { ...f.input.report, token: "secret" },
    { ...f.input.report, summary: "x".repeat(65537) },
    { ...f.input.report, summary: "\ud800" },
    { ...f.input.report, issues: Array(129).fill("issue") },
    { ...f.input.report, validation: [{ argv: Array(129).fill("x"), cwd: f.root, exitCode: 0, result: "" }] },
    { ...f.input.report, validation: [{ argv: ["x".repeat(4097)], cwd: f.root, exitCode: 0, result: "" }] },
    { ...f.input.report, validation: Array(128).fill({ argv: ["true"], cwd: f.root, exitCode: 0, result: "x".repeat(65536) }) }
  ]) await assert.rejects(f.journal.append(randomUUID(), "report", report))
  assert.equal((await f.journal.read(0, 256)).lastSeq, 0)
  await assert.rejects(f.journal.read(0, 257))
})

for (const operation of ["write", "file-sync", "rename", "directory-sync"]) {
  for (const after of [false, true]) test(`journal ${operation} failure ${after ? "after" : "before"} publication cannot acknowledge missing work`, async t => {
    const f = await coreFixture(t)
    await f.journal.read(0, 256)
    const prior = await f.journal.append(randomUUID(), "report", f.input.report)
    f.failAt(operation, operation === "directory-sync" ? "journal/entries" : ".tmp", after)
    if (operation === "rename") f.failAt(operation, "journal/entries", after)
    await assert.rejects(f.journal.append(f.input.eventId, "report", f.input.report), /ENOSPC/)
    f.restart()
    const page = await f.journal.read(0, 256)
    assert.deepEqual(page.entries[0], prior)
    assert.ok(page.entries.length === 1 || page.entries.length === 2)
    const retry = await f.journal.append(f.input.eventId, "report", f.input.report)
    assert.equal(retry.seq, 2)
    assert.equal((await f.journal.read(0, 256)).entries.length, 2)
  })
}

for (const boundary of ["summary", "checkpoint", "prefix"]) {
  for (const after of [false, true]) test(`compaction interruption ${boundary} ${after ? "after" : "before"} preserves replay or publishes expiry`, async t => {
    const f = await coreFixture(t), first = await f.journal.append(f.input.eventId, "report", f.input.report)
    await f.journal.acknowledge("bureau", first); f.clock.advance(week + 1)
    if (boundary === "summary") f.failAt("rename", "journal/summaries", after)
    if (boundary === "checkpoint") f.failAt("rename", "checkpoint.json", after)
    if (boundary === "prefix") f.failAt("remove", "journal/entries", after)
    await assert.rejects(f.journal.compact(f.clock.now()), /ENOSPC/)
    f.restart()
    try { assert.deepEqual((await f.journal.read(0, 256)).entries, [first]) }
    catch (error) { assert.match(String(error), /CURSOR_EXPIRED/) }
    await f.journal.compact(f.clock.now())
    assert.equal((await f.journal.read(1, 256)).checkpoint, 1)
    assert.deepEqual(await f.journal.append(first.eventId, "report", f.input.report), first)
  })
}

test("uncertain checkpoint directory fsync never authorizes prefix deletion in that call", async t => {
  const f = await coreFixture(t), first = await f.journal.append(randomUUID(), "report", f.input.report)
  await f.journal.acknowledge("bureau", first); f.clock.advance(week + 1)
  f.failAt("checkpoint-sync", "journal", false)
  await assert.rejects(f.journal.compact(f.clock.now()), /ENOSPC/)
  assert.equal((await readdir(join(f.root, "orchestration", "journal", "entries"))).filter(name => name.endsWith(".json")).length, 1)
})

test("missing unexpired sequence and changed immutable record are corruption", async t => {
  const f = await coreFixture(t)
  await f.journal.append(randomUUID(), "report", f.input.report)
  await f.journal.append(randomUUID(), "report", f.input.report)
  const directory = join(f.root, "orchestration", "journal", "entries")
  const names = (await readdir(directory)).filter(name => name.endsWith(".json")).sort()
  await rm(join(directory, names[0]!)); f.restart()
  await assert.rejects(f.journal.read(0, 256), /CORRUPT|INVALID/)
})

for (const data of [Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1)]) test(`unsafe retained bytes ${data.length} fail closed`, async t => {
  const f = await coreFixture(t)
  await f.journal.append(randomUUID(), "report", f.input.report)
  const directory = join(f.root, "orchestration", "journal", "entries"), name = (await readdir(directory)).find(name => name.endsWith(".json"))!
  await writeFile(join(directory, name), data, { mode: 0o600 }); f.restart()
  await assert.rejects(f.journal.read(0, 256))
})

test("same-byte file replacement is rejected by a live journal", async t => {
  const f = await coreFixture(t)
  await f.journal.append(randomUUID(), "report", f.input.report)
  const directory = join(f.root, "orchestration", "journal", "entries"), name = (await readdir(directory)).find(name => name.endsWith(".json"))!, path = join(directory, name)
  await writeFile(path + ".replacement", await readFile(path), { mode: 0o600 }); await rename(path + ".replacement", path)
  await assert.rejects(f.journal.read(0, 256), /REPLACED|CHANGED/)
})

test("private directory replacement and symlink substitution fail closed", async t => {
  const f = await coreFixture(t)
  await f.journal.append(randomUUID(), "report", f.input.report)
  const path = join(f.root, "orchestration", "journal", "entries")
  await rename(path, path + "-old"); await mkdir(path, { mode: 0o700 })
  await assert.rejects(f.journal.read(0, 256), /REPLACED|CHANGED/)
})

test("compaction requires every registered recipient to acknowledge the contiguous prefix", async t => {
  const f = await coreFixture(t), a = await f.journal.append(randomUUID(), "report", f.input.report), b = await f.journal.append(randomUUID(), "report", f.input.report)
  await f.journal.acknowledge("bureau", a); await f.journal.acknowledge("bureau", b)
  await f.journal.acknowledge("parent", b)
  f.clock.advance(week + 1); await f.journal.compact(f.clock.now())
  assert.equal((await f.journal.read(0, 256)).checkpoint, 0)
  await f.journal.acknowledge("parent", a); await f.journal.compact(f.clock.now())
  assert.equal((await f.journal.read(2, 256)).checkpoint, 2)
})

test("lost last record remains detectable after recovering an interrupted publication", async t => {
  const f = await coreFixture(t)
  f.failAt("rename", "journal/entries", true)
  await assert.rejects(f.journal.append(f.input.eventId, "report", f.input.report))
  f.restart()
  const event = await f.journal.append(f.input.eventId, "report", f.input.report)
  await f.journal.acknowledge("bureau", event)
  const directory = join(f.root, "orchestration", "journal", "entries")
  const name = (await readdir(directory)).find(name => name.endsWith(".json"))!
  await rm(join(directory, name)); f.restart()
  await assert.rejects(f.journal.read(0, 256), /CORRUPT/)
})

test("unsafe unpublished temporary symlinks cannot be silently ignored", async t => {
  const f = await coreFixture(t)
  await f.journal.append(randomUUID(), "report", f.input.report)
  const directory = join(f.root, "orchestration", "journal", "entries")
  await symlink("/etc/passwd", join(directory, `.0000000000000002.json.${randomUUID()}.tmp`))
  await assert.rejects(f.journal.read(0, 256))
})

for (const boundary of ["write", "file-sync", "rename", "directory-sync"]) test(`abrupt process death at ${boundary} leaves only complete published entries`, async t => {
  const f = await coreFixture(t), prior = await f.journal.append(randomUUID(), "report", f.input.report)
  const module = new URL("../src/orchestration/journal.js", import.meta.url).href
  const source = `
    import { createJournal } from ${JSON.stringify(module)}
    import { open, mkdir, rename, rm } from "node:fs/promises"
    import { constants } from "node:fs"
    const [root, eventId, report, boundary] = process.argv.slice(1)
    const die = (stage, path) => { if (stage === boundary && path.includes("journal/entries")) process.exit(77) }
    const fs = {
      mkdir, rm,
      async rename(from, to) { await rename(from, to); die("rename", to) },
      async open(path, flags, mode) {
        const handle = await open(path, flags, mode)
        return new Proxy(handle, { get(target, key) {
          if (key === "writeFile" || key === "sync") return async (...args) => {
            await target[key](...args)
            die(key === "writeFile" ? "write" : flags & constants.O_DIRECTORY ? "directory-sync" : "file-sync", path)
          }
          const value = target[key]
          return typeof value === "function" ? value.bind(target) : value
        } })
      }
    }
    await createJournal(root, fs).append(eventId, "report", JSON.parse(report))
  `
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, f.root, f.input.eventId, JSON.stringify(f.input.report), boundary], { timeout: 10000, encoding: "utf8" })
  assert.equal(child.status, 77, child.stderr)
  f.restart()
  const page = await f.journal.read(0, 256)
  assert.deepEqual(page.entries[0], prior)
  assert.ok(page.entries.length === 1 || page.entries.length === 2)
  const receipt = await f.journal.append(f.input.eventId, "report", f.input.report)
  assert.equal(receipt.seq, 2)
  assert.equal((await f.journal.read(0, 256)).entries.length, 2)
})

for (const boundary of ["summary", "checkpoint", "prefix"]) test(`abrupt compaction death after ${boundary} retains exact retry and resumes authorized cleanup`, async t => {
  const f = await coreFixture(t), first = await f.journal.append(f.input.eventId, "report", f.input.report)
  await f.journal.acknowledge("bureau", first); f.clock.advance(week + 1)
  const module = new URL("../src/orchestration/journal.js", import.meta.url).href
  const source = `
    import { createJournal } from ${JSON.stringify(module)}
    import { open, mkdir, rename, rm } from "node:fs/promises"
    const [root, time, boundary] = process.argv.slice(1)
    const fs = {
      open, mkdir,
      async rename(from, to) {
        await rename(from, to)
        if (boundary === "summary" && to.includes("journal/summaries") || boundary === "checkpoint" && to.endsWith("checkpoint.json")) process.exit(77)
      },
      async rm(path, options) { await rm(path, options); if (boundary === "prefix" && path.includes("journal/entries")) process.exit(77) }
    }
    await createJournal(root, fs).compact(Number(time))
  `
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, f.root, String(f.clock.now()), boundary], { timeout: 10000, encoding: "utf8" })
  assert.equal(child.status, 77, child.stderr)
  f.restart()
  await f.journal.compact(f.clock.now())
  assert.equal((await f.journal.read(1, 256)).checkpoint, 1)
  assert.deepEqual(await f.journal.append(first.eventId, "report", f.input.report), first)
})