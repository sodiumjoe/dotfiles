import { lstat, open, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { RetainedEvent } from "./conversation.js"
import type { AgentRecordV3 } from "./types.js"

export type ExcerptInput = { agentId: string; turns: number }
export type ExcerptTurn = { role: "user" | "agent"; text: string }
export type ConversationExcerpt = { state: "excerpt"; source: "live" | "history" | "none"; turns: ExcerptTurn[]; reason: string | null }

const TAIL_BYTES = 1024 * 1024, TURN_CHARS = 600
const injected = /<(INSTRUCTIONS|user_instructions|environment_context|environment_info|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g
type Json = Record<string, unknown>

export function cleanTurnText(raw: string): string {
  const text = raw.replace(injected, " ").replace(/^# AGENTS\.md instructions[^\n]*$/gm, " ").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()
  const chars = [...text]
  return chars.length > TURN_CHARS ? chars.slice(0, TURN_CHARS - 1).join("") + "…" : text
}

function push(turns: ExcerptTurn[], role: ExcerptTurn["role"], raw: string): void {
  const text = cleanTurnText(raw)
  if (!text) return
  const last = turns[turns.length - 1]
  if (last && last.role === role) last.text = cleanTurnText(last.text + " " + text)
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

export function codexTurns(lines: readonly string[]): ExcerptTurn[] {
  const turns: ExcerptTurn[] = []
  for (const line of lines) {
    const record = parse(line), payload = record?.payload as Json | undefined
    if (record?.type !== "response_item" || !payload || payload.type !== "message") continue
    if (payload.role === "user") push(turns, "user", texts(payload.content, ["input_text"]))
    else if (payload.role === "assistant") push(turns, "agent", texts(payload.content, ["output_text"]))
  }
  return turns
}

export function claudeTurns(lines: readonly string[]): ExcerptTurn[] {
  const turns: ExcerptTurn[] = []
  for (const line of lines) {
    const record = parse(line), message = record?.message as Json | undefined
    if (!record || record.isMeta === true || !message) continue
    if (record.type === "user" && message.role === "user") push(turns, "user", texts(message.content, ["text"]))
    else if (record.type === "assistant") push(turns, "agent", texts(message.content, ["text"]))
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

async function readTail(path: string): Promise<string[]> {
  const handle = await open(path, "r")
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES), buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString("utf8").split("\n")
    if (length < size) lines.shift()
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

export async function historyExcerpt(input: { record: AgentRecordV3; turns: number; codexHome: string; claudeHome: string }): Promise<ConversationExcerpt> {
  const none = (reason: string): ConversationExcerpt => ({ state: "excerpt", source: "none", turns: [], reason })
  const sessionId = input.record.session?.sessionId
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return none("This session has no provider history yet")
  const codex = input.record.definition.backendId === "codex-acp"
  const path = codex ? await findCodexFile(join(input.codexHome, "sessions"), sessionId)
    : join(input.claudeHome, "projects", input.record.definition.cwd.replace(/[^A-Za-z0-9]/g, "-"), sessionId + ".jsonl")
  if (!path) return none("No conversation history file")
  let lines: string[]
  try { lines = await readTail(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return none("No conversation history file"); throw error }
  const turns = (codex ? codexTurns(lines) : claudeTurns(lines)).slice(-input.turns)
  return { state: "excerpt", source: "history", turns, reason: turns.length ? null : "The history file has no conversation turns yet" }
}