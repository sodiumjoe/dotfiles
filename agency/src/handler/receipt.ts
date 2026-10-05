import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir, rename, rm, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { ControlError, object, exactKeys, string, uuid, hostId, integer } from "../control/protocol.js"
import { assertPrivateDirectory } from "../platform/private-state.js"
import { parseAgencyLaunchMarker } from "../platform/launch-marker.js"
import { processBirthStart, type ProcessIdentity } from "../platform/types.js"
import { ensurePrivateChild } from "./environment.js"
import type { RetirementView } from "../retention/store.js"

export type ShutdownReceipt = { version: 1; commandId: string; hostId: string; handlerGeneration: string; handlerIdentity: ProcessIdentity; stopAgents: boolean; state: "accepted" }
export type ReceiptFileSystem = { open(path: string, flags: number, mode?: number): Promise<FileHandle>; rename: typeof rename; rm: typeof rm }

export function assertSameShutdown(expected: Pick<ShutdownReceipt, "commandId" | "handlerGeneration" | "stopAgents">, actual: Pick<ShutdownReceipt, "commandId" | "handlerGeneration" | "stopAgents">): void {
  if (expected.commandId !== actual.commandId || expected.handlerGeneration !== actual.handlerGeneration || expected.stopAgents !== actual.stopAgents) throw new ControlError("COMMAND_CONFLICT")
}

function parseReceipt(value: unknown): ShutdownReceipt {
  const v = object(value)
  exactKeys(v, ["version", "commandId", "hostId", "handlerGeneration", "handlerIdentity", "stopAgents", "state"])
  if (v.version !== 1 || v.state !== "accepted" || typeof v.stopAgents !== "boolean") throw new ControlError("INVALID_PROTOCOL", "invalid shutdown receipt")
  const p = object(v.handlerIdentity)
  exactKeys(p, ["bootId", "pid", "birth", "parentPid", "processGroupId", "sessionId", "uid", "gid"])
  const identity: ProcessIdentity = { bootId: string(p.bootId), pid: integer(p.pid, 2), birth: string(p.birth), parentPid: integer(p.parentPid), processGroupId: integer(p.processGroupId, 2), sessionId: integer(p.sessionId, 2), uid: integer(p.uid), gid: integer(p.gid) }
  if (processBirthStart(identity.birth) === null || parseAgencyLaunchMarker(identity.birth.slice(identity.birth.indexOf(":") + 1))?.role !== "handler" || identity.pid !== identity.processGroupId || identity.pid !== identity.sessionId || identity.uid !== process.getuid!() || identity.gid !== process.getgid!()) throw new ControlError("INVALID_PROTOCOL", "invalid receipt process identity")
  return { version: 1, commandId: uuid(v.commandId), hostId: hostId(v.hostId), handlerGeneration: uuid(v.handlerGeneration), handlerIdentity: identity, stopAgents: v.stopAgents, state: "accepted" }
}

export async function readShutdownReceipt(root: string, commandId: string): Promise<ShutdownReceipt | null> {
  uuid(commandId)
  await assertPrivateDirectory(root)
  const directory = join(root, "shutdown")
  let handle: FileHandle | undefined
  try {
    await assertPrivateDirectory(directory)
    handle = await open(join(directory, `${commandId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.uid !== process.getuid!() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 * 1024) throw new Error("unsafe shutdown receipt")
    const bytes = await handle.readFile()
    if (bytes.length > 1024 * 1024) throw new Error("oversized shutdown receipt")
    const result = parseReceipt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
    if (result.commandId !== commandId) throw new ControlError("COMMAND_CONFLICT", "receipt filename mismatch")
    return result
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
  finally { await handle?.close() }
}

export async function readShutdownInventory(root: string, retirement?: RetirementView): Promise<{ receipts: ShutdownReceipt[]; issues: string[] }> {
  const result: { receipts: ShutdownReceipt[]; issues: string[] } = { receipts: [], issues: [] }, directory = join(root, "shutdown")
  try {
    await assertPrivateDirectory(root); await retirement?.validate()
    try { await assertPrivateDirectory(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error }
    for await (const entry of await opendir(directory)) {
      const path = "shutdown/" + entry.name
      if (retirement?.hides(path)) continue
      try {
        const stat = await lstat(join(root, path))
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error("unsafe shutdown entry")
        if (/^\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) continue
        if (!entry.name.endsWith(".json")) throw new Error("invalid shutdown filename")
        const receipt = await readShutdownReceipt(root, uuid(entry.name.slice(0, -5)))
        if (!receipt) throw new Error("missing shutdown receipt")
        result.receipts.push(receipt)
      } catch { result.issues.push(path) }
    }
  } catch { result.issues.push("shutdown") }
  result.receipts.sort((a, b) => a.commandId.localeCompare(b.commandId))
  return result
}

export async function writeShutdownReceipt(root: string, value: ShutdownReceipt, filesystem: ReceiptFileSystem = { open, rename, rm }): Promise<void> {
  const receipt = parseReceipt(value)
  const directory = await ensurePrivateChild(root, "shutdown")
  const previous = await readShutdownReceipt(root, receipt.commandId)
  if (previous !== null && !isDeepStrictEqual(previous, receipt)) throw new ControlError("COMMAND_CONFLICT")
  const temporary = join(directory, `.${receipt.commandId}.${randomUUID()}.tmp`)
  let handle: FileHandle | undefined, created = false
  try {
    handle = await filesystem.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    await handle.writeFile(JSON.stringify(receipt))
    await handle.sync()
    await handle.close()
    handle = undefined
    await filesystem.rename(temporary, join(directory, `${receipt.commandId}.json`))
    created = false
    const parent = await filesystem.open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try { await parent.sync() } finally { await parent.close() }
  } finally {
    await handle?.close()
    if (created) await filesystem.rm(temporary, { force: true })
  }
}