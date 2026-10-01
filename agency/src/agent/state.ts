import { randomUUID } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises"
import { isAbsolute, join, normalize, relative, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { UUID } from "../control/protocol.js"
import { ensurePrivateChild } from "../handler/environment.js"
import { assertPrivateDirectory, readLaunchRecordForReconciliation } from "../platform/private-state.js"
import type { LaunchRecord, LegacyLaunchRecord } from "../platform/types.js"
import type { LaunchEnvironmentPolicy } from "./qualification.js"
import { AgentError } from "./types.js"

export type PreparedProviderState = { root: string; environment: NodeJS.ProcessEnv }
type RootIdentity = { dev: string; ino: string; uid: string; gid: string; mode: string }
type LaunchIdentity = Pick<LegacyLaunchRecord, "agentId" | "leaseId" | "handlerGeneration" | "launchAttemptId" | "checkoutId" | "launchBootId">
type Marker = { version: 1; launchAttemptId: string; launch: LaunchIdentity; root: RootIdentity }
type RemovalDependencies = { beforeQuarantineRename?: () => Promise<void>; afterQuarantineRemoval?: () => Promise<void> }
type RemovalReceipt = Marker & { status: "pending" | "complete" }

const MARKER = ".agency-state.json"
const receiptName = (attempt: string, status: RemovalReceipt["status"]): string => `.cleanup-${attempt}.${status}.json`
const accepted = new Map<string, RootIdentity>()
const failure = (): never => { throw new AgentError("CLEANUP_UNVERIFIED") }
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT"
const privateMode = (stat: BigIntStats): bigint => stat.mode & 0o777n
const blockedKey = (key: string): boolean => key === "NODE_OPTIONS" || key === "NODE_PATH" || key.startsWith("AGENCY_") || key.startsWith("GIT_")

function canonicalRoot(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || path.endsWith(sep)) failure()
  return path
}

export function providerStatePath(persistentRoot: string, launchAttemptId: string): string {
  if (!UUID.test(launchAttemptId)) failure()
  return join(canonicalRoot(persistentRoot), "agents", "provider-state", launchAttemptId)
}

function identity(stat: BigIntStats): RootIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), gid: String(stat.gid), mode: String(stat.mode) }
}

async function directory(path: string): Promise<RootIdentity> {
  await assertPrivateDirectory(path)
  const before = await lstat(path, { bigint: true })
  if (!before.isDirectory() || before.uid !== BigInt(process.getuid!()) || privateMode(before) !== 0o700n || await realpath(path) !== path) failure()
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const observed = await handle.stat({ bigint: true })
    if (!observed.isDirectory() || !isDeepStrictEqual(identity(observed), identity(before))) failure()
  } finally { await handle.close() }
  if (!isDeepStrictEqual(identity(await lstat(path, { bigint: true })), identity(before))) failure()
  return identity(before)
}

