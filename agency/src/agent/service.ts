import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { observeConfig, readProfiles } from "../catalog/config.js"
import { createCatalogStore } from "../catalog/store.js"
import type { CatalogService, LaunchEvidence } from "../catalog/service.js"
import { id, isFresh } from "../catalog/types.js"
import { ControlError } from "../control/protocol.js"
import { commitLaunchTransition, type LaunchContext } from "../handler/launch-transitions.js"
import { refreshLaunchState } from "../handler/mutations.js"
import { readLaunchRecordForReconciliation } from "../platform/private-state.js"
import { reconcileRecord } from "../platform/reconcile.js"
import { observeLaunchContract, parseLaunchContract, resolveLaunchSpec, type LaunchContract } from "./contracts.js"
import { createAgentProcess, type OwnedAgentProcess } from "./process.js"
import type { LaunchEnvironment } from "./environment.js"
import { agentTuple, crossCheckAgents, recoverAgents } from "./recovery.js"
import type { AgentInventory, AgentStore } from "./store.js"
import { AgentError, agentFailure, parsePromptInput, parseStartInput, parseStopInput, projectStartInput, specOf, splitLaunchSpec, startCommand, type AgentCommand, type AgentFailure, type AgentList, type AgentRecord, type AgentView, type CommandResult, type CommandView, type CurrentAgents, type LaunchSpec, type PromptInput, type PromptView, type StartInput, type StopInput } from "./types.js"

export type AgentService = { initialize(): Promise<void>; start(input: StartInput): Promise<CommandView>; stop(input: StopInput): Promise<CommandView>; prompt(input: PromptInput): Promise<PromptView>; command(commandId: string, generation: string): Promise<CommandView>; current(cwd: string): Promise<CurrentAgents>; list(): Promise<AgentList>; assertOrdinaryShutdownSafe(): void; freezeAndDrain(stopAgents: boolean): Promise<void>; resume(): void; verifyDischarged(): Promise<void>; close(): void }
type LivePrompt = { controller: AbortController; promise: Promise<PromptView> }
type Live = { initial: AgentRecord; accepted: AgentCommand; environment: LaunchEnvironment; contract: LaunchContract; evidence: LaunchEvidence; controller: AbortController; deadline: number; watchdog?: NodeJS.Timeout; expired?: boolean; owner?: OwnedAgentProcess; work?: Promise<void>; cleanup?: Promise<void>; prompt: LivePrompt | null; cleanupVerified: boolean; started: boolean; ready: boolean; uncertain: AgentRecord | null; result: CommandResult | null; fault: AgentFailure | null }

export type AgentServiceDependencies = {
  processFactory: typeof createAgentProcess
  observeLaunchEvidence(spec: LaunchSpec, expected: LaunchEvidence): Promise<void>
  fatalStartupTimeout(spec: LaunchSpec): never
}

function productionDependencies(root: string): AgentServiceDependencies {
  const handlerPid = process.pid
  return {
    processFactory: createAgentProcess,
    async observeLaunchEvidence(spec, expected) {
      const current = await createCatalogStore(root).readCurrent()
      const profile = (await readProfiles(root)).find(value => value.id === spec.selection.providerId)
      if (!current || current.snapshotId !== spec.catalogSnapshotId
        || !isDeepStrictEqual(current.providers.find(value => value.providerId === spec.selection.providerId), spec.catalogEvidence)
        || !profile || !isDeepStrictEqual(profile, expected.profile)
        || !isDeepStrictEqual(await observeConfig(profile), spec.configuration)) throw new AgentError("CONFIG_CHANGED")
    },
    fatalStartupTimeout() {
      if (handlerPid !== process.pid) throw new AgentError("STARTUP_TIMEOUT")
      process.kill(handlerPid, "SIGKILL")
      throw new AgentError("STARTUP_TIMEOUT")
    },
  }
}

