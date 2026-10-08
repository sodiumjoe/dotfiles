import { createStorage, storageQueue } from "../orchestration/storage.js"
import { MutationQueue } from "../handler/mutations.js"
import { canonicalDigest, fail, parseJournalEntry } from "../orchestration/types.js"
import { createPermissionHistory, parsePermissionEvent, parsePermissionRef, parsePermissionReceipt, parsePermissionSnapshot, type PermissionOffer, type PermissionReceipt, type PermissionRef, type PermissionSnapshot } from "../orchestration/permission-routing.js"
import { hash, id, keys, object, timestamp } from "../catalog/types.js"
import type { OrchestrationHost } from "./host.js"

export function createBureauPermissions(input: { root: string; hosts: OrchestrationHost[]; enabled(): boolean }) {
  const storage = createStorage(input.root, "bureau"), queue = storageQueue(input.root)
  const captures = new Map<string, PermissionSnapshot>(), captureQueues = new Map<OrchestrationHost, MutationQueue>()
  async function capture(host: OrchestrationHost, snapshot: PermissionSnapshot): Promise<void> {
    if (snapshot.hostId !== host.hostId) fail("INVALID_ORIGIN")
    const prior = await queue.run(() => storage.read(`permission-hosts/${snapshot.hostId}.json`))
    const saved = prior === null ? null : parsePermissionSnapshot(prior)
    if (saved && snapshot.throughSeq < saved.throughSeq) fail("INVALID_CURSOR")
    let after = saved?.throughSeq ?? 0
    const received = []
    while (after < snapshot.throughSeq) {
      if (!host.permissionRead) fail("UNSUPPORTED_CAPABILITY")
      const page = await host.permissionRead(after, 256)
      if (page.checkpoint > after || page.lastSeq < snapshot.throughSeq) fail("INVALID_CURSOR")
      for (const raw of page.entries) {
        const entry = parseJournalEntry(raw)
        if (entry.seq > snapshot.throughSeq) break
        if (entry.seq !== after + 1 || entry.kind !== "permission") fail("INVALID_CURSOR")
        const event = parsePermissionEvent(entry.payload)
        const eventHost = event.kind === "owner" ? event.hostId : event.kind === "offer" ? event.offer.ref.hostId : event.kind === "receipt" ? event.receipt.ref.hostId : event.ref.hostId
        if (eventHost !== snapshot.hostId) fail("INVALID_ORIGIN")
        await queue.run(() => storage.publish(`permission-events/${snapshot.hostId}/${String(entry.seq).padStart(16, "0")}.json`, entry, null, true))
        received.push(entry); after = entry.seq
      }
      if (after === (saved?.throughSeq ?? 0) && !received.length || !page.entries.length) fail("INVALID_CURSOR")
    }
    const history = createPermissionHistory(snapshot.hostId)
    for (let seq = 1; seq <= snapshot.throughSeq; seq++) {
      const entry = parseJournalEntry(await queue.run(() => storage.read(`permission-events/${snapshot.hostId}/${String(seq).padStart(16, "0")}.json`)))
      history.apply(parsePermissionEvent(entry.payload))
    }
    history.validate(snapshot)
    await queue.run(() => storage.publish(`permission-hosts/${snapshot.hostId}.json`, snapshot, prior))
    captures.set(snapshot.hostId, structuredClone(snapshot))
    if (host.permissionAcknowledge) {
      const ackKey = `permission-acks/${snapshot.hostId}.json`
      let raw = await queue.run(() => storage.read(ackKey)), acknowledged = raw === null ? 0 : timestamp(object(raw).throughSeq)
      while (acknowledged < snapshot.throughSeq) {
        const entry = parseJournalEntry(await queue.run(() => storage.read(`permission-events/${snapshot.hostId}/${String(acknowledged + 1).padStart(16, "0")}.json`)))
        await host.permissionAcknowledge(entry)
        await queue.run(async () => {
          raw = await storage.read(ackKey)
          const throughSeq = raw === null ? 0 : timestamp(object(raw).throughSeq)
          if (throughSeq >= entry.seq) return
          if (throughSeq !== entry.seq - 1) fail("INVALID_CURSOR")
          await storage.publish(ackKey, { throughSeq: entry.seq }, raw)
        })
        acknowledged = entry.seq
      }
    }
  }
  function available(): void { if (!input.enabled()) fail("BUREAU_DISABLED") }
  async function current(): Promise<{ hosts: PermissionSnapshot[]; unavailable: Array<{ hostId: string | null; code: string }> }> {
    available()
    const result = await Promise.allSettled(input.hosts.map(async host => {
      const snapshot = await host.snapshot()
      if (!snapshot.permissions) { if (host.permissionRead) fail("PERMISSIONS_UNAVAILABLE"); return null }
      const permissions = parsePermissionSnapshot(snapshot.permissions)
      if (permissions.handlerGeneration !== snapshot.handlerGeneration) fail("STALE_HANDLER")
      let captureQueue = captureQueues.get(host)
      if (!captureQueue) { captureQueue = new MutationQueue(); captureQueues.set(host, captureQueue) }
      await captureQueue.run(() => capture(host, permissions)); return permissions
    }))
    return { hosts: result.flatMap(value => value.status === "fulfilled" && value.value ? [value.value] : []),
      unavailable: result.flatMap((value, index) => value.status === "rejected" ? [{ hostId: input.hosts[index]!.hostId ?? null, code: "ORIGIN_UNAVAILABLE" }] : []) }
  }
  return {
    async snapshot(): Promise<{ pending: PermissionOffer[]; hosts: PermissionSnapshot[]; unavailable: Array<{ hostId: string | null; code: string }> }> {
      const { hosts, unavailable } = await current(); return { pending: hosts.flatMap(host => host.pending), hosts, unavailable }
    },
    async decide(commandId: string, rawRef: PermissionRef, optionId: string): Promise<PermissionReceipt> {
      available(); commandId = id(commandId); const ref = parsePermissionRef(rawRef)
      const host = input.hosts.find(host => host.hostId === ref.hostId)
      const existingCommand = await queue.run(() => storage.read(`permission-commands/${commandId}.json`))
      if (existingCommand === null && host) {
        const snapshot = await host.snapshot()
        const offer = snapshot.permissions?.pending.find(offer => canonicalDigest(offer.ref) === canonicalDigest(ref))
        if (offer && !offer.options.some(option => option.optionId === optionId)) fail("INVALID_OPTION")
      }
      const digest = canonicalDigest({ commandId, ref, optionId }), key = `permission-commands/${commandId}.json`
      const saved = await queue.run(async () => {
        const prior = await storage.read(key)
        if (prior !== null) {
          const v = object(prior); keys(v, ["commandId", "ref", "optionId", "digest", "receipt"])
          if (hash(v.digest) !== digest) fail("COMMAND_CONFLICT")
          return { prior, receipt: v.receipt === null ? null : parsePermissionReceipt(v.receipt), fresh: false }
        }
        const next = { commandId, ref, optionId, digest, receipt: null }
        await storage.publish(key, next, null, true); return { prior: next, receipt: null, fresh: true }
      })
      if (saved.receipt && saved.receipt.state !== "uncertain") return saved.receipt
      const uncertain: PermissionReceipt = { commandId, ref, optionId, digest, state: "uncertain" }
      if (!host?.permissionDecide || !host.permissionInspect) return uncertain
      let receipt: PermissionReceipt
      try {
        const snapshot = await host.snapshot()
        const existing = await host.permissionInspect(commandId)
        if (existing) receipt = parsePermissionReceipt(existing)
        else if (!saved.fresh) receipt = uncertain
        else {
          const permitted = snapshot.permissions?.pending.some(offer => canonicalDigest(offer.ref) === canonicalDigest(ref))
          if (!permitted) receipt = { ...uncertain, state: "stale" }
          else receipt = parsePermissionReceipt(await host.permissionDecide(commandId, ref, optionId))
        }
        if (receipt.digest !== digest) fail("COMMAND_CONFLICT")
        if (receipt.state === "claimed") receipt = uncertain
      } catch { receipt = uncertain }
      return queue.run(async () => {
        const prior = await storage.read(key)
        if (!prior || hash(object(prior).digest) !== digest) fail("COMMAND_CONFLICT")
        const known = object(prior).receipt === null ? null : parsePermissionReceipt(object(prior).receipt)
        if (known && known.state !== "uncertain") return known
        await storage.publish(key, { commandId, ref, optionId, digest, receipt }, prior)
        return receipt
      })
    },
    async inspect(commandId: string): Promise<PermissionReceipt | null> {
      id(commandId)
      const value = await queue.run(() => storage.read(`permission-commands/${commandId}.json`))
      return value === null || object(value).receipt === null ? null : parsePermissionReceipt(object(value).receipt)
    },
    observed(hostId: string): PermissionSnapshot | null { return structuredClone(captures.get(hash(hostId)) ?? null) }
  }
}