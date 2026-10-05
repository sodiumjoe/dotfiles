import { randomUUID } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { decodeJson, digest, readBoundedFile } from "../catalog/config.js"
import { hash, id, keys, object } from "../catalog/types.js"
import type { InventoryEntry } from "../handler/inventory.js"
import { assertPrivateDirectory, parseLaunchRecord } from "../platform/private-state.js"
import { processBirthStart, type ProcessIdentity } from "../platform/types.js"
import { parseAgencyLaunchMarker } from "../platform/launch-marker.js"

export type RemovalEvidence = { path: string; kind: "file" | "directory"; dev: string; ino: string; uid: number; mode: number; size: number | null; mtimeNs: string | null; ctimeNs: string | null; sha256: string | null }
export type CleanupIntent = { version: 1; hostId: string; handlerGeneration: string; intentId: string; entries: readonly RemovalEvidence[]; launches: readonly InventoryEntry[]; handlers: readonly ProcessIdentity[] }
export type RetirementView = { validate(): Promise<void>; hides(path: string): boolean }
export type RetentionFileSystem = { open: typeof open; rename: typeof rename; unlink: typeof unlink; rmdir: typeof rmdir }
export type RetentionStore = {
  view: RetirementView
  pending(): Promise<CleanupIntent | null>
  prepare(input: { paths: readonly string[]; launches: CleanupIntent["launches"]; handlers: CleanupIntent["handlers"] }): Promise<CleanupIntent>
  resume(input: { authorize(intent: CleanupIntent): Promise<void>; removed(entry: RemovalEvidence): void }): Promise<void>
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const invalid = (): never => { throw new Error("unsafe or changed retention evidence") }
const integer = (v: unknown): number => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) invalid(); return v as number }
const decimal = (v: unknown): string => { if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v)) invalid(); return v as string }

export function retentionPath(input: unknown): string {
  if (typeof input !== "string" || input.length > 4096 || /[\x00-\x1f\x7f\\]/.test(input)) invalid()
  const path = input as string, parts = path.split("/")
  if (parts.some(p => !p || p === "." || p === "..")) invalid()
  if (parts[0] === "catalog" && parts[1] === "work") { if (parts.length < 3) invalid(); id(parts[2]); return path }
  const parent = parts.slice(0, -1).join("/")
  if (!["catalog/automatic", "catalog/commands", "catalog/snapshots", "catalog/probe-meta", "catalog/probe-launches", "agents/commands", "agents/records", "launches", "shutdown"].includes(parent)) invalid()
  if (!parts.at(-1)!.endsWith(".json")) invalid()
  id(parts.at(-1)!.slice(0, -5))
  return path
}

function processIdentity(input: unknown): ProcessIdentity {
  const v = object(input)
  keys(v, ["bootId", "pid", "birth", "parentPid", "processGroupId", "sessionId", "uid", "gid"])
  if (typeof v.bootId !== "string" || !v.bootId || typeof v.birth !== "string" || processBirthStart(v.birth) === null) invalid()
  const result = { bootId: v.bootId as string, birth: v.birth as string, pid: integer(v.pid), parentPid: integer(v.parentPid), processGroupId: integer(v.processGroupId), sessionId: integer(v.sessionId), uid: integer(v.uid), gid: integer(v.gid) }
  if (result.pid < 2 || result.pid !== result.processGroupId || result.pid !== result.sessionId || result.uid !== process.getuid!() || result.gid !== process.getgid!() || parseAgencyLaunchMarker(result.birth.slice(result.birth.indexOf(":") + 1))?.role !== "handler") invalid()
  return result
}

function parseIntent(input: unknown, hostId: string): CleanupIntent {
  const v = object(input)
  keys(v, ["version", "hostId", "handlerGeneration", "intentId", "entries", "launches", "handlers"])
  if (v.version !== 1 || hash(v.hostId) !== hostId || !Array.isArray(v.entries) || !v.entries.length || !Array.isArray(v.launches) || !Array.isArray(v.handlers)) invalid()
  const entries = (v.entries as unknown[]).map(input => {
    const e = object(input)
    keys(e, ["path", "kind", "dev", "ino", "uid", "mode", "size", "mtimeNs", "ctimeNs", "sha256"])
    if (e.kind !== "file" && e.kind !== "directory") invalid()
    const base = { path: retentionPath(e.path), kind: e.kind as "file" | "directory", dev: decimal(e.dev), ino: decimal(e.ino), uid: integer(e.uid), mode: integer(e.mode) }
    if (base.uid !== process.getuid!() || (base.mode & 0o077) !== 0) invalid()
    if (base.kind === "directory") {
      if (!base.path.startsWith("catalog/work/") || [e.size, e.mtimeNs, e.ctimeNs, e.sha256].some(v => v !== null)) invalid()
      return { ...base, size: null, mtimeNs: null, ctimeNs: null, sha256: null }
    }
    return { ...base, size: integer(e.size), mtimeNs: decimal(e.mtimeNs), ctimeNs: decimal(e.ctimeNs), sha256: hash(e.sha256) }
  })
  const indexed = new Map(entries.map(e => [e.path, e]))
  if (indexed.size !== entries.length) invalid()
  for (const e of entries) if (e.path.startsWith("catalog/work/")) {
    const attempt = e.path.split("/").slice(0, 3).join("/")
    if (indexed.get(attempt)?.kind !== "directory") invalid()
  }
  const launches = (v.launches as unknown[]).map(input => {
    const entry = object(input); keys(entry, ["path", "record"])
    const path = retentionPath(entry.path), record = parseLaunchRecord(entry.record, false)
    if (!isDeepStrictEqual(record, entry.record) || indexed.get(path)?.kind !== "file" || !["launches", "catalog/probe-launches"].includes(dirname(path)) || path !== dirname(path) + "/" + record.launchAttemptId + ".json") invalid()
    return { path, record }
  })
  if (new Set(launches.map(e => e.path)).size !== launches.length) invalid()
  return { version: 1, hostId, handlerGeneration: id(v.handlerGeneration), intentId: id(v.intentId), entries, launches, handlers: (v.handlers as unknown[]).map(processIdentity) }
}