async function makeDirectory(path: string): Promise<RootIdentity> {
  try { await mkdir(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
  return directory(path)
}

function launchIdentity(record: LaunchRecord): LaunchIdentity {
  if (record.version === 1) {
    const { agentId, leaseId, handlerGeneration, launchAttemptId, checkoutId, launchBootId } = record
    return { agentId, leaseId, handlerGeneration, launchAttemptId, checkoutId, launchBootId }
  }
  return failure()
}

async function retainedLaunch(persistentRoot: string, launchAttemptId: string): Promise<LaunchRecord> {
  await directory(persistentRoot)
  await directory(join(persistentRoot, "launches"))
  const record = await readLaunchRecordForReconciliation(join(persistentRoot, "launches", launchAttemptId + ".json"))
  if (record?.launchAttemptId !== launchAttemptId) failure()
  return record
}

function privateRelativePath(value: string): string[] {
  if (!value || isAbsolute(value) || value.includes("\\") || value.split("/").some(part => !part || part === "." || part === ".." || !part.isWellFormed() || /[\x00-\x1f\x7f]/u.test(part))) failure()
  return value.split("/")
}

export function resolvedLaunchEnvironment(root: string, policy: LaunchEnvironmentPolicy): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(policy.fixed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) failure()
    if (key === "GIT_CONFIG_NOSYSTEM") { if (value !== "1") failure() }
    else if (blockedKey(key)) continue
    environment[key] = value
  }
  for (const [key, value] of Object.entries(policy.private)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || blockedKey(key) || Object.hasOwn(environment, key)) failure()
    const target = join(root, ...privateRelativePath(value))
    const within = relative(root, target)
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) failure()
    environment[key] = target
  }
  return environment
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function marker(path: string): Promise<Marker> {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || privateMode(before) !== 0o600n || before.size > 4096n) failure()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !isDeepStrictEqual(identity(opened), identity(before)) || opened.size !== before.size || opened.nlink !== 1n) failure()
    const bytes = await handle.readFile()
    if (bytes.length > 4096 || BigInt(bytes.length) !== before.size) failure()
    const value: unknown = JSON.parse(bytes.toString("utf8"))
    if (typeof value !== "object" || value === null || Array.isArray(value)) failure()
    const parsed = value as Marker
    if (parsed.version !== 1 || !UUID.test(parsed.launchAttemptId) || !parsed.launch || !parsed.root || Object.keys(parsed).length !== 4 || Object.keys(parsed.launch).length !== 6 || Object.keys(parsed.root).length !== 5) failure()
    if (!isDeepStrictEqual(identity(await lstat(path, { bigint: true })), identity(before))) failure()
    return parsed
  } finally { await handle.close() }
}

async function readReceipt(path: string, launch: LaunchRecord, status: RemovalReceipt["status"]): Promise<RemovalReceipt> {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || privateMode(before) !== 0o600n || before.size > 4096n) failure()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== before.size || !isDeepStrictEqual(identity(opened), identity(before))) failure()
    const bytes = await handle.readFile()
    if (bytes.length > 4096 || BigInt(bytes.length) !== before.size) failure()
    const value: unknown = JSON.parse(bytes.toString("utf8"))
    if (typeof value !== "object" || value === null || Array.isArray(value)) failure()
    const parsed = value as RemovalReceipt
    if (parsed.version !== 1 || parsed.status !== status || parsed.launchAttemptId !== launch.launchAttemptId || !parsed.launch || !parsed.root || Object.keys(parsed).length !== 5 || Object.keys(parsed.launch).length !== 6 || Object.keys(parsed.root).length !== 5 || !isDeepStrictEqual(parsed.launch, launchIdentity(launch))) failure()
    if (Object.keys(parsed.root).sort().join() !== "dev,gid,ino,mode,uid" || Object.values(parsed.root).some(part => typeof part !== "string" || !/^(0|[1-9][0-9]*)$/.test(part)) || BigInt(parsed.root.uid) !== BigInt(process.getuid!()) || (BigInt(parsed.root.mode) & 0o170777n) !== 0o040700n) failure()
    const after = await lstat(path, { bigint: true })
    if (after.size !== before.size || after.nlink !== 1n || !isDeepStrictEqual(identity(after), identity(before))) failure()
    return parsed
  } finally { await handle.close() }
}

export async function readProviderStateReceipt(persistentRoot: string, launchAttemptId: string, status: RemovalReceipt["status"]): Promise<RemovalReceipt> {
  try {
    providerStatePath(persistentRoot, launchAttemptId)
    const parent = join(persistentRoot, "agents", "provider-state")
    await directory(persistentRoot); await directory(join(persistentRoot, "agents")); await directory(parent)
    const launch = await retainedLaunch(persistentRoot, launchAttemptId)
    if (launch.phase !== "cleanup_verified") failure()
    return await readReceipt(join(parent, receiptName(launchAttemptId, status)), launch, status)
  }
  catch { return failure() }
}

