import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath, rename, rm, type FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import {
  RUNTIME_RECORD_VERSION,
  type HandlerGenerationRecord,
  type LaunchPhase,
  type LaunchRecord,
  type ProcessGroupProviderIdentity,
  type ProcessIdentity,
  type ProviderIdentity,
} from "./types.js"

const MAX_RECORD_BYTES = 1024 * 1024

type UnknownRecord = Record<string, unknown>

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function object(value: unknown, name: string): UnknownRecord {
  if (!isUnknownRecord(value)) throw new Error(`${name} must be an object`)
  return value
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a nonempty string`)
  return value
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null
  return nonempty(value, name)
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer at least ${minimum}`)
  return value
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`)
  return value
}

function version(value: unknown): typeof RUNTIME_RECORD_VERSION {
  if (value !== RUNTIME_RECORD_VERSION) throw new Error(`record version must be ${RUNTIME_RECORD_VERSION}`)
  return RUNTIME_RECORD_VERSION
}

function processIdentity(value: unknown, name: string): ProcessIdentity {
  const source = object(value, name)
  return {
    bootId: nonempty(source.bootId, `${name}.bootId`),
    pid: integer(source.pid, `${name}.pid`, 1),
    birth: nonempty(source.birth, `${name}.birth`),
    parentPid: integer(source.parentPid, `${name}.parentPid`),
    processGroupId: integer(source.processGroupId, `${name}.processGroupId`, 1),
    sessionId: integer(source.sessionId, `${name}.sessionId`, 1),
    uid: integer(source.uid, `${name}.uid`),
    gid: integer(source.gid, `${name}.gid`),
  }
}

function identities(value: unknown, name: string): ProcessIdentity[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value.map((entry, index) => processIdentity(entry, `${name}[${index}]`))
}

function providerIdentity(value: unknown): ProviderIdentity | null {
  if (value === null) return null
  const source = object(value, "provider")
  if (source.kind === "process-group") {
    const group = object(source.group, "provider.group")
    return {
      kind: "process-group",
      group: {
        leader: processIdentity(group.leader, "provider.group.leader"),
        observed: identities(group.observed, "provider.group.observed"),
      },
    } satisfies ProcessGroupProviderIdentity
  }
  throw new Error("provider.kind is invalid")
}

function launchPhase(value: unknown): LaunchPhase {
  if (value === "launch_pending" || value === "readiness" || value === "active" || value === "exited_unverified" || value === "cleanup_pending" || value === "cleanup_verified" || value === "quarantined") return value
  throw new Error("launch phase is invalid")
}

function parseLaunchRecord(value: unknown, strict: boolean): LaunchRecord {
  const source = object(value, "LaunchRecord")
  const record: LaunchRecord = {
    version: version(source.version),
    checkoutId: nonempty(source.checkoutId, "checkoutId"),
    leaseId: nonempty(source.leaseId, "leaseId"),
    agentId: nonempty(source.agentId, "agentId"),
    handlerGeneration: nonempty(source.handlerGeneration, "handlerGeneration"),
    launchAttemptId: nonempty(source.launchAttemptId, "launchAttemptId"),
    launchBootId: nonempty(source.launchBootId, "launchBootId"),
    launchAttempted: boolean(source.launchAttempted, "launchAttempted"),
    phase: launchPhase(source.phase),
    provider: providerIdentity(source.provider),
    reason: nullableString(source.reason, "reason"),
  }
  if (strict) assertLaunchSemantics(record)
  return record
}

function assertLaunchSemantics(record: LaunchRecord): void {
  if (!record.launchAttempted && record.provider !== null && record.phase !== "quarantined") throw new Error("an unattempted launch record cannot have a provider")
  if ((record.phase === "readiness" || record.phase === "active") && record.provider === null) throw new Error(`${record.phase} requires a provider`)
  if (record.phase === "exited_unverified" && !record.launchAttempted) throw new Error("exited_unverified requires an attempted launch")
  if (record.phase === "cleanup_pending" && (!record.launchAttempted || record.provider === null)) throw new Error("cleanup_pending requires an attempted launch and provider identity")
  if ((record.phase === "exited_unverified" || record.phase === "quarantined") && record.reason === null) throw new Error(`${record.phase} requires a nonempty reason`)
  if (record.phase !== "exited_unverified" && record.phase !== "quarantined" && record.reason !== null) throw new Error(`${record.phase} cannot have a reason`)
}

function parseReconciliation(value: unknown): HandlerGenerationRecord["reconciliation"] {
  if (value === null) return null
  const source = object(value, "reconciliation")
  const reconciliation = {
    classified: integer(source.classified, "reconciliation.classified"),
    total: integer(source.total, "reconciliation.total"),
    quarantined: integer(source.quarantined, "reconciliation.quarantined"),
  }
  if (reconciliation.classified > reconciliation.total) throw new Error("reconciliation.classified cannot exceed total")
  if (reconciliation.quarantined > reconciliation.classified) throw new Error("reconciliation.quarantined cannot exceed classified")
  return reconciliation
}

function parseHandlerRecord(value: unknown): HandlerGenerationRecord {
  const source = object(value, "HandlerGenerationRecord")
  if (source.phase !== "launch_pending" && source.phase !== "identity_published" && source.phase !== "socket_bound" && source.phase !== "reconciling" && source.phase !== "ready" && source.phase !== "exited_unverified") throw new Error("handler phase is invalid")
  if (source.writer !== "launcher" && source.writer !== "handler" && source.writer !== "reconciler") throw new Error("handler writer is invalid")
  const record: HandlerGenerationRecord = {
    version: version(source.version),
    hostId: nonempty(source.hostId, "hostId"),
    launchBootId: nonempty(source.launchBootId, "launchBootId"),
    generation: nonempty(source.generation, "generation"),
    launchAttemptId: nonempty(source.launchAttemptId, "launchAttemptId"),
    launchAttempted: boolean(source.launchAttempted, "launchAttempted"),
    phase: source.phase,
    process: source.process === null ? null : processIdentity(source.process, "process"),
    socketPath: nonempty(source.socketPath, "socketPath"),
    writer: source.writer,
    reconciliation: parseReconciliation(source.reconciliation),
    reason: nullableString(source.reason, "reason"),
  }
  assertHandlerSemantics(record)
  return record
}

function assertHandlerSemantics(record: HandlerGenerationRecord): void {
  if (record.phase === "launch_pending" && (record.writer !== "launcher" || record.process !== null || record.reconciliation !== null)) throw new Error("launch_pending requires launcher ownership, process=null, and reconciliation=null")
  if (record.phase === "identity_published" && (record.writer !== "launcher" || record.process === null || record.reconciliation !== null)) throw new Error("identity_published requires launcher ownership, a process, and reconciliation=null")
  if ((record.phase === "socket_bound" || record.phase === "reconciling" || record.phase === "ready") && (record.writer !== "handler" || record.process === null)) throw new Error(`${record.phase} requires Handler ownership and a process`)
  if (record.phase === "socket_bound" && record.reconciliation !== null) throw new Error("socket_bound requires reconciliation=null")
  if (record.phase === "ready" && (record.reconciliation === null || record.reconciliation.classified !== record.reconciliation.total || record.reason !== null)) throw new Error("ready requires complete classification and reason=null")
  if (record.phase === "exited_unverified" && (record.writer !== "reconciler" || record.reason === null)) throw new Error("exited_unverified requires reconciler ownership and a nonempty reason")
  if (record.phase !== "exited_unverified" && record.reason !== null) throw new Error(`${record.phase} requires reason=null`)
  if (!record.launchAttempted && record.phase !== "launch_pending") throw new Error("an unattempted handler must remain launch_pending")
  if (record.process !== null && record.process.bootId !== record.launchBootId) throw new Error("handler process boot must match launch boot")
}

function currentUid(): number {
  if (process.getuid === undefined) throw new Error("private state requires a POSIX platform")
  return process.getuid()
}

export async function assertPrivateDirectory(path: string): Promise<void> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink()) throw new Error(`${path} is a symlink`)
  if (!stats.isDirectory()) throw new Error(`${path} is not a directory`)
  if (stats.uid !== currentUid()) throw new Error(`${path} has the wrong owner`)
  if ((stats.mode & 0o077) !== 0) throw new Error(`${path} must have private 0700 permissions`)
  if (await realpath(path) !== path) throw new Error(`${path} is not canonical`)
}

async function readJson(path: string): Promise<unknown> {
  await assertPrivateDirectory(dirname(path))
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error(`${path} is not a regular file`)
    if (stats.uid !== currentUid()) throw new Error(`${path} has the wrong owner`)
    if ((stats.mode & 0o077) !== 0) throw new Error(`${path} is not private`)
    if (stats.size > MAX_RECORD_BYTES) throw new Error(`${path} exceeds the 1 MiB size limit`)
    const contents = await handle.readFile({ encoding: "utf8" })
    if (Buffer.byteLength(contents, "utf8") > MAX_RECORD_BYTES) throw new Error(`${path} exceeds the 1 MiB size limit`)
    try {
      return JSON.parse(contents)
    } catch (error) {
      throw new Error(`${path} contains invalid JSON`, { cause: error })
    }
  } finally {
    await handle?.close()
  }
}

async function publish(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error("record cannot be serialized as JSON")
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) throw new Error(`${path} exceeds the 1 MiB size limit`)
  const parent = dirname(path)
  await assertPrivateDirectory(parent)
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`)
  let handle: FileHandle | undefined
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(serialized, { encoding: "utf8" })
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    const parentHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      await parentHandle.sync()
    } finally {
      await parentHandle.close()
    }
  } catch (error) {
    await handle?.close()
    await rm(temporary, { force: true })
    throw error
  }
}

