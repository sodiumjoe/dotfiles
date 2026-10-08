import { isDeepStrictEqual } from "node:util"
import { hash, id, object, timestamp } from "../catalog/types.js"
import { createStorage, defaultFileSystem, storageQueue } from "../orchestration/storage.js"
import { canonicalDigest, fail, parseEventRef, parseJournalEntry, type EventRef, type JournalEntry, type JournalPage } from "../orchestration/types.js"
import type { JournalPool } from "../orchestration/journal.js"
import type { HostSnapshot } from "./host.js"

export type OriginKey = { hostId: string; runId: string; streamId: string }
export type OriginSource = { hostId: string; list(): Promise<OriginKey[]>; read(key: OriginKey, after: number, limit: number): Promise<JournalPage>; verify(key: OriginKey, ref: EventRef, kind: string, payload: unknown): Promise<void>; acknowledge(key: OriginKey, ref: EventRef): Promise<void>; acknowledged(key: OriginKey, ref: EventRef): Promise<boolean> }
const filename = (seq: number) => String(seq).padStart(16, "0") + ".json"
function parseKey(key: OriginKey, hostId: string): OriginKey {
  if (hash(key.hostId) !== hostId || id(key.runId) !== id(key.streamId)) fail("INVALID_ORIGIN")
  return { hostId, runId: key.runId, streamId: key.streamId }
}
function validateOwner(key: OriginKey, entry: JournalEntry): void {
  const payload = object(entry.payload)
  const scope = payload.input && typeof payload.input === "object" ? object(payload.input) : payload
  if (scope.runId !== undefined && scope.runId !== key.runId) fail("INVALID_ORIGIN")
  for (const field of ["execution", "agent", "sender"]) if (scope[field] && object(scope[field]).hostId !== key.hostId) fail("INVALID_ORIGIN")
}
const refOf = (entry: EventRef): EventRef => ({ seq: entry.seq, eventId: entry.eventId, digest: entry.digest })
export function createLocalOrigins(hostId: string, journals: JournalPool): OriginSource {
  hash(hostId)
  return {
    hostId,
    async list() { return (await journals.list()).map(runId => ({ hostId, runId, streamId: runId })) },
    read(key, after, limit) { return journals.forRun(parseKey(key, hostId).runId).retainedRead(after, limit) },
    async verify(key, ref, kind, payload) {
      const journal = journals.forRun(parseKey(key, hostId).runId), page = await journal.retainedRead(ref.seq - 1, 1), entry = page.entries[0]
      if (!entry || !isDeepStrictEqual(refOf(entry), parseEventRef(refOf(ref))) || entry.kind !== kind || !isDeepStrictEqual(entry.payload, payload)) fail("INVALID_ORIGIN")
      validateOwner(key, entry); await journal.append(entry.eventId, entry.kind, entry.payload)
    },
    acknowledge(key, ref) { return journals.forRun(parseKey(key, hostId).runId).acknowledge("bureau", ref) },
    acknowledged(key, ref) { return journals.forRun(parseKey(key, hostId).runId).acknowledged("bureau", ref) }
  }
}
export function createRemoteOrigins(root: string, hostId: string, filesystem = defaultFileSystem) {
  hash(hostId)
  const storage = createStorage(root, "bureau", filesystem), queue = storageQueue(root)
  const prefix = (key: OriginKey) => { const k = parseKey(key, hostId); return `origins/${hostId}/${k.runId}/${k.streamId}` }
  async function entryAt(key: OriginKey, seq: number): Promise<JournalEntry | null> {
    const base = prefix(key), raw = await storage.read(`${base}/entries/${filename(seq)}`), committed = await storage.read(`${base}/commits/${filename(seq)}`)
    if (raw === null || committed === null) return null
    const entry = parseJournalEntry(raw)
    if (entry.seq !== seq || !isDeepStrictEqual(parseEventRef(committed), refOf(entry))) fail("INVALID_ORIGIN")
    validateOwner(key, entry); return entry
  }
  async function verify(key: OriginKey, ref: EventRef, kind?: string, payload?: unknown) {
    const parsed = parseEventRef(refOf(ref)), entry = await entryAt(key, parsed.seq)
    if (!entry || !isDeepStrictEqual(refOf(entry), parsed) || kind !== undefined && (entry.kind !== kind || !isDeepStrictEqual(entry.payload, payload))) fail("INVALID_ORIGIN")
    for (let seq = 1; seq < parsed.seq; seq++) if (!await entryAt(key, seq)) fail("MISSING_ORIGIN")
    await storage.publish(`${prefix(key)}/entries/${filename(entry.seq)}`, entry, null, true)
    await storage.publish(`${prefix(key)}/commits/${filename(entry.seq)}`, parsed, null, true)
  }
  async function sequences(key: OriginKey): Promise<number[]> {
    const names = await storage.names(`${prefix(key)}/commits`)
    return names.map(name => { if (!/^[0-9]{16}\.json$/.test(name)) fail("INVALID_ORIGIN"); const seq = timestamp(Number(name.slice(0, -5))); if (!seq) fail("INVALID_ORIGIN"); return seq })
  }
  async function ensure(snapshot: HostSnapshot) {
    if (snapshot.hostId !== hostId) fail("INVALID_ORIGIN")
    for (const fence of snapshot.replayFences) {
      const key = { hostId, runId: fence.runId, streamId: fence.streamId }, seqs = (await sequences(key)).filter(seq => seq <= fence.throughSeq)
      if (fence.checkpoint > fence.throughSeq || seqs.length !== fence.throughSeq) fail("MISSING_ORIGIN")
      for (let i = 0; i < seqs.length; i++) if (seqs[i] !== i + 1 || !await entryAt(key, i + 1)) fail("MISSING_ORIGIN")
    }
  }
  const binding = (snapshot: HostSnapshot, connectionId: string) => canonicalDigest({ snapshot, connectionId: id(connectionId) })
  return {
    hostId,
    async list(): Promise<OriginKey[]> {
      const keys: OriginKey[] = []
      for (const runId of await storage.directories(`origins/${hostId}`)) for (const streamId of await storage.directories(`origins/${hostId}/${id(runId)}`)) keys.push(parseKey({ hostId, runId, streamId }, hostId))
      return keys
    },
    import(key: OriginKey, raw: JournalEntry[]) { return queue.run(async () => {
      const base = prefix(key)
      for (const value of raw) {
        const entry = parseJournalEntry(value); validateOwner(key, entry)
        await storage.publish(`${base}/event-ids/${entry.eventId}.json`, refOf(entry), null, true)
        await storage.publish(`${base}/entries/${filename(entry.seq)}`, entry, null, true)
        await storage.publish(`${base}/commits/${filename(entry.seq)}`, refOf(entry), null, true)
      }
    }) },
    read(key: OriginKey, after: number, limit: number): Promise<JournalPage> { return queue.run(async () => {
      timestamp(after); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) fail("INVALID_PAGE")
      const seqs = await sequences(key), lastSeq = seqs.at(-1) ?? 0, entries: JournalEntry[] = []
      for (let seq = after + 1; seq <= lastSeq && entries.length < limit; seq++) { const entry = await entryAt(key, seq); if (!entry) fail("MISSING_ORIGIN"); entries.push(entry) }
      return { checkpoint: 0, lastSeq, entries, nextCursor: entries.at(-1)?.seq ?? after }
    }) },
    verify(key: OriginKey, ref: EventRef, kind: string, payload: unknown) { return queue.run(() => verify(key, ref, kind, payload)) },
    acknowledge(key: OriginKey, ref: EventRef) { return queue.run(async () => { await verify(key, ref); await storage.publish(`${prefix(key)}/acks/${filename(ref.seq)}`, parseEventRef(refOf(ref)), null, true) }) },
    acknowledged(key: OriginKey, ref: EventRef) { return queue.run(async () => { await verify(key, ref); const raw = await storage.read(`${prefix(key)}/acks/${filename(ref.seq)}`); if (raw === null) return false; if (!isDeepStrictEqual(parseEventRef(raw), refOf(ref))) fail("ACKNOWLEDGMENT_CONFLICT"); return true }) },
    watermark(key: OriginKey) { return queue.run(async () => {
      let through = 0
      for (const seq of await sequences(key)) {
        if (seq !== through + 1) break
        const entry = await entryAt(key, seq), raw = await storage.read(`${prefix(key)}/acks/${filename(seq)}`)
        if (!entry || raw === null) break
        if (!isDeepStrictEqual(parseEventRef(raw), refOf(entry))) fail("ACKNOWLEDGMENT_CONFLICT")
        through = seq
      }
      return through
    }) },
    complete(snapshot: HostSnapshot, connectionId: string) { return queue.run(async () => { await ensure(snapshot); const digest = binding(snapshot, connectionId); await storage.publish(`origin-fences/${hostId}/${digest}.json`, { digest, snapshot, connectionId }, null, true) }) },
    completed(snapshot: HostSnapshot, connectionId: string) { return queue.run(async () => { const digest = binding(snapshot, connectionId), raw = await storage.read(`origin-fences/${hostId}/${digest}.json`); if (raw === null) return false; if (!isDeepStrictEqual(raw, { digest, snapshot, connectionId })) fail("INVALID_ORIGIN"); await ensure(snapshot); return true }) }
  }
}
export type RemoteOrigins = ReturnType<typeof createRemoteOrigins>