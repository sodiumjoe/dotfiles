import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { hash, id, keys, object } from "../catalog/types.js"
import type { MutationQueue } from "../handler/mutations.js"
import type { BureauStore } from "../bureau/store.js"
import type { OrchestrationHost } from "../bureau/host.js"
import { parseDelivery, type createInbox, type Delivery, type InboxEntry, acknowledges } from "../bureau/inbox.js"
import type { JournalPool } from "./journal.js"
import { journalEntries } from "./reports.js"
import { canonicalDigest, enumValue, fail, parseExecutionRef, type AgentRef, type ExecutionRef } from "./types.js"

export type NotificationReceipt = { deliveryId: string; submissionId: string; runId: string; bindingEpoch: string; target: ExecutionRef; digest: string; state: "queued" | "dispatching" | "accepted" | "completed" | "interrupted" | "uncertain" }
export function parseNotificationReceipt(raw: unknown): NotificationReceipt {
  const v = object(raw); keys(v, ["deliveryId", "submissionId", "runId", "bindingEpoch", "target", "digest", "state"])
  return { deliveryId: id(v.deliveryId), submissionId: id(v.submissionId), runId: id(v.runId), bindingEpoch: id(v.bindingEpoch), target: parseExecutionRef(v.target), digest: hash(v.digest), state: enumValue(v.state, ["queued", "dispatching", "accepted", "completed", "interrupted", "uncertain"]) }
}
export function parseNotificationRetry(raw: unknown): { commandId: string; previousDeliveryId: string; result: Delivery } {
  const v = object(raw); keys(v, ["commandId", "previousDeliveryId", "result"])
  const result = parseDelivery(v.result), commandId = id(v.commandId)
  if (result.deliveryId !== commandId || result.channel !== "prompt" || result.state !== "queued" || result.journal !== null) fail("INVALID_DELIVERY")
  return { commandId, previousDeliveryId: id(v.previousDeliveryId), result }
}
export function notificationPrompt(entries: InboxEntry[]) {
  return [{ type: "text", text: "Delegated assignments reported:\n" + JSON.stringify(entries.map(entry => ({ eventId: entry.eventId, assignmentId: entry.report.assignmentId, attemptId: entry.report.attemptId, report: { status: entry.report.report.status, summary: entry.report.report.summary.slice(0, 4096), summaryTruncated: entry.report.report.summary.length > 4096, issueCount: entry.report.report.issues.length, validationCount: entry.report.report.validation.length } }))) }]
}
export function createScheduler(input: { store: BureauStore; journals: JournalPool; queue: MutationQueue; inbox: ReturnType<typeof createInbox>; hosts: OrchestrationHost[]; requireWrites(): void; failed(error: unknown): void; beforeClaim(): Promise<void>; automatic?: boolean }) {
  const { store, journals, queue, inbox } = input
  let closed = false, queued = false
  const active = new Map<string, Promise<void>>(), rerun = new Set<string>()
  async function adapter(hostId: string): Promise<OrchestrationHost> {
    for (const host of input.hosts) {
      if (host.hostId) { if (host.hostId === hostId) return host; continue }
      try { if ((await host.snapshot()).hostId === hostId) return host } catch (error) { if (error instanceof Error && /ENOSPC|CORRUPT|STATE_CHANGED|STATE_REPLACED/.test(error.message)) throw error }
    }
    return fail("HOST_UNAVAILABLE")
  }
  async function source(delivery: Delivery): Promise<InboxEntry[]> {
    return Promise.all(delivery.sources.map(async ref => { const entry = await store.readInbox(ref.eventId); if (!entry || !isDeepStrictEqual(entry.source, ref) || entry.runId !== delivery.runId || !isDeepStrictEqual(entry.parent, delivery.parent)) fail("INVALID_DELIVERY"); return entry }))
  }
  async function publish(delivery: Delivery, state: NotificationReceipt["state"]): Promise<void> {
    try {
      const receipt = parseNotificationReceipt({ deliveryId: delivery.deliveryId, submissionId: delivery.deliveryId, runId: delivery.runId, bindingEpoch: delivery.bindingEpoch, target: delivery.target, digest: canonicalDigest({ prompt: notificationPrompt(await source(delivery)) }), state })
      await journals.forRun(delivery.runId).append(randomUUID(), "notification-receipt", receipt)
    } catch (error) { input.failed(error); throw error }
  }
  async function reconcile(parent: AgentRef): Promise<void> {
    const deliveries = (await store.listDeliveries()).filter(delivery => delivery.channel === "prompt" && isDeepStrictEqual(delivery.parent, parent) && ["claimed", "dispatching", "accepted", "completed"].includes(delivery.state))
    for (const original of deliveries) {
      let state: Delivery["state"] = original.state
      const host = await adapter(parent.hostId), snapshot = await host.snapshot(), observed = snapshot.agents.find(agent => isDeepStrictEqual(agent.agent, parent))
      if (original.state === "claimed") state = "queued"
      else if (!isDeepStrictEqual(observed?.execution, original.target) || observed?.phase !== "ready") state = "interrupted"
      else {
        const receipt = await host.submission(original.target, original.deliveryId)
        if (receipt) {
          if (receipt.digest !== canonicalDigest({ prompt: notificationPrompt(await source(original)) })) fail("INVALID_RECEIPT")
          state = receipt.state === "completed" ? "completed" : receipt.state === "failed" ? "uncertain" : "accepted"
        } else state = "uncertain"
      }
      await queue.run(async () => {
        input.requireWrites(); const current = await store.readDelivery(original.deliveryId)
        if (!current || !isDeepStrictEqual(current, original)) return
        const saved = state === current.state ? current : await inbox.save({ ...current, state }, current)
        if (state !== "queued") await publish(saved, state as NotificationReceipt["state"])
        if (state === "completed") await inbox.delivered(saved.deliveryId, "prompt", saved.deliveryId)
      })
    }
  }
  async function work(parent: AgentRef): Promise<void> {
    if (closed) return
    await reconcile(parent)
    const selected = await queue.run(async () => {
      input.requireWrites(); await input.beforeClaim()
      const entries = (await store.listInbox()).filter(entry => isDeepStrictEqual(entry.parent, parent)).sort((a, b) => a.source.seq - b.source.seq)
      const deliveries = await store.listDeliveries(), acknowledgments = await store.listAcknowledgments()
      const pending = entries.filter(entry => !acknowledges(acknowledgments, entry.runId, entry.source) && !deliveries.some(delivery => !["queued", "superseded"].includes(delivery.state) && delivery.runId === entry.runId && delivery.sources.some(source => source.eventId === entry.eventId)))
      const first = pending[0]
      if (!first) return null
      const run = await store.readRun(first.runId)
      if (!run || run.state !== "active") return null
      const host = await adapter(parent.hostId), snapshot = await host.snapshot(), observed = snapshot.agents.find(agent => isDeepStrictEqual(agent.agent, parent))
      if (!observed?.execution || observed.phase !== "ready") return null
      const previous = [...deliveries].sort((a, b) => (b.journal?.seq ?? 0) - (a.journal?.seq ?? 0)).find(delivery => delivery.channel === "prompt" && delivery.state === "queued" && delivery.runId === run.runId && isDeepStrictEqual(delivery.parent, parent) && delivery.sources.every(source => pending.some(entry => entry.eventId === source.eventId)))
      const candidates = previous ? await source(previous) : pending.filter(entry => entry.runId === run.runId), batch: InboxEntry[] = []
      let bytes = 0
      for (const entry of candidates) { const size = Buffer.byteLength(JSON.stringify(entry)); if (batch.length && (batch.length === 128 || bytes + size > 256 * 1024)) break; batch.push(entry); bytes += size }
      const delivery = await inbox.claim(parent, batch.map(entry => entry.eventId), observed.execution, run.runId, run.bindingEpoch, "prompt", null, previous?.deliveryId)
      if (!delivery) return null
      const dispatching = await inbox.save({ ...delivery, state: "dispatching", receiptId: delivery.deliveryId }, delivery)
      await publish(dispatching, "dispatching")
      return { host, delivery: dispatching, prompt: notificationPrompt(batch) }
    })
    if (!selected || closed) return
    const { host, delivery, prompt } = selected
    try {
      await host.submit(delivery.target, { submissionId: delivery.deliveryId, prompt }, async () => {
        const run = await store.readRun(delivery.runId)
        if (!run || run.state !== "active" || run.bindingEpoch !== delivery.bindingEpoch) fail("STALE_BINDING")
        const acknowledgments = await store.listAcknowledgments()
        if (delivery.sources.some(source => acknowledges(acknowledgments, delivery.runId, source))) fail("STALE_BINDING")
        await publish(delivery, "accepted")
      })
    } catch (error) {
      if (error instanceof Error && ((error as { code?: string }).code === "BUSY" || error.message === "BUSY")) {
        await queue.run(async () => { input.requireWrites(); const current = (await store.readDelivery(delivery.deliveryId))!; await publish(current, "queued"); await inbox.save({ ...current, state: "queued", receiptId: null }, current) })
        return
      }
      input.requireWrites()
    }
    await reconcile(parent)
  }
  function schedule(parent: AgentRef): Promise<void> {
    const key = parent.hostId + "/" + parent.agentId, previous = active.get(key)
    if (previous) { rerun.add(key); return previous }
    const pending = work(parent).finally(() => { if (active.get(key) === pending) active.delete(key); if (rerun.delete(key)) notify() })
    active.set(key, pending)
    return pending
  }
  function notify(): void {
    if (closed || queued || !input.automatic) return
    queued = true
    setImmediate(() => {
      queued = false
      if (closed) return
      void (async () => {
        const deliveries = await store.listDeliveries(), entries = await store.listInbox(), acknowledgments = await store.listAcknowledgments(), parents = new Map<string, AgentRef>()
        for (const entry of entries) if (!acknowledges(acknowledgments, entry.runId, entry.source) && !deliveries.some(delivery => delivery.runId === entry.runId && delivery.state === "delivered" && delivery.sources.some(source => source.eventId === entry.eventId))) parents.set(entry.parent.hostId + "/" + entry.parent.agentId, entry.parent)
        for (const parent of parents.values()) await schedule(parent)
      })().catch(() => undefined)
    })
  }
  const unsubscribe = input.automatic ? input.hosts.flatMap(host => host.onSettled ? [host.onSettled(notify)] : []) : []
  return { schedule, reconcile, notify, close() { closed = true; for (const stop of unsubscribe) stop() } }
}