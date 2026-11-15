import { randomUUID } from "node:crypto"
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type IndexEntry = { version: 1; agentId: string; backendId: "claude-agent-acp" | "codex-acp"; nativeSessionId: string; cwd: string; createdAt: string; origin: "new" | "import" }
export type AgentIndex = { ensure(entry: IndexEntry): Promise<boolean>; list(): Promise<IndexEntry[]>; remove(agentId: string): Promise<void>; migrated(): Promise<boolean>; markMigrated(): Promise<void> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function parseEntry(value: unknown): IndexEntry | null {
  const v = value as Partial<IndexEntry> | null
  if (!v || v.version !== 1 || typeof v.agentId !== "string" || !UUID.test(v.agentId) || (v.backendId !== "claude-agent-acp" && v.backendId !== "codex-acp")
    || typeof v.nativeSessionId !== "string" || !v.nativeSessionId || typeof v.cwd !== "string" || !v.cwd.startsWith("/") || typeof v.createdAt !== "string" || (v.origin !== "new" && v.origin !== "import")) return null
  return { version: 1, agentId: v.agentId, backendId: v.backendId, nativeSessionId: v.nativeSessionId, cwd: v.cwd, createdAt: v.createdAt, origin: v.origin }
}

export function createAgentIndex(root: string): AgentIndex {
  const dir = join(root, "agents", "index"), file = (agentId: string) => join(dir, agentId + ".json")
  return {
    async ensure(entry) {
      if (!UUID.test(entry.agentId)) throw new Error("invalid agent ID")
      await mkdir(dir, { recursive: true, mode: 0o700 })
      if (await stat(file(entry.agentId)).then(() => true, () => false)) return false
      const temporary = join(dir, `.${entry.agentId}.${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 })
      try { await link(temporary, file(entry.agentId)); return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error }
      finally { await rm(temporary, { force: true }) }
    },
    async list() {
      let names: string[]
      try { names = await readdir(dir) } catch { return [] }
      const entries: IndexEntry[] = []
      for (const name of names.filter(name => name.endsWith(".json") && !name.startsWith(".")).sort()) {
        try { const parsed = parseEntry(JSON.parse(await readFile(join(dir, name), "utf8"))); if (parsed && name === parsed.agentId + ".json") entries.push(parsed) } catch {}
      }
      return entries
    },
    async remove(agentId) { if (UUID.test(agentId)) await rm(file(agentId), { force: true }) },
    migrated: () => stat(join(dir, ".migrated")).then(() => true, () => false),
    async markMigrated() { await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(join(dir, ".migrated"), new Date().toISOString(), { mode: 0o600 }) },
  }
}