import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { id, hash, keys, object, timestamp } from "../catalog/types.js"
import { MutationQueue } from "../handler/mutations.js"
import { createStorage, defaultFileSystem, storageQueue } from "../orchestration/storage.js"
import { boundedArray, canonicalDigest, enumValue, fail, parseAgentRef, parseEventRef, parseExecutionRef, type AgentRef, type ExecutionRef, type EventRef, type JournalEntry } from "../orchestration/types.js"
import { parseInboxEntry, type InboxEntry, type InboxStore, type createInbox } from "./inbox.js"
import type { JournalPool } from "../orchestration/journal.js"
import type { AssignmentRecord, AttemptRecord } from "./types.js"

export type WaitInput = { waitId: string; parent: AgentRef; runId: string; assignmentIds: string[]; after: number; timeoutMs: number }
export type WaitFailure = { assignmentId: string; attemptId: string; state: "failed" | "interrupted" | "cancelled" }
export type WaitResult = { waitId: string; kind: "reports" | "timeout" | "cancelled" | "terminal_failure"; cursor: number; reports: InboxEntry[]; failures: WaitFailure[] }
export type WaitRecord = { version: 1; input: WaitInput; target: ExecutionRef; bindingEpoch: string; digest: string; deadline: number; ended: boolean; result: WaitResult | null; deliveryId: string | null; journal: EventRef | null }
export function parseWaitInput(raw: unknown): WaitInput {
  const v = object(raw); keys(v, ["waitId", "parent", "runId", "assignmentIds", "after", "timeoutMs"])
  const assignmentIds = boundedArray(v.assignmentIds, id), timeoutMs = timestamp(v.timeoutMs)
  if (!assignmentIds.length || new Set(assignmentIds).size !== assignmentIds.length || timeoutMs > 2147483647) fail("INVALID_WAIT")
  return { waitId: id(v.waitId), parent: parseAgentRef(v.parent), runId: id(v.runId), assignmentIds, after: timestamp(v.after), timeoutMs }
}
export function parseWaitResult(raw: unknown): WaitResult {
  const v = object(raw); keys(v, ["waitId", "kind", "cursor", "reports", "failures"])
  const failures = boundedArray(v.failures, raw => { const f = object(raw); keys(f, ["assignmentId", "attemptId", "state"]); return { assignmentId: id(f.assignmentId), attemptId: id(f.attemptId), state: enumValue(f.state, ["failed", "interrupted", "cancelled"]) } })
  return { waitId: id(v.waitId), kind: enumValue(v.kind, ["reports", "timeout", "cancelled", "terminal_failure"]), cursor: timestamp(v.cursor), reports: boundedArray(v.reports, parseInboxEntry), failures }
}
export function parseWaitRecord(raw: unknown): WaitRecord {
  const v = object(raw); keys(v, ["version", "input", "target", "bindingEpoch", "digest", "deadline", "ended", "result", "deliveryId", "journal"])
  const input = parseWaitInput(v.input), target = parseExecutionRef(v.target), bindingEpoch = id(v.bindingEpoch), result = v.result === null ? null : parseWaitResult(v.result)
  if (v.version !== 1 || typeof v.ended !== "boolean" || input.parent.hostId !== target.hostId || input.parent.agentId !== target.agentId || canonicalDigest({ input, target, bindingEpoch }) !== v.digest || result && result.waitId !== input.waitId) fail("INVALID_WAIT")
  return { version: 1, input, target, bindingEpoch, digest: hash(v.digest), deadline: timestamp(v.deadline), ended: v.ended, result, deliveryId: v.deliveryId === null ? null : id(v.deliveryId), journal: v.journal === null ? null : parseEventRef(v.journal) }
}
export function parseWaitTransition(raw: unknown): { previousDigest: string | null; wait: WaitRecord } {
  const v = object(raw); keys(v, ["previousDigest", "wait"])
  return { previousDigest: v.previousDigest === null ? null : hash(v.previousDigest), wait: parseWaitRecord(v.wait) }
}
export function createWaitStore(root: string, filesystem = defaultFileSystem) {
  const storage = createStorage(root, "bureau", filesystem), queue = storageQueue(root)
  async function readWait(waitId: string): Promise<WaitRecord | null> {
    const raw = await storage.read(`waits/${id(waitId)}.json`)
    if (raw === null) return null
    const wait = parseWaitRecord(raw)
    if (wait.input.waitId !== waitId) fail("INVALID_WAIT")
    return wait
  }
  return { readWait,
    async listWaits(): Promise<WaitRecord[]> { const waits: WaitRecord[] = []; for (const name of await storage.names("waits")) { const wait = await readWait(id(name.slice(0, -5))); if (!wait) fail("INVALID_WAIT"); waits.push(wait) }; return waits },
    async writeWait(raw: WaitRecord, previous: WaitRecord | null) { const wait = parseWaitRecord(raw); await queue.run(() => storage.publish(`waits/${wait.input.waitId}.json`, wait, previous)) }
  }
}
export function createWaits(input: { store: ReturnType<typeof createWaitStore> & InboxStore & { listAssignments(): Promise<AssignmentRecord[]>; readAttempt(attemptId: string): Promise<AttemptRecord | null> }; journals: JournalPool; queue: MutationQueue; inbox: ReturnType<typeof createInbox>; requireWrites(): void; failed(error: unknown): void; binding(parent: AgentRef, runId: string): Promise<{ target: ExecutionRef; bindingEpoch: string } | null>; validateAssignments(parent: AgentRef, runId: string, assignmentIds: string[]): Promise<void>; now?: () => number; beforeAdmission?(): Promise<void> }) {
  const { store, journals, queue, inbox } = input, now = input.now ?? Date.now
  const transports = new Map<string, Set<{ resolve(result: WaitResult): void; reject(error: unknown): void }>>(), timers = new Map<string, NodeJS.Timeout>()
  let pumping = false
  async function apply(entry: JournalEntry): Promise<WaitRecord> {
    const transition = parseWaitTransition(entry.payload), previous = await store.readWait(transition.wait.input.waitId)
    const wait = parseWaitRecord({ ...transition.wait, journal: { seq: entry.seq, eventId: entry.eventId, digest: entry.digest } })
    if (previous?.journal && previous.journal.seq > entry.seq) return previous
    if (previous?.journal?.seq === entry.seq) { if (!isDeepStrictEqual(previous, wait)) fail("CORRUPT_WAIT"); return previous }
    if ((previous === null ? null : canonicalDigest(previous)) !== transition.previousDigest) fail("CORRUPT_WAIT")
    await store.writeWait(wait, previous)
    return wait
  }
  async function save(wait: WaitRecord, previous: WaitRecord | null): Promise<WaitRecord> {
    try { return await apply(await journals.forRun(wait.input.runId).append(randomUUID(), "bureau-wait", { previousDigest: previous === null ? null : canonicalDigest(previous), wait })) }
    catch (error) { input.failed(error); throw error }
  }
  function respond(wait: WaitRecord): void {
    if (!wait.result) return
    clearTimeout(timers.get(wait.input.waitId)); timers.delete(wait.input.waitId)
    for (const transport of transports.get(wait.input.waitId) ?? []) transport.resolve(structuredClone(wait.result))
    transports.delete(wait.input.waitId)
  }
  async function end(wait: WaitRecord): Promise<WaitRecord> {
    if (wait.ended) return wait
    const result = wait.result ?? { waitId: wait.input.waitId, kind: "cancelled" as const, cursor: wait.input.after, reports: [], failures: [] }
    const ended = await save({ ...wait, ended: true, result }, wait)
    await inbox.releaseRoute(wait.input.waitId)
    respond(ended)
    return ended
  }
  async function evaluate(wait: WaitRecord): Promise<WaitRecord> {
    if (wait.ended) { await inbox.releaseRoute(wait.input.waitId); respond(wait); return wait }
    const binding = await input.binding(wait.input.parent, wait.input.runId)
    if (!binding || !isDeepStrictEqual(binding.target, wait.target) || binding.bindingEpoch !== wait.bindingEpoch) return end(wait)
    if (wait.result) { if (wait.deliveryId) await inbox.delivered(wait.deliveryId, "wait", wait.input.waitId); respond(wait); return wait }
    const selected: InboxEntry[] = [], candidates = (await store.listInbox()).filter(entry => entry.runId === wait.input.runId && wait.input.assignmentIds.includes(entry.report.assignmentId) && entry.source.seq > wait.input.after).sort((a, b) => a.source.seq - b.source.seq)
    let bytes = 0
    for (const entry of candidates) { const size = Buffer.byteLength(JSON.stringify(entry)); if (selected.length && (selected.length === 128 || bytes + size > 256 * 1024)) break; selected.push(entry); bytes += size }
    const failures: WaitFailure[] = []
    if (!selected.length) for (const assignment of await store.listAssignments()) if (assignment.runId === wait.input.runId && wait.input.assignmentIds.includes(assignment.assignmentId)) {
      const attempt = await store.readAttempt(assignment.activeAttemptId)
      if (attempt && ["failed", "interrupted", "cancelled"].includes(attempt.state)) failures.push({ assignmentId: assignment.assignmentId, attemptId: attempt.ref.attemptId, state: attempt.state as WaitFailure["state"] })
    }
    const kind: WaitResult["kind"] | null = selected.length ? "reports" : failures.length ? "terminal_failure" : now() >= wait.deadline ? "timeout" : null
    if (!kind) {
      if (!timers.has(wait.input.waitId)) { const timer = setTimeout(() => { timers.delete(wait.input.waitId); notify() }, Math.max(1, wait.deadline - now())); timers.set(wait.input.waitId, timer) }
      return wait
    }
    const own = selected.filter(entry => isDeepStrictEqual(entry.parent, wait.input.parent)), delivery = own.length ? await inbox.claim(wait.input.parent, own.map(entry => entry.eventId), wait.target, wait.input.runId, wait.bindingEpoch, "wait", wait.input.waitId) : null
    const result: WaitResult = { waitId: wait.input.waitId, kind, cursor: selected.at(-1)?.source.seq ?? wait.input.after, reports: selected, failures }
    const saved = await save({ ...wait, result, ended: kind !== "reports", deliveryId: delivery?.deliveryId ?? null }, wait)
    if (delivery) await inbox.delivered(delivery.deliveryId, "wait", wait.input.waitId)
    respond(saved)
    return saved
  }
  async function pump(): Promise<void> {
    for (const wait of (await store.listWaits()).sort((a, b) => (a.journal?.seq ?? 0) - (b.journal?.seq ?? 0))) await evaluate(wait)
  }
  function notify(): void {
    if (pumping) return
    pumping = true
    void queue.run(async () => { input.requireWrites(); await pump() }).catch(error => { if (!(error instanceof Error && ["BUREAU_DISABLED", "NOT_READY", "BUREAU_UNAVAILABLE"].includes(error.message))) input.failed(error); for (const transport of [...transports.values()].flatMap(value => [...value])) transport.reject(error); transports.clear() }).finally(() => { pumping = false })
  }
  async function wait(raw: WaitInput, signal?: AbortSignal, authority?: { execution: ExecutionRef; bindingEpoch: string }): Promise<WaitResult> {
    const requested = parseWaitInput(raw)
    const record = await queue.run(async () => {
      input.requireWrites()
      await input.beforeAdmission?.()
      const previous = await store.readWait(requested.waitId)
      if (previous) { if (authority && (!isDeepStrictEqual(previous.target, authority.execution) || previous.bindingEpoch !== authority.bindingEpoch)) fail("STALE_BINDING"); if (!isDeepStrictEqual(previous.input, requested)) fail("COMMAND_CONFLICT"); return evaluate(previous) }
      const binding = await input.binding(requested.parent, requested.runId)
      if (!binding) fail("NOT_READY")
      if (authority && (!isDeepStrictEqual(binding.target, authority.execution) || binding.bindingEpoch !== authority.bindingEpoch)) fail("STALE_EXECUTION")
      await input.validateAssignments(requested.parent, requested.runId, requested.assignmentIds)
      const value: WaitRecord = { version: 1, input: requested, target: binding.target, bindingEpoch: binding.bindingEpoch, digest: canonicalDigest({ input: requested, ...binding }), deadline: now() + requested.timeoutMs, ended: false, result: null, deliveryId: null, journal: null }
      return evaluate(await save(value, null))
    })
    if (record.result) return structuredClone(record.result)
    return new Promise<WaitResult>((resolve, reject) => {
      const waitId = requested.waitId, attached = transports.get(waitId) ?? new Set(), detach = () => { attached.delete(transport); if (!attached.size) transports.delete(waitId); signal?.removeEventListener("abort", abort) }
      const transport = { resolve(result: WaitResult) { detach(); resolve(result) }, reject(error: unknown) { detach(); reject(error) } }
      const abort = () => transport.reject(new Error("ABORTED"))
      attached.add(transport); transports.set(waitId, attached)
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      else void queue.run(async () => { input.requireWrites(); const saved = await store.readWait(waitId); if (saved) await evaluate(saved) }).catch(error => transport.reject(error))
    })
  }
  return { apply, recoverLocked: pump, notify, wait,
    async cancel(waitId: string) { return queue.run(async () => { input.requireWrites(); const saved = await store.readWait(id(waitId)); if (!saved) fail("WAIT_NOT_FOUND"); return end(saved) }) },
    close() { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); for (const transport of [...transports.values()].flatMap(value => [...value])) transport.reject(new Error("BUREAU_UNAVAILABLE")); transports.clear() }
  }
}