import { lstat, mkdir, realpath } from "node:fs/promises"
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path"

export type PlatformPathInputs = {
  platform: "darwin" | "linux"
  uid: number
  hostKey: string
  home: string
  xdgStateHome?: string
}

export type PlatformPaths = {
  hostKey: string
  persistentRoot: string
  runtimeRoot: string
  handlerSocketPath: string
}

async function lstatOrCreate(path: string): ReturnType<typeof lstat> {
  try {
    return await lstat(path)
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error
    await mkdir(path, { mode: 0o700 })
    return lstat(path)
  }
}

async function ensureBaseDirectory(path: string): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const components = relative(root, absolute).split(sep).filter(Boolean)
  let current = root
  for (const component of components) {
    current = join(current, component)
    const stats = await lstatOrCreate(current)
    if (stats.isSymbolicLink()) throw new Error(`${current} is a symlink component`)
    if (!stats.isDirectory()) throw new Error(`${current} is not a directory`)
  }
  if (await realpath(absolute) !== absolute) throw new Error(`${absolute} is not canonical`)
}

async function ensureOwnedDirectory(parent: string, component: string, uid: number): Promise<string> {
  const path = join(parent, component)
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error
  }
  const stats = await lstat(path)
  if (stats.isSymbolicLink()) throw new Error(`${path} is a symlink`)
  if (!stats.isDirectory()) throw new Error(`${path} is not a directory`)
  if (stats.uid !== uid) throw new Error(`${path} has the wrong owner`)
  if ((stats.mode & 0o777) !== 0o700) throw new Error(`${path} must have mode 0700`)
  if (await realpath(path) !== path) throw new Error(`${path} is not canonical`)
  return path
}

async function assertRuntimeParent(path: string): Promise<void> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink()) throw new Error(`${path} is a symlink`)
  if (!stats.isDirectory()) throw new Error(`${path} is not a directory`)
  if (stats.uid !== 0) throw new Error(`${path} must be root-owned`)
  if ((stats.mode & 0o1000) === 0) throw new Error(`${path} must have the sticky bit`)
  if (await realpath(path) !== path) throw new Error(`${path} is not canonical`)
}

export async function resolvePlatformPaths(inputs: PlatformPathInputs): Promise<PlatformPaths> {
  if (!Number.isSafeInteger(inputs.uid) || inputs.uid < 0) throw new Error("uid is invalid")
  if (!/^[0-9a-f]{64}$/.test(inputs.hostKey)) throw new Error("hostKey must be lowercase SHA-256 hex")
  if (!isAbsolute(inputs.home)) throw new Error("home must be absolute")
  const persistentBase = inputs.xdgStateHome ?? join(await realpath(inputs.home), ".local/state")
  if (!isAbsolute(persistentBase)) throw new Error("persistent state path must be absolute")
  const previousUmask = process.umask(0o077)
  try {
    await ensureBaseDirectory(persistentBase)
    const agency = await ensureOwnedDirectory(persistentBase, "agency", inputs.uid)
    const hosts = await ensureOwnedDirectory(agency, "hosts", inputs.uid)
    const persistentRoot = await ensureOwnedDirectory(hosts, inputs.hostKey, inputs.uid)
    const runtimeParent = inputs.platform === "darwin" ? "/private/tmp" : "/tmp"
    await assertRuntimeParent(runtimeParent)
    const runtimeRoot = await ensureOwnedDirectory(runtimeParent, `agy-${inputs.uid}-${inputs.hostKey.slice(0, 12)}`, inputs.uid)
    const handlerSocketPath = join(runtimeRoot, "handler.sock")
    if (Buffer.byteLength(handlerSocketPath, "utf8") >= 100) throw new Error("handler socket path must be below 100 UTF-8 bytes")
    return { hostKey: inputs.hostKey, persistentRoot, runtimeRoot, handlerSocketPath }
  } finally {
    process.umask(previousUmask)
  }
}