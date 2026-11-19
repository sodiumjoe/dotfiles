import { randomUUID } from "node:crypto"
import { hash, id, keys, object, providerId, text, type ProviderId } from "../config/validate.js"
import type { JsonObject } from "../agent/session-config.js"
import type { RemoteHost } from "../hosts/remote-rosters.js"
import { RequestError } from "../live/errors.js"
import { liveErrorReply, REQUEST_PROTOCOL, type LiveReply } from "../live/protocol.js"
import type { ChildView } from "./box.js"
import type { ParentLink } from "./outbox.js"
import { longText, validated } from "./requests.js"

export const POOL_NAME = /^(.+)-agency-[0-9a-f]{4}$/
const IDLE_MS = 3600000, FAILURE_MS = 3600000, FAILURE_MISSES = 3
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, HOST = /^[0-9a-f]{64}$/
const ENTRY_STATES = ["answer", "failed", "interrupted"]

export type DelegateRequest =
  | { op: "start"; parent: ParentLink; parentName: string; depth: number; task: string; ref: string; remote: string; path: string; backendId?: ProviderId; model?: string }
  | { op: "ask"; parent: ParentLink; childId: string; text: string }
  | { op: "stop"; parent: ParentLink; childId: string }
  | { op: "list"; parent: ParentLink }
export type Coordinator = { handle(request: DelegateRequest): Promise<JsonObject>; changed(hostId: string): void; tick(): void }
type Failure = { childId: string; parent: ParentLink; box: string | null; submissionId: string; text: string; at: number; misses: number }

function invalid(message: string): never { throw new RequestError("INVALID", message) }

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const nullable = (value: unknown): boolean => value === null || typeof value === "string"
const count = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0

export function childView(value: unknown): ChildView | null {
  if (!record(value) || !record(value.parent) || !Array.isArray(value.entries)) return null
  const { parent, entries } = value
  if (typeof value.childId !== "string" || !UUID.test(value.childId) || typeof parent.hostId !== "string" || !HOST.test(parent.hostId) || typeof parent.agentId !== "string" || !UUID.test(parent.agentId)) return null
  if (!count(value.depth) || !count(value.dropped) || typeof value.stopped !== "boolean" || typeof value.moved !== "boolean" || typeof value.createdAt !== "string" || typeof value.ref !== "string" || !nullable(value.open) || !nullable(value.title)) return null
  if (value.live !== null && !(record(value.live) && typeof value.live.activity === "string" && typeof value.live.editors === "number")) return null
  const valid = entries.every(item => record(item) && typeof item.submissionId === "string" && ENTRY_STATES.includes(item.state as string) && nullable(item.stopReason) && nullable(item.failure) && typeof item.text === "string" && typeof item.delivered === "boolean" && typeof item.at === "string")
  return valid ? value as unknown as ChildView : null
}

export function parseDelegateRequest(raw: unknown): DelegateRequest {
  return validated(() => {
    const value = object(raw)
    const shape = (required: string[], optional: string[] = []): ParentLink => {
      keys(value, ["op", "parent", ...required, ...optional.filter(key => Object.hasOwn(value, key))])
      const parent = object(value.parent); keys(parent, ["hostId", "agentId"])
      return { hostId: hash(parent.hostId), agentId: id(parent.agentId) }
    }
    if (value.op === "start") {
      const parent = shape(["parentName", "depth", "task", "ref", "remote", "path"], ["backendId", "model"])
      if (typeof value.parentName !== "string" || Buffer.byteLength(value.parentName) > 256) invalid("parentName must be a short string")
      if (typeof value.depth !== "number" || !Number.isInteger(value.depth) || value.depth < 0 || value.depth > 64) invalid("depth must be a small non-negative integer")
      return { op: "start", parent, parentName: value.parentName, depth: value.depth, task: longText(value.task, "task"), ref: text(value.ref, 1024), remote: text(value.remote, 1024), path: text(value.path, 4096), ...(Object.hasOwn(value, "backendId") ? { backendId: providerId(value.backendId) } : {}), ...(Object.hasOwn(value, "model") ? { model: text(value.model, 1024) } : {}) }
    }
    if (value.op === "ask") { const parent = shape(["childId", "text"]); return { op: "ask", parent, childId: id(value.childId), text: longText(value.text, "text") } }
    if (value.op === "stop") { const parent = shape(["childId"]); return { op: "stop", parent, childId: id(value.childId) } }
    if (value.op === "list") return { op: "list", parent: shape([]) }
    return invalid("unknown delegate operation")
  })
}

export async function acceptUpward(payload: unknown, sourceHostId: string, coordinator: Coordinator | undefined): Promise<LiveReply> {
  const requestId = randomUUID()
  try {
    const request = parseDelegateRequest(payload)
    if (request.parent.hostId !== sourceHostId) throw new RequestError("INVALID", "a devbox may only delegate for its own agents")
    if (!coordinator) throw new RequestError("UNAVAILABLE", "the Handler is not ready")
    return { protocol: REQUEST_PROTOCOL, requestId, ok: true, result: await coordinator.handle(request) as never }
  } catch (error) { return liveErrorReply({ requestId }, error) }
}

