import { join } from "node:path"
import { startAcpServer } from "../acp/server.js"
import { createAgentService, type AgentService } from "../agent/service.js"
import { createAgentStore } from "../agent/store.js"
import { productionLaunchContracts, type LaunchContract } from "../agent/contracts.js"
import { AGENT_PROTOCOL, agentErrorReply, type AgentRequest, type AgentReply } from "../agent/protocol.js"
import { AgentError } from "../agent/types.js"
import { serveAttachment } from "../agent/attachment-server.js"
import { randomUUID } from "node:crypto"
import type { Duplex } from "node:stream"
import type { Server, Socket } from "node:net"
import { isDeepStrictEqual } from "node:util"
import { ControlError, PROTOCOL, errorReply, type HandlerStatus, type ControlRequest, type ControlReply } from "../control/protocol.js"
import { serveProtocols } from "../control/wire.js"
import { CATALOG_PROTOCOL, catalogErrorReply, type CatalogRequest, type CatalogReply } from "../catalog/protocol.js"
import { createCatalogService, type CatalogService } from "../catalog/service.js"
import { createCatalogStore, type CatalogStore } from "../catalog/store.js"
import { createProbeRuntime } from "../catalog/probes.js"
import { agencyLaunchMarker, exactAgencyBirth } from "../platform/launch-marker.js"
import { bindPrivateSocket } from "../platform/private-socket.js"
import { PrivateStatePublicationError, readHandlerRecord, readLaunchRecordForReconciliation, writeHandlerRecord } from "../platform/private-state.js"
import { reconcileRecord, RetainedInventoryChangedError } from "../platform/reconcile.js"
import { sameProcess, type HandlerGenerationRecord, type LaunchRecord, type PlatformAdapter, type ProcessIdentity } from "../platform/types.js"
import { acpSocketPath, type PlatformPaths } from "../platform/paths.js"
import { ensurePrivateChild } from "./environment.js"
import { inventoryLaunchState, summarizeLaunches, type InventoryEntry, type LaunchIssue } from "./inventory.js"
import { shutdownHandler, type ShutdownContext } from "./shutdown.js"
import { MutationQueue, type HandlerMutations } from "./mutations.js"
import { createRetentionStore, type RetirementView, type RetentionFileSystem } from "../retention/store.js"
import { authorizeRetirement, authorizedRetirementView, createRetentionCoordinator, type RetentionCoordinator } from "../retention/coordinator.js"

