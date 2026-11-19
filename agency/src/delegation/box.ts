import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { LaunchEnvironment } from "../agent/environment.js"
import type { LiveAgent } from "../live/state.js"
import type { LiveCore } from "../live/core.js"
import { RequestError } from "../live/errors.js"
import type { ProviderId } from "../config/validate.js"
import { DEFAULT_ROOTS, findCheckout, prepareCheckout } from "./checkout.js"
import type { Outbox, OutboxStore, ParentLink } from "./outbox.js"
import { recordTurns } from "./recorder.js"

export type ChildStart = { childId: string; parent: ParentLink; depth: number; task: string; ref: string; remote: string; path: string; backendId?: ProviderId; model?: string }
export type ChildView = Outbox & { live: ReturnType<LiveCore["liveRows"]>[number]["live"]; title: string | null; moved: boolean }
export type Box = {
  start(request: ChildStart): Promise<{ state: "accepted"; childId: string }>
  ask(childId: string, text: string): Promise<{ state: "accepted" }>
  stop(childId: string): Promise<{ state: "stopped" }>
  children(): Promise<ChildView[]>
  mark(childId: string, submissionIds: string[]): Promise<{ state: "marked" }>
  watch(): () => void
  sweep(): Promise<void>
  flushed(): Promise<void>
}

