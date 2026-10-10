import { randomUUID } from "node:crypto"
import { absolutePath, hash, id, keys, object, text, timestamp } from "../catalog/types.js"
import type { JsonObject } from "../agent/session-config.js"
import { type AgentTuple } from "../agent/types.js"
import { MutationQueue } from "../handler/mutations.js"
import { createJournal } from "./journal.js"
import { canonicalDigest, encode, enumValue, fail, type EventRef, type Journal, type JournalEntry } from "./types.js"

function parseAgentTuple(raw: unknown): AgentTuple {
  const v = object(raw); keys(v, ["agentId", "handlerGeneration", "providerGeneration"])
  return { agentId: id(v.agentId), handlerGeneration: id(v.handlerGeneration), providerGeneration: id(v.providerGeneration) }
}
export type PermissionRef = { hostId: string; target: AgentTuple; permissionId: string; revision: number }
export type PermissionOffer = { ref: PermissionRef; title: string; subject: JsonObject; options: JsonObject[]; originCwd: string; toolCallId: string }
export type PermissionReceipt = { commandId: string; ref: PermissionRef; optionId: string; digest: string; state: "claimed" | "applied" | "withdrawn" | "stale" | "uncertain" }
export type PermissionSnapshot = { hostId: string; handlerGeneration: string; throughSeq: number; pending: PermissionOffer[]; receipts: PermissionReceipt[] }
export type PermissionEvent = { kind: "owner"; hostId: string; handlerGeneration: string } | { kind: "offer"; offer: PermissionOffer } | { kind: "receipt"; receipt: PermissionReceipt } | { kind: "withdraw"; ref: PermissionRef }
export const permissionKey = (ref: PermissionRef): string => canonicalDigest(parsePermissionRef(ref))
export function parsePermissionRef(raw: unknown): PermissionRef {
  const v = object(raw); keys(v, ["hostId", "target", "permissionId", "revision"])
  const revision = timestamp(v.revision); if (!revision) fail("INVALID_PERMISSION")
  return { hostId: hash(v.hostId), target: parseAgentTuple(v.target), permissionId: id(v.permissionId), revision }
}
export function parsePermissionOffer(raw: unknown): PermissionOffer {
  const v = object(raw); keys(v, ["ref", "title", "subject", "options", "originCwd", "toolCallId"])
  if (!Array.isArray(v.options) || !v.options.length || v.options.length > 128) fail("INVALID_PERMISSION")
  const options = v.options.map(raw => { const o = object(raw); text(o.optionId); text(o.name, Infinity); enumValue(o.kind, ["allow_once", "allow_always", "reject_once", "reject_always"]); return structuredClone(o) as JsonObject })
  if (new Set(options.map(o => o.optionId)).size !== options.length) fail("INVALID_PERMISSION")
  const offer = { ref: parsePermissionRef(v.ref), title: text(v.title, 65536), subject: structuredClone(object(v.subject)) as JsonObject, options, originCwd: absolutePath(v.originCwd), toolCallId: text(v.toolCallId) }
  encode(offer); return offer
}
export function parsePermissionReceipt(raw: unknown): PermissionReceipt {
  const v = object(raw); keys(v, ["commandId", "ref", "optionId", "digest", "state"])
  const receipt = { commandId: id(v.commandId), ref: parsePermissionRef(v.ref), optionId: text(v.optionId), digest: hash(v.digest), state: enumValue(v.state, ["claimed", "applied", "withdrawn", "stale", "uncertain"]) }
  if (canonicalDigest({ commandId: receipt.commandId, ref: receipt.ref, optionId: receipt.optionId }) !== receipt.digest) fail("CORRUPT_PERMISSION")
  return receipt
}
export function parsePermissionEvent(raw: unknown): PermissionEvent {
  const v = object(raw)
  switch (v.kind) {
    case "owner": keys(v, ["kind", "hostId", "handlerGeneration"]); return { kind: "owner", hostId: hash(v.hostId), handlerGeneration: id(v.handlerGeneration) }
    case "offer": keys(v, ["kind", "offer"]); return { kind: "offer", offer: parsePermissionOffer(v.offer) }
    case "receipt": keys(v, ["kind", "receipt"]); return { kind: "receipt", receipt: parsePermissionReceipt(v.receipt) }
    case "withdraw": keys(v, ["kind", "ref"]); return { kind: "withdraw", ref: parsePermissionRef(v.ref) }
    default: return fail("INVALID_PERMISSION")
  }
}
export function parsePermissionSnapshot(raw: unknown): PermissionSnapshot {
  const v = object(raw); keys(v, ["hostId", "handlerGeneration", "throughSeq", "pending", "receipts"])
  if (!Array.isArray(v.pending) || !Array.isArray(v.receipts)) fail("INVALID_PERMISSION")
  const result = { hostId: hash(v.hostId), handlerGeneration: id(v.handlerGeneration), throughSeq: timestamp(v.throughSeq), pending: v.pending.map(parsePermissionOffer), receipts: v.receipts.map(parsePermissionReceipt) }
  if (result.pending.some(o => o.ref.hostId !== result.hostId || o.ref.target.handlerGeneration !== result.handlerGeneration) || result.receipts.some(r => r.ref.hostId !== result.hostId) || new Set(result.pending.map(o => permissionKey(o.ref))).size !== result.pending.length) fail("INVALID_PERMISSION")
  encode(result); return result
}
export function createPermissionHistory(hostId: string) {
  const offers = new Map<string, PermissionOffer>(), receipts = new Map<string, PermissionReceipt>(), consumed = new Set<string>()
  let owner: string | null = null
  function apply(event: PermissionEvent): void {
    const eventHost = event.kind === "owner" ? event.hostId : event.kind === "offer" ? event.offer.ref.hostId : event.kind === "receipt" ? event.receipt.ref.hostId : event.ref.hostId
    if (eventHost !== hostId) fail("INVALID_ORIGIN")
    if (event.kind === "owner") { owner = event.handlerGeneration; return }
    if (event.kind === "offer") {
      const key = permissionKey(event.offer.ref)
      if (offers.has(key) || event.offer.ref.target.handlerGeneration !== owner) fail("CORRUPT_PERMISSION")
      offers.set(key, event.offer); return
    }
    if (event.kind === "withdraw") { consumed.add(permissionKey(event.ref)); return }
    const receipt = event.receipt, prior = receipts.get(receipt.commandId), key = permissionKey(receipt.ref)
    if (prior && (prior.digest !== receipt.digest || prior.state !== "claimed")) fail("CORRUPT_PERMISSION")
    if (!prior && (receipt.state === "applied" || receipt.state === "uncertain")) fail("CORRUPT_PERMISSION")
    if (receipt.state === "claimed" && (consumed.has(key) || !offers.get(key)?.options.some(o => o.optionId === receipt.optionId))) fail("CORRUPT_PERMISSION")
    if (prior && receipt.state === "claimed") fail("CORRUPT_PERMISSION")
    if (receipt.state === "claimed") consumed.add(key)
    receipts.set(receipt.commandId, receipt)
  }
  return { offers, receipts, consumed, apply, owner: () => owner,
    validate(snapshot: PermissionSnapshot): void {
      if (snapshot.hostId !== hostId || snapshot.handlerGeneration !== owner) fail("CORRUPT_PERMISSION")
      for (const offer of snapshot.pending) {
        const key = permissionKey(offer.ref), recorded = offers.get(key)
        if (consumed.has(key) || !recorded || canonicalDigest(recorded) !== canonicalDigest(offer)) fail("CORRUPT_PERMISSION")
      }
      if (snapshot.receipts.length !== receipts.size || snapshot.receipts.some(receipt => canonicalDigest(receipts.get(receipt.commandId) ?? null) !== canonicalDigest(receipt))) fail("CORRUPT_PERMISSION")
    }
  }
}
export type PermissionRouting = ReturnType<typeof createPermissionRouting>
export function createPermissionRouting(input: { root: string; hostId: string; handlerGeneration: string; queue?: MutationQueue; journal?: Journal }) {
  const hostId = hash(input.hostId), handlerGeneration = id(input.handlerGeneration), mutations = input.queue ?? new MutationQueue(), stateQueue = new MutationQueue()
  const journal = input.journal ?? createJournal(input.root, undefined, Date.now, { kind: "permissions", hostId })
  const history = createPermissionHistory(hostId), { offers, receipts, consumed, apply: reduce } = history
  const live = new Map<string, { offer: PermissionOffer; cancelled: boolean; respond(optionId: string): Promise<void> }>(), completions = new Map<string, Promise<PermissionReceipt>>()
  const listeners = new Set<(event: PermissionEvent) => void>()
  let throughSeq = 0, initialized = false, failure: unknown = null
  async function refresh(): Promise<void> {
    while (true) {
      const page = await journal.retainedRead(throughSeq, 256)
      for (const entry of page.entries) {
        if (entry.seq !== throughSeq + 1 || entry.kind !== "permission") fail("CORRUPT_PERMISSION")
        reduce(parsePermissionEvent(entry.payload)); throughSeq = entry.seq
      }
      if (throughSeq >= page.lastSeq) return
      if (!page.entries.length) fail("CORRUPT_PERMISSION")
    }
  }
  async function persist(event: PermissionEvent): Promise<void> {
    await refresh()
    if (event.kind !== "owner" && history.owner() !== handlerGeneration) fail("STALE_HANDLER")
    const entry = await journal.append(randomUUID(), "permission", parsePermissionEvent(event))
    reduce(event); throughSeq = entry.seq
    for (const listener of listeners) { try { listener(structuredClone(event)) } catch {} }
  }
  function ready(): void { if (!initialized || failure) fail("PERMISSIONS_UNAVAILABLE") }
  function receiptFor(commandId: string, ref: PermissionRef, optionId: string, state: PermissionReceipt["state"]): PermissionReceipt {
    const value = { commandId, ref, optionId }; return { ...value, digest: canonicalDigest(value), state }
  }
  async function settle(claim: PermissionReceipt, write: Promise<void>): Promise<PermissionReceipt> {
    let state: PermissionReceipt["state"] = "applied"
    try { await write } catch { state = "uncertain" }
    const result = { ...claim, state }
    try {
      return await stateQueue.run(async () => {
        await refresh()
        const current = receipts.get(claim.commandId)
        if (current && current.state !== "claimed") return structuredClone(current)
        await persist({ kind: "receipt", receipt: result }); return result
      })
    } catch (error) { failure = error; return { ...claim, state: "uncertain" } }
  }
  return {
    async initialize(): Promise<void> {
      try { await stateQueue.run(async () => {
        await refresh(); await persist({ kind: "owner", hostId, handlerGeneration })
        for (const receipt of [...receipts.values()]) if (receipt.state === "claimed") await persist({ kind: "receipt", receipt: { ...receipt, state: "uncertain" } })
        for (const offer of offers.values()) if (!consumed.has(permissionKey(offer.ref))) await persist({ kind: "withdraw", ref: offer.ref })
        initialized = true
      }) } catch (error) { failure = error }
    },
    status() { return { available: initialized && !failure, issue: failure instanceof Error ? failure.message : failure ? String(failure) : initialized ? null : "PERMISSIONS_UNAVAILABLE" } },
    async open(target: AgentTuple, params: JsonObject, originCwd: string, respond: (optionId: string) => Promise<void>): Promise<PermissionRef> {
      ready(); target = parseAgentTuple(target)
      if (target.handlerGeneration !== handlerGeneration) fail("STALE_HANDLER")
      const subject = object(params.toolCall), ref = { hostId, target, permissionId: randomUUID(), revision: 1 }
      const offer = parsePermissionOffer({ ref, title: typeof subject.title === "string" && subject.title.length ? subject.title : "Permission request", subject, options: params.options, originCwd, toolCallId: subject.toolCallId })
      const request = { offer, respond, cancelled: false }; live.set(permissionKey(ref), request)
      try { await stateQueue.run(async () => { await persist({ kind: "offer", offer }); if (request.cancelled) await persist({ kind: "withdraw", ref }) }); return structuredClone(ref) }
      catch (error) { live.delete(permissionKey(ref)); failure = error; throw error }
    },
    async decide(commandId: string, rawRef: PermissionRef, optionId: string): Promise<PermissionReceipt> {
      const ref = parsePermissionRef(rawRef); commandId = id(commandId); optionId = text(optionId)
      const wanted = receiptFor(commandId, ref, optionId, "claimed")
      if (ref.hostId !== hostId) return { ...wanted, state: "stale" }
      const begun = await mutations.run(() => stateQueue.run(async () => {
        ready(); await refresh()
        const prior = receipts.get(commandId)
        if (prior) {
          if (prior.digest !== wanted.digest) fail("COMMAND_CONFLICT")
          return { receipt: structuredClone(prior), completion: completions.get(commandId) }
        }
        const key = permissionKey(ref), request = live.get(key)
        if (ref.hostId !== hostId || ref.target.handlerGeneration !== handlerGeneration || !request || request.cancelled) {
          const receipt = { ...wanted, state: "stale" as const }
          await persist({ kind: "receipt", receipt }); return { receipt }
        }
        if (!request.offer.options.some(option => option.optionId === optionId)) fail("INVALID_OPTION")
        if (consumed.has(key)) {
          const receipt = { ...wanted, state: "withdrawn" as const }
          await persist({ kind: "receipt", receipt }); return { receipt }
        }
        await persist({ kind: "receipt", receipt: wanted })
        if (request.cancelled) {
          const receipt = { ...wanted, state: "withdrawn" as const }
          await persist({ kind: "receipt", receipt }); return { receipt }
        }
        const completion = settle(wanted, (() => { try { return request.respond(optionId) } catch (error) { return Promise.reject(error) } })())
        completions.set(commandId, completion); return { receipt: wanted, completion }
      }))
      return structuredClone(begun.completion ? await begun.completion : begun.receipt)
    },
    invalidate(target: AgentTuple): Promise<void> {
      const withdrawn: PermissionRef[] = []
      for (const [key, request] of live) if (canonicalDigest(request.offer.ref.target) === canonicalDigest(target)) { request.cancelled = true; live.delete(key); withdrawn.push(request.offer.ref) }
      return stateQueue.run(async () => { ready(); for (const ref of withdrawn) await persist({ kind: "withdraw", ref }) }).catch(error => { failure = error })
    },
    snapshot(): Promise<PermissionSnapshot> {
      return stateQueue.run(async () => {
        ready(); await refresh()
        const pending = [...live.values()].filter(r => !r.cancelled && !consumed.has(permissionKey(r.offer.ref))).map(r => structuredClone(r.offer))
        return parsePermissionSnapshot({ hostId, handlerGeneration, throughSeq, pending, receipts: [...receipts.values()] })
      }).catch(error => { failure ??= error; return fail("PERMISSIONS_UNAVAILABLE") })
    },
    inspect(commandId: string): Promise<PermissionReceipt | null> { id(commandId); return stateQueue.run(async () => { ready(); await refresh(); return structuredClone(receipts.get(commandId) ?? null) }) },
    read(after: number, limit: number): Promise<import("./types.js").JournalPage> { ready(); return journal.read(after, limit) },
    acknowledge(ref: EventRef): Promise<void> { ready(); return journal.acknowledge("bureau", ref) },
    subscribe(listener: (event: PermissionEvent) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
}