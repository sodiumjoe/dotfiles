import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { basename, dirname, join, relative } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { assertPrivateDirectory } from "../platform/private-state.js"
import { ensurePrivateChild } from "../handler/environment.js"
import { decodeJson, readBoundedFile } from "../catalog/config.js"
import { MutationQueue } from "../handler/mutations.js"
import { encode, fail, RECORD_BYTES } from "./types.js"

export type StorageFileSystem = { open(path: string, flags: number, mode?: number): Promise<FileHandle>; mkdir: typeof mkdir; rename: typeof rename; rm: typeof rm }
export const defaultFileSystem: StorageFileSystem = { open, mkdir, rename, rm }
const queues = new Map<string, MutationQueue>()
export function storageQueue(root: string): MutationQueue {
  let queue = queues.get(root)
  if (!queue) { queue = new MutationQueue(); queues.set(root, queue) }
  return queue
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
export function createStorage(root: string, area: "orchestration" | "bureau", filesystem = defaultFileSystem) {
  const base = join(root, area), identities = new Map<string, string>(), accepted = new Map<string, Buffer>()
  const checkIdentity = async (path: string, file = false): Promise<void> => {
    const stat = await lstat(path, { bigint: true }), identity = stat.dev + ":" + stat.ino
    if (identities.has(path) && identities.get(path) !== identity) fail("STATE_REPLACED")
    if (file && (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n)) fail()
    identities.set(path, identity)
  }
  const directory = async (path: string, create: boolean): Promise<boolean> => {
    await assertPrivateDirectory(root); await checkIdentity(root)
    const suffix = relative(root, path)
    if (suffix.split("/").some(part => !part || part === "." || part === "..") || !suffix.startsWith(area)) fail()
    let current = root
    for (const part of suffix.split("/")) {
      const parent = current; current = join(current, part)
      if (create) {
        if (parent === root) await ensurePrivateChild(parent, part)
        else { try { await filesystem.mkdir(current, { mode: 0o700 }) } catch (error) { if (!((error as NodeJS.ErrnoException).code === "EEXIST")) throw error } }
      }
      if (create) await sync(parent)
      try { await assertPrivateDirectory(current); await checkIdentity(current) }
      catch (error) { if (absent(error) && !create) { if (identities.has(current)) fail("STATE_CHANGED"); return false }; throw error }
    }
    return true
  }
  const pathFor = (key: string): string => {
    if (!/^[a-zA-Z0-9_./-]+$/.test(key) || key.split("/").some(part => !part || part === "." || part === "..")) fail()
    return join(base, key)
  }
  const sync = async (path: string): Promise<void> => {
    const handle = await filesystem.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }
  const readBytes = async (path: string): Promise<Buffer | null> => {
    if (!await directory(dirname(path), false)) return null
    const bytes = await readBoundedFile(path, RECORD_BYTES, true)
    if (bytes !== null) { await checkIdentity(path, true); if (accepted.has(path) && !accepted.get(path)!.equals(bytes)) fail("STATE_CHANGED"); accepted.set(path, bytes) }
    else if (accepted.has(path)) fail("STATE_CHANGED")
    return bytes
  }
  return {
    base,
    async read(key: string): Promise<unknown | null> { const bytes = await readBytes(pathFor(key)); return bytes === null ? null : decodeJson(bytes) },
    async directories(key: string): Promise<string[]> {
      const path = pathFor(key)
      if (!await directory(path, false)) return []
      const names = await readdir(path)
      for (const name of names) await directory(join(path, name), false)
      return names.sort()
    },
    async names(key: string): Promise<string[]> {
      const path = pathFor(key)
      if (!await directory(path, false)) return []
      const names = await readdir(path)
      for (const name of names) {
        if (!name.endsWith(".json") && !/^\.[a-zA-Z0-9_-]+\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) fail("UNEXPLAINED_STATE")
        await checkIdentity(join(path, name), true)
      }
      return names.filter(name => name.endsWith(".json")).sort()
    },
    async publish(key: string, value: unknown, expected: unknown | null, immutable = false): Promise<void> {
      const path = pathFor(key), bytes = encode(value), previous = await readBytes(path)
      if (previous?.equals(bytes)) { await sync(dirname(path)); return }
      if (immutable ? previous !== null : !isDeepStrictEqual(previous === null ? null : decodeJson(previous), expected)) fail("COMMAND_CONFLICT")
      await directory(dirname(path), true)
      const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
      let handle: FileHandle | undefined, renamed = false
      try {
        handle = await filesystem.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined
        const before = await readBytes(path)
        if (!isDeepStrictEqual(before, previous)) fail("STATE_CHANGED")
        await directory(dirname(path), false)
        await filesystem.rename(temporary, path); renamed = true
        identities.delete(path); accepted.set(path, bytes); await checkIdentity(path, true)
        await sync(dirname(path))
        if (!(await readBytes(path))?.equals(bytes)) fail("STATE_CHANGED")
      } catch (error) {
        if (!renamed && (await readBoundedFile(path, RECORD_BYTES, true))?.equals(bytes)) { identities.delete(path); accepted.set(path, bytes) }
        throw error
      } finally { await handle?.close(); if (!renamed) await filesystem.rm(temporary, { force: true }) }
    },
    async remove(key: string): Promise<void> {
      const path = pathFor(key), bytes = await readBytes(path)
      if (bytes === null) return
      await filesystem.rm(path)
      identities.delete(path); accepted.delete(path)
      await sync(dirname(path))
    },
    async sync(key: string): Promise<void> { const path = pathFor(key); if (await directory(path, false)) await sync(path) }
  }
}