export function createRetentionStore(root: string, hostId: string, handlerGeneration: string, filesystem: RetentionFileSystem = { open, rename, unlink, rmdir }): RetentionStore {
  hash(hostId); id(handlerGeneration)
  const directory = join(root, "retention"), marker = join(directory, "pending.json")
  let active: CleanupIntent | null = null, markerBytes: Buffer | null = null, valid = false, durable = false, clearing = false
  const hidden = new Set<string>()
  async function ancestors(path: string): Promise<void> {
    await assertPrivateDirectory(root)
    const rootStat = await lstat(root, { bigint: true })
    const parts = relative(root, path).split("/")
    if (parts.some(p => !p || p === ".." || p === ".")) invalid()
    for (let n = 1; n <= parts.length; n++) {
      const p = join(root, ...parts.slice(0, n)), before = await lstat(p, { bigint: true })
      if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== rootStat.dev || before.uid !== rootStat.uid || (before.mode & 0o077n) !== 0n) invalid()
      const handle = await filesystem.open(p, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { const observed = await handle.stat({ bigint: true }); if (observed.dev !== before.dev || observed.ino !== before.ino || !isDeepStrictEqual(before, await lstat(p, { bigint: true }))) invalid() }
      finally { await handle.close() }
    }
  }
  async function sync(path: string): Promise<void> {
    if (path === root) await assertPrivateDirectory(root); else await ancestors(path)
    const h = await filesystem.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await h.sync() } finally { await h.close() }
  }
  async function capture(path: string): Promise<RemovalEvidence> {
    retentionPath(path)
    await ancestors(dirname(join(root, path)))
    const full = join(root, path), before = await lstat(full, { bigint: true }), rootStat = await lstat(root, { bigint: true })
    if (before.dev !== rootStat.dev || before.uid !== rootStat.uid || (before.mode & 0o077n) !== 0n || before.isSymbolicLink()) invalid()
    const base = { path, dev: String(before.dev), ino: String(before.ino), uid: Number(before.uid), mode: Number(before.mode) }
    if (before.isDirectory()) {
      await ancestors(full)
      return { ...base, kind: "directory", size: null, mtimeNs: null, ctimeNs: null, sha256: null }
    }
    if (!before.isFile() || before.nlink !== 1n) invalid()
    const bytes = await readBoundedFile(full, 2 * 1048576 + 8192, true)
    const identity = (s: BigIntStats) => [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String)
    if (!bytes || !isDeepStrictEqual(identity(before), identity(await lstat(full, { bigint: true })))) return invalid()
    return { ...base, kind: "file", size: Number(before.size), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs), sha256: digest(bytes) }
  }
  async function pending(): Promise<CleanupIntent | null> {
    await assertPrivateDirectory(root)
    try { await ancestors(directory) } catch (error) { if (absent(error) && active === null) return null; throw error }
    const bytes = await readBoundedFile(marker, 1048576, true)
    if (bytes === null) { if (active !== null) { if (!clearing) return invalid(); return active }; valid = false; hidden.clear(); return null }
    const intent = parseIntent(decodeJson(bytes), hostId)
    if (markerBytes !== null && !markerBytes.equals(bytes)) invalid()
    if (active === null) { active = intent; markerBytes = bytes; durable = false }
    return intent
  }
  async function barriers(): Promise<void> {
    if (!active || !markerBytes) return invalid()
    const bytes = await readBoundedFile(marker, 1048576, true)
    if (!bytes?.equals(markerBytes)) invalid()
    const h = await filesystem.open(marker, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await h.sync() } finally { await h.close() }
    await sync(directory); await sync(root)
    if (!(await readBoundedFile(marker, 1048576, true))?.equals(markerBytes)) invalid()
    durable = true
  }
  async function validate(): Promise<void> {
    valid = false; hidden.clear()
    const intent = await pending()
    if (!intent) return
    if (!durable) await barriers()
    const indexed = new Map(intent.entries.map(e => [e.path, e]))
    for (const e of intent.entries) {
      try { if (!isDeepStrictEqual(await capture(e.path), e)) invalid() }
      catch (error) {
        if (!absent(error)) throw error
        let parent = dirname(e.path)
        while (parent !== ".") {
          try { await ancestors(join(root, parent)); break }
          catch (error) { if (!absent(error) || indexed.get(parent)?.kind !== "directory") throw error; parent = dirname(parent) }
        }
      }
      if (e.kind === "directory") {
        try { for (const name of await readdir(join(root, e.path))) if (!indexed.has(e.path + "/" + name)) invalid() }
        catch (error) { if (!absent(error)) throw error }
      }
    }
    for (const entry of intent.launches) {
      const bytes = await readBoundedFile(join(root, entry.path), 1048576, true)
      if (bytes && !isDeepStrictEqual(parseLaunchRecord(decodeJson(bytes), false), entry.record)) invalid()
    }
    for (const e of intent.entries) hidden.add(e.path)
    valid = true
  }
  async function prepare(input: { paths: readonly string[]; launches: CleanupIntent["launches"]; handlers: CleanupIntent["handlers"] }): Promise<CleanupIntent> {
    if (await pending()) throw new Error("cleanup intent already pending")
    const entries = new Map<string, RemovalEvidence>()
    async function add(path: string): Promise<void> {
      if (entries.has(path)) return
      const e = await capture(path); entries.set(path, e)
      if (e.kind === "directory") for (const name of await readdir(join(root, path))) await add(path + "/" + name)
    }
    for (const path of input.paths) await add(retentionPath(path))
    const intent = parseIntent({ version: 1, hostId, handlerGeneration, intentId: randomUUID(), entries: [...entries.values()], launches: input.launches.map(e => ({ ...e, path: e.path.startsWith(root + "/") ? relative(root, e.path) : e.path })), handlers: input.handlers }, hostId)
    const bytes = Buffer.from(JSON.stringify(intent))
    if (bytes.length > 1048576) throw new Error("cleanup group exceeds 1 MiB intent bound")
    for (const entry of intent.launches) {
      const bytes = await readBoundedFile(join(root, entry.path), 1048576, true)
      if (!bytes || !isDeepStrictEqual(parseLaunchRecord(decodeJson(bytes), false), entry.record)) invalid()
    }
    try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
    await ancestors(directory); await sync(root)
    const temporary = join(directory, ".pending.json." + randomUUID() + ".tmp")
    let h: FileHandle | undefined
    try {
      h = await filesystem.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      await h.writeFile(bytes); await h.sync(); await h.close(); h = undefined
      if (await readBoundedFile(marker, 1048576, true)) invalid()
      await filesystem.rename(temporary, marker)
      active = intent; markerBytes = bytes; durable = false
      await barriers(); await validate()
      return intent
    } finally { await h?.close(); try { await filesystem.unlink(temporary) } catch (error) { if (!absent(error)) throw error } }
  }
  async function resume(input: { authorize(intent: CleanupIntent): Promise<void>; removed(entry: RemovalEvidence): void }): Promise<void> {
    const intent = await pending()
    if (!intent) return
    if (!await readBoundedFile(marker, 1048576, true)) {
      await sync(directory); active = null; markerBytes = null; valid = false; durable = false; hidden.clear(); return
    }
    await validate(); await input.authorize(intent)
    const priority = (e: RemovalEvidence) => e.path.startsWith("catalog/work/") ? e.kind === "file" ? 0 : 1 : e.path.includes("/snapshots/") ? 3 : e.path.includes("/probe-meta/") ? 4 : e.path.startsWith("launches/") || e.path.includes("/probe-launches/") ? 5 : 2
    const ordered = [...intent.entries].sort((a, b) => priority(a) - priority(b) || b.path.split("/").length - a.path.split("/").length || a.path.localeCompare(b.path))
    for (const entry of ordered) {
      let exists = true
      try { if (!isDeepStrictEqual(await capture(entry.path), entry)) invalid() } catch (error) { if (!absent(error)) throw error; exists = false }
      try { if (exists) { if (entry.kind === "file") await filesystem.unlink(join(root, entry.path)); else await filesystem.rmdir(join(root, entry.path)) } }
      finally {
        try { await lstat(join(root, entry.path)) } catch (error) { if (!absent(error)) throw error; input.removed(entry) }
      }
      let parent = dirname(entry.path)
      while (true) {
        try { await sync(join(root, parent)); break }
        catch (error) { if (!absent(error) || !intent.entries.some(e => e.path === parent && e.kind === "directory")) throw error; parent = dirname(parent) }
      }
    }
    await validate(); await input.authorize(intent)
    try { await filesystem.unlink(marker) }
    finally { try { await lstat(marker) } catch (error) { if (!absent(error)) throw error; clearing = true } }
    await sync(directory)
    active = null; markerBytes = null; valid = false; durable = false; clearing = false; hidden.clear()
  }
  return { pending, prepare, resume, view: { validate, hides: path => valid && hidden.has(path) } }
}