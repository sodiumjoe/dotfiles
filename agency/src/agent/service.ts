import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { observeConfig, readProfiles } from "../catalog/config.js"
import { createCatalogStore } from "../catalog/store.js"
import type { CatalogService, LaunchEvidence } from "../catalog/service.js"
import { id, isFresh } from "../catalog/types.js"
import { AdmissionError, type AdmissionContext, type AdmissionController } from "../checkout/admission.js"
import { checkoutsOverlap, resolveCheckout } from "../checkout/identity.js"
import { inventoryAdmissions } from "../checkout/records.js"
import { ControlError } from "../control/protocol.js"
import { commitLaunchTransition } from "../handler/launch-transitions.js"
import { refreshLaunchState } from "../handler/mutations.js"
import { readLaunchRecordForReconciliation } from "../platform/private-state.js"
import { reconcileRecord } from "../platform/reconcile.js"
import { observeLaunchContract, parseLaunchContract, resolveLaunchSpec, type LaunchContract } from "./contracts.js"
import { createAgentProcess, type OwnedAgentProcess } from "./process.js"
import { agentTuple, crossCheckAgents, recoverAgents } from "./recovery.js"
import type { AgentInventory, AgentStore } from "./store.js"
import { AgentError, agentFailure, parseStartInput, parseStopInput, type AgentCommand, type AgentFailure, type AgentList, type AgentRecord, type AgentView, type CommandResult, type CommandView, type CurrentAgent, type StartInput, type StopInput } from "./types.js"

export type AgentService = { initialize(): Promise<void>; start(input: StartInput): Promise<CommandView>; stop(input: StopInput): Promise<CommandView>; command(commandId: string, generation: string): Promise<CommandView>; current(cwd: string): Promise<CurrentAgent>; list(): Promise<AgentList>; assertOrdinaryShutdownSafe(): void; freezeAndDrain(stopAgents: boolean): Promise<void>; resume(): void; verifyDischarged(): Promise<void>; close(): void }
type Live = { initial: AgentRecord; contract: LaunchContract; evidence: LaunchEvidence; controller: AbortController; owner?: OwnedAgentProcess; work?: Promise<void>; cleanup?: Promise<void>; started: boolean; ready: boolean; uncertain: AgentRecord | null; result: CommandResult | null; fault: AgentFailure | null }

