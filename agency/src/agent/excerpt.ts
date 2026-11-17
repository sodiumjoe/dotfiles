import { lstat, open, readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { RetainedEvent } from "./conversation.js"
import type { AgentRecordV3 } from "./types.js"

export type ExcerptInput = { agentId: string; turns: number }
export type ExcerptTurn = { role: "user" | "agent"; text: string }
export type ConversationExcerpt = { state: "excerpt"; source: "live" | "history" | "none"; turns: ExcerptTurn[]; reason: string | null }

const TAIL_WINDOWS = [1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024], HEAD_BYTES = 1024 * 1024, TURN_CHARS = 600, TITLE_CHARS = 200
const injected = /<(INSTRUCTIONS|user_instructions|environment_context|environment_info|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g
type Json = Record<string, unknown>

export function cleanTurnText(raw: string, limit = TURN_CHARS): string {
  const text = raw.replace(injected, " ").replace(/^# AGENTS\.md instructions[^\n]*$/gm, " ").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()
  const chars = [...text]
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : text
}

function push(turns: ExcerptTurn[], role: ExcerptTurn["role"], raw: string, limit = TURN_CHARS): void {
  const text = cleanTurnText(raw, limit)
  if (!text) return
  const last = turns[turns.length - 1]
  if (last && last.role === role) last.text = cleanTurnText(last.text + " " + text, limit)
  else turns.push({ role, text })
}

function texts(content: unknown, types: readonly string[]): string {
  if (typeof content === "string") return types.includes("text") || types.includes("input_text") ? content : ""
  if (!Array.isArray(content)) return ""
  return content.flatMap(block => {
    const value = block as Json | null
    return value && typeof value === "object" && types.includes(String(value.type)) && typeof value.text === "string" ? [value.text] : []
  }).join("\n")
}

function parse(line: string): Json | null {
  try { const value: unknown = JSON.parse(line); return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null } catch { return null }
}

export function codexTurns(lines: readonly string[], limit = TURN_CHARS): ExcerptTurn[] {
  const turns: ExcerptTurn[] = []
  for (const line of lines) {
    const record = parse(line), payload = record?.payload as Json | undefined
    if (record?.type !== "response_item" || !payload || payload.type !== "message") continue
    if (payload.role === "user") push(turns, "user", texts(payload.content, ["input_text"]), limit)
    else if (payload.role === "assistant") push(turns, "agent", texts(payload.content, ["output_text"]), limit)
  }
  return turns
}

export function claudeTurns(lines: readonly string[], limit = TURN_CHARS): ExcerptTurn[] {
  const turns: ExcerptTurn[] = []
  for (const line of lines) {
    const record = parse(line), message = record?.message as Json | undefined
    if (!record || record.isMeta === true || !message) continue
    if (record.type === "user" && message.role === "user") push(turns, "user", texts(message.content, ["text"]), limit)
    else if (record.type === "assistant") push(turns, "agent", texts(message.content, ["text"]), limit)
  }
  return turns
}

export function liveExcerpt(events: readonly RetainedEvent[], count: number): ExcerptTurn[] {
  const turns: ExcerptTurn[] = []
  let user = "", agent = ""
  const flush = (): void => {
    if (user) push(turns, "user", user)
    if (agent) push(turns, "agent", agent)
    user = ""; agent = ""
  }
  for (const event of events) {
    if (event.kind === "submitted") { flush(); push(turns, "user", event.text); continue }
    if (event.kind !== "update") continue
    const content = event.update.content as Json | undefined
    if (content?.type !== "text" || typeof content.text !== "string") continue
    if (event.update.sessionUpdate === "user_message_chunk" && event.replay) { if (agent) flush(); user += content.text }
    else if (event.update.sessionUpdate === "agent_message_chunk") { if (user) { push(turns, "user", user); user = "" } agent += content.text }
  }
  flush()
  return turns.slice(-count)
}

async function readTail(path: string, bytes: number): Promise<{ lines: string[]; complete: boolean }> {
  const handle = await open(path, "r")
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, bytes), buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString("utf8").split("\n")
    if (length < size) lines.shift()
    return { lines, complete: length === size }
  } finally { await handle.close() }
}

async function readHead(path: string, bytes: number): Promise<string[]> {
  const handle = await open(path, "r")
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, bytes), buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    const lines = buffer.toString("utf8").split("\n")
    if (length < size) lines.pop()
    return lines
  } finally { await handle.close() }
}

