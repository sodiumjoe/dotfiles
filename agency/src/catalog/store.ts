import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, opendir, rename, rm, type FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { UUID } from "../control/protocol.js"
import type { InventoryEntry } from "../handler/inventory.js"
import { assertPrivateDirectory, readLaunchRecordForReconciliation } from "../platform/private-state.js"
import { decodeJson, digest, readBoundedFile } from "./config.js"
import { CatalogError, hash, id, invalid, keys, MAX_CATALOG_BYTES, object, parseCommand, parseProbeMeta, parseSnapshot, type CatalogSnapshot, type ProbeMeta, type RefreshCommand } from "./types.js"

export type CatalogFileSystem = { open(path: string, flags: number, mode?: number): Promise<FileHandle>; rename: typeof rename; rm: typeof rm; mkdir: typeof mkdir }
export type CatalogInventory = { launches: InventoryEntry[]; metadata: ProbeMeta[]; commands: RefreshCommand[]; issues: string[] }
export type CatalogStore = {
  root: string
  readSnapshot(id: string): Promise<CatalogSnapshot | null>
  readCurrent(): Promise<CatalogSnapshot | null>
  readCommand(id: string): Promise<RefreshCommand | null>
  writeCommand(value: RefreshCommand, expected: RefreshCommand | null): Promise<void>
  writeSnapshot(value: CatalogSnapshot): Promise<void>
  publishCurrent(value: CatalogSnapshot): Promise<void>
  writeProbeMeta(value: ProbeMeta): Promise<void>
  inventory(): Promise<CatalogInventory>
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const conflict = (): never => { throw new CatalogError("COMMAND_CONFLICT") }
export function createCatalogStore(root: string, filesystem: CatalogFileSystem = { open, rename, rm, mkdir }): CatalogStore {
  const catalog = join(root, "catalog"), accepted = new Map<string, Buffer>()
  const byteLimit = (path: string) => dirname(path) === join(catalog, "snapshots") ? 2 * MAX_CATALOG_BYTES + 8192 : MAX_CATALOG_BYTES
  let snapshots: Map<string, Buffer> | null = null
  async function checkDirectory(path: string): Promise<boolean> {
    await assertPrivateDirectory(root)
    try { await assertPrivateDirectory(catalog); if (path !== catalog) await assertPrivateDirectory(path); return true }
    catch (error) { if (absent(error)) return false; throw new CatalogError("INVALID_CATALOG") }
  }
  async function read(path: string): Promise<Buffer | null> {
    if (!await checkDirectory(dirname(path))) return null
    return readBoundedFile(path, byteLimit(path), true)
  }
  async function sync(path: string): Promise<void> {
    const handle = await filesystem.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }
  async function ensure(path: string): Promise<void> {
    await assertPrivateDirectory(root)
    for (const dir of path === catalog ? [catalog] : [catalog, path]) {
      try { await filesystem.mkdir(dir, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
      await assertPrivateDirectory(dir)
      await sync(dirname(dir))
    }
  }
  async function publish(path: string, value: unknown, expected: unknown, immutable: boolean): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value))
    if (bytes.length > byteLimit(path)) invalid()
    for (const [knownPath, knownBytes] of accepted) {
      const current = await read(knownPath)
      if (current === null || !current.equals(knownBytes)) throw new CatalogError("CATALOG_UNAVAILABLE")
    }
    const previous = await read(path)
    if (previous !== null && previous.equals(bytes)) { }
    else if (immutable ? previous !== null : !isDeepStrictEqual(previous === null ? null : decodeJson(previous), expected)) conflict()
    await ensure(dirname(path))
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
    let handle: FileHandle | undefined, renamed = false
    try {
      handle = await filesystem.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      const before = await read(path)
      if (!isDeepStrictEqual(before, previous)) throw new CatalogError("CATALOG_UNAVAILABLE")
      await filesystem.rename(temporary, path)
      renamed = true
      accepted.set(path, bytes)
      await sync(dirname(path))
      if (!bytes.equals((await read(path)) ?? Buffer.alloc(0))) invalid()
    } catch (error) {
      const remaining = await read(path)
      if (remaining?.equals(bytes)) accepted.set(path, bytes)
      throw error
    } finally { await handle?.close(); if (!renamed) await filesystem.rm(temporary, { force: true }) }
  }
  async function readSnapshot(snapshotId: string): Promise<CatalogSnapshot | null> {
    const bytes = await read(join(catalog, "snapshots", id(snapshotId) + ".json"))
    if (bytes === null) return null
    const value = parseSnapshot(decodeJson(bytes))
    if (value.snapshotId !== snapshotId) invalid()
    return value
  }
  async function readCommand(commandId: string): Promise<RefreshCommand | null> {
    const bytes = await read(join(catalog, "commands", id(commandId) + ".json"))
    if (bytes === null) return null
    const value = parseCommand(decodeJson(bytes))
    if (value.commandId !== commandId) invalid()
    return value
  }
  async function readCurrent(): Promise<CatalogSnapshot | null> {
    const bytes = await read(join(catalog, "current.json"))
    if (bytes === null) return null
    const pointer = object(decodeJson(bytes))
    keys(pointer, ["version", "hostId", "snapshotId", "sha256"])
    if (pointer.version !== 1) invalid()
    const snapshotBytes = await read(join(catalog, "snapshots", id(pointer.snapshotId) + ".json"))
    if (snapshotBytes === null || digest(snapshotBytes) !== hash(pointer.sha256)) invalid()
    const snapshot = parseSnapshot(decodeJson(snapshotBytes))
    if (snapshot.hostId !== hash(pointer.hostId) || snapshot.snapshotId !== pointer.snapshotId) invalid()
    return snapshot
  }
  async function names(directory: string): Promise<string[]> {
    if (!await checkDirectory(directory)) return []
    const result: string[] = [], handle = await opendir(directory)
    for await (const entry of handle) { if (result.length >= 4096) invalid(); result.push(entry.name) }
    return result.sort()
  }
  async function inventory(): Promise<CatalogInventory> {
    const result: CatalogInventory = { launches: [], metadata: [], commands: [], issues: [] }
    const observedSnapshots = new Map<string, Buffer>()
    try {
      const allowed = new Set(["providers.json", "current.json", "commands", "snapshots", "probe-launches", "probe-meta", "work"])
      for (const name of await names(catalog)) {
        if (allowed.has(name)) continue
        const remnant = /^\.current\.json\.(.+)\.tmp$/.exec(name)
        if (!remnant || !UUID.test(remnant[1]!)) invalid()
        const stats = await lstat(join(catalog, name))
        if (!stats.isFile() || stats.nlink !== 1 || stats.uid !== process.getuid!() || (stats.mode & 0o077) !== 0) invalid()
      }
      for (const kind of ["commands", "snapshots", "probe-meta", "probe-launches", "work"]) {
        const directory = join(catalog, kind)
        for (const name of await names(directory)) {
          const path = join(directory, name)
          try {
            if (kind === "work") { id(name); await assertPrivateDirectory(path); continue }
            const stats = await lstat(path)
            if (!stats.isFile() || stats.nlink !== 1 || stats.uid !== process.getuid!() || (stats.mode & 0o077) !== 0) invalid()
            const remnant = /^\.(.+)\.json\.(.+)\.tmp$/.exec(name)
            if (remnant && UUID.test(remnant[1]!) && UUID.test(remnant[2]!)) continue
            if (!name.endsWith(".json")) invalid()
            const recordId = id(name.slice(0, -5)), bytes = await read(path)
            if (bytes === null) invalid()
            const raw = decodeJson(bytes)
            if (kind === "commands") { const c = parseCommand(raw); if (c.commandId !== recordId) invalid(); result.commands.push(c) }
            if (kind === "snapshots") {
              if (parseSnapshot(raw).snapshotId !== recordId) invalid()
              observedSnapshots.set(path, bytes)
              if (snapshots !== null && !(snapshots.get(path) ?? accepted.get(path))?.equals(bytes)) invalid()
            }
            if (kind === "probe-meta") {
              const m = parseProbeMeta(raw)
              if (m.attemptId !== recordId || m.workPath !== join(catalog, "work", m.attemptId)) invalid()
              result.metadata.push(m)
            }
            if (kind === "probe-launches") {
              const v = object(raw)
              keys(v, ["version", "checkoutId", "leaseId", "agentId", "handlerGeneration", "launchAttemptId", "launchBootId", "launchAttempted", "phase", "provider", "reason"])
              for (const field of ["leaseId", "agentId", "handlerGeneration", "launchAttemptId"]) id(v[field])
              if (v.provider !== null) {
                const p = object(v.provider); keys(p, ["kind", "group"])
                const g = object(p.group); keys(g, ["leader", "observed"])
                if (!Array.isArray(g.observed) || g.observed.length > 512) invalid()
                for (const process of [g.leader, ...g.observed]) keys(object(process), ["bootId", "pid", "birth", "parentPid", "processGroupId", "sessionId", "uid", "gid"])
              }
              const record = await readLaunchRecordForReconciliation(path)
              if (!isDeepStrictEqual(raw, record) || record.launchAttemptId !== recordId || !bytes.equals((await read(path)) ?? Buffer.alloc(0))) invalid()
              result.launches.push({ path, record })
            }
          } catch { result.issues.push(`${kind}/${name}`) }
        }
      }
      const hosts = new Set([...result.commands, ...result.metadata].map(v => v.hostId))
      if (hosts.size > 1) invalid()
      const agents = new Set<string>(), leases = new Set<string>()
      for (const m of result.metadata) {
        const c = result.commands.find(c => c.commandId === m.commandId)
        const entry = result.launches.find(l => l.record.launchAttemptId === m.attemptId)
        if (!c || c.hostId !== m.hostId || c.handlerGeneration !== m.handlerGeneration || !c.attempts.some(a => a.attemptId === m.attemptId && a.providerId === m.providerId) || !c.fingerprints.some(f => f.providerId === m.providerId && f.fingerprint === m.fingerprint) || !entry || entry.record.agentId !== m.agentId || entry.record.leaseId !== m.leaseId || entry.record.handlerGeneration !== m.handlerGeneration || entry.record.checkoutId !== `catalog-v1:${m.providerId}:${m.fingerprint}` || agents.has(m.agentId) || leases.has(m.leaseId)) result.issues.push(`probe-meta/${m.attemptId}`)
        agents.add(m.agentId); leases.add(m.leaseId)
      }
      for (const entry of result.launches) if (!result.metadata.some(m => m.attemptId === entry.record.launchAttemptId)) result.issues.push(`probe-launches/${entry.record.launchAttemptId}`)
      for (const c of result.commands) if (c.snapshotId !== null) { const s = await readSnapshot(c.snapshotId); if (!s || s.hostId !== c.hostId || s.handlerGeneration !== c.handlerGeneration) invalid() }
      await readCurrent()
      if (snapshots !== null && [...snapshots.keys()].some(path => !observedSnapshots.has(path))) invalid()
      if (result.issues.length === 0) {
        snapshots = observedSnapshots
        for (const [path, bytes] of snapshots) accepted.set(path, bytes)
      }
    } catch { result.issues.push("catalog") }
    return result
  }
  return {
    root, readSnapshot, readCurrent, readCommand, inventory,
    async writeSnapshot(input) { const value = parseSnapshot(input); await publish(join(catalog, "snapshots", value.snapshotId + ".json"), value, null, true) },
    async publishCurrent(input) {
      const value = parseSnapshot(input), path = join(catalog, "current.json"), bytes = await read(join(catalog, "snapshots", value.snapshotId + ".json"))
      if (bytes === null || !isDeepStrictEqual(parseSnapshot(decodeJson(bytes)), value)) invalid()
      const previous = await read(path)
      await publish(path, { version: 1, hostId: value.hostId, snapshotId: value.snapshotId, sha256: digest(bytes) }, previous === null ? null : decodeJson(previous), false)
    },
    async writeCommand(input, expected) {
      const value = parseCommand(input), current = await readCommand(value.commandId)
      if (!isDeepStrictEqual(value, current)) {
        if (!isDeepStrictEqual(current, expected)) conflict()
        if (current === null) { if (value.state !== "pending") conflict() }
        else if (current.state !== "pending" || value.state === "pending" || !isDeepStrictEqual({ ...value, state: current.state, snapshotId: current.snapshotId }, current)) conflict()
      }
      if (value.snapshotId !== null) { const s = await readSnapshot(value.snapshotId); if (!s || s.hostId !== value.hostId || s.handlerGeneration !== value.handlerGeneration) invalid() }
      await publish(join(catalog, "commands", value.commandId + ".json"), value, expected, false)
    },
    async writeProbeMeta(input) {
      const value = parseProbeMeta(input)
      if (value.workPath !== join(catalog, "work", value.attemptId)) invalid()
      await publish(join(catalog, "probe-meta", value.attemptId + ".json"), value, null, true)
    },
  }
}