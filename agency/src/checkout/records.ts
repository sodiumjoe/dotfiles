import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, rename, rm, type FileHandle } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { exactKeys, hostId, object, string, uuid, UUID } from "../control/protocol.js"
import { ensurePrivateChild } from "../handler/environment.js"
import { assertPrivateDirectory } from "../platform/private-state.js"
import { checkoutIdFor, type CheckoutIdentity, type DirectoryIdentity } from "./identity.js"

export type AdmissionRecord = { version: 1; checkout: CheckoutIdentity; agentId: string; leaseId: string; handlerGeneration: string; launchAttemptId: string }
export type AdmissionIssue = { path: string; reason: string }
export type AdmissionInventory = { records: AdmissionRecord[]; issues: AdmissionIssue[] }
export type AdmissionFileSystem = { open(path: string, flags: number, mode?: number): Promise<FileHandle>; rename: typeof rename; rm: typeof rm }

function directoryIdentity(value: unknown): DirectoryIdentity {
  const v = object(value)
  exactKeys(v, ["path", "device", "inode"])
  const path = string(v.path), device = string(v.device), inode = string(v.inode)
  if (!isAbsolute(path) || normalize(path) !== path || (path !== "/" && path.endsWith("/")) || /[\x00-\x1f\x7f]/.test(path) || !/^(0|[1-9]\d*)$/.test(device) || !/^(0|[1-9]\d*)$/.test(inode)) throw new Error("invalid checkout directory identity")
  return { path, device, inode }
}

export function parseAdmissionRecord(value: unknown): AdmissionRecord {
  const v = object(value)
  exactKeys(v, ["version", "checkout", "agentId", "leaseId", "handlerGeneration", "launchAttemptId"])
  const c = object(v.checkout)
  exactKeys(c, ["version", "checkoutId", "hostId", "root", "commonDirectory", "gitDirectory", "ancestors"])
  if (v.version !== 1 || c.version !== 1 || !Array.isArray(c.ancestors) || c.ancestors.length > 256) throw new Error("invalid admission version or ancestry")
  const root = directoryIdentity(c.root), commonDirectory = directoryIdentity(c.commonDirectory), gitDirectory = directoryIdentity(c.gitDirectory)
  const ancestors = c.ancestors.map(directoryIdentity)
  let parent = root.path
  for (const ancestor of ancestors) {
    if (parent === dirname(parent) || ancestor.path !== dirname(parent)) throw new Error("invalid checkout parent chain")
    parent = ancestor.path
  }
  if (parent !== "/") throw new Error("incomplete checkout parent chain")
  const checkout: CheckoutIdentity = { version: 1, checkoutId: string(c.checkoutId), hostId: hostId(c.hostId), root, commonDirectory, gitDirectory, ancestors }
  if (checkout.checkoutId !== checkoutIdFor(checkout.hostId, root, gitDirectory)) throw new Error("checkout hash mismatch")
  return { version: 1, checkout, agentId: uuid(v.agentId), leaseId: uuid(v.leaseId), handlerGeneration: uuid(v.handlerGeneration), launchAttemptId: uuid(v.launchAttemptId) }
}

export async function readAdmission(root: string, attemptId: string): Promise<AdmissionRecord | null> {
  uuid(attemptId)
  await assertPrivateDirectory(root)
  let handle: FileHandle | undefined
  try {
    await assertPrivateDirectory(join(root, "admissions"))
    handle = await open(join(root, "admissions", `${attemptId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.uid !== process.getuid!() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 * 1024) throw new Error("unsafe admission record")
    const bytes = await handle.readFile()
    if (bytes.length > 1024 * 1024) throw new Error("oversized admission record")
    const value = parseAdmissionRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
    if (value.launchAttemptId !== attemptId) throw new Error("admission filename mismatch")
    return value
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
  finally { await handle?.close() }
}

export async function writeAdmission(root: string, value: AdmissionRecord, filesystem: AdmissionFileSystem = { open, rename, rm }): Promise<void> {
  const record = parseAdmissionRecord(value), bytes = JSON.stringify(record)
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error("oversized admission record")
  const directory = await ensurePrivateChild(root, "admissions")
  const parent = await filesystem.open(root, constants.O_RDONLY | constants.O_DIRECTORY)
  try { await parent.sync() } finally { await parent.close() }
  const previous = await readAdmission(root, record.launchAttemptId)
  if (previous !== null && !isDeepStrictEqual(previous, record)) throw new Error("admission identity conflict")
  const temporary = join(directory, `.${record.launchAttemptId}.json.${randomUUID()}.tmp`)
  let handle: FileHandle | undefined, created = false
  try {
    handle = await filesystem.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await filesystem.rename(temporary, join(directory, `${record.launchAttemptId}.json`))
    created = false
    const directoryHandle = await filesystem.open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  } finally {
    await handle?.close()
    if (created) await filesystem.rm(temporary, { force: true })
  }
}

export async function inventoryAdmissions(root: string): Promise<AdmissionInventory> {
  const records: AdmissionRecord[] = [], issues: AdmissionIssue[] = [], directory = join(root, "admissions")
  let names: string[]
  try {
    await assertPrivateDirectory(root)
    try { await lstat(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records, issues }; throw error }
    await assertPrivateDirectory(directory)
    names = (await readdir(directory)).sort()
  } catch (error) { return { records, issues: [{ path: directory, reason: String(error).slice(0, 512) }] } }
  for (const name of names) {
    const path = join(directory, name)
    try {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== process.getuid!() || (metadata.mode & 0o077) !== 0) throw new Error("unsafe admission entry")
      const remnant = /^\.(.+)\.json\.(.+)\.tmp$/.exec(name)
      if (remnant && UUID.test(remnant[1]!) && UUID.test(remnant[2]!)) continue
      if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) throw new Error("unknown admission entry")
      const record = await readAdmission(root, name.slice(0, -5))
      if (record === null) throw new Error("admission disappeared during inventory")
      records.push(record)
    } catch (error) { issues.push({ path, reason: String(error).slice(0, 512) }) }
  }
  return { records, issues }
}