async function findCodexFile(root: string, sessionId: string): Promise<string | null> {
  const suffix = "-" + sessionId + ".jsonl"
  let visited = 0
  async function visit(path: string, depth: number): Promise<string | null> {
    let entries: string[]
    try { entries = (await readdir(path)).sort().reverse() } catch { return null }
    for (const entry of entries) {
      if (++visited > 20000) return null
      const child = join(path, entry)
      if (entry.endsWith(suffix)) return child
      if (depth < 3 && (await lstat(child).catch(() => null))?.isDirectory()) {
        const found = await visit(child, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return visit(root, 0)
}

export type SessionRef = { backendId: string; cwd: string; sessionId: string }
export type SessionHomes = { codexHome: string; claudeHome: string }

export function defaultHomes(): SessionHomes {
  return { codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"), claudeHome: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude") }
}

export async function codexSessionFiles(codexHome: string): Promise<Map<string, string>> {
  const files = new Map<string, string>(), rollout = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([A-Za-z0-9._-]+)\.jsonl$/
  async function visit(path: string, depth: number): Promise<void> {
    let entries: string[]
    try { entries = await readdir(path) } catch { return }
    for (const entry of entries) {
      const child = join(path, entry), match = rollout.exec(entry)
      if (depth === 3 && match) { files.set(match[1]!, child); continue }
      if (depth < 3 && (await lstat(child).catch(() => null))?.isDirectory()) await visit(child, depth + 1)
    }
  }
  await visit(join(codexHome, "sessions"), 0)
  return files
}

async function existing(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null)
  return info && !info.isDirectory() ? path : null
}

export async function sessionFile(ref: SessionRef, homes: SessionHomes, codexFiles?: Map<string, string>): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(ref.sessionId)) return null
  if (ref.backendId === "codex-acp") {
    const path = codexFiles ? codexFiles.get(ref.sessionId) ?? null : await findCodexFile(join(homes.codexHome, "sessions"), ref.sessionId)
    return path ? existing(path) : null
  }
  const claude = (cwd: string) => join(homes.claudeHome, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), ref.sessionId + ".jsonl")
  const resolved = await realpath(ref.cwd).catch(() => ref.cwd)
  return await existing(claude(ref.cwd)) ?? (resolved === ref.cwd ? null : existing(claude(resolved)))
}

export async function sessionSummary(ref: SessionRef, homes: SessionHomes, codexFiles?: Map<string, string>): Promise<{ title: string | null; modifiedAt: string | null }> {
  const path = await sessionFile(ref, homes, codexFiles)
  if (!path) return { title: null, modifiedAt: null }
  try {
    const info = await stat(path), lines = await readHead(path, HEAD_BYTES)
    const first = (ref.backendId === "codex-acp" ? codexTurns(lines) : claudeTurns(lines)).find(turn => turn.role === "user")
    const chars = first ? [...first.text] : []
    return { title: chars.length ? chars.slice(0, TITLE_CHARS).join("") : null, modifiedAt: info.mtime.toISOString() }
  } catch (error) { if (missing(error)) return { title: null, modifiedAt: null }; throw error }
}

type HistoryInput = { record: AgentRecordV3; codexHome: string; claudeHome: string }

function historySession(record: AgentRecordV3): string | null {
  const sessionId = record.session?.sessionId
  return sessionId && /^[A-Za-z0-9._-]+$/.test(sessionId) ? sessionId : null
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT"
const none = (reason: string): ConversationExcerpt => ({ state: "excerpt", source: "none", turns: [], reason })

export async function sessionExcerpt(ref: SessionRef, homes: SessionHomes, count: number, codexFiles?: Map<string, string>): Promise<ConversationExcerpt> {
  const path = await sessionFile(ref, homes, codexFiles)
  if (!path) return none("No conversation history file")
  let turns: ExcerptTurn[] = []
  try {
    for (const window of TAIL_WINDOWS) {
      const tail = await readTail(path, window)
      turns = ref.backendId === "codex-acp" ? codexTurns(tail.lines) : claudeTurns(tail.lines)
      if (tail.complete || turns.some(turn => turn.role === "user")) break
    }
  } catch (error) { if (missing(error)) return none("No conversation history file"); throw error }
  turns = turns.slice(-count)
  return { state: "excerpt", source: "history", turns, reason: turns.length ? null : "The history file has no conversation turns yet" }
}

export async function sessionTranscript(ref: SessionRef, homes: SessionHomes, codexFiles?: Map<string, string>): Promise<{ turns: ExcerptTurn[]; truncated: boolean } | null> {
  const path = await sessionFile(ref, homes, codexFiles)
  if (!path) return null
  try {
    const tail = await readTail(path, TAIL_WINDOWS[TAIL_WINDOWS.length - 1]! * 4)
    return { turns: ref.backendId === "codex-acp" ? codexTurns(tail.lines, Infinity) : claudeTurns(tail.lines, Infinity), truncated: !tail.complete }
  } catch (error) { if (missing(error)) return null; throw error }
}

export async function historyExcerpt(input: HistoryInput & { turns: number }): Promise<ConversationExcerpt> {
  const sessionId = historySession(input.record)
  if (!sessionId) return none("This session has no provider history yet")
  return sessionExcerpt({ backendId: input.record.definition.backendId, cwd: input.record.definition.cwd, sessionId }, { codexHome: input.codexHome, claudeHome: input.claudeHome }, input.turns)
}

export async function historySummary(input: HistoryInput): Promise<{ title: string | null; modifiedAt: string | null }> {
  const sessionId = historySession(input.record)
  if (!sessionId) return { title: null, modifiedAt: null }
  return sessionSummary({ backendId: input.record.definition.backendId, cwd: input.record.definition.cwd, sessionId }, { codexHome: input.codexHome, claudeHome: input.claudeHome })
}