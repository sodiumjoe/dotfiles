import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { AgentIndex } from "./agent-index.js"
import { codexSessionFiles, sessionFile, type SessionHomes } from "./excerpt.js"
import type { EventLog } from "../handler/event-log.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
type RecordFields = { agentId: string; backendId: "claude-agent-acp" | "codex-acp"; cwd: string; origin: "new" | "import"; sessionId: string | null }

async function recordFiles(root: string, events?: EventLog): Promise<{ records: RecordFields[]; unreadable: number }> {
  const directory = join(root, "agents/records"), records: RecordFields[] = [], names = await readdir(directory).catch(() => [] as string[])
  let unreadable = 0
  for (const name of names.filter(value => value.endsWith(".json")).sort()) {
    try {
      const value = JSON.parse(await readFile(join(directory, name), "utf8")), definition = value?.definition
      if (value?.version !== 3 || typeof definition?.agentId !== "string" || !UUID.test(definition.agentId) || (definition.backendId !== "claude-agent-acp" && definition.backendId !== "codex-acp") || typeof definition.cwd !== "string" || (definition.origin !== "new" && definition.origin !== "import")) throw new Error("not a version 3 agent record")
      records.push({ agentId: definition.agentId, backendId: definition.backendId, cwd: definition.cwd, origin: definition.origin, sessionId: typeof value.session?.sessionId === "string" ? value.session.sessionId : null })
    } catch (error) { unreadable++; events?.append({ type: "index_migration_skipped", file: name, reason: String(error instanceof Error ? error.message : error).slice(0, 256) }) }
  }
  return { records, unreadable }
}

export async function migrateIndex(input: { root: string; index: AgentIndex; homes: SessionHomes; events?: EventLog }): Promise<{ migrated: number; skipped: number; failed: number } | null> {
  if (await input.index.migrated()) return null
  const { records, unreadable } = await recordFiles(input.root, input.events), codexFiles = await codexSessionFiles(input.homes.codexHome)
  let migrated = 0, skipped = unreadable, failed = 0
  for (const record of records) {
    const ref = record.sessionId ? { backendId: record.backendId, cwd: record.cwd, sessionId: record.sessionId } : null
    const path = ref ? await sessionFile(ref, input.homes, codexFiles) : null
    if (!ref || !path) { skipped++; input.events?.append({ type: "index_migration_skipped", agentId: record.agentId, reason: ref ? "no session file" : "no native session" }); continue }
    const createdAt = await stat(path).then(info => info.birthtime.toISOString(), () => new Date().toISOString())
    try { if (await input.index.ensure({ version: 1, agentId: record.agentId, backendId: record.backendId, nativeSessionId: ref.sessionId, cwd: ref.cwd, createdAt, origin: record.origin })) migrated++ }
    catch (error) { failed++; input.events?.append({ type: "index_migration_record_failed", agentId: record.agentId, message: String(error).slice(0, 512) }) }
  }
  if (!failed) await input.index.markMigrated()
  input.events?.append({ type: "index_migrated", migrated, skipped, failed })
  return { migrated, skipped, failed }
}