export function createAgentService(input: { context: LaunchContext; catalog: CatalogService; contracts: readonly LaunchContract[]; store: AgentStore }, dependencies: AgentServiceDependencies = productionDependencies(input.context.paths.persistentRoot)): AgentService {
  const { context, store, catalog } = input, { queue } = context.mutations, root = context.paths.persistentRoot, generation = context.state.handlerGeneration
  const commands = new Map<string, AgentCommand>(), records = new Map<string, AgentRecord>(), operations = new Map<string, Live>(), intents = new Map<string, Live>()
  const dirty = new Set<string>(), dirtyAgents = new Set<string>(), stops = new Map<string, Promise<void>>()
  let initialized = false, closed = false, frozen = false, inventoryEmpty = false, accepting = 0, stopping = 0, blocked: AgentFailure | null = null
  const emptyLifecycle = (inventory: AgentInventory): boolean => !inventory.issues.length && !inventory.agents.length && !inventory.commands.length && !records.size && !commands.size && !operations.size && !intents.size
  const errorFor = (error: unknown): AgentError => error instanceof AgentError ? error : new AgentError("STARTUP_FAILED")
  const latch = (error: unknown): void => { blocked ??= agentFailure(error instanceof AgentError ? error : new AgentError("INVALID_AGENT_STATE")) }
  function expire(op: Live): never {
    if (op.expired) throw new AgentError("STARTUP_TIMEOUT")
    op.expired = true; clearTimeout(op.watchdog)
    op.fault ??= agentFailure(new AgentError("STARTUP_TIMEOUT"))
    latch(new AgentError("STARTUP_TIMEOUT"))
    context.mutations.unavailable ??= `startup timed out: ${op.initial.launch.launchAttemptId}`
    op.controller.abort()
    dependencies.fatalStartupTimeout(specOf(op.initial))
  }
  const available = (): void => {
    if (!initialized || closed || frozen || context.shutdownPending() || context.state.phase !== "ready") throw new AgentError("NOT_READY")
    if (blocked || context.mutations.unavailable) throw new AgentError("UNAVAILABLE")
  }
  async function verify(): Promise<AgentInventory> {
    try {
      await refreshLaunchState(context.state, context.mutations, join(root, "launches"))
      const inventory = await store.inventory()
      inventoryEmpty = emptyLifecycle(inventory)
      const ownedAttempts = new Set(inventory.agents.map(agent => agent.launch.launchAttemptId))
      if (context.mutations.issues?.some(issue => issue.launchAttemptId !== null && ownedAttempts.has(issue.launchAttemptId))) throw new AgentError("INVALID_AGENT_STATE")
      crossCheckAgents(context, inventory)
      if (context.mutations.unavailable) throw new AgentError("UNAVAILABLE")
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
    dirtyAgents.add(next.definition.agentId)
    try { await store.writeAgent(next, expected); dirtyAgents.delete(next.definition.agentId) }
    finally {
      const visible = await store.readAgent(next.definition.agentId)
      if (isDeepStrictEqual(visible, next)) records.set(next.definition.agentId, structuredClone(next))
      else if (!isDeepStrictEqual(visible, expected)) latch(new AgentError("INVALID_AGENT_STATE"))
    }
  }
  const view = (command: AgentCommand): CommandView => ({ state: "command", command: structuredClone(command), durability: dirty.has(command.commandId) ? "unverified" : "verified" })
  async function revalidate(op: Live): Promise<void> {
    if (closed || op.controller.signal.aborted || op.fault) throw new AgentError("STARTUP_FAILED")
    if (context.state.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
    if (context.state.phase !== "ready") throw new AgentError("NOT_READY")
    await verify()
    const spec = specOf(op.initial)
    if (performance.now() >= op.deadline) throw new AgentError("STARTUP_TIMEOUT")
    if (!isFresh(spec.catalogEvidence.verifiedAt, Date.now())) throw new AgentError("MODEL_UNAVAILABLE")
    await dependencies.observeLaunchEvidence(spec, op.evidence)
    if (await observeLaunchContract(op.contract) !== spec.contractFingerprint) throw new AgentError("CONFIG_CHANGED")
    if (op.controller.signal.aborted || op.fault || closed) throw new AgentError("STARTUP_FAILED")
    if (performance.now() >= op.deadline) throw new AgentError("STARTUP_TIMEOUT")
  }
  async function finishStart(op: Live): Promise<void> {
    if (op.expired) return
    if (!op.result) return
    if (op.owner && op.result.outcome === "failed" && !op.cleanupVerified) return
    const command = commands.get(op.initial.definition.createdCommandId)
    if (!command || command.state !== "pending") return
    await publishCommand({ ...command, state: "completed", result: op.result }, command)
  }
  function cleanup(op: Live): Promise<void> {
    if (op.cleanup) return op.cleanup
    const checkCleanup = (): void => { if (op.expired || !op.ready && performance.now() >= op.deadline) throw new AgentError("CLEANUP_UNVERIFIED") }
    op.cleanup = (async () => {
      checkCleanup()
      if (op.owner) { await op.owner.cleanup(); return }
      await queue.run(async () => {
        checkCleanup()
        const spec = specOf(op.initial), entry = context.mutations.accepted.find(e => e.record.launchAttemptId === spec.launchAttemptId)
        if (!entry) {
          await verify()
          return
        }
        if (entry.record.version !== 2 || entry.record.owner.kind !== "agent" || entry.record.owner.agentId !== spec.agentId || entry.record.owner.providerGeneration !== spec.providerGeneration) throw new AgentError("CLEANUP_UNVERIFIED")
        checkCleanup()
        const result = await reconcileRecord(entry.path, context.adapter, entry.record)
        if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(entry.path), result.record)) throw new AgentError("CLEANUP_UNVERIFIED")
        entry.record = result.record
        await refreshLaunchState(context.state, context.mutations, join(root, "launches"))
        if (result.record.phase !== "cleanup_verified") throw new AgentError("CLEANUP_UNVERIFIED")
      })
    })().then(() => {
      checkCleanup()
      op.cleanupVerified = true; clearTimeout(op.watchdog)
    }).catch(error => { latch(new AgentError("CLEANUP_UNVERIFIED")); throw error })
    return op.cleanup
  }
  async function failOperation(op: Live, error: unknown): Promise<void> {
    if (op.expired) return
    op.fault ??= agentFailure(errorFor(error)); op.controller.abort(); op.uncertain = null
    if (!op.ready) op.result = { outcome: "failed", target: agentTuple(op.initial), failure: op.fault, session: null }
    await queue.run(async () => {
      const record = records.get(op.initial.definition.agentId)
      if (record && ["starting", "ready"].includes(record.phase)) await publishAgent({ ...record, phase: "failed", failure: op.fault }, record)
    }).catch(latch)
    await cleanup(op).catch(() => undefined)
    await queue.run(() => finishStart(op)).catch(() => undefined)
  }
  async function ready(op: Live, record: AgentRecord): Promise<void> {
    await revalidate(op)
    const previous = records.get(record.definition.agentId)!
    if (op.controller.signal.aborted || !["starting", "ready"].includes(previous.phase)) throw new AgentError("STARTUP_FAILED")
    try { await publishAgent(record, previous) }
    catch (error) { op.uncertain = record; throw error }
    op.uncertain = null
    if (op.controller.signal.aborted || op.fault || closed) throw new AgentError("STARTUP_FAILED")
    if (performance.now() >= op.deadline) throw new AgentError("STARTUP_TIMEOUT")
    op.ready = true
    clearTimeout(op.watchdog)
    op.deadline = Infinity
    op.result = { outcome: "started", target: agentTuple(record), failure: null, session: record.session }
  }
  function launch(op: Live): void {
    if (op.started || closed) return
    op.started = true
    void new Promise<void>(resolve => { op.watchdog = setTimeout(resolve, Math.max(1, op.deadline - performance.now())) }).then(() => {
      if (!closed && !op.ready && !op.cleanupVerified && !op.expired) expire(op)
    }).catch(latch)
    op.work = (async () => {
      try {
        if (op.controller.signal.aborted) throw new AgentError("STARTUP_FAILED")
        const spec = specOf(op.initial)
        await queue.run(() => revalidate(op))
        if (op.controller.signal.aborted) throw new AgentError("STARTUP_FAILED")
        op.owner = dependencies.processFactory({ context, spec, environment: op.environment, contract: op.contract, deadline: op.deadline, isReady: () => op.ready, revalidate: () => revalidate(op) })
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
        if (!op.expired && !closed && !op.ready && !op.uncertain) await failOperation(op, error)
      }
    })().catch(latch)
  }
  async function repair(op: Live): Promise<void> {
    if (!op.started) {
      const command = commands.get(op.initial.definition.createdCommandId)
      if (!command || dirty.has(command.commandId)) await publishCommand(command ?? op.accepted, command ?? null)
      await publishAgent(op.initial, records.get(op.initial.definition.agentId) ?? null)
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
    const durableInput = projectStartInput(request)
    accepting++
    try {
      const existing = await queue.run(async () => {
        await verify()
        const command = commands.get(request.commandId), op = intents.get(request.commandId)
        if (command && (command.op !== "start" || !isDeepStrictEqual(command.input, durableInput))) throw new AgentError("COMMAND_CONFLICT")
        if (op && !isDeepStrictEqual(op.accepted.input, durableInput)) throw new AgentError("COMMAND_CONFLICT")
        if (op && !command) await repair(op)
        return commands.get(request.commandId) ?? null
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
      let timedOut = false, acceptingOperation: Live | undefined, timer: NodeJS.Timeout | undefined
      const commandDeadline = performance.now() + (contract.qualification?.deadlines.commandMs ?? 5000)
      const checkCommandDeadline = (): void => {
        if (timedOut || performance.now() >= commandDeadline) {
          timedOut = true; acceptingOperation?.controller.abort(); throw new AgentError("STARTUP_TIMEOUT")
        }
      }
      const acceptance = queue.run(async () => {
        checkCommandDeadline()
        await verify(); available()
        const previous = commands.get(request.commandId)
        if (previous) { if (previous.op !== "start" || !isDeepStrictEqual(previous.input, durableInput)) throw new AgentError("COMMAND_CONFLICT"); return view(previous) }
        const spec = resolveLaunchSpec({ ids: { hostId: context.paths.hostKey, handlerGeneration: generation, agentId: randomUUID(), providerGeneration: randomUUID(), launchAttemptId: randomUUID(), commandId: request.commandId }, cwd: request.cwd, selection: request.selection, ...evidence, contract })
        if (await observeLaunchContract(contract) !== fingerprint) throw new AgentError("CONFIG_CHANGED")
        const record: AgentRecord = { version: 2, ...splitLaunchSpec(spec), phase: "starting", session: null, failure: null }
        const accepted = startCommand(request, agentTuple(record), spec.hostId)
        const op: Live = { initial: record, accepted, environment: request.environment, contract, evidence, controller: new AbortController(), deadline: performance.now() + (contract.qualification?.deadlines.overallMs ?? spec.limits.startupMs), prompt: null, cleanupVerified: false, ready: false, started: false, uncertain: null, result: null, fault: null }
        checkCommandDeadline()
        acceptingOperation = op
        operations.set(spec.agentId, op); intents.set(request.commandId, op)
        try { await publishCommand(accepted, null); checkCommandDeadline(); await publishAgent(record, null) }
        catch (error) { if (error instanceof AgentError && error.code === "STARTUP_TIMEOUT") throw error; throw new AgentError("INCOMPLETE") }
        checkCommandDeadline()
        launch(op); return view(accepted)
      })
      try {
        return await Promise.race([acceptance, new Promise<never>((_, reject) => { timer = setTimeout(() => {
          timedOut = true; acceptingOperation?.controller.abort(); reject(new AgentError("STARTUP_TIMEOUT"))
        }, Math.max(1, commandDeadline - performance.now())) })])
      } finally { clearTimeout(timer) }
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
        if (closed || !initialized || blocked) throw new AgentError("UNAVAILABLE")
        if (request.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
        const record = records.get(request.agentId)
        if (!record) throw new AgentError("UNAVAILABLE")
        if (record.launch.handlerGeneration !== request.handlerGeneration) throw new AgentError("STALE_HANDLER")
        if (record.launch.providerGeneration !== request.providerGeneration) throw new AgentError("STALE_PROVIDER")
        const accepted: AgentCommand = { version: 2, hostId: context.paths.hostKey, commandId: request.commandId, handlerGeneration: generation, input: request, op: "stop", target: agentTuple(record), state: "pending", result: null }
        await publishCommand(accepted, null)
        scheduleStop(accepted)
        return view(accepted)
      })
    } finally { stopping-- }
  }
  async function prompt(raw: PromptInput): Promise<PromptView> {
    const request = parsePromptInput(raw)
    let pending!: Promise<PromptView>
    await queue.run(async () => {
      available()
      if (request.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
      const record = records.get(request.agentId)
      if (!record) throw new AgentError("UNAVAILABLE")
      if (record.launch.handlerGeneration !== request.handlerGeneration) throw new AgentError("STALE_HANDLER")
      if (record.launch.providerGeneration !== request.providerGeneration) throw new AgentError("STALE_PROVIDER")
      const op = operations.get(request.agentId)
      if (record.phase !== "ready" || !op?.ready || !op.owner || op.controller.signal.aborted || op.fault || op.cleanupVerified) throw new AgentError("NOT_READY")
      if (op.prompt) throw new AgentError("INCOMPLETE")
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      op.controller.signal.addEventListener("abort", abort, { once: true })
      if (op.controller.signal.aborted) controller.abort()
      pending = Promise.resolve().then(async () => {
        try {
          await revalidate(op)
          if (controller.signal.aborted) throw new AgentError("STARTUP_FAILED")
          const result = await op.owner!.prompt(request.text, controller.signal)
          await revalidate(op)
          return { state: "prompt", target: agentTuple(record), stopReason: result.stopReason, text: result.text }
        } catch (error) {
          const failure = errorFor(error)
          if (!controller.signal.aborted && !op.controller.signal.aborted && !closed) await failOperation(op, failure)
          throw failure
        } finally {
          op.controller.signal.removeEventListener("abort", abort)
          if (op.prompt?.promise === pending) op.prompt = null
        }
      })
      op.prompt = { controller, promise: pending }
    })
    return pending
  }
  function scheduleStop(command: AgentCommand): void {
    if (stops.has(command.commandId) || command.state !== "pending") return
    const op = operations.get(command.target!.agentId)
    const activePrompt = op?.prompt?.promise
    op?.controller.abort()
    const operation = (async () => {
      try {
        await activePrompt?.catch(() => undefined)
        await queue.run(async () => {
          if (closed) throw new AgentError("NOT_READY")
          const record = records.get(command.target!.agentId)!
          if (["starting", "ready"].includes(record.phase)) await publishAgent({ ...record, phase: "stopping" }, record)
          else if (dirtyAgents.has(record.definition.agentId)) await publishAgent(record, record)
        })
        await op?.work
        if (op) {
          if (!op.ready && !op.result) { op.uncertain = null; op.result = { outcome: "failed", target: command.target, failure: agentFailure(new AgentError("STARTUP_FAILED")), session: null } }
          await cleanup(op)
        } else if (context.mutations.accepted.some(e => e.record.version === 2 && e.record.owner.kind === "agent" && e.record.owner.agentId === command.target!.agentId && e.record.phase !== "cleanup_verified")) throw new AgentError("CLEANUP_UNVERIFIED")
        await queue.run(async () => {
          if (closed) throw new AgentError("NOT_READY")
          const record = records.get(command.target!.agentId)!
          if (record.phase === "stopping") await publishAgent({ ...record, phase: "stopped" }, record)
          else if (dirtyAgents.has(record.definition.agentId)) await publishAgent(record, record)
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
    const launch = context.mutations.accepted.find(e => e.record.launchAttemptId === record.launch.launchAttemptId)?.record ?? null, op = operations.get(record.definition.agentId)
    return { record: structuredClone(op?.uncertain && !op.ready ? op.initial : record), launch: structuredClone(launch), live: !blocked && !closed && record.launch.handlerGeneration === generation && !!op?.owner && !op.fault && !op.controller.signal.aborted && ["starting", "ready", "recoverable", "restoring", "stopping"].includes(record.phase), cleanup: launch === null ? blocked ? "unknown" : "not_launched" : launch.phase === "cleanup_verified" ? blocked && (!op || blocked.code === "CLEANUP_UNVERIFIED") ? "unknown" : op && !op.cleanupVerified ? "unverified" : "verified" : launch.phase === "quarantined" ? "unknown" : "unverified" }
  }
  const ordinary = (): void => {
    if (!initialized || blocked && !inventoryEmpty || accepting || stopping || stops.size || [...operations.values()].some(op => op.prompt) || [...commands.values()].some(c => c.state === "pending") || [...records.values()].some(r => ["starting", "ready", "recoverable", "restoring", "stopping"].includes(r.phase)) || context.mutations.accepted.some(e => e.record.version === 2 && e.record.owner.kind === "agent" && records.has(e.record.owner.agentId) && e.record.phase !== "cleanup_verified")) throw new ControlError("ACTIVE_AGENTS")
  }
  return {
    start, stop, prompt, command,
    async initialize() {
      const recovered = await recoverAgents({ context, store })
      for (const record of recovered.inventory.agents) records.set(record.definition.agentId, record)
      for (const command of recovered.inventory.commands) commands.set(command.commandId, command)
      inventoryEmpty = emptyLifecycle(recovered.inventory)
      blocked = recovered.unavailable; initialized = true
    },
    async list() {
      return queue.run(async () => {
        try { await verify() } catch { }
        const legacy = (await store.inventory()).legacyAgents.map(record => ({ record, launch: context.mutations.accepted.find(entry => entry.record.launchAttemptId === record.spec.launchAttemptId)?.record ?? null, live: false as const, cleanup: "unknown" as const }))
        const result: AgentList = { state: "agents", agents: [...[...records.values()].sort((a, b) => a.definition.agentId.localeCompare(b.definition.agentId)).map(agentView), ...legacy], unavailable: blocked }
        if (Buffer.byteLength(JSON.stringify(result)) > 7 * 1024 * 1024) throw new AgentError("INCOMPLETE")
        return result
      })
    },
    async current(cwd) {
      return queue.run(async () => {
        try { await verify() } catch { }
        const agents = [...records.values()].map(agentView).filter(agent => agent.live && agent.record.definition.cwd === cwd)
        return { state: "current", cwd, agents }
      })
    },
    assertOrdinaryShutdownSafe: ordinary,
    async freezeAndDrain(stopAgents) {
      if (!stopAgents) ordinary()
      frozen = true
      if (!stopAgents) return
      const prompts = [...operations.values()].flatMap(op => op.prompt ? [op.prompt] : [])
      for (const active of prompts) active.controller.abort()
      await Promise.all(prompts.map(active => active.promise.catch(() => undefined)))
      for (const record of records.values()) {
        const view = agentView(record)
        if (!["starting", "ready", "recoverable", "restoring", "stopping"].includes(record.phase) && ["not_launched", "verified"].includes(view.cleanup)) continue
        const existing = [...commands.values()].find(c => c.op === "stop" && c.target?.agentId === record.definition.agentId && c.state === "pending")
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
    close() { closed = true; frozen = true; for (const op of operations.values()) { clearTimeout(op.watchdog); op.prompt?.controller.abort(); op.owner?.dispose(); op.controller.abort() } },
  }
}