export function createAgentService(input: { context: AdmissionContext; admission: AdmissionController; catalog: CatalogService; contracts: readonly LaunchContract[]; store: AgentStore; processFactory?: typeof createAgentProcess }): AgentService {
  const { context, store, admission, catalog } = input, { queue } = context.mutations, root = context.paths.persistentRoot, generation = context.state.handlerGeneration
  const catalogStore = createCatalogStore(root), commands = new Map<string, AgentCommand>(), records = new Map<string, AgentRecord>(), operations = new Map<string, Live>(), intents = new Map<string, Live>()
  const dirty = new Set<string>(), dirtyAgents = new Set<string>(), stops = new Map<string, Promise<void>>()
  let initialized = false, closed = false, frozen = false, inventoryEmpty = false, accepting = 0, stopping = 0, blocked: AgentFailure | null = null
  const emptyLifecycle = (inventory: AgentInventory): boolean => !inventory.issues.length && !inventory.agents.length && !inventory.commands.length && !records.size && !commands.size && !operations.size && !intents.size
  const errorFor = (error: unknown): AgentError => error instanceof AgentError ? error : error instanceof AdmissionError ? new AgentError(error.code === "CHECKOUT_BUSY" || error.code === "CHECKOUT_QUARANTINED" ? error.code : "ADMISSION_UNAVAILABLE") : new AgentError("STARTUP_FAILED")
  const latch = (error: unknown): void => { blocked ??= agentFailure(error instanceof AgentError ? error : new AgentError("INVALID_AGENT_STATE")) }
  const available = (): void => {
    if (!initialized || closed || frozen || context.shutdownPending() || context.state.phase !== "ready") throw new AgentError("NOT_READY")
    if (blocked || context.mutations.unavailable) throw new AgentError("ADMISSION_UNAVAILABLE")
  }
  async function verify(): Promise<AgentInventory> {
    try {
      await refreshLaunchState(context.state, context.mutations, join(root, "launches"))
      const inventory = await store.inventory()
      inventoryEmpty = emptyLifecycle(inventory)
      crossCheckAgents(context, inventory, await inventoryAdmissions(root))
      if (context.mutations.unavailable) throw new AgentError("ADMISSION_UNAVAILABLE")
      return inventory
    } catch (error) { latch(error); throw error }
  }
  async function publishCommand(next: AgentCommand, expected: AgentCommand | null): Promise<void> {
    dirty.add(next.commandId)
    try { await store.writeCommand(next, expected); dirty.delete(next.commandId) }
    finally {
      const visible = await store.readCommand(next.commandId)
      if (isDeepStrictEqual(visible, next)) commands.set(next.commandId, structuredClone(next))
      else if (!isDeepStrictEqual(visible, expected)) latch(new AgentError("INVALID_AGENT_STATE"))
    }
  }
  async function publishAgent(next: AgentRecord, expected: AgentRecord | null): Promise<void> {
    dirtyAgents.add(next.spec.agentId)
    try { await store.writeAgent(next, expected); dirtyAgents.delete(next.spec.agentId) }
    finally {
      const visible = await store.readAgent(next.spec.agentId)
      if (isDeepStrictEqual(visible, next)) records.set(next.spec.agentId, structuredClone(next))
      else if (!isDeepStrictEqual(visible, expected)) latch(new AgentError("INVALID_AGENT_STATE"))
    }
  }
  const view = (command: AgentCommand): CommandView => ({ state: "command", command: structuredClone(command), durability: dirty.has(command.commandId) ? "unverified" : "verified" })
  async function revalidate(op: Live): Promise<void> {
    if (closed || op.controller.signal.aborted || op.fault) throw new AgentError("STARTUP_FAILED")
    if (context.state.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
    if (context.state.phase !== "ready") throw new AgentError("NOT_READY")
    await verify()
    const spec = op.initial.spec, current = await catalogStore.readCurrent(), profile = (await readProfiles(root)).find(p => p.id === spec.selection.providerId)
    if (!current || current.snapshotId !== spec.catalogSnapshotId || !isDeepStrictEqual(current.providers.find(p => p.providerId === spec.selection.providerId), spec.catalogEvidence) || !isFresh(spec.catalogEvidence.verifiedAt, Date.now())) throw new AgentError("MODEL_UNAVAILABLE")
    if (!profile || !isDeepStrictEqual(profile, op.evidence.profile) || !isDeepStrictEqual(await observeConfig(profile), spec.configuration) || await observeLaunchContract(op.contract) !== spec.contractFingerprint) throw new AgentError("CONFIG_CHANGED")
    if (!isDeepStrictEqual(await resolveCheckout(spec.checkout.root.path, spec.hostId), spec.checkout)) throw new AgentError("CONFIG_CHANGED")
    if (op.controller.signal.aborted || op.fault || closed) throw new AgentError("STARTUP_FAILED")
  }
  async function finishStart(op: Live): Promise<void> {
    if (!op.result) return
    const command = commands.get(op.initial.spec.startCommandId)
    if (!command || command.state !== "pending") return
    await publishCommand({ ...command, state: "completed", result: op.result }, command)
  }
  function cleanup(op: Live): Promise<void> {
    if (op.cleanup) return op.cleanup
    op.cleanup = (async () => {
      if (op.owner) { await op.owner.cleanup(); return }
      await queue.run(async () => {
        const spec = op.initial.spec, entry = context.mutations.accepted.find(e => e.record.launchAttemptId === spec.launchAttemptId)
        if (!entry) {
          await verify()
          if ((await inventoryAdmissions(root)).records.some(a => a.agentId === spec.agentId)) throw new AgentError("CLEANUP_UNVERIFIED")
          return
        }
        if (entry.record.agentId !== spec.agentId || entry.record.leaseId !== spec.leaseId) throw new AgentError("CLEANUP_UNVERIFIED")
        const result = await reconcileRecord(entry.path, context.adapter, entry.record)
        if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(entry.path), result.record)) throw new AgentError("CLEANUP_UNVERIFIED")
        entry.record = result.record
        await refreshLaunchState(context.state, context.mutations, join(root, "launches"))
        if (result.record.phase !== "cleanup_verified") throw new AgentError("CLEANUP_UNVERIFIED")
      })
    })()
    return op.cleanup
  }
  async function failOperation(op: Live, error: unknown): Promise<void> {
    op.fault ??= agentFailure(errorFor(error)); op.controller.abort(); op.uncertain = null
    if (!op.ready) op.result = { outcome: "failed", target: agentTuple(op.initial), failure: op.fault, session: null }
    await queue.run(async () => {
      const record = records.get(op.initial.spec.agentId)
      if (record && ["starting", "ready"].includes(record.phase)) await publishAgent({ ...record, phase: "failed", failure: op.fault }, record)
    }).catch(latch)
    await cleanup(op).catch(() => undefined)
    await queue.run(() => finishStart(op)).catch(() => undefined)
  }
  async function ready(op: Live, record: AgentRecord): Promise<void> {
    await revalidate(op)
    const previous = records.get(record.spec.agentId)!
    if (op.controller.signal.aborted || !["starting", "ready"].includes(previous.phase)) throw new AgentError("STARTUP_FAILED")
    try { await publishAgent(record, previous) }
    catch (error) { op.uncertain = record; throw error }
    op.uncertain = null
    if (op.controller.signal.aborted || op.fault || closed) throw new AgentError("STARTUP_FAILED")
    op.ready = true
    op.result = { outcome: "started", target: agentTuple(record), failure: null, session: record.session }
  }
  function launch(op: Live): void {
    if (op.started || closed) return
    op.started = true
    op.work = (async () => {
      try {
        if (op.controller.signal.aborted) throw new AgentError("STARTUP_FAILED")
        const spec = op.initial.spec
        const reservation = await admission.reserve({ checkout: spec.checkout, agentId: spec.agentId, leaseId: spec.leaseId, launchAttemptId: spec.launchAttemptId, handlerGeneration: generation })
        op.owner = (input.processFactory ?? createAgentProcess)({ context, reservation, spec, contract: op.contract, revalidate: () => revalidate(op) })
        void op.owner.fault.then(failure => { if (!closed && !op.controller.signal.aborted) void failOperation(op, new AgentError(failure.code)).catch(latch) })
        if (op.controller.signal.aborted) throw new AgentError("STARTUP_FAILED")
        const session = await op.owner.initialize(op.controller.signal)
        await queue.run(async () => {
          await revalidate(op)
          const record = op.owner!.record()
          await commitLaunchTransition(context, record, { ...record, phase: "active" })
          await ready(op, { ...op.initial, phase: "ready", session })
          await finishStart(op)
        })
      } catch (error) {
        if (!closed && !op.ready && !op.uncertain) await failOperation(op, error)
      }
    })().catch(latch)
  }
  async function repair(op: Live): Promise<void> {
    if (!op.started) {
      const command = commands.get(op.initial.spec.startCommandId)
      if (!command) throw new AgentError("INCOMPLETE")
      if (dirty.has(command.commandId)) await publishCommand(command, command)
      await publishAgent(op.initial, records.get(op.initial.spec.agentId) ?? null)
      launch(op)
    } else if (op.uncertain && !op.controller.signal.aborted && !op.fault) await ready(op, op.uncertain)
    await finishStart(op)
  }
  async function command(commandId: string, expectedGeneration: string): Promise<CommandView> {
    id(commandId); id(expectedGeneration)
    return queue.run(async () => {
      await verify()
      const command = commands.get(commandId)
      if (!command) throw new AgentError("UNAVAILABLE")
      if (command.handlerGeneration !== expectedGeneration) throw new AgentError("COMMAND_CONFLICT")
      const op = intents.get(commandId)
      try {
        if (op && !closed) await repair(op)
        const current = commands.get(commandId)!
        if (dirty.has(commandId)) await publishCommand(current, current)
        if (current.op === "stop" && current.state === "pending" && current.handlerGeneration === generation && !closed) scheduleStop(current)
      } catch (error) {
        if (op?.uncertain && !op.ready && error instanceof AgentError) {
          op.uncertain = null
          void failOperation(op, error).catch(latch)
        }
        return { ...view(commands.get(commandId)!), durability: "unverified" }
      }
      return view(commands.get(commandId)!)
    })
  }
  async function start(raw: StartInput): Promise<CommandView> {
    const request = parseStartInput(raw)
    accepting++
    try {
      const existing = await queue.run(async () => {
        await verify()
        const command = commands.get(request.commandId), op = intents.get(request.commandId)
        if (command && (command.op !== "start" || !isDeepStrictEqual(command.input, request))) throw new AgentError("COMMAND_CONFLICT")
        if (op && !isDeepStrictEqual((commands.get(request.commandId)?.input ?? { ...request, selection: op.initial.spec.selection }), request)) throw new AgentError("COMMAND_CONFLICT")
        return command ?? null
      })
      if (existing) return command(request.commandId, request.handlerGeneration)
      available()
      if (request.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
      const candidates = input.contracts.filter(contract => contract.providerId === request.selection.providerId)
      if (candidates.length !== 1) throw new AgentError("ADAPTER_UNQUALIFIED")
      const contract = parseLaunchContract(candidates[0]), fingerprint = await observeLaunchContract(contract)
      if (fingerprint !== contract.fingerprint) throw new AgentError("CONFIG_CHANGED")
      let evidence: LaunchEvidence
      try { evidence = await catalog.launchEvidence(request.selection.providerId) } catch { throw new AgentError("MODEL_UNAVAILABLE") }
      return await queue.run(async () => {
        await verify(); available()
        const previous = commands.get(request.commandId)
        if (previous) { if (previous.op !== "start" || !isDeepStrictEqual(previous.input, request)) throw new AgentError("COMMAND_CONFLICT"); return view(previous) }
        if ([...operations.values()].filter(op => !op.result).length >= 4 || [...records.values()].filter(record => ["starting", "ready", "stopping"].includes(record.phase)).length >= 16) throw new AgentError("INCOMPLETE")
        const checkout = await resolveCheckout(request.cwd, context.paths.hostKey)
        const spec = resolveLaunchSpec({ ids: { hostId: context.paths.hostKey, handlerGeneration: generation, agentId: randomUUID(), providerGeneration: randomUUID(), leaseId: randomUUID(), launchAttemptId: randomUUID(), startCommandId: request.commandId }, checkout, selection: request.selection, ...evidence, contract })
        if (await observeLaunchContract(contract) !== fingerprint) throw new AgentError("CONFIG_CHANGED")
        const record: AgentRecord = { version: 1, spec, phase: "starting", session: null, failure: null }
        const op: Live = { initial: record, contract, evidence, controller: new AbortController(), ready: false, started: false, uncertain: null, result: null, fault: null }
        const accepted: AgentCommand = { version: 1, hostId: spec.hostId, commandId: request.commandId, handlerGeneration: generation, input: request, op: "start", target: agentTuple(record), state: "pending", result: null }
        operations.set(spec.agentId, op); intents.set(request.commandId, op)
        try { await publishCommand(accepted, null); await publishAgent(record, null) }
        catch { throw new AgentError("INCOMPLETE") }
        launch(op); return view(accepted)
      })
    } finally { accepting-- }
  }
  async function stop(raw: StopInput): Promise<CommandView> {
    const request = parseStopInput(raw)
    stopping++
    try {
      return await queue.run(async () => {
        await verify()
        const prior = commands.get(request.commandId)
        if (prior) {
          if (prior.op !== "stop" || !isDeepStrictEqual(prior.input, request)) throw new AgentError("COMMAND_CONFLICT")
          if (dirty.has(prior.commandId)) await publishCommand(prior, prior)
          if (prior.state === "pending") scheduleStop(prior)
          return view(prior)
        }
        if (closed || !initialized || blocked) throw new AgentError("ADMISSION_UNAVAILABLE")
        if (request.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
        const record = records.get(request.agentId)
        if (!record) throw new AgentError("UNAVAILABLE")
        if (record.spec.handlerGeneration !== request.handlerGeneration) throw new AgentError("STALE_HANDLER")
        if (record.spec.providerGeneration !== request.providerGeneration) throw new AgentError("STALE_PROVIDER")
        const accepted: AgentCommand = { version: 1, hostId: context.paths.hostKey, commandId: request.commandId, handlerGeneration: generation, input: request, op: "stop", target: agentTuple(record), state: "pending", result: null }
        await publishCommand(accepted, null)
        scheduleStop(accepted)
        return view(accepted)
      })
    } finally { stopping-- }
  }
  function scheduleStop(command: AgentCommand): void {
    if (stops.has(command.commandId) || command.state !== "pending") return
    const op = operations.get(command.target!.agentId)
    op?.controller.abort()
    const operation = (async () => {
      try {
        await queue.run(async () => {
          if (closed) throw new AgentError("NOT_READY")
          const record = records.get(command.target!.agentId)!
          if (["starting", "ready"].includes(record.phase)) await publishAgent({ ...record, phase: "stopping" }, record)
          else if (dirtyAgents.has(record.spec.agentId)) await publishAgent(record, record)
        })
        await op?.work
        if (op) {
          if (!op.ready && !op.result) { op.uncertain = null; op.result = { outcome: "failed", target: command.target, failure: agentFailure(new AgentError("STARTUP_FAILED")), session: null } }
          await cleanup(op)
        } else if (context.mutations.accepted.some(e => e.record.agentId === command.target!.agentId && e.record.phase !== "cleanup_verified")) throw new AgentError("CLEANUP_UNVERIFIED")
        await queue.run(async () => {
          if (closed) throw new AgentError("NOT_READY")
          const record = records.get(command.target!.agentId)!
          if (record.phase === "stopping") await publishAgent({ ...record, phase: "stopped" }, record)
          else if (dirtyAgents.has(record.spec.agentId)) await publishAgent(record, record)
          if (op) await finishStart(op)
          const previous = commands.get(command.commandId)!
          if (previous.state === "pending") await publishCommand({ ...previous, state: "completed", result: { outcome: "stopped", target: command.target, failure: null, session: record.session } }, previous)
        })
      } catch { }
      finally { stops.delete(command.commandId) }
    })()
    stops.set(command.commandId, operation)
  }
  function agentView(record: AgentRecord): AgentView {
    const launch = context.mutations.accepted.find(e => e.record.launchAttemptId === record.spec.launchAttemptId)?.record ?? null, op = operations.get(record.spec.agentId)
    return { record: structuredClone(op?.uncertain && !op.ready ? op.initial : record), launch: structuredClone(launch), live: !blocked && !closed && record.spec.handlerGeneration === generation && !!op?.owner && !op.fault && !op.controller.signal.aborted && ["starting", "ready", "stopping"].includes(record.phase), cleanup: launch === null ? blocked ? "unknown" : "not_reserved" : launch.phase === "cleanup_verified" ? "verified" : launch.phase === "quarantined" ? "unknown" : "unverified" }
  }
  const ordinary = (): void => {
    if (!initialized || blocked && !inventoryEmpty || accepting || stopping || stops.size || [...commands.values()].some(c => c.state === "pending") || [...records.values()].some(r => ["starting", "ready", "stopping"].includes(r.phase)) || context.mutations.accepted.some(e => records.has(e.record.agentId) && e.record.phase !== "cleanup_verified")) throw new ControlError("ACTIVE_AGENTS")
  }
  return {
    start, stop, command,
    async initialize() {
      const recovered = await recoverAgents({ context, store })
      for (const record of recovered.inventory.agents) records.set(record.spec.agentId, record)
      for (const command of recovered.inventory.commands) commands.set(command.commandId, command)
      inventoryEmpty = emptyLifecycle(recovered.inventory)
      blocked = recovered.unavailable; initialized = true
    },
    async list() {
      return queue.run(async () => {
        try { await verify() } catch { }
        const result: AgentList = { state: "agents", agents: [...records.values()].sort((a, b) => a.spec.agentId.localeCompare(b.spec.agentId)).map(agentView), unavailable: blocked }
        if (Buffer.byteLength(JSON.stringify(result)) > 7 * 1024 * 1024) throw new AgentError("INCOMPLETE")
        return result
      })
    },
    async current(cwd) {
      return queue.run(async () => {
        const checkout = await resolveCheckout(cwd, context.paths.hostKey)
        try { await verify() } catch { }
        const matches = [...records.values()].map(agentView).filter(a => checkoutsOverlap(checkout, a.record.spec.checkout) && (["starting", "ready", "stopping"].includes(a.record.phase) || !["not_reserved", "verified"].includes(a.cleanup)))
        const admissions = await inventoryAdmissions(root)
        const blockers = context.mutations.accepted.filter(e => e.record.phase !== "cleanup_verified" && admissions.records.some(a => a.launchAttemptId === e.record.launchAttemptId && checkoutsOverlap(checkout, a.checkout))).map(e => e.record.launchAttemptId).sort()
        if (matches.length > 1) latch(new AgentError("INVALID_AGENT_STATE"))
        return { state: "current", checkout, agent: blocked ? null : matches[0] ?? null, blockers, unavailable: blocked }
      })
    },
    assertOrdinaryShutdownSafe: ordinary,
    async freezeAndDrain(stopAgents) {
      if (!stopAgents) ordinary()
      frozen = true
      if (!stopAgents) return
      for (const record of records.values()) {
        const view = agentView(record)
        if (!["starting", "ready", "stopping"].includes(record.phase) && ["not_reserved", "verified"].includes(view.cleanup)) continue
        const existing = [...commands.values()].find(c => c.op === "stop" && c.target?.agentId === record.spec.agentId && c.state === "pending")
        await stop(existing?.input as StopInput ?? { ...agentTuple(record), commandId: randomUUID() })
      }
      await Promise.all([...stops.values()])
      await queue.run(async () => {
        for (const op of operations.values()) await finishStart(op)
        for (const command of commands.values()) if (dirty.has(command.commandId)) await publishCommand(command, command)
      })
    },
    resume() { if (!closed) frozen = false },
    async verifyDischarged() { inventoryEmpty = emptyLifecycle(await store.inventory()); if (!inventoryEmpty) await verify(); ordinary(); if (dirty.size || dirtyAgents.size) throw new AgentError("INCOMPLETE") },
    close() { closed = true; frozen = true; for (const op of operations.values()) { op.owner?.dispose(); op.controller.abort() } },
  }
}