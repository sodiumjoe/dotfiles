import { createHash } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { assertPrivateDirectory } from "../platform/private-state.js"
import { absolutePath, CatalogError, invalid, keys, object, providerId, text, type ConfigEvidence, type ProviderProfile } from "./types.js"

export const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex")
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT"
function identity(s: BigIntStats): string[] { return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.nlink].map(String) }

export async function readBoundedFile(path: string, max: number, privateFile = false): Promise<Buffer | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(max) || (privateFile && (before.uid !== BigInt(process.getuid!()) || before.nlink !== 1n || (before.mode & 0o077n) !== 0n))) invalid()
    const bytes = Buffer.alloc(max + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > max || !isDeepStrictEqual(identity(before), identity(await handle.stat({ bigint: true }))) || !isDeepStrictEqual(identity(before), identity(await lstat(path, { bigint: true })))) invalid()
    return bytes.subarray(0, length)
  } catch (error) { if (missing(error)) return null; if (error instanceof CatalogError) throw error; return invalid() }
  finally { await handle?.close() }
}
export function decodeJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { return invalid() }
}
export function parseProfile(input: unknown): ProviderProfile {
  const v = object(input)
  keys(v, ["id", "enabled", "executable", "adapterPackageJson", "sdkPackageJson", "configurationFiles"])
  const id = providerId(v.id)
  if (typeof v.enabled !== "boolean" || !Array.isArray(v.configurationFiles) || v.configurationFiles.length > 16) invalid()
  const configurationFiles = v.configurationFiles.map(absolutePath)
  if (new Set(configurationFiles).size !== configurationFiles.length) invalid()
  if (id === "codex-acp" && v.sdkPackageJson !== null) invalid()
  return { id, enabled: v.enabled, executable: absolutePath(v.executable), adapterPackageJson: absolutePath(v.adapterPackageJson), sdkPackageJson: id === "codex-acp" ? null : absolutePath(v.sdkPackageJson), configurationFiles }
}
export async function readProfiles(root: string): Promise<ProviderProfile[]> {
  try {
    await assertPrivateDirectory(root)
    const catalog = join(root, "catalog")
    try { await assertPrivateDirectory(catalog) } catch (error) { if (missing(error)) return []; throw error }
    const bytes = await readBoundedFile(join(catalog, "providers.json"), 65536, true)
    if (bytes === null) return []
    const v = object(decodeJson(bytes))
    keys(v, ["version", "providers"])
    if (v.version !== 1 || !Array.isArray(v.providers) || v.providers.length > 2) invalid()
    const profiles = v.providers.map(parseProfile)
    if (new Set(profiles.map(value => value.id)).size !== profiles.length) invalid()
    return profiles.sort((a, b) => a.id < b.id ? -1 : 1)
  } catch (error) { if (error instanceof CatalogError) throw error; return invalid() }
}
async function fileIdentity(path: string): Promise<unknown> {
  if (await realpath(path) !== path) invalid()
  const stat = await lstat(path, { bigint: true })
  if (!stat.isFile()) invalid()
  return [path, identity(stat)]
}
function adapterMain(profile: ProviderProfile, value: unknown): string {
  const metadata = object(value), main = text(metadata.main, 4096)
  if (metadata.name !== "@agentclientprotocol/" + profile.id || isAbsolute(main) || normalize(main) !== main || main.includes("\\") || main.split("/").some(part => part === "" || part === "." || part === "..")) invalid()
  return join(dirname(profile.adapterPackageJson), main)
}
export async function adapterEntry(input: ProviderProfile): Promise<string> {
  try {
    const profile = parseProfile(input), bytes = await readBoundedFile(profile.adapterPackageJson, 1024 * 1024)
    if (bytes === null) invalid()
    const entry = adapterMain(profile, decodeJson(bytes)), before = await fileIdentity(entry), after = await fileIdentity(entry)
    if (!isDeepStrictEqual(before, after)) throw new CatalogError("CONFIG_CHANGED")
    return entry
  } catch (error) { if (error instanceof CatalogError) throw error; return invalid() }
}
export async function sdkEntry(profile: ProviderProfile): Promise<string> {
  if (profile.sdkPackageJson === null) invalid()
  const bytes = await readBoundedFile(profile.sdkPackageJson, 1024 * 1024)
  if (bytes === null) invalid()
  const metadata = object(decodeJson(bytes)), main = text(metadata.main)
  if (metadata.name !== "@anthropic-ai/claude-agent-sdk") invalid()
  if (metadata.version !== "0.3.232") throw new CatalogError("UNSUPPORTED_PROVIDER_VERSION")
  if (!/^[a-zA-Z0-9_.-]+\.m?js$/.test(main)) invalid()
  const entry = join(dirname(profile.sdkPackageJson), main)
  await fileIdentity(entry)
  return entry
}
export async function observeConfig(input: ProviderProfile): Promise<ConfigEvidence> {
  try {
    const profile = parseProfile(input), evidence: unknown[] = [1, "declared-config-v1", profile]
    let size = 0
    const file = async (path: string, absent = false, max = 1024 * 1024): Promise<Buffer | null> => {
      let before
      try { before = await fileIdentity(path) } catch (error) {
        if (absent && missing(error)) { evidence.push([path, null]); return null }
        throw error
      }
      const bytes = await readBoundedFile(path, max)
      if (bytes === null || !isDeepStrictEqual(before, await fileIdentity(path))) throw new CatalogError("CONFIG_CHANGED")
      size += bytes.length
      if (size > 8 * 1024 * 1024) invalid()
      evidence.push([before, digest(bytes)])
      return bytes
    }
    evidence.push(await fileIdentity(profile.executable))
    const adapter = object(decodeJson((await file(profile.adapterPackageJson))!))
    if (adapter.name !== "@agentclientprotocol/" + profile.id) invalid()
    const adapterVersion = text(adapter.version)
    await file(adapterMain(profile, adapter), false, 8 * 1024 * 1024)
    let sdkVersion: string | null = null
    if (profile.sdkPackageJson !== null) {
      const sdk = object(decodeJson((await file(profile.sdkPackageJson))!))
      if (sdk.name !== "@anthropic-ai/claude-agent-sdk") invalid()
      if (sdk.version !== "0.3.232") throw new CatalogError("UNSUPPORTED_PROVIDER_VERSION")
      sdkVersion = sdk.version
      evidence.push(await fileIdentity(await sdkEntry(profile)))
    }
    for (const path of profile.configurationFiles) await file(path, true)
    return { fingerprint: digest(JSON.stringify(evidence)), scope: "declared-config-v1", providerId: profile.id, adapterVersion, sdkVersion }
  } catch (error) { if (error instanceof CatalogError) throw error; return invalid() }
}