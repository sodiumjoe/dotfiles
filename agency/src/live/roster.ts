import { stat } from "node:fs/promises"
import type { AgentIndex, IndexEntry } from "../agent/agent-index.js"
import { codexSessionFiles, liveExcerpt, sessionExcerpt, sessionFile, sessionSettings, sessionSummary, sessionTranscript, type ConversationExcerpt, type RecordedSettings, type ExcerptTurn, type SessionHomes, type SessionRef } from "../agent/excerpt.js"
import type { ProviderId } from "../catalog/types.js"
import type { Activity, LiveAgent, LiveTable } from "./state.js"

export type LiveRow = { activity: Activity; handlerGeneration: string; providerGeneration: string; model: string | null; mode: string | null }
export type RosterRow = { agentId: string; backendId: ProviderId; cwd: string; createdAt: string; title: string | null; lastActivityAt: string | null; live: LiveRow | null }
export type History = { title: string | null; lastActivityAt: string | null }
export type Transcript = { state: "transcript"; agentId: string; turns: ExcerptTurn[]; truncated: boolean; reason: string | null }
export type Roster = { entry(agentId: string): Promise<IndexEntry | null>; sessionPath(entry: IndexEntry): Promise<string | null>; recorded(entry: IndexEntry): Promise<RecordedSettings>; history(entry: IndexEntry): Promise<History>; changed(sessionId: string): void; rows(table: LiveTable): Promise<RosterRow[]>; row(table: LiveTable, agentId: string): Promise<RosterRow | null>; excerpt(table: LiveTable, agentId: string, turns: number): Promise<ConversationExcerpt | null>; transcript(agentId: string): Promise<Transcript | null> }

export function currentSettings(agent: LiveAgent): { model: string | null; mode: string | null } {
  let snapshot
  try { snapshot = agent.session && agent.owner ? agent.owner.snapshot() : null } catch { snapshot = null }
  if (!snapshot || !agent.contract) return { model: null, mode: null }
  const option = (id: string | null): unknown => id === null ? undefined : snapshot.configOptions.find(value => value.id === id)?.currentValue
  const model = option(agent.contract.modelOption), mode = option(agent.contract.modeOption)
  return { model: typeof model === "string" ? model : typeof snapshot.models?.currentModelId === "string" ? snapshot.models.currentModelId : null,
    mode: typeof mode === "string" ? mode : typeof snapshot.modes?.currentModeId === "string" ? snapshot.modes.currentModeId : null }
}

export function liveRow(table: LiveTable, agent: LiveAgent): RosterRow {
  return { agentId: agent.agentId, backendId: agent.backendId, cwd: agent.cwd, createdAt: agent.createdAt, title: agent.conversation.display().title ?? agent.title, lastActivityAt: agent.lastActivityAt,
    live: { activity: table.activity(agent), handlerGeneration: agent.tuple.handlerGeneration, providerGeneration: agent.tuple.providerGeneration, ...currentSettings(agent) } }
}

const order = (a: RosterRow, b: RosterRow): number => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || b.createdAt.localeCompare(a.createdAt) || a.agentId.localeCompare(b.agentId)

export function createRoster(input: { index: AgentIndex; homes: SessionHomes }): Roster {
  type Summary = { key: string; history: History; settings: RecordedSettings }
  const summaries = new Map<string, Summary>(), missed = new Set<string>(), empty = { history: { title: null, lastActivityAt: null }, settings: { model: null, mode: null } }
  let codexFiles: Map<string, string> | undefined
  const ref = (entry: IndexEntry): SessionRef => ({ backendId: entry.backendId, cwd: entry.cwd, sessionId: entry.nativeSessionId })
  async function files(entries: IndexEntry[]): Promise<Map<string, string>> {
    const unknown = entries.filter(entry => entry.backendId === "codex-acp" && !codexFiles?.has(entry.nativeSessionId) && !missed.has(entry.nativeSessionId))
    if (!codexFiles || unknown.length) {
      codexFiles = await codexSessionFiles(input.homes.codexHome)
      for (const entry of unknown) if (!codexFiles.has(entry.nativeSessionId)) missed.add(entry.nativeSessionId)
    }
    return codexFiles
  }
  async function locate(entry: IndexEntry): Promise<string | null> {
    if (entry.backendId !== "codex-acp") return sessionFile(ref(entry), input.homes)
    const known = await sessionFile(ref(entry), input.homes, await files([entry]))
    if (known) return known
    const found = await sessionFile(ref(entry), input.homes)
    if (found) { codexFiles?.set(entry.nativeSessionId, found); missed.delete(entry.nativeSessionId) }
    return found
  }
  async function summary(entry: IndexEntry, codex?: Map<string, string>): Promise<Omit<Summary, "key">> {
    const path = await (codex ? sessionFile(ref(entry), input.homes, codex) : locate(entry)).catch(() => null), info = path ? await stat(path).catch(() => null) : null
    if (!path || !info) { summaries.delete(entry.agentId); return empty }
    const key = path + ":" + info.mtimeMs + ":" + info.size, cached = summaries.get(entry.agentId)
    if (cached?.key === key) return cached
    const [read, settings] = await Promise.all([sessionSummary(ref(entry), input.homes, codex ?? new Map([[entry.nativeSessionId, path]])).catch(() => ({ title: null, modifiedAt: null })), sessionSettings(path, entry.backendId).catch(() => empty.settings)])
    const value = { key, history: { title: read.title, lastActivityAt: read.modifiedAt }, settings }
    summaries.set(entry.agentId, value)
    return value
  }
  async function rows(table: LiveTable): Promise<RosterRow[]> {
    const entries = await input.index.list(), codex = entries.some(entry => entry.backendId === "codex-acp") ? await files(entries) : new Map<string, string>()
    const indexed = new Set(entries.map(entry => entry.agentId))
    const result = await Promise.all(entries.map(async entry => {
      const agent = table.get(entry.agentId)
      if (agent) return liveRow(table, agent)
      const past = (await summary(entry, codex)).history
      return { agentId: entry.agentId, backendId: entry.backendId, cwd: entry.cwd, createdAt: entry.createdAt, title: past.title, lastActivityAt: past.lastActivityAt, live: null }
    }))
    return [...result, ...table.all().filter(agent => !indexed.has(agent.agentId)).map(agent => liveRow(table, agent))].sort(order)
  }
  const entry = async (agentId: string): Promise<IndexEntry | null> => (await input.index.list()).find(value => value.agentId === agentId) ?? null
  return {
    entry, sessionPath: locate, rows,
    async recorded(found) { return (await summary(found)).settings },
    async history(found) { return (await summary(found)).history },
    changed(sessionId) { missed.delete(sessionId) },
    async row(table, agentId) { return (await rows(table)).find(row => row.agentId === agentId) ?? null },
    async excerpt(table, agentId, turns) {
      const agent = table.get(agentId)
      if (agent?.phase === "ready") { const observation = agent.conversation.observe(() => {}), events = observation.snapshot.events; observation.close(); return { state: "excerpt", source: "live", turns: liveExcerpt(events, turns), reason: null } }
      const found = await entry(agentId)
      return found ? sessionExcerpt(ref(found), input.homes, turns, found.backendId === "codex-acp" ? await files([found]) : undefined) : null
    },
    async transcript(agentId) {
      const found = await entry(agentId)
      if (!found) return null
      const read = await sessionTranscript(ref(found), input.homes, found.backendId === "codex-acp" ? await files([found]) : undefined)
      return { state: "transcript", agentId, turns: read?.turns ?? [], truncated: read?.truncated ?? false, reason: read ? null : "No conversation history file" }
    },
  }
}