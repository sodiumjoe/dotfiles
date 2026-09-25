import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { Duplex } from "node:stream"
import type { Server, Socket } from "node:net"
import { isDeepStrictEqual } from "node:util"
import { ControlError, PROTOCOL, errorReply, type HandlerStatus, type ControlRequest, type ControlReply } from "../control/protocol.js"
import { serveControl } from "../control/wire.js"
import { agencyLaunchMarker, exactAgencyBirth } from "../platform/launch-marker.js"
import { bindPrivateSocket } from "../platform/private-socket.js"
import { readHandlerRecord, readLaunchRecordForReconciliation, writeHandlerRecord } from "../platform/private-state.js"
import { reconcileRecord } from "../platform/reconcile.js"
import { sameProcess, type HandlerGenerationRecord, type PlatformAdapter, type ProcessIdentity } from "../platform/types.js"
import type { PlatformPaths } from "../platform/paths.js"
import { ensurePrivateChild } from "./environment.js"
import { inventoryLaunches, summarizeLaunches, verifyInventory, type InventoryEntry } from "./inventory.js"
import { shutdownHandler, type ShutdownContext } from "./shutdown.js"

export type HandlerOptions = {
  paths: PlatformPaths
  adapter: PlatformAdapter
  recordPath: string
  generation: string
  status: Duplex
  gate: Duplex
  onPhase?: (phase: HandlerStatus["phase"]) => Promise<void>
}

export function receiveStart(gate: Duplex, status: Duplex, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let content = "", settled = false
    const done = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      gate.off("data", data)
      for (const stream of [gate, status]) { stream.off("end", lost); stream.off("close", lost); stream.off("error", lost) }
      if (error) reject(error); else resolve()
    }
    const lost = (): void => done(new Error("startup gate lost its launcher"))
    const data = (bytes: Buffer): void => {
      content += bytes.toString("utf8")
      if (!"start\n".startsWith(content)) done(new Error("invalid startup gate token"))
      else if (content === "start\n") done()
    }
    const timer = setTimeout(() => done(new Error("startup gate timed out")), timeoutMs)
    gate.on("data", data)
    for (const stream of [gate, status]) { stream.once("end", lost); stream.once("close", lost); stream.once("error", lost); stream.resume() }
    if (gate.destroyed || status.destroyed || gate.readableEnded || status.readableEnded) lost()
  })
}

async function sendStatus(stream: Duplex, value: unknown): Promise<void> {
  if (stream.destroyed || stream.writableEnded) throw new Error("startup channel unavailable")
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup write timed out")), 1000)
    stream.write(JSON.stringify(value) + "\n", error => { clearTimeout(timer); if (error) reject(error); else resolve() })
  })
}

