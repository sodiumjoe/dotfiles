import { AgentError } from "../agent/types.js"
import { createRuntimeEntry, type RuntimeEntryDriver } from "../entry/runtime.js"
import { createRuntimeEntryDriver } from "../entry/editor.js"
import { id, keys, object, text } from "../config/validate.js"
import { createHostInventory } from "../hosts/inventory.js"
import { createHostRouter, registerHostRouter, type HostRouter } from "../hosts/router.js"
import { createRemoteRosters } from "../hosts/remote-rosters.js"
import { connectBridge } from "../bridge/ssh.js"
import { bridgeError } from "../bridge/protocol.js"
import { createHandlerBridge, type HandlerBridge } from "../bridge/server.js"
import { registerRuntimeEndpoint } from "../hosts/runtime.js"
import { join } from "node:path"
import { startAcpServer } from "../acp/server.js"
import { createLiveRouter } from "../acp/live-router.js"
import { productionLaunchContracts, type LaunchContract } from "../agent/contracts.js"
import { agentErrorReply, type AgentRequest, type AgentReply } from "../agent/protocol.js"
import { randomUUID } from "node:crypto"
import type { Duplex } from "node:stream"
import type { Server, Socket } from "node:net"
import { isDeepStrictEqual } from "node:util"
import { write } from "node:fs"
import { createHandlerTermination, formatTerminationFailure } from "./termination.js"
import { ControlError, PROTOCOL, errorReply, type HandlerStatus, type ControlRequest, type ControlReply } from "../control/protocol.js"
import { serveProtocols } from "../control/wire.js"
import { agencyLaunchMarker, exactAgencyBirth } from "../platform/launch-marker.js"
import { bindPrivateSocket } from "../platform/private-socket.js"
import { readHandlerRecord, writeHandlerRecord } from "../platform/private-state.js"
import { sameProcess, type HandlerGenerationRecord, type PlatformAdapter, type ProcessIdentity } from "../platform/types.js"
import { acpSocketPath, type PlatformPaths } from "../platform/paths.js"
import { shutdownHandler, type ShutdownContext } from "./shutdown.js"
import { consumeCleanShutdown, markCleanShutdownSync, openEventLog, type EventLog } from "./event-log.js"
import { createAgentIndex } from "../agent/agent-index.js"
import { migrateIndex } from "../agent/index-migration.js"
import { defaultHomes } from "../agent/excerpt.js"
import { destinationEnvironment } from "../agent/environment.js"
import { createLiveCore, type LiveCore, type LiveCoreDependencies } from "../live/core.js"
import type { RosterRow } from "../live/roster.js"
import { dispatchLive } from "../live/dispatch.js"
import { liveErrorReply, type LiveReply } from "../live/protocol.js"
import { RequestError } from "../live/errors.js"
import { createRemoteShapes, dispatchRemoteRequest, type RemoteShapes } from "../live/remote-shapes.js"

