import { createHash } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, open, readlink, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { AgentError } from "./types.js"

export type SecurityIdentity = readonly [
  dev: string, ino: string, size: string, mtimeNs: string, ctimeNs: string,
  mode: string, uid: string, gid: string, nlink: string,
]

export type CodexUserSecurityStatePolicy = {
  version: 1
  root: { path: string; identity: SecurityIdentity }
  config: {
    path: string
    identity: SecurityIdentity
    linkTarget: string
    target: { path: string; sha256: string; identity: SecurityIdentity }
  }
  absent: readonly [string, string]
}

export type CodexUserSecurityStateMismatch =
  | "root_missing" | "root_kind" | "root_identity"
  | "config_missing" | "config_kind" | "config_identity" | "config_link_target"
  | "config_target_missing" | "config_target_kind" | "config_target_identity" | "config_target_hash"
  | "auth_present" | "requirements_present"

export type CodexUserSecurityStateUnavailable =
  | "root_unavailable" | "config_unavailable" | "config_target_unavailable"
  | "auth_unavailable" | "requirements_unavailable"

export type CodexUserSecurityStateCheck =
  | { outcome: "match"; reason: null; observation: CodexUserSecurityStatePolicy }
  | { outcome: "mismatch"; reason: CodexUserSecurityStateMismatch; observation: null }
  | { outcome: "unavailable"; reason: CodexUserSecurityStateUnavailable; observation: null }

export type CodexUserSecurityStateInput = {
  root: string
  configPath: string
  configLinkTarget: string
  configTargetPath: string
  absent: readonly [string, string]
}

export type CodexUserSecurityStateIO = Readonly<{
  lstat: typeof lstat
  readlink: typeof readlink
  realpath: typeof realpath
  open: typeof open
}>

const defaultIO: CodexUserSecurityStateIO = { lstat, readlink, realpath, open }
const MAX_CONFIG_BYTES = 1_048_576

