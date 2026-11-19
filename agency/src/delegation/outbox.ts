import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type ParentLink = { hostId: string; agentId: string }
export type OutboxEntry = { submissionId: string; state: "answer" | "failed" | "interrupted"; stopReason: string | null; failure: string | null; text: string; delivered: boolean; at: string }
export type Outbox = { version: 1; childId: string; parent: ParentLink; depth: number; ref: string; createdAt: string; open: string | null; stopped: boolean; dropped: number; entries: OutboxEntry[] }
export type OutboxStore = {
  create(outbox: Omit<Outbox, "version" | "createdAt" | "open" | "stopped" | "dropped" | "entries">): Promise<Outbox>
  read(childId: string): Promise<Outbox | null>
  list(): Promise<Outbox[]>
  update(childId: string, change: (outbox: Outbox) => void): Promise<Outbox | null>
  append(childId: string, entry: Omit<OutboxEntry, "delivered" | "at">): Promise<Outbox | null>
  flushed(): Promise<void>
}
export const TEXT_LIMIT = 65536, UNDELIVERED_LIMIT = 20, DELIVERED_KEPT = 3
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createOutboxStore(root: string, now: () => Date = () => new Date()): OutboxStore {
  const dir = join(root, "children"), queues = new Map<string, Promise<unknown>>()
  const file = (childId: string): string => { if (!UUID.test(childId)) throw new Error("invalid child ID"); return join(dir, childId + ".json") }
  const queued = <T>(childId: string, action: () => Promise<T>): Promise<T> => {
    const result = (queues.get(childId) ?? Promise.resolve()).then(action)
    queues.set(childId, result.catch(() => undefined))
    return result
  }
  const load = async (childId: string): Promise<Outbox | null> => { try { return JSON.parse(await readFile(file(childId), "utf8")) as Outbox } catch { return null } }
  const save = async (outbox: Outbox): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const temporary = join(dir, `.${outbox.childId}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(outbox), { mode: 0o600 })
    await rename(temporary, file(outbox.childId))
  }
  const bound = (outbox: Outbox): void => {
    let undelivered = outbox.entries.filter(entry => !entry.delivered).length
    while (undelivered > UNDELIVERED_LIMIT) { const index = outbox.entries.findIndex(entry => !entry.delivered); outbox.entries.splice(index, 1); outbox.dropped++; undelivered-- }
    const delivered = outbox.entries.filter(entry => entry.delivered)
    const drop = new Set(delivered.slice(0, Math.max(0, delivered.length - DELIVERED_KEPT)))
    outbox.entries = outbox.entries.filter(entry => !drop.has(entry))
  }
  const update = (childId: string, change: (outbox: Outbox) => void): Promise<Outbox | null> => queued(childId, async () => {
    const outbox = await load(childId)
    if (!outbox) return null
    change(outbox); bound(outbox)
    if (outbox.stopped && outbox.entries.every(entry => entry.delivered)) { await rm(file(childId), { force: true }); return null }
    await save(outbox)
    return outbox
  })
  return {
    create: async value => { file(value.childId); return queued(value.childId, async () => {
      const existing = await load(value.childId)
      if (existing) return existing
      const outbox: Outbox = { version: 1, ...value, createdAt: now().toISOString(), open: null, stopped: false, dropped: 0, entries: [] }
      await save(outbox)
      return outbox
    }) },
    read: async childId => { file(childId); return queued(childId, () => load(childId)) },
    async list() {
      let names: string[]
      try { names = await readdir(dir) } catch { return [] }
      const values = await Promise.all(names.filter(name => name.endsWith(".json") && !name.startsWith(".")).map(name => load(name.slice(0, -5)).catch(() => null)))
      return values.filter((value): value is Outbox => value !== null)
    },
    update,
    append: (childId, entry) => update(childId, outbox => {
      const text = !entry.text ? "(no text)" : entry.text.length > TEXT_LIMIT ? entry.text.slice(0, TEXT_LIMIT) + "\n\n(answer cut at 65536 characters)" : entry.text
      outbox.entries.push({ ...entry, text, delivered: false, at: now().toISOString() })
      if (outbox.open === entry.submissionId) outbox.open = null
    }),
    flushed: () => Promise.all([...queues.values()]).then(() => undefined),
  }
}