import { taskToolDescriptor } from "../tasks/mcp.js"
import { createTaskStore } from "../tasks/store.js"
import { createTaskService, type TaskService, type TaskServiceOptions } from "../tasks/service.js"
import { registerTaskEndpoint } from "../tasks/endpoint.js"
import { destinationEnvironment } from "../agent/environment.js"
import { AgentError } from "../agent/types.js"
import { createRuntimeEntry, type RuntimeEntryDriver } from "../entry/runtime.js"
import { createRuntimeEntryDriver } from "../entry/editor.js"
import { id, keys, object } from "../catalog/types.js"
import { createHostInventory } from "../hosts/inventory.js"
import { createHostRouter, registerHostRouter, type HostRouter } from "../hosts/router.js"
import { connectBridge } from "../bridge/ssh.js"
import { dispatchAgentRequest } from "../agent/dispatch.js"
import { createHandlerBridge, type HandlerBridge } from "../bridge/server.js"
import { registerRuntimeEndpoint } from "../hosts/runtime.js"
import { join } from "node:path"
import { startAcpServer } from "../acp/server.js"
import { createAgentService, type AgentService } from "../agent/service.js"
import { createAgentStore } from "../agent/store.js"
import { productionLaunchContracts, type LaunchContract } from "../agent/contracts.js"
import { type AgentRequest, type AgentReply } from "../agent/protocol.js"
import { serveAttachment } from "../agent/attachment-server.js"
import { randomUUID } from "node:crypto"
import type { Duplex } from "node:stream"
import type { Server, Socket } from "node:net"
import { isDeepStrictEqual } from "node:util"
import { write } from "node:fs"
import { createHandlerTermination, formatTerminationFailure } from "./termination.js"
import { ControlError, PROTOCOL, errorReply, type HandlerStatus, type ControlRequest, type ControlReply } from "../control/protocol.js"
import { serveProtocols } from "../control/wire.js"
import { CATALOG_PROTOCOL, catalogErrorReply, type CatalogRequest, type CatalogReply } from "../catalog/protocol.js"
import { createCatalogService, type CatalogService } from "../catalog/service.js"
import { createCatalogStore, type CatalogStore } from "../catalog/store.js"
import { createProbeRuntime } from "../catalog/probes.js"
import { agencyLaunchMarker, exactAgencyBirth } from "../platform/launch-marker.js"
import { bindPrivateSocket } from "../platform/private-socket.js"
import { readHandlerRecord, writeHandlerRecord } from "../platform/private-state.js"
import { sameProcess, type HandlerGenerationRecord, type PlatformAdapter, type ProcessIdentity } from "../platform/types.js"
import { acpSocketPath, type PlatformPaths } from "../platform/paths.js"
import { ensurePrivateChild } from "./environment.js"
import { drainHandlerServices, shutdownHandler, type ShutdownContext } from "./shutdown.js"
import { MutationQueue, type HandlerMutations } from "./mutations.js"