async function writeReceipt(parent: string, value: RemovalReceipt): Promise<void> {
  const temporary = join(parent, `.cleanup-${value.launchAttemptId}-${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, join(parent, receiptName(value.launchAttemptId, value.status)))
  await syncDirectory(parent)
}

export async function prepareProviderState(persistentRoot: string, launchAttemptId: string, policy: LaunchEnvironmentPolicy): Promise<PreparedProviderState> {
  const root = providerStatePath(persistentRoot, launchAttemptId)
  const environment = resolvedLaunchEnvironment(root, policy)
  try {
    const launch = await retainedLaunch(persistentRoot, launchAttemptId)
    await ensurePrivateChild(persistentRoot, "agents")
    const parent = join(persistentRoot, "agents", "provider-state")
    await makeDirectory(parent)
    await mkdir(root, { mode: 0o700 })
    const rootIdentity = await directory(root)
    for (const value of Object.values(policy.private)) {
      let current = root
      for (const part of privateRelativePath(value)) { current = join(current, part); await makeDirectory(current) }
    }
    const content: Marker = { version: 1, launchAttemptId, launch: launchIdentity(launch), root: rootIdentity }
    const handle = await open(join(root, MARKER), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(JSON.stringify(content)); await handle.sync() } finally { await handle.close() }
    await syncDirectory(root); await syncDirectory(parent)
    if (!isDeepStrictEqual(await directory(root), rootIdentity)) failure()
    accepted.set(root, rootIdentity)
    return { root, environment }
  } catch (error) { throw error instanceof AgentError ? error : new AgentError("CLEANUP_UNVERIFIED") }
}

async function inspectTree(path: string): Promise<void> {
  for (const name of await readdir(path)) {
    const child = join(path, name), stat = await lstat(child, { bigint: true })
    if (stat.uid !== BigInt(process.getuid!()) || stat.isSymbolicLink()) failure()
    if (stat.isDirectory()) { if (privateMode(stat) !== 0o700n) failure(); await directory(child); await inspectTree(child) }
    else if (!stat.isFile() || stat.nlink !== 1n || (privateMode(stat) & 0o077n) !== 0n) failure()
  }
}

export async function removeProviderState(persistentRoot: string, launchAttemptId: string, dependencies: RemovalDependencies = {}): Promise<void> {
  const root = providerStatePath(persistentRoot, launchAttemptId), parent = join(persistentRoot, "agents", "provider-state")
  try {
    await directory(persistentRoot)
    const launch = await retainedLaunch(persistentRoot, launchAttemptId)
    if (launch.phase !== "cleanup_verified") failure()
    try { await directory(join(persistentRoot, "agents")); await directory(parent) }
    catch (error) { if (absent(error) && !accepted.has(root)) return; throw error }
    let original: RootIdentity
    try { original = await directory(root) }
    catch (error) { if (absent(error) && !accepted.has(root)) return; throw error }
    const proof = await marker(join(root, MARKER))
    if (proof.launchAttemptId !== launchAttemptId || !isDeepStrictEqual(proof.launch, launchIdentity(launch)) || !isDeepStrictEqual(proof.root, original) || accepted.has(root) && !isDeepStrictEqual(accepted.get(root), original)) failure()
    for (const status of ["pending", "complete"] as const) {
      try { await lstat(join(parent, receiptName(launchAttemptId, status))); failure() }
      catch (error) { if (!absent(error)) throw error }
    }
    await inspectTree(root)
    await dependencies.beforeQuarantineRename?.()
    const quarantine = join(parent, `.cleanup-${launchAttemptId}-${randomUUID()}`)
    await rename(root, quarantine)
    const moved = await directory(quarantine)
    if (!isDeepStrictEqual(moved, original)) failure()
    const movedProof = await marker(join(quarantine, MARKER))
    if (!isDeepStrictEqual(movedProof, proof)) failure()
    await inspectTree(quarantine)
    await writeReceipt(parent, { ...proof, status: "pending" })
    await rm(quarantine, { recursive: true })
    await dependencies.afterQuarantineRemoval?.()
    await syncDirectory(parent)
    await writeReceipt(parent, { ...proof, status: "complete" })
    accepted.delete(root)
  } catch { failure() }
}