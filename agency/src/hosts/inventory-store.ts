import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { assertPrivateDirectory } from "../platform/private-state.js"
import { ensurePrivateChild } from "../handler/environment.js"
import { decodeJson, readBoundedFile } from "../catalog/config.js"
import { canonicalJson } from "../agent/session-config.js"

const RECORD_BYTES = 1024 * 1024
function fail(code = "INVALID_STATE"): never { throw new Error(code) }
function encode(value: unknown): Buffer {
  const bytes = Buffer.from(canonicalJson(value))
  if (bytes.length > RECORD_BYTES) fail("RECORD_TOO_LARGE")
  return bytes
}

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
export function createInventoryStore(root: string, filesystem: { rename: typeof rename } = { rename }) {
  const base = join(root, "bureau", "hosts"), identities = new Map<string, string>(), accepted = new Map<string, Buffer>()
  const checkIdentity = async (path: string, file = false): Promise<void> => {
    const stat = await lstat(path, { bigint: true }), identity = stat.dev + ":" + stat.ino
    if (identities.has(path) && identities.get(path) !== identity) fail("STATE_REPLACED")
    if (file && (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n)) fail()
    identities.set(path, identity)
  }
  const directory = async (path: string, create: boolean): Promise<boolean> => {
    await assertPrivateDirectory(root); await checkIdentity(root)
    if (path !== base) fail()
    const suffix = "bureau/hosts"
    let current = root
    for (const part of suffix.split("/")) {
      const parent = current; current = join(current, part)
      if (create) {
        if (parent === root) await ensurePrivateChild(parent, part)
        else { try { await mkdir(current, { mode: 0o700 }) } catch (error) { if (!((error as NodeJS.ErrnoException).code === "EEXIST")) throw error } }
      }
      if (create) await sync(parent)
      try { await assertPrivateDirectory(current); await checkIdentity(current) }
      catch (error) { if (absent(error) && !create) { if (identities.has(current)) fail("STATE_CHANGED"); return false }; throw error }
    }
    return true
  }
  const pathFor = (key: string): string => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/.test(key)) fail()
    return join(base, key)
  }
  const sync = async (path: string): Promise<void> => {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
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
    async read(key: string): Promise<unknown | null> { const bytes = await readBytes(pathFor(key)); return bytes === null ? null : decodeJson(bytes) },
    async names(): Promise<string[]> {
      const path = base
      if (!await directory(path, false)) return []
      const names = await readdir(path)
      for (const name of names) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name) && !/^\.[a-zA-Z0-9_-]+\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) fail("UNEXPLAINED_STATE")
        await checkIdentity(join(path, name), true)
      }
      return names.filter(name => name.endsWith(".json")).sort()
    },
    async publish(key: string, value: unknown): Promise<void> {
      const path = pathFor(key), bytes = encode(value), previous = await readBytes(path)
      if (previous?.equals(bytes)) { await sync(dirname(path)); return }
      if (previous !== null) fail("COMMAND_CONFLICT")
      await directory(dirname(path), true)
      const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
      let handle: FileHandle | undefined, renamed = false
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined
        const before = await readBytes(path)
        if (before === null ? previous !== null : previous === null || !before.equals(previous)) fail("STATE_CHANGED")
        await directory(dirname(path), false)
        await filesystem.rename(temporary, path); renamed = true
        identities.delete(path); accepted.set(path, bytes); await checkIdentity(path, true)
        await sync(dirname(path))
        if (!(await readBytes(path))?.equals(bytes)) fail("STATE_CHANGED")
      } catch (error) {
        if (!renamed && (await readBoundedFile(path, RECORD_BYTES, true))?.equals(bytes)) { identities.delete(path); accepted.set(path, bytes) }
        throw error
      } finally { await handle?.close(); if (!renamed) await rm(temporary, { force: true }) }
    },
  }
}