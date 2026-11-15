import { stat } from "node:fs/promises"
import type { AgentIndex } from "./agent-index.js"
import { codexSessionFiles, sessionFile, type SessionHomes } from "./excerpt.js"
import type { AgentStore } from "./store.js"
import type { EventLog } from "../handler/event-log.js"

export async function migrateIndex(input: { store: Pick<AgentStore, "inventory">; index: AgentIndex; homes: SessionHomes; events?: EventLog }): Promise<{ migrated: number; skipped: number; failed: number } | null> {
  if (await input.index.migrated()) return null
  const inventory = await input.store.inventory(), codexFiles = await codexSessionFiles(input.homes.codexHome)
  let migrated = 0, skipped = 0, failed = 0
  for (const record of inventory.agents) {
    if (record.version !== 3) continue
    const sessionId = record.session?.sessionId, ref = sessionId ? { backendId: record.definition.backendId, cwd: record.definition.cwd, sessionId } : null
    const path = ref ? await sessionFile(ref, input.homes, codexFiles) : null
    if (!ref || !path) { skipped++; input.events?.append({ type: "index_migration_skipped", agentId: record.definition.agentId, reason: ref ? "no session file" : "no native session" }); continue }
    const createdAt = await stat(path).then(info => info.birthtime.toISOString(), () => new Date().toISOString())
    try { if (await input.index.ensure({ version: 1, agentId: record.definition.agentId, backendId: record.definition.backendId, nativeSessionId: ref.sessionId, cwd: ref.cwd, createdAt, origin: record.definition.origin })) migrated++ }
    catch (error) { failed++; input.events?.append({ type: "index_migration_record_failed", agentId: record.definition.agentId, message: String(error).slice(0, 512) }) }
  }
  if (!failed) await input.index.markMigrated()
  input.events?.append({ type: "index_migrated", migrated, skipped, failed })
  return { migrated, skipped, failed }
}