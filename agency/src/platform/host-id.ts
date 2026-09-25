import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { execFile as execFileCallback } from "node:child_process"
import { lstat as fsLstat, open, realpath as fsRealpath } from "node:fs/promises"
import { promisify } from "node:util"

type TrustedStats = Pick<Stats, "mode" | "uid" | "isFile" | "isSymbolicLink">

export type HostIdDependencies = {
  lstat(path: string): Promise<TrustedStats>
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<string>
  execFile(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>
}

const execFile = promisify(execFileCallback)

const defaults: HostIdDependencies = {
  lstat: fsLstat,
  realpath: fsRealpath,
  readFile: async path => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return await handle.readFile({ encoding: "utf8" })
    } finally {
      await handle.close()
    }
  },
  execFile: async (file, args) => {
    const result = await execFile(file, args, { encoding: "utf8", shell: false })
    return { stdout: result.stdout, stderr: result.stderr }
  },
}

async function assertTrustedFile(path: string, dependencies: HostIdDependencies): Promise<void> {
  const stats = await dependencies.lstat(path)
  if (stats.isSymbolicLink()) throw new Error(`${path} must not be a symlink`)
  if (!stats.isFile()) throw new Error(`${path} must be a regular file`)
  if (stats.uid !== 0) throw new Error(`${path} must be root-owned`)
  if ((stats.mode & 0o022) !== 0) throw new Error(`${path} must not be group/world writable`)
  if (await dependencies.realpath(path) !== path) throw new Error(`${path} must resolve canonically`)
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export async function readHostId(platform: "darwin" | "linux", dependencies: HostIdDependencies = defaults): Promise<string> {
  if (platform === "darwin") {
    const path = "/usr/sbin/ioreg"
    await assertTrustedFile(path, dependencies)
    const { stdout } = await dependencies.execFile(path, ["-rd1", "-c", "IOPlatformExpertDevice"])
    const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/)
    if (match?.[1] === undefined) throw new Error("ioreg output does not contain IOPlatformUUID")
    return hash(match[1].toLowerCase())
  }
  const path = "/etc/machine-id"
  await assertTrustedFile(path, dependencies)
  const machineId = (await dependencies.readFile(path)).trim().toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(machineId)) throw new Error("machine identity is malformed")
  return hash(machineId)
}