async function selfIdentity(adapter: PlatformAdapter): Promise<ProcessIdentity> {
  const deadline = Date.now() + 5000
  while (true) {
    try {
      const identity = await adapter.readProcess(process.pid)
      if (identity !== null) return identity
    } catch (error) { if (!(error instanceof Error) || !error.name.endsWith("ObservationUnavailable")) throw error }
    if (Date.now() >= deadline) throw new Error("Handler identity unavailable")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

export async function runHandler(options: HandlerOptions): Promise<void> {
  let server: Server | undefined, current: HandlerGenerationRecord | undefined, termination = false, closing = false
  const sockets = new Set<Socket>()
  let entries: InventoryEntry[] = []
  let shutdown: ShutdownContext | undefined
  const state: HandlerStatus = { hostId: options.paths.hostKey, handlerGeneration: options.generation, phase: "starting", reconciliation: { classified: 0, total: 0, quarantined: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] }
  let resolveClosed: () => void = () => undefined, rejectClosed: (error: Error) => void = () => undefined
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  void closed.catch(() => undefined)
  const close = async (): Promise<void> => {
    if (closing) return closed
    closing = true
    for (const socket of sockets) socket.destroy()
    if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()))
    resolveClosed()
  }
  const terminate = async (): Promise<void> => {
    termination = true
    if (state.phase === "ready" && shutdown !== undefined) {
      const reply = await shutdownHandler({ protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: options.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true }, shutdown)
      if (reply.ok) await shutdown.closeAfterReply()
    }
  }
  const onSignal = (): void => { void terminate().catch(rejectClosed) }
  const channelError = (): void => undefined
  options.status.on("error", channelError); options.gate.on("error", channelError)
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal)
  try {
    await ensurePrivateChild(options.paths.persistentRoot, "launches")
    if (options.recordPath !== join(options.paths.runtimeRoot, "handler.json")) throw new Error("Handler record path mismatch")
    const pending = await readHandlerRecord(options.recordPath)
    if (pending.phase !== "launch_pending" || !pending.launchAttempted || pending.process !== null || pending.generation !== options.generation || pending.hostId !== options.paths.hostKey || pending.socketPath !== options.paths.handlerSocketPath || process.argv0 !== agencyLaunchMarker("handler", pending.launchAttemptId)) throw new Error("Handler pending record mismatch")
    const self = await selfIdentity(options.adapter)
    if (self.pid !== self.processGroupId || self.pid !== self.sessionId || self.uid !== process.getuid!() || self.gid !== process.getgid!() || self.bootId !== pending.launchBootId || !exactAgencyBirth(self.birth, process.argv0)) throw new Error("Handler identity mismatch")
    const gate = receiveStart(options.gate, options.status)
    void gate.catch(() => undefined)
    await sendStatus(options.status, { type: "identity", identity: self })
    await gate
    options.gate.destroy()
    const published = await readHandlerRecord(options.recordPath)
    const expected = { ...pending, phase: "identity_published", process: self }
    const live = await selfIdentity(options.adapter)
    if (!isDeepStrictEqual(published, expected) || !sameProcess(self, live)) throw new Error("Handler publication mismatch")
    current = published
    await sendStatus(options.status, { type: "gate_released", generation: options.generation }).catch(() => undefined)
    const dispatch = async (request: ControlRequest): Promise<ControlReply> => {
      if (request.handlerGeneration !== options.generation) return errorReply({ ...request, handlerGeneration: options.generation }, new ControlError("STALE_HANDLER"))
      if (request.op === "shutdown") return shutdown === undefined ? errorReply(request, new ControlError("INCOMPLETE", "Handler has not completed startup")) : shutdownHandler(request, shutdown)
      return { protocol: PROTOCOL, requestId: request.requestId, handlerGeneration: options.generation, ok: true, result: structuredClone(state) }
    }
    server = await bindPrivateSocket(options.paths.runtimeRoot, "handler.sock", socket => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      void serveControl(socket, dispatch).then(async () => { if (shutdown?.accepted !== undefined) await shutdown.closeAfterReply() }).catch(rejectClosed)
    })
    server.on("error", rejectClosed)
    current = { ...published, writer: "handler", phase: "socket_bound" }
    await writeHandlerRecord(options.recordPath, current)
    const directory = join(options.paths.persistentRoot, "launches")
    entries = await inventoryLaunches(directory)
    state.phase = "reconciling"
    state.reconciliation.total = entries.length
    state.launches = summarizeLaunches(entries.map(entry => entry.record))
    current = { ...published, writer: "handler", phase: "reconciling", reconciliation: { ...state.reconciliation } }
    await writeHandlerRecord(options.recordPath, current)
    await options.onPhase?.("reconciling")
    for (const entry of entries) {
      const result = await reconcileRecord(entry.path, options.adapter, entry.record)
      if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(entry.path), result.record)) throw new Error("RETAINED_INVENTORY_CHANGED")
      entry.record = result.record
      state.reconciliation.classified++
      if (result.disposition === "quarantined") state.reconciliation.quarantined++
      state.launches = summarizeLaunches(entries.map(item => item.record))
      current = { ...current, reconciliation: { ...state.reconciliation } }
      await writeHandlerRecord(options.recordPath, current)
    }
    await options.onPhase?.("ready")
    await verifyInventory(directory, entries)
    current = { ...current, phase: "ready" }
    await writeHandlerRecord(options.recordPath, current)
    if (!isDeepStrictEqual(await readHandlerRecord(options.recordPath), current)) throw new Error("Handler readiness record changed")
    state.phase = "ready"
    shutdown = { record: current, state, paths: options.paths, adapter: options.adapter, closeAfterReply: close }
    if (termination) await terminate()
    else await sendStatus(options.status, { type: "ready", generation: options.generation }).catch(() => undefined)
    options.status.destroy()
    await closed
  } catch (error) {
    if (current !== undefined) {
      await writeHandlerRecord(options.recordPath, { ...current, phase: "exited_unverified", reason: String(error).slice(0, 512) }).catch(() => undefined)
    }
    throw error
  } finally {
    await close()
    process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal)
    options.status.destroy(); options.gate.destroy()
  }
}