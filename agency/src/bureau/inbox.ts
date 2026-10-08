import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { id, hash, keys, object } from "../catalog/types.js"
import { createStorage, defaultFileSystem, storageQueue } from "../orchestration/storage.js"
import { canonicalDigest, enumValue, fail, parseAgentRef, parseEventRef, parseExecutionRef, parseReportInput, boundedArray, type AgentRef, type EventRef, type ExecutionRef, type JournalEntry, type ReportInput } from "../orchestration/types.js"
import { parseAcceptedReport, type AcceptedReport } from "../orchestration/reports.js"
import type { JournalPool } from "../orchestration/journal.js"

export type InboxEntry = { version: 1; eventId: string; runId: string; parent: AgentRef; source: EventRef; report: ReportInput }
export type Delivery = { version: 1; deliveryId: string; runId: string; parent: AgentRef; target: ExecutionRef; bindingEpoch: string; sources: EventRef[]; digest: string; channel: "wait" | "prompt"; routeId: string | null; state: "queued" | "claimed" | "dispatching" | "accepted" | "completed" | "interrupted" | "uncertain" | "delivered"; receiptId: string | null; journal: EventRef | null }
export type InboxView = { entries: InboxEntry[]; pending: InboxEntry[]; deliveries: Delivery[]; nextCursor: number | null }
export type ReportTransition = AcceptedReport & { recipient: AgentRef | null }
export function parseReportTransition(raw: unknown): ReportTransition {
  const { recipient, ...report } = object(raw)
  const accepted = parseAcceptedReport(report)
  if ((recipient === null) !== (accepted.receipt.state === "late")) fail("INVALID_REPORT")
  return { ...accepted, recipient: recipient === null ? null : parseAgentRef(recipient) }
}
export function parseInboxEntry(raw: unknown): InboxEntry {
  const v = object(raw); keys(v, ["version", "eventId", "runId", "parent", "source", "report"])
  const report = parseReportInput(v.report), source = parseEventRef(v.source)
  if (v.version !== 1 || v.eventId !== report.commandId || v.runId !== report.runId || source.eventId !== v.eventId) fail("INVALID_INBOX")
  return { version: 1, eventId: id(v.eventId), runId: id(v.runId), parent: parseAgentRef(v.parent), source, report }
}
export function parseDelivery(raw: unknown): Delivery {
  const v = object(raw); keys(v, ["version", "deliveryId", "runId", "parent", "target", "bindingEpoch", "sources", "digest", "channel", "routeId", "state", "receiptId", "journal"])
  const parent = parseAgentRef(v.parent), target = parseExecutionRef(v.target), sources = boundedArray(v.sources, parseEventRef), channel = enumValue(v.channel, ["wait", "prompt"])
  if (v.version !== 1 || !sources.length || new Set(sources.map(source => source.eventId)).size !== sources.length || parent.hostId !== target.hostId || parent.agentId !== target.agentId || canonicalDigest(sources) !== v.digest || (channel === "wait") !== (v.routeId !== null)) fail("INVALID_DELIVERY")
  return { version: 1, deliveryId: id(v.deliveryId), runId: id(v.runId), parent, target, bindingEpoch: id(v.bindingEpoch), sources, digest: hash(v.digest), channel, routeId: v.routeId === null ? null : id(v.routeId), state: enumValue(v.state, ["queued", "claimed", "dispatching", "accepted", "completed", "interrupted", "uncertain", "delivered"]), receiptId: v.receiptId === null ? null : id(v.receiptId), journal: v.journal === null ? null : parseEventRef(v.journal) }
}
export function parseDeliveryTransition(raw: unknown): { previousDigest: string | null; delivery: Delivery } {
  const v = object(raw); keys(v, ["previousDigest", "delivery"])
  return { previousDigest: v.previousDigest === null ? null : hash(v.previousDigest), delivery: parseDelivery(v.delivery) }
}
export function createInboxStore(root: string, filesystem = defaultFileSystem) {
  const storage = createStorage(root, "bureau", filesystem), queue = storageQueue(root)
  async function read<T>(area: string, recordId: string, parse: (value: unknown) => T): Promise<T | null> {
    const raw = await storage.read(`${area}/${id(recordId)}.json`)
    if (raw === null) return null
    const record = parse(raw), value = object(record)
    if ((area === "inbox" ? value.eventId : value.deliveryId) !== recordId) fail("INVALID_INBOX")
    return record
  }
  async function list<T>(area: string, parse: (value: unknown) => T): Promise<T[]> {
    const records: T[] = []
    for (const name of await storage.names(area)) { const record = await read(area, id(name.slice(0, -5)), parse); if (!record) fail("INVALID_INBOX"); records.push(record) }
    return records
  }
  return {
    readInbox: (eventId: string) => read("inbox", eventId, parseInboxEntry),
    listInbox: () => list("inbox", parseInboxEntry),
    async writeInbox(raw: InboxEntry) { const entry = parseInboxEntry(raw); await queue.run(() => storage.publish(`inbox/${entry.eventId}.json`, entry, null, true)) },
    readDelivery: (deliveryId: string) => read("deliveries", deliveryId, parseDelivery),
    listDeliveries: () => list("deliveries", parseDelivery),
    async writeDelivery(raw: Delivery, previous: Delivery | null) { const delivery = parseDelivery(raw); await queue.run(() => storage.publish(`deliveries/${delivery.deliveryId}.json`, delivery, previous)) }
  }
}
export type InboxStore = ReturnType<typeof createInboxStore>
export function createInbox(input: { store: InboxStore; journals: JournalPool; failed(error: unknown): void }) {
  const { store, journals } = input
  async function apply(entry: JournalEntry): Promise<Delivery> {
    const transition = parseDeliveryTransition(entry.payload), previous = await store.readDelivery(transition.delivery.deliveryId)
    const delivery = parseDelivery({ ...transition.delivery, journal: { seq: entry.seq, eventId: entry.eventId, digest: entry.digest } })
    for (const source of delivery.sources) {
      const report = await store.readInbox(source.eventId)
      if (!report || report.runId !== delivery.runId || !isDeepStrictEqual(report.parent, delivery.parent) || !isDeepStrictEqual(report.source, source)) fail("INVALID_DELIVERY")
    }
    if (previous?.journal && previous.journal.seq > entry.seq) return previous
    if (previous?.journal?.seq === entry.seq) { if (!isDeepStrictEqual(previous, delivery)) fail("CORRUPT_INBOX"); return previous }
    if ((previous === null ? null : canonicalDigest(previous)) !== transition.previousDigest) fail("CORRUPT_INBOX")
    await store.writeDelivery(delivery, previous)
    return delivery
  }
  async function save(delivery: Delivery, previous: Delivery | null): Promise<Delivery> {
    try { return await apply(await journals.forRun(delivery.runId).append(randomUUID(), "bureau-delivery", { previousDigest: previous === null ? null : canonicalDigest(previous), delivery })) }
    catch (error) { input.failed(error); throw error }
  }
  const matches = (entry: InboxEntry, parent: AgentRef, runId: string) => entry.runId === runId && isDeepStrictEqual(entry.parent, parent)
  const holds = (delivery: Delivery) => delivery.state !== "queued"
  async function entries(parent: AgentRef, runId: string): Promise<InboxEntry[]> { return (await store.listInbox()).filter(entry => matches(entry, parent, runId)).sort((a, b) => a.source.seq - b.source.seq) }
  async function inspect(parent: AgentRef, runId: string, after = 0): Promise<InboxView> {
    const all = (await entries(parent, runId)).filter(entry => entry.source.seq > after), deliveries = (await store.listDeliveries()).filter(delivery => delivery.runId === runId && isDeepStrictEqual(delivery.parent, parent)), page: InboxEntry[] = []
    let bytes = 0
    for (const entry of all) { const size = Buffer.byteLength(JSON.stringify(entry)); if (page.length && (page.length === 128 || bytes + size > 256 * 1024)) break; page.push(entry); bytes += size }
    const visible = deliveries.filter(delivery => delivery.sources.some(source => page.some(entry => entry.eventId === source.eventId)))
    return { entries: page, pending: page.filter(entry => !deliveries.some(delivery => holds(delivery) && delivery.sources.some(source => source.eventId === entry.eventId))), deliveries: visible, nextCursor: page.length < all.length ? page.at(-1)!.source.seq : null }
  }
  async function claim(parent: AgentRef, eventIds: string[], target: ExecutionRef, runId: string, bindingEpoch: string, channel: Delivery["channel"] = "prompt", routeId: string | null = null): Promise<Delivery | null> {
    parseAgentRef(parent); parseExecutionRef(target); id(runId); id(bindingEpoch)
    if (!eventIds.length || eventIds.length > 128 || new Set(eventIds).size !== eventIds.length) fail("INVALID_DELIVERY")
    const available = await entries(parent, runId), deliveries = await store.listDeliveries()
    const requested = eventIds.map(eventId => { const entry = available.find(entry => entry.eventId === id(eventId)); if (!entry) fail("INVALID_DELIVERY"); return entry.source })
    const existing = deliveries.find(delivery => delivery.runId === runId && delivery.channel === channel && delivery.routeId === routeId && isDeepStrictEqual(delivery.sources, requested) && isDeepStrictEqual(delivery.parent, parent))
    if (existing && existing.state !== "queued") { if (!isDeepStrictEqual(existing.target, target) || existing.bindingEpoch !== bindingEpoch) fail("STALE_BINDING"); return existing }
    const sources = requested.filter(source => !deliveries.some(delivery => holds(delivery) && delivery.sources.some(other => other.eventId === source.eventId)))
    if (!sources.length) return null
    const reusable = existing && isDeepStrictEqual(existing.sources, sources) ? existing : null
    return save({ version: 1, deliveryId: reusable?.deliveryId ?? randomUUID(), runId, parent, target, bindingEpoch, sources, digest: canonicalDigest(sources), channel, routeId, state: "claimed", receiptId: null, journal: reusable?.journal ?? null }, reusable)
  }
  async function delivered(deliveryId: string, channel: Delivery["channel"], receiptId: string): Promise<void> {
    const previous = await store.readDelivery(id(deliveryId)); if (!previous || previous.channel !== channel) fail("INVALID_DELIVERY")
    id(receiptId)
    if (previous.state === "delivered") { if (previous.receiptId !== receiptId) fail("COMMAND_CONFLICT"); return }
    if (previous.state !== "claimed" && previous.state !== "accepted" && previous.state !== "completed") fail("INVALID_DELIVERY")
    await save({ ...previous, state: "delivered", receiptId }, previous)
  }
  async function releaseRoute(routeId: string): Promise<void> {
    for (const previous of await store.listDeliveries()) if (previous.channel === "wait" && previous.routeId === routeId && previous.state !== "queued") await save({ ...previous, state: "queued", receiptId: null }, previous)
  }
  return { apply, save, entries, inspect, claim, delivered, releaseRoute }
}