export type HandlerOptions = {
  paths: PlatformPaths
  adapter: PlatformAdapter
  recordPath: string
  generation: string
  status: Duplex
  gate: Duplex
  onPhase?: (phase: HandlerStatus["phase"]) => Promise<void>
  catalogFactory?: (context: { paths: PlatformPaths; adapter: PlatformAdapter; mutations: HandlerMutations; generation: string; store: CatalogStore; isReady(): boolean; shutdownPending(): boolean }) => CatalogService
  agentFactory?: (input: Parameters<typeof createAgentService>[0]) => AgentService
  launchContracts?: readonly LaunchContract[]
  entryDriver?: RuntimeEntryDriver
  taskFactory?: (input: TaskServiceOptions) => Promise<TaskService>
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
  let server: Server | undefined, attachmentServer: Server | undefined, current: HandlerGenerationRecord | undefined, termination = false, closing = false
  const sockets = new Set<Socket>()
  let shutdown: ShutdownContext | undefined
  let catalog: CatalogService | undefined
  let agents: AgentService | undefined
  let router: HostRouter | undefined
  let bridge: HandlerBridge | undefined
  let ownerTasks: TaskService | undefined
  let unregisterTasks: (() => void) | undefined
  let acpServer: Awaited<ReturnType<typeof startAcpServer>> | undefined
  const state: HandlerStatus = { hostId: options.paths.hostKey, handlerGeneration: options.generation, phase: "starting", reconciliation: { classified: 0, total: 0, uncertain: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] }
  const taskIssues: NonNullable<HandlerStatus["issues"]> = []
  let resolveClosed: () => void = () => undefined, rejectClosed: (error: Error) => void = () => undefined
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  void closed.catch(() => undefined)
  let closeOperation: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closeOperation) return closeOperation
    closing = true
    const attempts = [
      () => unregisterTasks?.(),
      () => ownerTasks?.close(),
      () => router?.close(),
      () => bridge?.close(),
      () => acpServer?.close(),
      () => agents?.close(),
      () => catalog?.close(),
      () => { options.status.destroy() },
      () => { options.gate.destroy() },
      ...[...sockets].map(socket => () => { socket.destroy() }),
      ...[server, attachmentServer].filter(listener => listener !== undefined).map(listener => () => new Promise<void>((resolve, reject) => listener.close(error => { if (error) reject(error); else resolve() }))),
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
      try { await drainHandlerServices({ ...(agents ? { agents } : {}), ...(catalog ? { catalog } : {}) }, true) } catch (error) { failures.push(error) }
      const verified = await Promise.allSettled([
        Promise.resolve().then(() => agents?.verifyDischarged()),
        Promise.resolve().then(() => catalog?.verifyDischarged()),
      ])
      failures.push(...verified.filter(result => result.status === "rejected").map(result => result.reason))
      if (interruptedStartup) failures.push(new Error("Handler startup interrupted by signal"))
      if (failures.length) throw new AggregateError(failures, "Handler discharge failed")
    },
    close,
  })
  const onSignal = (): void => {
    if (termination) return
    interruptedStartup = state.phase !== "ready"
    termination = true
    void terminate().then(error => {
      if (error) {
        try { write(2, formatTerminationFailure(error), () => undefined) } catch {}
      }
      process.exit(error ? 70 : 0)
    })
  }
  const checkStartup = (): void => { if (termination || closing) throw new Error("Handler startup interrupted") }
  const channelError = (): void => undefined
  options.status.on("error", channelError); options.gate.on("error", channelError)
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal)
  try {
    await ensurePrivateChild(options.paths.persistentRoot, "launches")
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
      return { protocol: PROTOCOL, requestId: request.requestId, handlerGeneration: options.generation, ok: true, result: structuredClone({ ...state, issues: [...(state.issues ?? []), ...taskIssues] }) }
    }
    const dispatchCatalog = async (request: CatalogRequest): Promise<CatalogReply> => {
      const bound = { ...request, handlerGeneration: options.generation }
      if (request.handlerGeneration !== options.generation) return catalogErrorReply(bound, new ControlError("STALE_HANDLER"))
      if (!catalog || state.phase !== "ready" || termination || closing) return catalogErrorReply(bound, new ControlError("INCOMPLETE", "Handler has not completed startup"))
      try { return { protocol: CATALOG_PROTOCOL, requestId: request.requestId, handlerGeneration: options.generation, ok: true, result: request.op === "model_list" ? await catalog.list() : await catalog.refresh(request.commandId, request.handlerGeneration) } }
      catch (error) { return catalogErrorReply(bound, error) }
    }
    const dispatchAgent = (request: AgentRequest): Promise<AgentReply> => dispatchAgentRequest({ agents, generation: options.generation, ready: () => state.phase === "ready" && !closing && !termination }, request)
    server = await bindPrivateSocket(options.paths.runtimeRoot, "handler.sock", socket => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      void serveProtocols(socket, dispatch, dispatchCatalog, 5000, dispatchAgent).then(async () => { if (shutdown?.accepted !== undefined) await shutdown.closeAfterReply() }).catch(rejectClosed)
    })
    if (termination || closing) await new Promise<void>(resolve => server!.close(() => resolve()))
    checkStartup()
    server.on("error", rejectClosed)
    server.on("close", () => { if (!closing) rejectClosed(new Error("control listener closed unexpectedly")) })
    attachmentServer = await bindPrivateSocket(options.paths.runtimeRoot, "attachment.sock", socket => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      if (!agents || state.phase !== "ready" || closing || termination) { socket.destroy(); return }
      void serveAttachment(socket, agents, options.generation).catch(rejectClosed)
    })
    if (termination || closing) await new Promise<void>(resolve => attachmentServer!.close(() => resolve()))
    checkStartup()
    attachmentServer.on("error", rejectClosed)
    attachmentServer.on("close", () => { if (!closing) rejectClosed(new Error("attachment listener closed unexpectedly")) })
    current = { ...published, writer: "handler", phase: "socket_bound" }
    await writeHandlerRecord(options.recordPath, current)
    checkStartup()
    await options.onPhase?.("ready")
    checkStartup()
    const mutations: HandlerMutations = { queue: new MutationQueue(), accepted: [], root }
    const catalogStore = createCatalogStore(root), agentStore = createAgentStore(root)
    const catalogContext = { paths: options.paths, adapter: options.adapter, mutations, generation: options.generation, store: catalogStore, isReady: () => state.phase === "ready" && !closing && !termination, shutdownPending: () => termination || shutdown?.pending !== undefined || shutdown?.accepted !== undefined }
    if (options.catalogFactory) catalog = options.catalogFactory(catalogContext)
    else {
      const store = catalogStore
      const probes = createProbeRuntime({ ...catalogContext, queue: mutations.queue, store, canStart: () => catalogContext.isReady() && !catalogContext.shutdownPending() })
      catalog = createCatalogService({ ...catalogContext, queue: mutations.queue, store, probes })
    }
    await catalog.initialize()
    checkStartup()
    const launchContext = { paths: options.paths, adapter: options.adapter, state, mutations, shutdownPending: () => termination || shutdown?.pending !== undefined || shutdown?.accepted !== undefined }
    agents = (options.agentFactory ?? createAgentService)({ context: launchContext, catalog, contracts: options.launchContracts ?? productionLaunchContracts(), store: agentStore })
    await agents.initialize()
    checkStartup()
    bridge = await createHandlerBridge({ root: options.paths.runtimeRoot, identity: { hostId: options.paths.hostKey, handlerGeneration: options.generation } })
    if (termination || closing) await bridge.close()
    checkStartup()
    unregisterTasks = registerTaskEndpoint({ bridge, hostId: options.paths.hostKey, generation: options.generation, ready: () => state.phase === "ready" && !closing && !termination, service: () => ownerTasks })
    registerRuntimeEndpoint(bridge, dispatchAgent)
    const ownerAgents = agents
    const entry = createRuntimeEntry({ hostId: options.paths.hostKey, generation: options.generation, driver: options.entryDriver ?? createRuntimeEntryDriver({ runtimeRoot: options.paths.runtimeRoot }), validate: async target => {
      try { await ownerAgents.sessionSnapshot(target); return true }
      catch (error) { if (error instanceof AgentError && ["STALE_HANDLER", "STALE_PROVIDER", "SESSION_UNAVAILABLE", "NOT_READY", "UNAVAILABLE"].includes(error.code)) return false; throw error }
    } })
    bridge.register(["entry-open", "runtime-entry-inspect"], async ({ channel, payload }) => {
      const value = object(payload); keys(value, channel === "entry-open" ? ["commandId", "ref"] : ["commandId"])
      return channel === "entry-open" ? entry.open(id(value.commandId), value.ref as never) : entry.inspect(id(value.commandId))
    })
    const coreBridge = bridge
    router = createHostRouter({ hostId: options.paths.hostKey, inventory: createHostInventory(root), local: (channel, payload, signal) => coreBridge.dispatch(channel, payload, signal ?? new AbortController().signal), connect: enrollment => connectBridge(enrollment, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read", "host-identity"] }) })
    registerHostRouter({ bridge, router, hostId: options.paths.hostKey, handlerGeneration: options.generation })
    acpServer = await startAcpServer({ socketPath: acpSocketPath(options.paths), service: agents, onError: rejectClosed })
    if (termination || closing) await acpServer.close()
    checkStartup()
    current = { ...current, phase: "ready", reconciliation: { classified: 0, total: 0, quarantined: 0 } }
    await writeHandlerRecord(options.recordPath, current)
    if (!isDeepStrictEqual(await readHandlerRecord(options.recordPath), current)) throw new Error("Handler readiness record changed")
    checkStartup()
    shutdown = { record: current, state, paths: options.paths, adapter: options.adapter, mutations, closeAfterReply: close, catalog, agents }
    state.phase = "ready"
    await sendStatus(options.status, { type: "ready", generation: options.generation }).catch(() => undefined)
    options.status.destroy()
    if (!termination && !closing) {
      const taskInput: TaskServiceOptions = { store: createTaskStore({ root, hostId: options.paths.hostKey }), hostId: options.paths.hostKey, generation: options.generation, runtime: agents, descriptor: taskToolDescriptor, environment: () => destinationEnvironment(process.env) }
      const initializeTasks = options.taskFactory ?? (async (input: TaskServiceOptions) => { await input.store.initialize(); return createTaskService(input) })
      void Promise.resolve().then(() => initializeTasks(taskInput)).then(async service => { if (closing || termination) await service.close(); else ownerTasks = service }).catch(() => {
        if (!closing) taskIssues.push({ path: join(root, "tasks"), launchAttemptId: null, message: "Task service is unavailable" })
      })
    }
    await closed
  } catch (error) {
    if (current !== undefined) {
      await writeHandlerRecord(options.recordPath, { ...current, phase: "exited_unverified", reason: String(error).slice(0, 512) }).catch(() => undefined)
    }
    throw error
  } finally {
    try { await close() } finally {
      process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal)
      options.status.destroy(); options.gate.destroy()
    }
  }
}