export async function readLaunchRecord(path: string): Promise<LaunchRecord> {
  return parseLaunchRecord(await readJson(path), true)
}

export async function readLaunchRecordForReconciliation(path: string): Promise<LaunchRecord> {
  return parseLaunchRecord(await readJson(path), false)
}

export async function writeLaunchRecord(path: string, record: LaunchRecord): Promise<void> {
  await publish(path, parseLaunchRecord(record, true))
}

export async function readHandlerRecord(path: string): Promise<HandlerGenerationRecord> {
  return parseHandlerRecord(await readJson(path))
}

export async function writeHandlerRecord(path: string, record: HandlerGenerationRecord): Promise<void> {
  const validated = parseHandlerRecord(record)
  if (validated.phase === "exited_unverified") {
    let previous: HandlerGenerationRecord
    try {
      previous = await readHandlerRecord(path)
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") throw new Error("exited_unverified requires an existing prior record with preserved evidence")
      throw error
    }
    if (!isDeepStrictEqual(validated.process, previous.process)) throw new Error("exited_unverified must preserve exact prior process evidence")
    if (!isDeepStrictEqual(validated.reconciliation, previous.reconciliation)) throw new Error("exited_unverified must preserve exact prior reconciliation evidence")
  }
  await publish(path, validated)
}