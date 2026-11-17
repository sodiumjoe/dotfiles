import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseEntry, type IndexEntry } from "../agent/agent-index.js"

export type HandoffAgent = Omit<IndexEntry, "version"> & { model: string | null; mode: string | null }
export type Handoff = { version: 1; handlerGeneration: string; bootId: string; writtenAt: string; agents: HandoffAgent[] }
export type ReadHandoff = { handoff: Handoff; dropped: Array<{ index: number; reason: string }> }

export const HANDOFF_MAX_AGE_MS = 10 * 60 * 1000
export const handoffPath = (root: string): string => join(root, "handoff.json")
const setting = (value: unknown): value is string | null => value === null || typeof value === "string" && value.length > 0 && value.length <= 256

export function parseHandoffAgent(value: unknown): HandoffAgent {
  const agent = value as Partial<HandoffAgent> | null
  if (!agent || typeof agent !== "object") throw new Error("the entry is not an object")
  const entry = parseEntry({ ...agent, version: 1 })
  if (!entry || !/^[A-Za-z0-9._-]{1,256}$/.test(entry.nativeSessionId) || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error("the entry does not name an indexable agent")
  if (!setting(agent.model) || !setting(agent.mode)) throw new Error("the entry has an invalid model or mode")
  return { agentId: entry.agentId, backendId: entry.backendId, nativeSessionId: entry.nativeSessionId, cwd: entry.cwd, createdAt: entry.createdAt, origin: entry.origin, model: agent.model, mode: agent.mode }
}

function header(value: unknown): Omit<Handoff, "agents"> & { agents: unknown[] } {
  const record = value as Partial<Handoff> | null
  if (!record || typeof record !== "object" || record.version !== 1 || typeof record.handlerGeneration !== "string" || typeof record.bootId !== "string" || !record.bootId
    || typeof record.writtenAt !== "string" || !Number.isFinite(Date.parse(record.writtenAt)) || !Array.isArray(record.agents) || record.agents.length > 256) throw new Error("handoff.json is not a version 1 handoff")
  return { version: 1, handlerGeneration: record.handlerGeneration, bootId: record.bootId, writtenAt: record.writtenAt, agents: record.agents }
}

export function parseHandoff(value: unknown): ReadHandoff {
  const { agents, ...rest } = header(value), dropped: ReadHandoff["dropped"] = [], valid: HandoffAgent[] = []
  agents.forEach((item, index) => {
    try {
      const agent = parseHandoffAgent(item)
      if (valid.some(other => other.agentId === agent.agentId)) throw new Error("the entry repeats agent " + agent.agentId)
      valid.push(agent)
    } catch (error) { dropped.push({ index, reason: error instanceof Error ? error.message : String(error) }) }
  })
  return { handoff: { ...rest, agents: valid }, dropped }
}

export async function writeHandoff(root: string, handoff: Handoff): Promise<void> {
  const checked = { ...header(handoff), agents: handoff.agents.map(parseHandoffAgent) }
  const temporary = join(root, ".handoff." + randomUUID() + ".tmp")
  try {
    await writeFile(temporary, JSON.stringify(checked), { mode: 0o600 })
    await rename(temporary, handoffPath(root))
  } finally { await rm(temporary, { force: true }) }
}

export async function readHandoff(root: string): Promise<ReadHandoff | null> {
  let text: string
  try { text = await readFile(handoffPath(root), "utf8") } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
  return parseHandoff(JSON.parse(text))
}

export function staleness(handoff: Handoff, bootId: string, now: number): string | null {
  if (handoff.bootId !== bootId) return "it was written before the last boot"
  const age = now - Date.parse(handoff.writtenAt)
  if (age > HANDOFF_MAX_AGE_MS) return "it is " + Math.round(age / 1000) + " seconds old, more than " + HANDOFF_MAX_AGE_MS / 1000
  if (age < -60000) return "its time is in the future"
  return null
}

export const removeHandoff = (root: string): Promise<void> => rm(handoffPath(root), { force: true })