export type HandlerOptions = {
  paths: PlatformPaths
  adapter: PlatformAdapter
  recordPath: string
  generation: string
  status: Duplex
  gate: Duplex
  onPhase?: (phase: HandlerStatus["phase"]) => Promise<void>
  liveDependencies?: LiveCoreDependencies
  launchContracts?: readonly LaunchContract[]
  entryDriver?: RuntimeEntryDriver
  distDigest?: string | null
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
  let shutdown: ShutdownContext | undefined
  let core: LiveCore | undefined
  let shapes: RemoteShapes | undefined
  let router: HostRouter | undefined
  let remotes: ReturnType<typeof createRemoteRosters> | undefined
  let bridge: HandlerBridge | undefined
  let acpServer: Awaited<ReturnType<typeof startAcpServer>> | undefined
  const state: HandlerStatus = { hostId: options.paths.hostKey, handlerGeneration: options.generation, phase: "starting", reconciliation: { classified: 0, total: 0, uncertain: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"], distDigest: options.distDigest ?? null }
  let resolveClosed: () => void = () => undefined, rejectClosed: (error: Error) => void = () => undefined
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  void closed.catch(() => undefined)
  let closeOperation: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closeOperation) return closeOperation
    closing = true
    const attempts = [
      () => remotes?.close(),
      () => router?.close(),
      () => bridge?.close(),
      () => acpServer?.close(),
      () => core?.close(),
      () => { options.status.destroy() },
      () => { options.gate.destroy() },
      ...[...sockets].map(socket => () => { socket.destroy() }),
      ...[server].filter(listener => listener !== undefined).map(listener => () => new Promise<void>((resolve, reject) => listener.close(error => { if (error) reject(error); else resolve() }))),
    ]
    closeOperation = Promise.allSettled(attempts.map(attempt => Promise.resolve().then(attempt))).then(results => {
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason)
      if (failures.length) throw new AggregateError(failures, "Handler close failed")
    })
    void closeOperation.then(resolveClosed, rejectClosed)
    return closeOperation
  }
  let interruptedStartup = false
  const terminate = createHandlerTermination({
    async drain() {
      const failures: unknown[] = []
      try { await core?.freezeAndDrain(true) } catch (error) { failures.push(error) }
      const verified = await Promise.allSettled([
        Promise.resolve().then(() => core?.verifyDischarged()),
      ])
      failures.push(...verified.filter(result => result.status === "rejected").map(result => result.reason))
      if (interruptedStartup) failures.push(new Error("Handler startup interrupted by signal"))
      if (failures.length) throw new AggregateError(failures, "Handler discharge failed")
    },
    close,
  })
  let recordStop: (() => void) | undefined, recordFailure: ((error: unknown) => void) | undefined
  const onSignal = (): void => {
    if (termination) return
    interruptedStartup = shutdown === undefined
    termination = true
    void terminate().then(error => {
      if (error) {
        try { write(2, formatTerminationFailure(error), () => undefined) } catch {}
      } else recordStop?.()
      process.exit(error ? 70 : 0)
    })
  }
  const checkStartup = (): void => { if (termination || closing) throw new Error("Handler startup interrupted") }
  const channelError = (): void => undefined
  options.status.on("error", channelError); options.gate.on("error", channelError)
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal)
  try {
    checkStartup()
    if (options.recordPath !== join(options.paths.runtimeRoot, "handler.json")) throw new Error("Handler record path mismatch")
    const pending = await readHandlerRecord(options.recordPath)
    if (pending.phase !== "launch_pending" || !pending.launchAttempted || pending.process !== null || pending.generation !== options.generation || pending.hostId !== options.paths.hostKey || pending.socketPath !== options.paths.handlerSocketPath || process.argv0 !== agencyLaunchMarker("handler", pending.launchAttemptId)) throw new Error("Handler pending record mismatch")
    checkStartup()
    const self = await selfIdentity(options.adapter)
    checkStartup()
    if (self.pid !== self.processGroupId || self.pid !== self.sessionId || self.uid !== process.getuid!() || self.gid !== process.getgid!() || self.bootId !== pending.launchBootId || !exactAgencyBirth(self.birth, process.argv0)) throw new Error("Handler identity mismatch")
    const gate = receiveStart(options.gate, options.status)
    void gate.catch(() => undefined)
    await sendStatus(options.status, { type: "identity", identity: self })
    await gate
    checkStartup()
    options.gate.destroy()
    const published = await readHandlerRecord(options.recordPath)
    const expected = { ...pending, phase: "identity_published", process: self }
    const live = await selfIdentity(options.adapter)
    if (!isDeepStrictEqual(published, expected) || !sameProcess(self, live)) throw new Error("Handler publication mismatch")
    checkStartup()
    current = published
    const root = options.paths.persistentRoot
    await sendStatus(options.status, { type: "gate_released", generation: options.generation }).catch(() => undefined)
    const dispatch = async (request: ControlRequest): Promise<ControlReply> => {
      if (request.handlerGeneration !== options.generation) return errorReply({ ...request, handlerGeneration: options.generation }, new ControlError("STALE_HANDLER"))
      if (request.op === "shutdown") return shutdown === undefined ? errorReply(request, new ControlError("INCOMPLETE", "Handler has not completed startup")) : shutdownHandler(request, shutdown)
      return { protocol: PROTOCOL, requestId: request.requestId, handlerGeneration: options.generation, ok: true, result: structuredClone({ ...state, issues: [...(state.issues ?? [])] }) }
    }
    const ready = () => state.phase === "ready" && !closing && !termination
    const dispatchAgent = (request: AgentRequest): Promise<AgentReply> => shapes && core ? dispatchRemoteRequest({ shapes, generation: options.generation, ready, failed: core.failed }, request) : Promise.resolve(agentErrorReply({ ...request, handlerGeneration: options.generation }, new AgentError("NOT_READY")))
    const dispatchRequest = async (raw: unknown): Promise<LiveReply> => core && state.phase === "ready" && !closing && !termination ? dispatchLive(core, raw) : liveErrorReply({ requestId: typeof (raw as { requestId?: unknown }).requestId === "string" ? (raw as { requestId: string }).requestId : randomUUID() }, new RequestError("UNAVAILABLE", "the Handler is not ready"))
    server = await bindPrivateSocket(options.paths.runtimeRoot, "handler.sock", socket => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      void serveProtocols(socket, dispatch, 5000, dispatchAgent, dispatchRequest).then(async () => { if (shutdown?.accepted !== undefined) await shutdown.closeAfterReply() }).catch(rejectClosed)
    })
    if (termination || closing) await new Promise<void>(resolve => server!.close(() => resolve()))
    checkStartup()
    server.on("error", rejectClosed)
    server.on("close", () => { if (!closing) rejectClosed(new Error("control listener closed unexpectedly")) })
    current = { ...published, writer: "handler", phase: "socket_bound" }
    await writeHandlerRecord(options.recordPath, current)
    checkStartup()
    await options.onPhase?.("ready")
    checkStartup()
    const events = await openEventLog({ root, hostId: options.paths.hostKey })
    if (!(await consumeCleanShutdown(root)) && events.lastSequence() > 0) events.append({ type: "handler_unclean_exit" })
    events.append({ type: "handler_started", generation: options.generation })
    let stopped = false
    recordStop = () => { if (stopped) return; stopped = true; events.appendSync({ type: "handler_stopped", generation: options.generation }); markCleanShutdownSync(root) }
    recordFailure = error => events.appendSync({ type: "handler_failed", generation: options.generation, message: String(error).slice(0, 512) })
    const launchContext = { paths: options.paths, adapter: options.adapter, state, shutdownPending: () => termination || shutdown?.pending !== undefined || shutdown?.accepted !== undefined }
    const agentIndex = createAgentIndex(root)
    const migrate = () => migrateIndex({ root, index: agentIndex, homes: defaultHomes(), events }).catch(error => events.append({ type: "index_migration_failed", message: String(error).slice(0, 512) }))
    if (await agentIndex.migrated()) void migrate()
    else await migrate()
    checkStartup()
    core = createLiveCore({ context: launchContext, contracts: options.launchContracts ?? productionLaunchContracts(), index: agentIndex, homes: defaultHomes(), events }, options.liveDependencies)
    await core.initialize()
    await core.loadHandoff()
    shapes = createRemoteShapes(core, options.paths.hostKey)
    checkStartup()
    bridge = await createHandlerBridge({ root: options.paths.runtimeRoot, identity: { hostId: options.paths.hostKey, handlerGeneration: options.generation } })
    if (termination || closing) await bridge.close()
    checkStartup()
    registerRuntimeEndpoint(bridge, dispatchAgent)
    const servedCore = core
    bridge.register(["live-read", "live-wait"], async ({ channel, payload }) => {
      if (!ready()) bridgeError("HANDLER_UNAVAILABLE")
      const value = object(payload)
      if (channel === "live-read") {
        keys(value, ["op"])
        if (value.op !== "agents") bridgeError("UNSUPPORTED_CAPABILITY")
        return { handlerGeneration: options.generation, agents: servedCore.liveRows() }
      }
      keys(value, ["after", "waitMs"])
      const after = value.after === null ? null : typeof value.after === "string" && value.after.length <= 128 ? value.after : bridgeError("UNSUPPORTED_CAPABILITY")
      if (typeof value.waitMs !== "number" || !Number.isInteger(value.waitMs) || value.waitMs < 0 || value.waitMs > 8000) bridgeError("UNSUPPORTED_CAPABILITY")
      return { revision: await servedCore.changed(after, value.waitMs as number) }
    })
    const ownerCore = core
    const entry = createRuntimeEntry({ hostId: options.paths.hostKey, generation: options.generation, driver: options.entryDriver ?? createRuntimeEntryDriver({ runtimeRoot: options.paths.runtimeRoot }), validate: async target => {
      return ownerCore.isLive(target)
    } })
    bridge.register(["entry-open", "runtime-entry-inspect"], async ({ channel, payload }) => {
      const value = object(payload); keys(value, channel === "entry-open" ? ["commandId", "ref"] : ["commandId"])
      return channel === "entry-open" ? entry.open(id(value.commandId), value.ref as never) : entry.inspect(id(value.commandId))
    })
    const coreBridge = bridge
    const inventory = createHostInventory(root)
    router = createHostRouter({ hostId: options.paths.hostKey, inventory, local: (channel, payload, signal) => coreBridge.dispatch(channel, payload, signal ?? new AbortController().signal), connect: enrollment => connectBridge(enrollment, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read", "host-identity"] }) })
    registerHostRouter({ bridge, router, hostId: options.paths.hostKey, handlerGeneration: options.generation })
    const hosts = router
    remotes = createRemoteRosters({
      list: () => inventory.list(),
      wait: async (hostId, after, waitMs) => text(object(await hosts.request({ hostId, channel: "live-wait", payload: { after, waitMs } }, undefined, waitMs + 5000)).revision),
      read: async hostId => {
        const reply = object(await hosts.request({ hostId, channel: "live-read", payload: { op: "agents" } }))
        if (!Array.isArray(reply.agents)) bridgeError("INVALID_HOST_REPLY")
        return { handlerGeneration: text(reply.handlerGeneration), agents: reply.agents as RosterRow[] }
      },
    })
    const remoteHosts = remotes
    const liveCore = core
    acpServer = await startAcpServer({ socketPath: acpSocketPath(options.paths), handlerGeneration: options.generation, onError: rejectClosed,
      router: connection => createLiveRouter({ core: liveCore, remotes: () => remoteHosts.hosts(), ...connection }) })
    if (termination || closing) await acpServer.close()
    checkStartup()
    current = { ...current, phase: "ready", reconciliation: { classified: 0, total: 0, quarantined: 0 } }
    await writeHandlerRecord(options.recordPath, current)
    if (!isDeepStrictEqual(await readHandlerRecord(options.recordPath), current)) throw new Error("Handler readiness record changed")
    checkStartup()
    shutdown = { record: current, state, closeAfterReply: close, agents: core }
    state.phase = "ready"
    void core?.resumeHandoff(destinationEnvironment(process.env)).catch(() => undefined)
    await sendStatus(options.status, { type: "ready", generation: options.generation }).catch(() => undefined)
    options.status.destroy()
    await closed
    await events.flush()
    recordStop()
  } catch (error) {
    recordFailure?.(error)
    await sendStatus(options.status, { type: "failed", reason: String(error).slice(0, 512) }).catch(() => undefined)
    throw error
  } finally {
    try { await close() } finally {
      process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal)
      options.status.destroy(); options.gate.destroy()
    }
  }
}