export function createCoordinator(input: { hostId: string; hosts(): RemoteHost[]; request(hostId: string, payload: JsonObject): Promise<JsonObject>; now?: () => number; idleMs?: number }): Coordinator {
  const now = input.now ?? Date.now, idleMs = input.idleMs ?? IDLE_MS
  const reserved = new Set<string>(), failures: Failure[] = [], cache = new Map<string, ChildView[]>(), chains = new Map<string, Promise<void>>(), parents = new Map<string, ParentLink>(), listed = new Map<string, Set<string>>()
  const queued = new Set<string>(), reads = new Map<string, { again: boolean; done: Promise<void> }>()
  const host = (hostId: string): RemoteHost | undefined => input.hosts().find(value => value.hostId === hostId)
  const pool = (value: RemoteHost): boolean => value.name !== null && POOL_NAME.test(value.name)
  const boxName = (hostId: string): string => { const value = host(hostId); return value?.name ?? value?.hostname.split(".")[0] ?? hostId.slice(0, 8) }
  const hostName = (hostId: string): string => { if (hostId === input.hostId) return "laptop"; const value = host(hostId); return value?.name ?? value?.hostname.split(".")[0] ?? "" }
  const same = (a: ParentLink, b: ParentLink): boolean => a.hostId === b.hostId && a.agentId === b.agentId
  const label = (childId: string, box: string | null, state: string, note = ""): string => "[Agency child " + childId.slice(0, 8) + " · " + (box ?? "no box") + " · " + state + note + "]"
  const enqueue = (parent: ParentLink, key: string, job: () => Promise<void>): void => {
    if (queued.has(key)) return
    queued.add(key)
    const chain = parent.hostId + ":" + parent.agentId
    const next = (chains.get(chain) ?? Promise.resolve()).then(() => { queued.delete(key); return job() }).catch(() => undefined)
    chains.set(chain, next)
    void next.then(() => { if (chains.get(chain) === next) chains.delete(chain) })
  }
  const current = (boxId: string, childId: string): ChildView | undefined => cache.get(boxId)?.find(value => value.childId === childId)
  async function deliverOutbox(boxId: string, childId: string): Promise<void> {
    const view = current(boxId, childId)
    if (!view) return
    const name = boxName(boxId), done: string[] = []
    for (const entry of view.entries.filter(value => !value.delivered)) {
      const note = !done.length && view.dropped > 0 ? " · " + view.dropped + " earlier answers were dropped" : ""
      try { await input.request(view.parent.hostId, { op: "deliver", parentAgentId: view.parent.agentId, childId, submissionId: entry.submissionId, label: label(childId, name, entry.state, note), text: entry.text }) } catch { break }
      done.push(entry.submissionId)
    }
    if (!done.length) return
    await input.request(boxId, { op: "child-mark", childId, submissionIds: done })
    const latest = current(boxId, childId)
    if (!latest) return
    for (const entry of latest.entries) if (done.includes(entry.submissionId)) entry.delivered = true
    latest.dropped = 0
  }
  const queueOutbox = (boxId: string, view: ChildView): void => { if (view.entries.some(entry => !entry.delivered)) enqueue(view.parent, boxId + ":" + view.childId, () => deliverOutbox(boxId, view.childId)) }
  const drop = (failure: Failure): void => { const index = failures.indexOf(failure); if (index >= 0) failures.splice(index, 1) }
  const queueFailure = (failure: Failure): void => {
    if (now() - failure.at > FAILURE_MS) { drop(failure); return }
    enqueue(failure.parent, "failure:" + failure.childId, async () => {
      if (!failures.includes(failure)) return
      try { await input.request(failure.parent.hostId, { op: "deliver", parentAgentId: failure.parent.agentId, childId: failure.childId, submissionId: failure.submissionId, label: label(failure.childId, failure.box, "failed"), text: failure.text }) } catch (error) {
        if (error instanceof RequestError && error.code === "NOT_FOUND" && ++failure.misses >= FAILURE_MISSES) drop(failure)
        throw error
      }
      drop(failure)
    })
  }
  const pinned = (view: ChildView): boolean => {
    const parent = parents.get(view.childId)
    if (!parent) { parents.set(view.childId, { hostId: view.parent.hostId, agentId: view.parent.agentId }); return true }
    return same(parent, view.parent)
  }
  function read(hostId: string): Promise<void> {
    const running = reads.get(hostId)
    if (running) { running.again = true; return running.done }
    const state = { again: false, done: Promise.resolve() }
    state.done = (async () => {
      try {
        do {
          state.again = false
          const reply = await input.request(hostId, { op: "children" })
          if (!Array.isArray(reply.children)) throw new RequestError("FAILED", "invalid children reply")
          const ids = new Set(reply.children.map(value => record(value) && typeof value.childId === "string" ? value.childId : null).filter((value): value is string => value !== null))
          for (const childId of listed.get(hostId) ?? []) if (!ids.has(childId)) parents.delete(childId)
          listed.set(hostId, ids)
          const views = reply.children.map(childView).filter((view): view is ChildView => view !== null && pinned(view))
          cache.set(hostId, views)
          for (const view of views) queueOutbox(hostId, view)
        } while (state.again)
      } finally { reads.delete(hostId) }
    })()
    reads.set(hostId, state)
    return state.done
  }
  async function choose(origin: string): Promise<RemoteHost | string> {
    const hosts = input.hosts()
    if (hosts.length && hosts.every(value => value.name === null)) return "no free pool box (pool names are unavailable; check pay remote list)"
    const boxes = hosts.filter(value => value.state === "online" && pool(value)), own = (value: RemoteHost): boolean => POOL_NAME.exec(value.name!)![1] === origin
    const free = (hostId: string): boolean => {
      const value = host(hostId)
      return !!value && value.state === "online" && !reserved.has(hostId) && !value.agents.some(row => row.live !== null) && cache.get(hostId)?.every(view => view.stopped) === true
    }
    for (const box of [...boxes.filter(own), ...boxes.filter(value => !own(value))]) {
      if (reserved.has(box.hostId) || box.agents.some(row => row.live !== null)) continue
      if (!cache.has(box.hostId)) await read(box.hostId).catch(() => undefined)
      if (free(box.hostId)) { reserved.add(box.hostId); return box }
    }
    return "no free pool box"
  }
  const fail = (childId: string, parent: ParentLink, box: string | null, message: string): JsonObject => {
    failures.push({ childId, parent, box, submissionId: randomUUID(), text: message, at: now(), misses: 0 })
    return { state: "starting", childId, box: null }
  }
  async function start(request: Extract<DelegateRequest, { op: "start" }>): Promise<JsonObject> {
    const childId = randomUUID(), box = await choose(hostName(request.parent.hostId))
    parents.set(childId, request.parent)
    if (typeof box === "string") return fail(childId, request.parent, null, box)
    const name = boxName(box.hostId)
    try {
      await input.request(box.hostId, { op: "child-start", childId, parent: request.parent, depth: request.depth, task: request.task, ref: request.ref, remote: request.remote, path: request.path, ...(request.backendId ? { backendId: request.backendId } : {}), ...(request.model ? { model: request.model } : {}) })
      const views = cache.get(box.hostId) ?? []
      if (!views.some(view => view.childId === childId)) cache.set(box.hostId, [...views, { version: 1, childId, parent: request.parent, depth: request.depth, ref: request.ref, createdAt: new Date(now()).toISOString(), open: null, stopped: false, dropped: 0, entries: [], live: null, title: null, moved: false }])
    } catch (error) {
      return fail(childId, request.parent, name, "could not start the child on " + name + ": " + (error instanceof Error ? error.message : String(error)))
    } finally { reserved.delete(box.hostId) }
    return { state: "starting", childId, box: name }
  }
  const locate = (parent: ParentLink, childId: string): { boxId: string; view: ChildView } => {
    for (const [boxId, views] of cache) {
      const view = views.find(value => value.childId === childId)
      if (view && same(view.parent, parent)) return { boxId, view }
    }
    throw new RequestError("NOT_FOUND", "child " + childId + " is not one of your children")
  }
  return {
    async handle(request) {
      if (request.op === "start") return start(request)
      if (request.op === "ask") {
        const { boxId } = locate(request.parent, request.childId)
        await input.request(boxId, { op: "child-ask", childId: request.childId, text: request.text })
        return { state: "accepted", childId: request.childId }
      }
      if (request.op === "stop") {
        const { boxId } = locate(request.parent, request.childId)
        await input.request(boxId, { op: "child-stop", childId: request.childId })
        const view = current(boxId, request.childId)
        if (view) view.stopped = true
        return { state: "stopped", childId: request.childId }
      }
      const children = [...cache].flatMap(([boxId, views]) => views.filter(view => same(view.parent, request.parent)).map(view => ({
        childId: view.childId, box: boxName(boxId), state: view.stopped ? "stopped" : view.live?.activity ?? "starting",
        answers: { delivered: view.entries.filter(entry => entry.delivered).length, undelivered: view.entries.filter(entry => !entry.delivered).length }, moved: view.moved, title: view.title })))
      return { state: "children", children }
    },
    changed(hostId) {
      const value = host(hostId)
      if (value && pool(value)) void read(hostId).catch(() => undefined)
      for (const [boxId, views] of cache) for (const view of views) if (view.parent.hostId === hostId) queueOutbox(boxId, view)
      for (const failure of [...failures]) if (failure.parent.hostId === hostId) queueFailure(failure)
    },
    tick() {
      for (const failure of [...failures]) queueFailure(failure)
      const at = now()
      for (const [boxId, views] of cache) {
        const box = host(boxId)
        if (!box) continue
        for (const view of views) {
          const row = box.agents.find(value => value.agentId === view.childId)
          if (view.stopped || row?.live?.activity !== "idle" || row.live.editors !== 0 || !(at - Date.parse(row.lastActivityAt ?? view.createdAt) > idleMs)) continue
          view.stopped = true
          void input.request(boxId, { op: "child-stop", childId: view.childId }).catch(() => { view.stopped = false })
        }
      }
    },
  }
}