import { open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { HandlerOptions } from "../src/handler/daemon.js"

export type CleanupPhase = "intent" | "work" | "receipt" | "snapshot" | "metadata" | "launch" | "intent-removed"
export type RetentionFixtureOptions = { retentionNow?: number; cleanupPauseAt?: CleanupPhase; cleanupFailAt?: CleanupPhase }
export function fixtureRetention(root: string, persistentRoot: string, config: RetentionFixtureOptions): NonNullable<HandlerOptions["retention"]> {
  let paused = false
  const phase = (path: string): CleanupPhase | null => {
    const key = relative(persistentRoot, path)
    if (key === "retention/pending.json") return "intent-removed"
    if (key.startsWith("catalog/work/")) return "work"
    if (key.includes("/commands/") || key.includes("/automatic/") || key.startsWith("shutdown/") || key.startsWith("agents/records/")) return "receipt"
    if (key.startsWith("catalog/snapshots/")) return "snapshot"
    if (key.startsWith("catalog/probe-meta/")) return "metadata"
    if (key.startsWith("launches/") || key.startsWith("catalog/probe-launches/")) return "launch"
    return null
  }
  async function barrier(name: CleanupPhase | null): Promise<void> {
    if (paused || name !== config.cleanupPauseAt) return
    paused = true
    await writeFile(join(root, "cleanup-barrier.json"), JSON.stringify({ name, pid: process.pid }), { mode: 0o600 })
    while (true) {
      try { await readFile(join(root, "release-cleanup")); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  return { ...(config.retentionNow === undefined ? {} : { now: () => config.retentionNow! }), filesystem: {
    open,
    async rename(from, to) { await rename(from, to); if (relative(persistentRoot, String(to)) === "retention/pending.json") await barrier("intent") },
    async unlink(path) { const name = phase(String(path)); if (name && config.cleanupFailAt === name) throw new Error("fixture cleanup failure at " + name); await unlink(path); await barrier(name) },
    async rmdir(path) { const name = phase(String(path)); if (name && config.cleanupFailAt === name) throw new Error("fixture cleanup failure at " + name); await rmdir(path); await barrier(name) },
  } }
}