function invalid(): never { throw new AgentError("ADAPTER_UNQUALIFIED") }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
  return value as Record<string, unknown>
}
function canonicalPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4096 || !value.isWellFormed() || /[\x00-\x1f\x7f]/u.test(value) || !isAbsolute(value) || normalize(value) !== value || value.endsWith("/") || value.split("/").includes("..")) invalid()
  return value
}
function identity(value: unknown): SecurityIdentity {
  if (!Array.isArray(value) || value.length !== 9 || value.some(part => typeof part !== "string" || !/^(0|[1-9][0-9]*)$/.test(part))) invalid()
  return [...value] as unknown as SecurityIdentity
}
function linkTarget(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4096 || !value.isWellFormed() || /[\x00-\x1f\x7f]/u.test(value) || isAbsolute(value)) invalid()
  return value
}
function decodeLinkTarget(value: unknown): string {
  if (!Buffer.isBuffer(value)) throw new TypeError("invalid link bytes")
  return new TextDecoder("utf-8", { fatal: true }).decode(value)
}
function parse(value: unknown): CodexUserSecurityStatePolicy {
  const policy = record(value, ["version", "root", "config", "absent"])
  if (policy.version !== 1) invalid()
  const root = record(policy.root, ["path", "identity"])
  const config = record(policy.config, ["path", "identity", "linkTarget", "target"])
  const target = record(config.target, ["path", "sha256", "identity"])
  const rootPath = canonicalPath(root.path), configPath = canonicalPath(config.path), targetPath = canonicalPath(target.path)
  const relativeTarget = linkTarget(config.linkTarget)
  const targetIdentity = identity(target.identity)
  if (typeof target.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(target.sha256) || BigInt(targetIdentity[2]) > BigInt(MAX_CONFIG_BYTES)) invalid()
  if (!Array.isArray(policy.absent) || policy.absent.length !== 2) invalid()
  const absent = [canonicalPath(policy.absent[0]), canonicalPath(policy.absent[1])] as const
  if (configPath !== join(rootPath, "config.toml") || absent[0] !== join(rootPath, "auth.json") || absent[1] !== join(rootPath, "requirements.toml") || resolve(dirname(configPath), relativeTarget) !== targetPath || new Set([rootPath, configPath, targetPath, ...absent]).size !== 5) invalid()
  return { version: 1, root: { path: rootPath, identity: identity(root.identity) }, config: { path: configPath, identity: identity(config.identity), linkTarget: relativeTarget, target: { path: targetPath, sha256: target.sha256, identity: targetIdentity } }, absent }
}
export function parseCodexUserSecurityStatePolicy(value: unknown): CodexUserSecurityStatePolicy {
  try { return parse(value) } catch { return invalid() }
}
function statIdentity(stat: BigIntStats): SecurityIdentity {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].map(String) as unknown as SecurityIdentity
}
function validRoot(stat: BigIntStats): boolean {
  return stat.isDirectory() && stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o022n) === 0n
}
async function hashTarget(path: string, expected: SecurityIdentity, io: CodexUserSecurityStateIO): Promise<string> {
  const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !isDeepStrictEqual(statIdentity(opened), expected)) invalid()
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(64 * 1024)
    let bytes = 0
    while (bytes < MAX_CONFIG_BYTES) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, MAX_CONFIG_BYTES - bytes), null)
      if (result.bytesRead === 0) break
      bytes += result.bytesRead
      if (bytes > MAX_CONFIG_BYTES) invalid()
      hash.update(buffer.subarray(0, result.bytesRead))
    }
    if (BigInt(bytes) !== opened.size || !isDeepStrictEqual(statIdentity(await handle.stat({ bigint: true })), expected)) invalid()
    return hash.digest("hex")
  } finally { await handle.close() }
}
async function capture(input: CodexUserSecurityStateInput, io: CodexUserSecurityStateIO): Promise<CodexUserSecurityStatePolicy> {
  const root = await io.lstat(input.root, { bigint: true })
  if (!validRoot(root) || await io.realpath(input.root) !== input.root) invalid()
  const config = await io.lstat(input.configPath, { bigint: true })
  if (!config.isSymbolicLink() || decodeLinkTarget(await io.readlink(input.configPath, { encoding: "buffer" })) !== input.configLinkTarget || await io.realpath(input.configPath) !== input.configTargetPath) invalid()
  const target = await io.lstat(input.configTargetPath, { bigint: true })
  if (!target.isFile() || target.nlink !== 1n || target.size > BigInt(MAX_CONFIG_BYTES)) invalid()
  for (const path of input.absent) {
    try { await io.lstat(path, { bigint: true }); invalid() } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  const sha256 = await hashTarget(input.configTargetPath, statIdentity(target), io)
  if (!isDeepStrictEqual(statIdentity(await io.lstat(input.configTargetPath, { bigint: true })), statIdentity(target)) || !isDeepStrictEqual(statIdentity(await io.lstat(input.configPath, { bigint: true })), statIdentity(config)) || !isDeepStrictEqual(statIdentity(await io.lstat(input.root, { bigint: true })), statIdentity(root))) invalid()
  for (const path of input.absent) {
    try { await io.lstat(path, { bigint: true }); invalid() } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  return parse({ version: 1, root: { path: input.root, identity: statIdentity(root) }, config: { path: input.configPath, identity: statIdentity(config), linkTarget: input.configLinkTarget, target: { path: input.configTargetPath, sha256, identity: statIdentity(target) } }, absent: input.absent })
}
export async function pinCodexUserSecurityStatePolicy(input: CodexUserSecurityStateInput, io: CodexUserSecurityStateIO = defaultIO): Promise<CodexUserSecurityStatePolicy> {
  try {
    const policy = parse({ version: 1, root: { path: input.root, identity: Array(9).fill("0") }, config: { path: input.configPath, identity: Array(9).fill("0"), linkTarget: input.configLinkTarget, target: { path: input.configTargetPath, sha256: "0".repeat(64), identity: Array(9).fill("0") } }, absent: input.absent })
    return await capture({ root: policy.root.path, configPath: policy.config.path, configLinkTarget: policy.config.linkTarget, configTargetPath: policy.config.target.path, absent: policy.absent }, io)
  } catch { return invalid() }
}

class ObservationFailure extends Error {
  constructor(readonly outcome: "mismatch" | "unavailable", readonly reason: CodexUserSecurityStateMismatch | CodexUserSecurityStateUnavailable) { super(reason) }
}

function mismatch(reason: CodexUserSecurityStateMismatch): never { throw new ObservationFailure("mismatch", reason) }
function unavailable(reason: CodexUserSecurityStateUnavailable): never { throw new ObservationFailure("unavailable", reason) }
function errorCode(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined }

async function required<T>(operation: () => Promise<T>, missing: CodexUserSecurityStateMismatch, inaccessible: CodexUserSecurityStateUnavailable): Promise<T> {
  try { return await operation() } catch (error) {
    if (error instanceof ObservationFailure) throw error
    if (errorCode(error) === "ENOENT") mismatch(missing)
    unavailable(inaccessible)
  }
}

function checkedStat(stat: BigIntStats, reason: CodexUserSecurityStateUnavailable): BigIntStats {
  if (typeof stat !== "object" || stat === null || typeof stat.isDirectory !== "function" || typeof stat.isSymbolicLink !== "function" || typeof stat.isFile !== "function" || [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].some(value => typeof value !== "bigint")) unavailable(reason)
  return stat
}

function checkedText(value: string, reason: CodexUserSecurityStateUnavailable): string {
  if (typeof value !== "string" || !value.isWellFormed()) unavailable(reason)
  return value
}

async function absent(path: string, present: "auth_present" | "requirements_present", inaccessible: "auth_unavailable" | "requirements_unavailable", io: CodexUserSecurityStateIO): Promise<void> {
  try { await io.lstat(path, { bigint: true }) } catch (error) {
    if (errorCode(error) === "ENOENT") return
    unavailable(inaccessible)
  }
  mismatch(present)
}

async function observedHashTarget(policy: CodexUserSecurityStatePolicy, io: CodexUserSecurityStateIO): Promise<string> {
  const path = policy.config.target.path
  const expected = policy.config.target.identity
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
    if (errorCode(error) === "ENOENT") mismatch("config_target_missing")
    if (errorCode(error) === "ELOOP") mismatch("config_target_kind")
    unavailable("config_target_unavailable")
  }
  try {
    const opened = checkedStat(await required(() => handle.stat({ bigint: true }), "config_target_missing", "config_target_unavailable"), "config_target_unavailable")
    if (!opened.isFile()) mismatch("config_target_kind")
    if (!isDeepStrictEqual(statIdentity(opened), expected)) mismatch("config_target_identity")
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(64 * 1024)
    let bytes = 0
    while (bytes < MAX_CONFIG_BYTES) {
      const requested = Math.min(buffer.length, MAX_CONFIG_BYTES - bytes)
      const result = await required(() => handle.read(buffer, 0, requested, null), "config_target_missing", "config_target_unavailable")
      if (typeof result !== "object" || result === null || !Number.isInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > requested) unavailable("config_target_unavailable")
      if (result.bytesRead === 0) break
      bytes += result.bytesRead
      if (bytes > MAX_CONFIG_BYTES) mismatch("config_target_identity")
      hash.update(buffer.subarray(0, result.bytesRead))
    }
    const final = checkedStat(await required(() => handle.stat({ bigint: true }), "config_target_missing", "config_target_unavailable"), "config_target_unavailable")
    if (!final.isFile()) mismatch("config_target_kind")
    if (!isDeepStrictEqual(statIdentity(final), expected) || BigInt(bytes) !== opened.size) mismatch("config_target_identity")
    return hash.digest("hex")
  } finally {
    try { await handle.close() } catch { unavailable("config_target_unavailable") }
  }
}

export async function observeCodexUserSecurityState(policy: CodexUserSecurityStatePolicy, io: CodexUserSecurityStateIO = defaultIO): Promise<CodexUserSecurityStateCheck> {
  const expected = parseCodexUserSecurityStatePolicy(policy)
  let stage: CodexUserSecurityStateUnavailable = "root_unavailable"
  try {
    const root = checkedStat(await required(() => io.lstat(expected.root.path, { bigint: true }), "root_missing", "root_unavailable"), "root_unavailable")
    if (!root.isDirectory()) mismatch("root_kind")
    if (!validRoot(root) || !isDeepStrictEqual(statIdentity(root), expected.root.identity)) mismatch("root_identity")
    const resolvedRoot = checkedText(await required(() => io.realpath(expected.root.path), "root_missing", "root_unavailable"), "root_unavailable")
    if (resolvedRoot !== expected.root.path) mismatch("root_identity")
    stage = "config_unavailable"
    const link = checkedStat(await required(() => io.lstat(expected.config.path, { bigint: true }), "config_missing", "config_unavailable"), "config_unavailable")
    if (!link.isSymbolicLink()) mismatch("config_kind")
    if (!isDeepStrictEqual(statIdentity(link), expected.config.identity)) mismatch("config_identity")
    const rawLink = await required(() => io.readlink(expected.config.path, { encoding: "buffer" }), "config_missing", "config_unavailable")
    let text: string
    try { text = decodeLinkTarget(rawLink) } catch { unavailable("config_unavailable") }
    if (text !== expected.config.linkTarget) mismatch("config_link_target")
    const resolvedTarget = checkedText(await required(() => io.realpath(expected.config.path), "config_target_missing", "config_unavailable"), "config_unavailable")
    if (resolvedTarget !== expected.config.target.path) mismatch("config_link_target")
    stage = "config_target_unavailable"
    const target = checkedStat(await required(() => io.lstat(expected.config.target.path, { bigint: true }), "config_target_missing", "config_target_unavailable"), "config_target_unavailable")
    if (!target.isFile()) mismatch("config_target_kind")
    if (target.nlink !== 1n || target.size > BigInt(MAX_CONFIG_BYTES) || !isDeepStrictEqual(statIdentity(target), expected.config.target.identity)) mismatch("config_target_identity")
    stage = "auth_unavailable"
    await absent(expected.absent[0], "auth_present", "auth_unavailable", io)
    stage = "requirements_unavailable"
    await absent(expected.absent[1], "requirements_present", "requirements_unavailable", io)
    stage = "config_target_unavailable"
    const sha256 = await observedHashTarget(expected, io)
    if (sha256 !== expected.config.target.sha256) mismatch("config_target_hash")
    const finalTarget = checkedStat(await required(() => io.lstat(expected.config.target.path, { bigint: true }), "config_target_missing", "config_target_unavailable"), "config_target_unavailable")
    if (!finalTarget.isFile()) mismatch("config_target_kind")
    if (!isDeepStrictEqual(statIdentity(finalTarget), expected.config.target.identity)) mismatch("config_target_identity")
    stage = "config_unavailable"
    const finalLink = checkedStat(await required(() => io.lstat(expected.config.path, { bigint: true }), "config_missing", "config_unavailable"), "config_unavailable")
    if (!finalLink.isSymbolicLink()) mismatch("config_kind")
    if (!isDeepStrictEqual(statIdentity(finalLink), expected.config.identity)) mismatch("config_identity")
    stage = "root_unavailable"
    const finalRoot = checkedStat(await required(() => io.lstat(expected.root.path, { bigint: true }), "root_missing", "root_unavailable"), "root_unavailable")
    if (!finalRoot.isDirectory()) mismatch("root_kind")
    if (!isDeepStrictEqual(statIdentity(finalRoot), expected.root.identity)) mismatch("root_identity")
    stage = "auth_unavailable"
    await absent(expected.absent[0], "auth_present", "auth_unavailable", io)
    stage = "requirements_unavailable"
    await absent(expected.absent[1], "requirements_present", "requirements_unavailable", io)
    return { outcome: "match", reason: null, observation: expected }
  } catch (error) {
    if (error instanceof ObservationFailure) return { outcome: error.outcome, reason: error.reason, observation: null } as CodexUserSecurityStateCheck
    return { outcome: "unavailable", reason: stage, observation: null }
  }
}