import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { hash, id, keys, object, text, timestamp } from "../catalog/types.js"
import { createStorage, defaultFileSystem, storageQueue } from "./storage.js"
import { canonicalDigest, enumValue, fail, OrchestrationError, PAGE_LIMIT, parseEventPayload, parseEventRef, parseJournalEntry, TERMINAL_AGE, type EventRef, type Journal, type JournalEntry } from "./types.js"

type Saved = { version: 1; createdAt: number; entry: JournalEntry }
type Checkpoint = { epoch: string; compactedThrough: number; summaryDigest: string }
type Summary = { version: 1; epoch: string; from: number; through: number; previous: Checkpoint | null; entries: EventRef[] }
const name = (seq: number) => String(seq).padStart(16, "0") + ".json"
function parseSaved(raw: unknown): Saved {
  const v = object(raw); keys(v, ["version", "createdAt", "entry"])
  if (v.version !== 1) fail("CORRUPT_JOURNAL")
  return { version: 1, createdAt: timestamp(v.createdAt), entry: parseJournalEntry(v.entry) }
}
function parseCheckpoint(raw: unknown): Checkpoint {
  const v = object(raw); keys(v, ["epoch", "compactedThrough", "summaryDigest"])
  const compactedThrough = timestamp(v.compactedThrough); if (!compactedThrough) fail("CORRUPT_JOURNAL")
  return { epoch: id(v.epoch), compactedThrough, summaryDigest: hash(v.summaryDigest) }
}
function recipientName(recipient: string): string {
  text(recipient, 64); if (!/^[a-zA-Z0-9_-]+$/.test(recipient)) fail()
  return recipient
}
export function createJournal(root: string, filesystem = defaultFileSystem, now = Date.now, scope?: { runId: string; kind: "bureau" | "origin" } | { hostId: string; kind: "permissions" }): Journal {
  const backing = createStorage(root, "orchestration", filesystem), queue = storageQueue(root)
  const prefix = scope ? scope.kind === "permissions" ? `permissions/${hash(scope.hostId)}/` : `${scope.kind}-runs/${id(scope.runId)}/` : ""
  const storage = {
    read: (key: string) => backing.read(prefix + key),
    names: (key: string) => backing.names(prefix + key),
    publish: (key: string, value: unknown, expected: unknown | null, immutable = false) => backing.publish(prefix + key, value, expected, immutable),
    remove: (key: string) => backing.remove(prefix + key),
    sync: (key: string) => backing.sync(prefix + key)
  }
  const key = (kind: string, seq: number) => `journal/${kind}/${name(seq)}`
  async function saved(kind: "entries" | "receipts", seq: number): Promise<Saved | null> {
    const raw = await storage.read(key(kind, seq)); if (raw === null) return null
    const result = parseSaved(raw); if (result.entry.seq !== seq) fail("CORRUPT_JOURNAL")
    return result
  }
  async function checkpoint(): Promise<Checkpoint | null> {
    const raw = await storage.read("journal/checkpoint.json")
    if (raw === null) return null
    const current = parseCheckpoint(raw)
    let cursor: Checkpoint | null = current
    const epochs = new Set<string>()
    while (cursor !== null) {
      if (epochs.has(cursor.epoch)) fail("CORRUPT_JOURNAL"); epochs.add(cursor.epoch)
      const value = await storage.read(`journal/summaries/${cursor.epoch}.json`)
      if (value === null || canonicalDigest(value) !== cursor.summaryDigest) fail("CORRUPT_JOURNAL")
      const v = object(value); keys(v, ["version", "epoch", "from", "through", "previous", "entries"])
      if (v.version !== 1 || v.epoch !== cursor.epoch || v.through !== cursor.compactedThrough || !Array.isArray(v.entries) || !v.entries.length || v.entries.length > PAGE_LIMIT) fail("CORRUPT_JOURNAL")
      const previous = v.previous === null ? null : parseCheckpoint(v.previous)
      const from = timestamp(v.from)
      if (from !== (previous?.compactedThrough ?? 0) + 1 || v.entries.length !== cursor.compactedThrough - from + 1) fail("CORRUPT_JOURNAL")
      for (const [i, rawRef] of v.entries.entries()) {
        const ref = parseEventRef(rawRef), receipt = await saved("receipts", from + i)
        if (!receipt || ref.seq !== from + i || !matches(receipt.entry, ref)) fail("CORRUPT_JOURNAL")
      }
      cursor = previous
    }
    return current
  }
  const matches = (entry: JournalEntry, ref: EventRef): boolean => entry.seq === ref.seq && entry.eventId === ref.eventId && entry.digest === ref.digest
  async function inventory(): Promise<{ checkpoint: Checkpoint | null; records: Saved[]; lastSeq: number }> {
    const cp = await checkpoint(), records = new Map<number, Saved>(), commits = new Map<number, EventRef>()
    for (const filename of await storage.names("journal/entries")) {
      if (!/^[0-9]{16}\.json$/.test(filename)) fail("CORRUPT_JOURNAL")
      const seq = Number(filename.slice(0, -5)), value = await saved("entries", seq)
      if (!value) fail("CORRUPT_JOURNAL")
      if (seq > (cp?.compactedThrough ?? 0)) records.set(seq, value)
    }
    for (const filename of await storage.names("journal/commits")) {
      if (!/^[0-9]{16}\.json$/.test(filename)) fail("CORRUPT_JOURNAL")
      const seq = Number(filename.slice(0, -5)), raw = await storage.read(key("commits", seq))
      if (raw === null) fail("CORRUPT_JOURNAL")
      const ref = parseEventRef(raw); if (ref.seq !== seq) fail("CORRUPT_JOURNAL")
      commits.set(seq, ref)
    }
    let lastSeq = cp?.compactedThrough ?? 0
    for (const seq of records.keys()) lastSeq = Math.max(lastSeq, seq)
    for (const seq of commits.keys()) lastSeq = Math.max(lastSeq, seq)
    for (let seq = (cp?.compactedThrough ?? 0) + 1; seq <= lastSeq; seq++) {
      const record = records.get(seq)
      if (!record || (commits.has(seq) && !matches(record.entry, commits.get(seq)!))) fail("CORRUPT_JOURNAL")
    }
    const ids = new Set<string>()
    for (const record of records.values()) { if (ids.has(record.entry.eventId)) fail("CORRUPT_JOURNAL"); ids.add(record.entry.eventId) }
    return { checkpoint: cp, records: [...records.values()].sort((a, b) => a.entry.seq - b.entry.seq), lastSeq }
  }
  async function readById(eventId: string, view: Awaited<ReturnType<typeof inventory>>): Promise<Saved | null> {
    const value = view.records.find(value => value.entry.eventId === eventId)
    if (value) return value
    for (let seq = 1; seq <= (view.checkpoint?.compactedThrough ?? 0); seq++) {
      const receipt = await saved("receipts", seq)
      if (!receipt) fail("CORRUPT_JOURNAL")
      if (receipt.entry.eventId === eventId) return receipt
    }
    return null
  }
  async function acknowledgeRecord(recipient: string, entry: JournalEntry): Promise<boolean> {
    const raw = await storage.read(`journal/acks-${recipientName(recipient)}/${name(entry.seq)}`)
    if (raw === null) return false
    const ref = parseEventRef(raw)
    if (!matches(entry, ref)) fail("CORRUPT_ACKNOWLEDGMENT")
    return true
  }
  async function recordAt(seq: number, view: Awaited<ReturnType<typeof inventory>>): Promise<Saved> {
    const record = seq <= (view.checkpoint?.compactedThrough ?? 0) ? await saved("receipts", seq) : view.records.find(value => value.entry.seq === seq)
    if (!record) fail("CORRUPT_JOURNAL")
    return record
  }
  async function cleanup(cp: Checkpoint | null): Promise<void> {
    if (!cp) return
    await storage.sync("journal")
    for (const filename of await storage.names("journal/entries")) {
      const seq = Number(filename.slice(0, -5))
      if (seq > cp.compactedThrough) continue
      const entry = await saved("entries", seq), receipt = await saved("receipts", seq)
      if (!entry || !receipt || !isDeepStrictEqual(entry, receipt)) fail("CORRUPT_JOURNAL")
      await storage.remove(key("entries", seq))
    }
  }
  async function compact(time: number, terminal = false): Promise<void> {
    timestamp(time)
    await queue.run(async () => {
      const view = await inventory(); await cleanup(view.checkpoint)
      const recipients = new Set<string>(["bureau"])
      for (const filename of await storage.names("journal/recipients")) {
        const raw = object(await storage.read(`journal/recipients/${filename}`)); keys(raw, ["recipient"])
        const recipient = recipientName(text(raw.recipient, 64))
        if (filename !== recipient + ".json") fail("CORRUPT_JOURNAL")
        recipients.add(recipient)
      }
      const prefix: Saved[] = []
      for (const record of view.records) {
        if (prefix.length === PAGE_LIMIT || (!terminal && record.entry.kind !== "report") || time < record.createdAt || time - record.createdAt < TERMINAL_AGE ) break
        let acknowledged = true
        for (const recipient of recipients) if (!await acknowledgeRecord(recipient, record.entry)) { acknowledged = false; break }
        if (!acknowledged) break
        prefix.push(record)
      }
      if (!prefix.length) return
      const epoch = randomUUID(), through = prefix.at(-1)!.entry.seq
      for (const record of prefix) await storage.publish(key("receipts", record.entry.seq), record, null, true)
      const summary: Summary = { version: 1, epoch, from: prefix[0]!.entry.seq, through, previous: view.checkpoint, entries: prefix.map(({ entry }) => ({ seq: entry.seq, eventId: entry.eventId, digest: entry.digest })) }
      await storage.publish(`journal/summaries/${epoch}.json`, summary, null, true)
      const next: Checkpoint = { epoch, compactedThrough: through, summaryDigest: canonicalDigest(summary) }
      await storage.publish("journal/checkpoint.json", next, view.checkpoint)
      await cleanup(next)
    })
  }
  return {
    async append(eventId, kind, raw) {
      id(eventId)
      return queue.run(async () => {
        const view = await inventory(), prior = await readById(eventId, view)
        if (prior && canonicalDigest({ kind, payload: raw }) !== prior.entry.digest) fail("COMMAND_CONFLICT")
        if (prior) { await storage.publish(key("commits", prior.entry.seq), { seq: prior.entry.seq, eventId, digest: prior.entry.digest }, null, true); await storage.sync(prior.entry.seq <= (view.checkpoint?.compactedThrough ?? 0) ? "journal/receipts" : "journal/entries"); return structuredClone(prior.entry) }
        const payload = parseEventPayload(kind, raw), seq = view.lastSeq + 1
        const entry: JournalEntry = { seq, eventId, kind, payload, digest: canonicalDigest({ kind, payload }) }
        const value: Saved = { version: 1, createdAt: timestamp(now()), entry }
        await storage.publish(key("entries", seq), value, null, true)
        await storage.publish(key("commits", seq), { seq, eventId, digest: entry.digest }, null, true)
        return structuredClone(entry)
      })
    },
    async read(after, limit) {
      timestamp(after); if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) fail("INVALID_PAGE")
      return queue.run(async () => {
        const view = await inventory(), cp = view.checkpoint?.compactedThrough ?? 0
        if (after < cp) throw new OrchestrationError("CURSOR_EXPIRED", view.checkpoint)
        const entries = view.records.filter(value => value.entry.seq > after).slice(0, limit).map(value => value.entry)
        return { checkpoint: cp, lastSeq: view.lastSeq, entries: structuredClone(entries), nextCursor: entries.at(-1)?.seq ?? after }
      })
    },
    async retainedRead(after, limit) {
      timestamp(after); if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) fail("INVALID_PAGE")
      return queue.run(async () => {
        const view = await inventory(), entries: JournalEntry[] = []
        for (let seq = after + 1; seq <= view.lastSeq && entries.length < limit; seq++) entries.push((await recordAt(seq, view)).entry)
        return { checkpoint: view.checkpoint?.compactedThrough ?? 0, lastSeq: view.lastSeq, entries: structuredClone(entries), nextCursor: entries.at(-1)?.seq ?? after }
      })
    },
    async metadata() { return queue.run(async () => { const view = await inventory(); return { checkpoint: view.checkpoint?.compactedThrough ?? 0, lastSeq: view.lastSeq } }) },
    async acknowledged(recipient, ref) { return queue.run(async () => { const record = await recordAt(ref.seq, await inventory()); if (!matches(record.entry, ref)) fail("ACKNOWLEDGMENT_CONFLICT"); return acknowledgeRecord(recipient, record.entry) }) },
    compact: time => compact(time), compactTerminal: time => compact(time, true),
    async acknowledge(recipient, input) {
      const ref = parseEventRef({ seq: input.seq, eventId: input.eventId, digest: input.digest })
      await queue.run(async () => {
        const view = await inventory(), record = await recordAt(ref.seq, view)
        if (!matches(record.entry, ref)) fail("ACKNOWLEDGMENT_CONFLICT")
        await storage.publish(key("commits", ref.seq), ref, null, true)
        await storage.publish(`journal/recipients/${recipientName(recipient)}.json`, { recipient }, null, true)
        await storage.publish(`journal/acks-${recipientName(recipient)}/${name(ref.seq)}`, ref, null, true)
      })
    },
    async watermark(recipient) {
      return queue.run(async () => {
        const view = await inventory(); let through = 0
        for (let seq = 1; seq <= view.lastSeq; seq++) {
          if (!await acknowledgeRecord(recipient, (await recordAt(seq, view)).entry)) break
          through = seq
        }
        return through
      })
    },

  }
}

export function createJournalPool(root: string, filesystem = defaultFileSystem, now = Date.now, kind: "bureau" | "origin" = "bureau") {
  const storage = createStorage(root, "orchestration", filesystem), journals = new Map<string, Journal>()
  return {
    async list(): Promise<string[]> { return (await storage.directories(`${kind}-runs`)).map(id) },
    async erase(runId: string): Promise<void> { id(runId); await storageQueue(root).run(() => storage.removeTree(`${kind}-runs/${runId}`)); journals.delete(runId) },
    forRun(runId: string): Journal {
      id(runId)
      let journal = journals.get(runId)
      if (!journal) { journal = createJournal(root, filesystem, now, { runId, kind }); journals.set(runId, journal) }
      return journal
    }
  }
}
export type JournalPool = ReturnType<typeof createJournalPool>