import { readFileSync } from "node:fs"

export function readDistDigest(path: string): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (typeof value !== "object" || value === null) return null
    const digest = (value as { distDigest?: unknown }).distDigest
    return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : null
  } catch { return null }
}