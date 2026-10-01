import { createHash } from "node:crypto"

export type LaunchEnvironment = Readonly<Record<string, string>>

export const MAX_ENVIRONMENT_ENTRIES = 4096
export const MAX_ENVIRONMENT_BYTES = 256 * 1024

export function snapshotLaunchEnvironment(source: NodeJS.ProcessEnv): LaunchEnvironment {
  const entries = Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined)
  return parseLaunchEnvironment(Object.fromEntries(entries))
}

export function parseLaunchEnvironment(value: unknown): LaunchEnvironment {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error()
    const environment: Record<string, string> = {}
    let entryCount = 0, byteCount = 0
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "string" || key.length === 0 || key.includes("=") || key.includes("\0") || item.includes("\0") || !key.isWellFormed() || !item.isWellFormed()) throw new Error()
      entryCount++
      byteCount += Buffer.byteLength(key, "utf8") + Buffer.byteLength(item, "utf8") + 2
      if (entryCount > MAX_ENVIRONMENT_ENTRIES || byteCount > MAX_ENVIRONMENT_BYTES) throw new Error()
      Object.defineProperty(environment, key, { value: item, enumerable: true, writable: true, configurable: true })
    }
    return environment
  } catch {
    throw new Error("invalid launch environment")
  }
}

export function launchEnvironmentDigest(value: LaunchEnvironment): string {
  const entries = Object.entries(parseLaunchEnvironment(value)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex")
}