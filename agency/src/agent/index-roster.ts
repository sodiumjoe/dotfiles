import type { AgentIndex } from "./agent-index.js"
import { codexSessionFiles, sessionSummary, type SessionHomes } from "./excerpt.js"

export type IndexRosterRow = { agentId: string; backendId: string; cwd: string; title: string | null; lastActivityAt: string | null; createdAt: string }

export async function readIndexRoster(input: { index: AgentIndex; homes: SessionHomes }): Promise<IndexRosterRow[]> {
  const entries = await input.index.list(), codexFiles = entries.some(entry => entry.backendId === "codex-acp") ? await codexSessionFiles(input.homes.codexHome) : new Map<string, string>()
  const rows = await Promise.all(entries.map(async entry => {
    const summary = await sessionSummary({ backendId: entry.backendId, cwd: entry.cwd, sessionId: entry.nativeSessionId }, input.homes, codexFiles).catch(() => ({ title: null, modifiedAt: null }))
    return { agentId: entry.agentId, backendId: entry.backendId, cwd: entry.cwd, title: summary.title, lastActivityAt: summary.modifiedAt, createdAt: entry.createdAt }
  }))
  return rows.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || b.createdAt.localeCompare(a.createdAt))
}