export function createBox(input: { core: LiveCore; outbox: OutboxStore; roots?: string[]; environment(): LaunchEnvironment; changed(): void }): Box {
  const { core, outbox } = input, recorders = new Map<string, { close(): void }>(), unclaimed = new Set<string>(), reading = new Set<string>()
  const bornAt = Date.now()
  let reserving = false, stopped = false
  const attach = (agent: LiveAgent): void => {
    const generation = agent.tuple.providerGeneration
    if (recorders.has(generation)) return
    recorders.set(generation, recordTurns({ childId: agent.agentId, conversation: agent.conversation, outbox, running: () => agent.running.size ? [...agent.running].at(-1)! : null, changed: input.changed }))
  }
  const live = (childId: string): LiveAgent | undefined => core.liveAgents().find(agent => agent.agentId === childId && agent.phase === "ready")
  const idle = (agent: LiveAgent): boolean => core.liveRows().find(row => row.agentId === agent.agentId)?.live?.activity === "idle"
  const fail = async (childId: string, message: string): Promise<void> => {
    await outbox.append(childId, { submissionId: randomUUID(), state: "failed", stopReason: null, failure: "START_FAILED", text: message }, { stop: true })
    input.changed()
  }
  const run = async (request: ChildStart): Promise<void> => {
    let stashed = false, launched = false
    const closed = async (): Promise<boolean> => (await outbox.read(request.childId))?.stopped !== false
    try {
      const dir = await findCheckout(request.remote, input.roots ?? DEFAULT_ROOTS)
      if (!dir) throw new Error("no checkout on this box has origin " + request.remote)
      stashed = (await prepareCheckout(dir, request.ref, "agency child " + request.childId)).stashed
      const target = resolve(dir, request.path), within = relative(dir, target)
      if (within.startsWith("..") || isAbsolute(within)) throw new Error("invalid path: " + request.path)
      const cwd = await stat(target).then(value => value.isDirectory() ? target : dir, () => dir)
      if (await closed()) return
      launched = true
      const agent = await (await core.launch({ agentId: request.childId, cwd, environment: input.environment(), ...(request.backendId ? { backendId: request.backendId } : {}), ...(request.model ? { model: request.model } : {}) })).ready
      if (await closed()) { await core.stop(request.childId).catch(() => undefined); return }
      attach(agent)
      await core.submitAcp(agent.tuple, { submissionId: randomUUID(), prompt: [{ type: "text", text: request.task }] })
    } catch (error) {
      if (launched) await core.stop(request.childId).catch(() => undefined)
      const message = (error instanceof Error ? error.message : String(error)) + (stashed ? " (local changes were stashed as \"agency child " + request.childId + "\")" : "")
      await fail(request.childId, message).catch(() => undefined)
    }
  }
  const scan = (): void => {
    const present = new Set(core.liveAgents().map(agent => agent.tuple.providerGeneration))
    for (const key of [...recorders.keys()]) if (!present.has(key)) { recorders.delete(key) }
    for (const key of [...unclaimed]) if (!present.has(key)) unclaimed.delete(key)
    for (const agent of core.liveAgents()) {
      const generation = agent.tuple.providerGeneration
      if (agent.phase !== "ready" || recorders.has(generation) || unclaimed.has(generation) || reading.has(generation)) continue
      reading.add(generation)
      void outbox.read(agent.agentId).then(value => { if (!value) unclaimed.add(generation); else if (!stopped && agent.phase === "ready") attach(agent) }).catch(() => undefined).finally(() => reading.delete(generation))
    }
  }
  return {
    async start(request) {
      if (reserving) throw new RequestError("BUSY", "this box is already running a child")
      reserving = true
      try {
        if (await outbox.read(request.childId)) return { state: "accepted", childId: request.childId }
        if ((await outbox.list()).some(value => !value.stopped)) throw new RequestError("BUSY", "this box is already running a child")
        await outbox.create({ childId: request.childId, parent: request.parent, depth: request.depth, ref: request.ref })
      } finally { reserving = false }
      input.changed()
      void run(request)
      return { state: "accepted", childId: request.childId }
    },
    async ask(childId, text) {
      const value = await outbox.read(childId), agent = live(childId)
      if (!value || value.stopped || !agent) throw new RequestError("NOT_FOUND", "child " + childId + " is not live")
      if (!idle(agent)) throw new RequestError("BUSY", "child " + childId + " is busy")
      attach(agent)
      await core.submitAcp(agent.tuple, { submissionId: randomUUID(), prompt: [{ type: "text", text }] })
      return { state: "accepted" }
    },
    async stop(childId) {
      if (!await outbox.read(childId)) return { state: "stopped" }
      await outbox.update(childId, value => { value.stopped = true })
      input.changed()
      if (core.liveAgents().some(agent => agent.agentId === childId)) void core.stop(childId).catch(() => undefined)
      return { state: "stopped" }
    },
    async children() {
      const outboxes = await outbox.list(), rows = core.liveRows()
      return outboxes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(value => {
        const row = rows.find(item => item.agentId === value.childId)
        return { ...value, live: row?.live ?? null, title: row?.title ?? null, moved: value.stopped && outboxes.some(other => other.createdAt > value.createdAt) }
      })
    },
    async mark(childId, submissionIds) {
      await outbox.update(childId, value => { for (const entry of value.entries) if (submissionIds.includes(entry.submissionId)) entry.delivered = true; value.dropped = 0 })
      input.changed()
      return { state: "marked" }
    },
    watch() {
      stopped = false
      void (async () => {
        let after: string | null = null
        while (!stopped) {
          try { scan() } catch {}
          after = await core.changed(after, 30000).catch(() => null)
        }
      })()
      return () => { stopped = true; for (const recorder of recorders.values()) recorder.close(); recorders.clear() }
    },
    async sweep() {
      while (!stopped) {
        const status = core.handoffStatus()
        if (!status || !status.pending.length) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      for (const value of await outbox.list()) {
        if (value.stopped || Date.parse(value.createdAt) >= bornAt || core.liveAgents().some(agent => agent.agentId === value.childId)) continue
        if (value.open) await outbox.append(value.childId, { submissionId: value.open, state: "interrupted", stopReason: null, failure: null, text: "" })
        else if (!value.entries.length) await outbox.append(value.childId, { submissionId: randomUUID(), state: "failed", stopReason: null, failure: "START_FAILED", text: "the box's Handler restarted before the child started" })
        await outbox.update(value.childId, current => { current.stopped = true })
      }
      input.changed()
    },
    flushed: () => outbox.flushed(),
  }
}