export type HandlerOptions = {
  paths: PlatformPaths
  adapter: PlatformAdapter
  recordPath: string
  generation: string
  status: Duplex
  gate: Duplex
  onPhase?: (phase: HandlerStatus["phase"]) => Promise<void>
  catalogFactory?: (context: { paths: PlatformPaths; adapter: PlatformAdapter; mutations: HandlerMutations; generation: string; store: CatalogStore; retirement: RetirementView; onTerminal(): void; cleanupIssues(): readonly string[]; isReady(): boolean; shutdownPending(): boolean }) => CatalogService
  agentFactory?: (input: Parameters<typeof createAgentService>[0]) => AgentService
  launchContracts?: readonly LaunchContract[]
  retention?: { now?: () => number; filesystem?: RetentionFileSystem }
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

function retainedIdentity(record: LaunchRecord): unknown {
  const { phase, reason, launchAttempted, provider, ...identity } = record
  return { ...identity, leader: provider?.group.leader }
}

export async function runHandler(options: HandlerOptions): Promise<void> {
  let server: Server | undefined, attachmentServer: Server | undefined, current: HandlerGenerationRecord | undefined, termination = false, closing = false
  const sockets = new Set<Socket>()
  let entries: InventoryEntry[] = []
  let shutdown: ShutdownContext | undefined
  let catalog: CatalogService | undefined
  let agents: AgentService | undefined
  let acpServer: Awaited<ReturnType<typeof startAcpServer>> | undefined
  const state: HandlerStatus = { hostId: options.paths.hostKey, handlerGeneration: options.generation, phase: "starting", reconciliation: { classified: 0, total: 0, uncertain: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] }
  let resolveClosed: () => void = () => undefined, rejectClosed: (error: Error) => void = () => undefined
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  void closed.catch(() => undefined)
  const close = async (): Promise<void> => {
    if (closing) return closed
    closing = true
    await acpServer?.close()
    for (const socket of sockets) socket.destroy()
    for (const listener of [server, attachmentServer]) if (listener !== undefined) await new Promise<void>(resolve => listener.close(() => resolve()))
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
    const root = options.paths.persistentRoot, retentionStore = createRetentionStore(root, options.paths.hostKey, options.generation, options.retention?.filesystem)
    retentionStore.view = authorizedRetirementView(retentionStore, intent => authorizeRetirement({ root, hostId: options.paths.hostKey, generation: options.generation, adapter: options.adapter, pins: [...(catalog?.retentionPins().paths ?? []), ...(agents?.retentionPins().paths ?? [])] }, intent))
    let coordinator: RetentionCoordinator | undefined, bootstrapIssue: string | undefined
    try { await retentionStore.resume({ authorize: intent => authorizeRetirement({ root, hostId: options.paths.hostKey, generation: options.generation, adapter: options.adapter }, intent), removed() {} }) }
    catch (error) { bootstrapIssue = String(error).slice(0, 480) }
    const cleanupIssues = () => coordinator?.diagnostics() ?? (bootstrapIssue ? [bootstrapIssue] : [])
    const onTerminal = () => coordinator?.request()
    await sendStatus(options.status, { type: "gate_released", generation: options.generation }).catch(() => undefined)
    const dispatch = async (request: ControlRequest): Promise<ControlReply> => {
      if (request.handlerGeneration !== options.generation) return errorReply({ ...request, handlerGeneration: options.generation }, new ControlError("STALE_HANDLER"))
      if (request.op === "shutdown") return shutdown === undefined ? errorReply(request, new ControlError("INCOMPLETE", "Handler has not completed startup")) : shutdownHandler(request, shutdown)
      return { protocol: PROTOCOL, requestId: request.requestId, handlerGeneration: options.generation, ok: true, result: structuredClone(state) }
    }
    const dispatchCatalog = async (request: CatalogRequest): Promise<CatalogReply> => {
      const bound = { ...request, handlerGeneration: options.generation }
      if (request.handlerGeneration !== options.generation) return catalogErrorReply(bound, new ControlError("STALE_HANDLER"))
      if (!catalog || state.phase !== "ready") return catalogErrorReply(bound, new ControlError("INCOMPLETE", "Handler has not completed startup"))
      try { return { protocol: CATALOG_PROTOCOL, requestId: request.requestId, handlerGeneration: options.generation, ok: true, result: request.op === "model_list" ? await catalog.list() : await catalog.refresh(request.commandId, request.handlerGeneration) } }
      catch (error) { return catalogErrorReply(bound, error) }
    }
    const dispatchAgent = async (request: AgentRequest): Promise<AgentReply> => {
      const bound = { ...request, handlerGeneration: options.generation }
      if (request.handlerGeneration !== options.generation) return agentErrorReply(bound, new AgentError("STALE_HANDLER"))
      if (!agents || state.phase !== "ready") return agentErrorReply(bound, new AgentError("NOT_READY"))
      try {
        const result = request.op === "agent_choices" ? await agents.choices() : request.op === "agent_page" ? await agents.page(request.input) : request.op === "agent_start" ? await agents.start(request.input) : request.op === "agent_restore" ? await agents.restore(request.input) : request.op === "agent_stop" ? await agents.stop(request.input) : request.op === "agent_prompt" ? await agents.prompt(request.input) : request.op === "agent_command" ? await agents.command(request.commandId, request.commandGeneration) : request.op === "agent_current" ? await agents.current(request.cwd) : await agents.list()
        return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: options.generation, ...(request.op === "agent_command" ? { commandId: request.commandId } : request.op === "agent_start" || request.op === "agent_restore" || request.op === "agent_stop" ? { commandId: request.input.commandId } : {}), ok: true, result }
      } catch (error) { return agentErrorReply(bound, error) }
    }
    server = await bindPrivateSocket(options.paths.runtimeRoot, "handler.sock", socket => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      void serveProtocols(socket, dispatch, dispatchCatalog, 5000, dispatchAgent).then(async () => { if (shutdown?.accepted !== undefined) await shutdown.closeAfterReply() }).catch(rejectClosed)
    })
    server.on("error", rejectClosed)
    server.on("close", () => { if (!closing) rejectClosed(new Error("control listener closed unexpectedly")) })
    attachmentServer = await bindPrivateSocket(options.paths.runtimeRoot, "attachment.sock", socket => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      if (!agents || state.phase !== "ready" || closing) { socket.destroy(); return }
      void serveAttachment(socket, agents, options.generation).catch(rejectClosed)
    })
    attachmentServer.on("error", rejectClosed)
    attachmentServer.on("close", () => { if (!closing) rejectClosed(new Error("attachment listener closed unexpectedly")) })
    current = { ...published, writer: "handler", phase: "socket_bound" }
    await writeHandlerRecord(options.recordPath, current)
    const directory = join(options.paths.persistentRoot, "launches")
    const initialInventory = await inventoryLaunchState(directory, retentionStore.view, root)
    entries = initialInventory.records
    state.issues = initialInventory.issues
    state.phase = "reconciling"
    state.reconciliation.total = entries.length
    state.launches = summarizeLaunches(entries.map(entry => entry.record))
    current = { ...published, writer: "handler", phase: "reconciling", reconciliation: { classified: state.reconciliation.classified, total: state.reconciliation.total, quarantined: state.reconciliation.uncertain } }
    await writeHandlerRecord(options.recordPath, current)
    await options.onPhase?.("reconciling")
    const reconciliationIssues: LaunchIssue[] = [], successful = new Map<string, InventoryEntry["record"]>()
    for (const entry of entries) {
      try {
        const result = await reconcileRecord(entry.path, options.adapter, entry.record)
        if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(entry.path), result.record)) throw new RetainedInventoryChangedError()
        entry.record = result.record
        successful.set(entry.path, result.record)
      } catch (error) {
        if (error instanceof RetainedInventoryChangedError || error instanceof PrivateStatePublicationError) throw error
        reconciliationIssues.push({ path: entry.path, launchAttemptId: entry.record.launchAttemptId, message: String(error).slice(0, 512) })
      }
      state.reconciliation.classified++
      if (entry.record.phase === "quarantined") state.reconciliation.uncertain++
      state.launches = summarizeLaunches(entries.map(item => item.record))
      current = { ...current, reconciliation: { classified: state.reconciliation.classified, total: state.reconciliation.total, quarantined: state.reconciliation.uncertain } }
      await writeHandlerRecord(options.recordPath, current)
    }
    await options.onPhase?.("ready")
    const checkedInventory = await inventoryLaunchState(directory, retentionStore.view, root)
    const initialPaths = new Set(entries.map(entry => entry.path))
    if (checkedInventory.records.some(entry => !initialPaths.has(entry.path))) throw new Error("RETAINED_INVENTORY_CHANGED")
    for (const [path, expected] of successful) if (!isDeepStrictEqual(checkedInventory.records.find(entry => entry.path === path)?.record, expected)) throw new Error("RETAINED_INVENTORY_CHANGED")
    const trusted = checkedInventory.records.filter(entry => {
      const original = entries.find(value => value.path === entry.path)?.record
      if (!original) return false
      if (successful.has(entry.path)) return true
      return isDeepStrictEqual(retainedIdentity(original), retainedIdentity(entry.record))
    })
    state.launches = summarizeLaunches(checkedInventory.records.map(entry => entry.record))
    state.reconciliation = { classified: checkedInventory.records.length, total: checkedInventory.records.length, uncertain: checkedInventory.records.filter(entry => entry.record.phase === "quarantined").length }
    state.issues = [...checkedInventory.issues, ...reconciliationIssues]
    current = { ...current, reconciliation: { classified: state.reconciliation.classified, total: state.reconciliation.total, quarantined: state.reconciliation.uncertain } }
    await writeHandlerRecord(options.recordPath, current)
    const mutations: HandlerMutations = { queue: new MutationQueue(), accepted: structuredClone(trusted), reconciliationIssues, retirement: retentionStore.view, root }
    const catalogStore = createCatalogStore(root, undefined, retentionStore.view), agentStore = createAgentStore(root, undefined, retentionStore.view)
    const catalogContext = { paths: options.paths, adapter: options.adapter, mutations, generation: options.generation, store: catalogStore, retirement: retentionStore.view, onTerminal, cleanupIssues, isReady: () => state.phase === "ready" && !closing, shutdownPending: () => termination || shutdown?.pending !== undefined || shutdown?.accepted !== undefined }
    if (options.catalogFactory) catalog = options.catalogFactory(catalogContext)
    else {
      const store = catalogStore
      const probes = createProbeRuntime({ ...catalogContext, queue: mutations.queue, store, canStart: () => catalogContext.isReady() && !catalogContext.shutdownPending() })
      catalog = createCatalogService({ ...catalogContext, queue: mutations.queue, store, probes })
    }
    await catalog.initialize()
    const launchContext = { paths: options.paths, adapter: options.adapter, state, mutations, shutdownPending: () => termination || shutdown?.pending !== undefined || shutdown?.accepted !== undefined }
    agents = (options.agentFactory ?? createAgentService)({ context: launchContext, catalog, contracts: options.launchContracts ?? productionLaunchContracts(), store: agentStore, retirement: retentionStore.view, onTerminal, cleanupIssues })
    await agents.initialize()
    acpServer = await startAcpServer({ socketPath: acpSocketPath(options.paths), service: agents, onError: rejectClosed })
    coordinator = createRetentionCoordinator({ root, hostId: options.paths.hostKey, generation: options.generation, queue: mutations.queue, adapter: options.adapter, store: retentionStore, catalogStore, agentStore, mutations, catalog, agents, ...(options.retention?.now ? { now: options.retention.now } : {}) })
    await coordinator.initialize()
    current = { ...current, phase: "ready" }
    await writeHandlerRecord(options.recordPath, current)
    if (!isDeepStrictEqual(await readHandlerRecord(options.recordPath), current)) throw new Error("Handler readiness record changed")
    shutdown = { record: current, state, paths: options.paths, adapter: options.adapter, mutations, closeAfterReply: close, catalog, agents }
    state.phase = "ready"
    if (termination) await terminate()
    else await sendStatus(options.status, { type: "ready", generation: options.generation }).catch(() => undefined)
    options.status.destroy()
    if (!termination && !closing) catalog.startScheduling()
    await closed
  } catch (error) {
    if (current !== undefined) {
      await writeHandlerRecord(options.recordPath, { ...current, phase: "exited_unverified", reason: String(error).slice(0, 512) }).catch(() => undefined)
    }
    throw error
  } finally {
    agents?.close()
    catalog?.close()
    await close()
    process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal)
    options.status.destroy(); options.gate.destroy()
  }
}