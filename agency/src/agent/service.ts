import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { observeConfig, readProfiles } from "../catalog/config.js"
import { createCatalogStore } from "../catalog/store.js"
import type { CatalogService, LaunchEvidence } from "../catalog/service.js"
import { id, isFresh } from "../catalog/types.js"
import { ControlError } from "../control/protocol.js"
import { commitLaunchTransition, type LaunchContext } from "../handler/launch-transitions.js"
import { confirmReconciledLaunch, refreshLaunchState } from "../handler/mutations.js"
import { readLaunchRecordForReconciliation } from "../platform/private-state.js"
import { reconcileRecord } from "../platform/reconcile.js"
import { observeLaunchContract, parseLaunchContract, resolveLaunchSpec, type LaunchContract } from "./contracts.js"
import { createAgentProcess, type OwnedAgentProcess } from "./process.js"
import type { LaunchEnvironment } from "./environment.js"
import { agentTuple, crossCheckAgents, recoverAgents, retainUnspawnedRestore, type AgentAssessment, type AgentRecoveryRepair } from "./recovery.js"
import type { AgentInventory, AgentStateIssue, AgentStore } from "./store.js"
import { AgentError, agentFailure, parsePromptInput, parseStartInput, parseStopInput, projectStartInput, specOf, splitLaunchSpec, type AgentCommand, type AgentFailure, type AgentList, type AgentRecord, type AgentView, type CommandResult, type CommandView, type CurrentAgents, type LaunchSpec, type PromptInput, type PromptView, type StartInput, type StopInput } from "./types.js"
import { parseRestoreRequest, projectRestoreInput, type RestoreRequest } from "./types.js"

export type AgentService = { initialize(): Promise<void>; start(input: StartInput): Promise<CommandView>; restore(input: RestoreRequest): Promise<CommandView>; stop(input: StopInput): Promise<CommandView>; prompt(input: PromptInput): Promise<PromptView>; command(commandId: string, generation: string): Promise<CommandView>; current(cwd: string): Promise<CurrentAgents>; list(): Promise<AgentList>; assertOrdinaryShutdownSafe(): void; freezeAndDrain(stopAgents: boolean): Promise<void>; resume(): void; verifyDischarged(): Promise<void>; close(): void }
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

export function createAgentService(input: { context: LaunchContext; catalog: CatalogService; contracts: readonly LaunchContract[]; candidateRestoreContracts?: ReadonlySet<string>; store: AgentStore }, dependencies: AgentServiceDependencies = productionDependencies(input.context.paths.persistentRoot)): AgentService {
  const { context, store, catalog } = input, { queue } = context.mutations, root = context.paths.persistentRoot, generation = context.state.handlerGeneration
  const candidateRestoreContracts = new Set(input.candidateRestoreContracts)
  const commands = new Map<string, AgentCommand>(), records = new Map<string, AgentRecord>(), operations = new Map<string, Live>(), intents = new Map<string, Live>()
  const dirty = new Set<string>(), dirtyAgents = new Set<string>(), stops = new Map<string, Promise<void>>()
  const recoveryRepairs = new Map<string, AgentRecoveryRepair>()
  let initialized = false, closed = false, frozen = false, accepting = 0, stopping = 0
  let assessment: AgentAssessment = { unavailable: new Map(), issues: [] }
  const runtimeIssues = new Map<string, AgentStateIssue>()
  const errorFor = (error: unknown): AgentError => error instanceof AgentError ? error : new AgentError("STARTUP_FAILED")
  const note = (agentId: string, kind: AgentStateIssue["kind"], id: string, path: string, error: unknown): void => {
    runtimeIssues.set(agentId, { kind, id, path, message: String(error).slice(0, 512) })
  }
  const noteOperation = (op: Live, error: unknown): void => note(op.initial.definition.agentId, "agent", op.initial.definition.agentId, join(root, "launches", op.initial.launch.launchAttemptId + ".json"), error)
  const issueFor = (agentId: string): AgentStateIssue | null => assessment.unavailable.get(agentId) ?? runtimeIssues.get(agentId) ?? null
  const targetFailure = (issue: AgentStateIssue): AgentError => new AgentError(issue.path.startsWith(join(root, "launches") + "/") ? "CLEANUP_UNVERIFIED" : "INVALID_AGENT_STATE")
  function expire(op: Live): never {
    if (op.expired) throw new AgentError("STARTUP_TIMEOUT")
    op.expired = true; clearTimeout(op.watchdog)
    op.fault ??= agentFailure(new AgentError("STARTUP_TIMEOUT"))
    noteOperation(op, new AgentError("STARTUP_TIMEOUT"))
    op.controller.abort()
    dependencies.fatalStartupTimeout(specOf(op.initial))
  }
  const available = (): void => {
    if (!initialized || closed || frozen || context.shutdownPending() || context.state.phase !== "ready") throw new AgentError("NOT_READY")
  }
  async function verify(): Promise<AgentInventory> {
    await refreshLaunchState(context.state, context.mutations, join(root, "launches"))
    const inventory = await store.inventory()
    assessment = crossCheckAgents(context, inventory)
    for (const repair of recoveryRepairs.values()) {
      const agentId = repair.kind === "command" ? repair.next.target?.agentId : repair.next.definition.agentId
      if (agentId && inventory.agents.some(record => record.definition.agentId === agentId)) assessment.unavailable.set(agentId, repair.issue)
      else assessment.issues.push(repair.issue)
    }
    if (inventory.issues.some(issue => issue.path === join(root, "agents") || issue.path === join(root, "agents", "provider-state"))) throw new AgentError("UNAVAILABLE")
    const agentIds = new Set(inventory.agents.map(record => record.definition.agentId)), commandIds = new Set(inventory.commands.map(command => command.commandId))
    for (const agentId of records.keys()) if (!agentIds.has(agentId) && !dirtyAgents.has(agentId)) records.delete(agentId)
    for (const commandId of commands.keys()) if (!commandIds.has(commandId) && !dirty.has(commandId)) commands.delete(commandId)
    for (const record of inventory.agents) if (!dirtyAgents.has(record.definition.agentId)) records.set(record.definition.agentId, record)
    for (const command of inventory.commands) if (!dirty.has(command.commandId)) commands.set(command.commandId, command)
    return inventory
  }
  async function publishCommand(next: AgentCommand, expected: AgentCommand | null): Promise<void> {
    dirty.add(next.commandId)
    try { await store.writeCommand(next, expected); dirty.delete(next.commandId) }
    finally {
      try {
        const visible = await store.readCommand(next.commandId)
        if (isDeepStrictEqual(visible, next)) {
          commands.set(next.commandId, structuredClone(next))
          if (next.target && runtimeIssues.get(next.target.agentId)?.path === join(root, "agents", "commands", next.commandId + ".json")) runtimeIssues.delete(next.target.agentId)
        }
        else if (!isDeepStrictEqual(visible, expected) && next.target) note(next.target.agentId, "command", next.commandId, join(root, "agents", "commands", next.commandId + ".json"), new AgentError("INVALID_AGENT_STATE"))
      } catch (error) { if (next.target) note(next.target.agentId, "command", next.commandId, join(root, "agents", "commands", next.commandId + ".json"), error) }
    }
  }
  async function publishAgent(next: AgentRecord, expected: AgentRecord | null): Promise<void> {
    dirtyAgents.add(next.definition.agentId)
    try { await store.writeAgent(next, expected); dirtyAgents.delete(next.definition.agentId) }
    finally {
      try {
        const visible = await store.readAgent(next.definition.agentId)
        if (isDeepStrictEqual(visible, next)) {
          records.set(next.definition.agentId, structuredClone(next))
          if (runtimeIssues.get(next.definition.agentId)?.path === join(root, "agents", "records", next.definition.agentId + ".json")) runtimeIssues.delete(next.definition.agentId)
        }
        else if (!isDeepStrictEqual(visible, expected)) note(next.definition.agentId, "agent", next.definition.agentId, join(root, "agents", "records", next.definition.agentId + ".json"), new AgentError("INVALID_AGENT_STATE"))
      } catch (error) { note(next.definition.agentId, "agent", next.definition.agentId, join(root, "agents", "records", next.definition.agentId + ".json"), error) }
    }
  }
  const view = (command: AgentCommand): CommandView => ({ state: "command", command: structuredClone(command), durability: dirty.has(command.commandId) || !!command.target && [...recoveryRepairs.values()].some(repair => repair.kind === "command" ? repair.next.target?.agentId === command.target?.agentId : repair.next.definition.agentId === command.target?.agentId) ? "unverified" : "verified" })
  async function retryRecovery(agentId: string | null, commandId: string): Promise<void> {
    for (const [key, repair] of recoveryRepairs) {
      if (repair.kind === "command" ? repair.next.commandId !== commandId && repair.next.target?.agentId !== agentId : repair.next.definition.agentId !== agentId) continue
      if (repair.kind === "launch") {
        await retainUnspawnedRestore(context, repair.expected)
        if (!context.mutations.accepted.some(entry => entry.record.launchAttemptId === repair.expected.launch.launchAttemptId && entry.record.phase === "cleanup_verified")) throw new AgentError("CLEANUP_UNVERIFIED")
        await publishAgent(repair.next, repair.expected)
      } else if (repair.kind === "agent") await publishAgent(repair.next, repair.expected)
      else await publishCommand(repair.next, repair.expected)
      recoveryRepairs.delete(key)
    }
    await verify()
  }
  async function revalidate(op: Live): Promise<void> {
    if (closed || op.controller.signal.aborted || op.fault) throw new AgentError("STARTUP_FAILED")
    if (context.state.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
    if (context.state.phase !== "ready") throw new AgentError("NOT_READY")
    await verify()
    if (assessment.unavailable.has(op.initial.definition.agentId) || runtimeIssues.has(op.initial.definition.agentId)) throw new AgentError("INVALID_AGENT_STATE")
    const observed = records.get(op.initial.definition.agentId)
    if (!observed || !isDeepStrictEqual(observed.definition, op.initial.definition) || !isDeepStrictEqual(observed.launch, op.initial.launch)) throw new AgentError("INVALID_AGENT_STATE")
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
    const command = commands.get(op.initial.launch.commandId)
    if (!command || command.state !== "pending") return
    await publishCommand({ ...command, state: "completed", result: op.result }, command)
  }
  function cleanup(op: Live): Promise<void> {
    if (op.cleanup) return op.cleanup
    const checkCleanup = (): void => { if (op.expired || !op.ready && performance.now() >= op.deadline) throw new AgentError("CLEANUP_UNVERIFIED") }
    op.cleanup = (async () => {
      checkCleanup()
      if (op.owner) await op.owner.cleanup()
      await queue.run(async () => {
        checkCleanup()
        await retainUnspawnedRestore(context, op.initial)
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
        confirmReconciledLaunch(context.mutations, entry.path)
        await refreshLaunchState(context.state, context.mutations, join(root, "launches"))
      })
    })().then(() => {
      checkCleanup()
      op.cleanupVerified = true; runtimeIssues.delete(op.initial.definition.agentId); clearTimeout(op.watchdog)
    }).catch(error => { delete op.cleanup; noteOperation(op, new AgentError("CLEANUP_UNVERIFIED")); throw error })
    return op.cleanup
  }
  async function failOperation(op: Live, error: unknown): Promise<void> {
    if (op.expired) return
    op.fault ??= agentFailure(errorFor(error)); op.controller.abort(); op.uncertain = null
    if (!op.ready) op.result = { outcome: "failed", target: agentTuple(op.initial), failure: op.fault, session: null }
    await queue.run(async () => {
      const record = records.get(op.initial.definition.agentId)
      if (record && ["starting", "ready"].includes(record.phase)) await publishAgent({ ...record, phase: "failed", failure: op.fault }, record)
    }).catch(error => noteOperation(op, error))
    await cleanup(op).catch(() => undefined)
    if (op.accepted.op === "restore" && op.cleanupVerified) await queue.run(async () => {
      const record = records.get(op.initial.definition.agentId)
      if (record?.phase === "restoring") await publishAgent({ ...record, phase: op.fault!.code === "SESSION_UNAVAILABLE" ? "failed" : "recoverable", failure: op.fault }, record)
    }).catch(error => noteOperation(op, error))
    await queue.run(() => finishStart(op)).catch(() => undefined)
  }
  async function ready(op: Live, record: AgentRecord): Promise<void> {
    await revalidate(op)
    const previous = records.get(record.definition.agentId)!
    if (op.controller.signal.aborted || !["starting", "restoring", "ready"].includes(previous.phase)) throw new AgentError("STARTUP_FAILED")
    try { await publishAgent(record, previous) }
    catch (error) { op.uncertain = record; throw error }
    op.uncertain = null
    if (op.controller.signal.aborted || op.fault || closed) throw new AgentError("STARTUP_FAILED")
    if (performance.now() >= op.deadline) throw new AgentError("STARTUP_TIMEOUT")
    op.ready = true
    clearTimeout(op.watchdog)
    op.deadline = Infinity
    op.result = { outcome: op.accepted.op === "restore" ? "restored" : "started", target: agentTuple(record), failure: null, session: record.session }
  }
  function launch(op: Live): void {
    if (op.started || closed) return
    op.started = true
    void new Promise<void>(resolve => { op.watchdog = setTimeout(resolve, Math.max(1, op.deadline - performance.now())) }).then(() => {
      if (!closed && !op.ready && !op.cleanupVerified && !op.expired) expire(op)
    }).catch(error => noteOperation(op, error))
    op.work = (async () => {
      try {
        if (op.controller.signal.aborted) throw new AgentError("STARTUP_FAILED")
        const spec = specOf(op.initial)
        await queue.run(() => revalidate(op))
        if (op.controller.signal.aborted) throw new AgentError("STARTUP_FAILED")
        op.owner = dependencies.processFactory({ context, spec, session: op.accepted.op === "restore" ? { kind: "load", sessionId: op.initial.session!.sessionId } : { kind: "new" }, environment: op.environment, contract: op.contract, deadline: op.deadline, isReady: () => op.ready, revalidate: () => revalidate(op) })
        void op.owner.fault.then(failure => { if (!closed && !op.controller.signal.aborted) void failOperation(op, new AgentError(failure.code)).catch(error => noteOperation(op, error)) })
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
    })().catch(error => noteOperation(op, error))
  }
  async function repair(op: Live): Promise<void> {
    if (!op.started) {
      const command = commands.get(op.initial.launch.commandId)
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
        await retryRecovery(command.target?.agentId ?? null, commandId)
        if (op && !closed) await repair(op)
        const current = commands.get(commandId)!
        if (dirty.has(commandId)) await publishCommand(current, current)
        if (current.op === "stop" && current.state === "pending" && current.handlerGeneration === generation && !closed) scheduleStop(current)
      } catch (error) {
        if (op?.uncertain && !op.ready && error instanceof AgentError) {
          op.uncertain = null
          void failOperation(op, error).catch(failure => noteOperation(op, failure))
        }
        return { ...view(commands.get(commandId)!), durability: "unverified" }
      }
      return view(commands.get(commandId)!)
    })
  }
  async function acceptLaunch(raw: StartInput | RestoreRequest, kind: "start" | "restore"): Promise<CommandView> {
    const request = kind === "start" ? parseStartInput(raw) : parseRestoreRequest(raw)
    const durableInput = kind === "start" ? projectStartInput(request as StartInput) : projectRestoreInput(request as RestoreRequest)
    accepting++
    try {
      const existing = await queue.run(async () => {
        await verify()
        const command = commands.get(request.commandId), op = intents.get(request.commandId)
        if (kind === "restore") { const issue = issueFor((request as RestoreRequest).agentId); if (issue) throw targetFailure(issue) }
        if (command && (command.op !== kind || !isDeepStrictEqual(command.input, durableInput))) throw new AgentError("COMMAND_CONFLICT")
        if (op && !isDeepStrictEqual(op.accepted.input, durableInput)) throw new AgentError("COMMAND_CONFLICT")
        if (op && !command) await repair(op)
        return commands.get(request.commandId) ?? null
      })
      if (existing) return command(request.commandId, request.handlerGeneration)
      available()
      if (request.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
      const previousAgent = kind === "restore" ? records.get((request as RestoreRequest).agentId) : undefined
      const checkRestorable = (): void => {
        if (kind !== "restore") return
        const issue = issueFor((request as RestoreRequest).agentId)
        if (issue) throw targetFailure(issue)
        if (!previousAgent || !previousAgent.session || !["stopped", "recoverable"].includes(previousAgent.phase)) throw new AgentError("NOT_READY")
        if (!isDeepStrictEqual(records.get(previousAgent.definition.agentId), previousAgent)) throw new AgentError("NOT_READY")
        if (!context.mutations.accepted.some(entry => entry.record.launchAttemptId === previousAgent.launch.launchAttemptId && entry.record.phase === "cleanup_verified")) throw new AgentError("CLEANUP_UNVERIFIED")
      }
      checkRestorable()
      const selection = previousAgent?.definition.selection ?? (request as StartInput).selection
      const cwd = previousAgent?.definition.cwd ?? (request as StartInput).cwd
      const candidates = input.contracts.filter(contract => contract.providerId === selection.providerId)
      if (candidates.length !== 1) throw new AgentError("ADAPTER_UNQUALIFIED")
      const contract = parseLaunchContract(candidates[0]), fingerprint = await observeLaunchContract(contract)
      if (kind === "restore" && contract.sessionLoad !== "qualified" && !(contract.sessionLoad === "candidate" && candidateRestoreContracts.has(contract.id))) throw new AgentError("RESTORE_UNSUPPORTED")
      if (fingerprint !== contract.fingerprint) throw new AgentError("CONFIG_CHANGED")
      let evidence: LaunchEvidence
      try { evidence = await catalog.launchEvidence(selection.providerId) } catch { throw new AgentError("MODEL_UNAVAILABLE") }
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
        if (previous) { if (previous.op !== kind || !isDeepStrictEqual(previous.input, durableInput)) throw new AgentError("COMMAND_CONFLICT"); return view(previous) }
        checkRestorable()
        const spec = resolveLaunchSpec({ ids: { hostId: context.paths.hostKey, handlerGeneration: generation, agentId: previousAgent?.definition.agentId ?? randomUUID(), providerGeneration: randomUUID(), launchAttemptId: randomUUID(), commandId: request.commandId }, cwd, selection, ...evidence, contract })
        if (previousAgent) spec.createdCommandId = previousAgent.definition.createdCommandId
        if (await observeLaunchContract(contract) !== fingerprint) throw new AgentError("CONFIG_CHANGED")
        const record: AgentRecord = { version: 2, ...splitLaunchSpec(spec), phase: kind === "restore" ? "restoring" : "starting", session: previousAgent?.session ?? null, failure: null }
        const accepted: AgentCommand = { version: 2, hostId: spec.hostId, commandId: request.commandId, handlerGeneration: generation, op: kind, input: durableInput, target: agentTuple(record), state: "pending", result: null }
        const op: Live = { initial: record, accepted, environment: request.environment, contract, evidence, controller: new AbortController(), deadline: performance.now() + (contract.qualification?.deadlines.overallMs ?? spec.limits.startupMs), prompt: null, cleanupVerified: false, ready: false, started: false, uncertain: null, result: null, fault: null }
        checkCommandDeadline()
        acceptingOperation = op
        operations.set(spec.agentId, op); intents.set(request.commandId, op)
        try { await publishCommand(accepted, null); checkCommandDeadline(); await publishAgent(record, previousAgent ?? null) }
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
  const start = (request: StartInput): Promise<CommandView> => acceptLaunch(request, "start")
  const restore = (request: RestoreRequest): Promise<CommandView> => acceptLaunch(request, "restore")
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
        if (closed || !initialized) throw new AgentError("UNAVAILABLE")
        if (request.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
        const record = records.get(request.agentId)
        if (!record) throw new AgentError("UNAVAILABLE")
        const issue = issueFor(request.agentId)
        if (issue) throw targetFailure(issue)
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
      if (issueFor(request.agentId)) throw new AgentError("INVALID_AGENT_STATE")
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
    const op = [...intents.values()].find(value => isDeepStrictEqual(agentTuple(value.initial), command.target))
    const activePrompt = op?.prompt?.promise
    op?.controller.abort()
    const operation = (async () => {
      try {
        await activePrompt?.catch(() => undefined)
        await queue.run(async () => {
          if (closed) throw new AgentError("NOT_READY")
          const record = records.get(command.target!.agentId)!
          if (!isDeepStrictEqual(agentTuple(record), command.target)) return
          if (["starting", "restoring", "ready"].includes(record.phase)) await publishAgent({ ...record, phase: "stopping" }, record)
          else if (dirtyAgents.has(record.definition.agentId)) await publishAgent(record, record)
        })
        await op?.work
        if (op) {
          if (!op.ready && !op.result) { op.uncertain = null; op.result = { outcome: "failed", target: command.target, failure: agentFailure(new AgentError("STARTUP_FAILED")), session: null } }
          await cleanup(op)
        } else if (context.mutations.accepted.some(e => e.record.version === 2 && e.record.owner.kind === "agent" && e.record.owner.agentId === command.target!.agentId && e.record.owner.providerGeneration === command.target!.providerGeneration && e.record.handlerGeneration === command.target!.handlerGeneration && e.record.phase !== "cleanup_verified")) throw new AgentError("CLEANUP_UNVERIFIED")
        await queue.run(async () => {
          if (closed) throw new AgentError("NOT_READY")
          const record = records.get(command.target!.agentId)!
          const matching = isDeepStrictEqual(agentTuple(record), command.target)
          if (matching && record.phase === "stopping") await publishAgent({ ...record, phase: "stopped" }, record)
          else if (matching && dirtyAgents.has(record.definition.agentId)) await publishAgent(record, record)
          if (op) await finishStart(op)
          const previous = commands.get(command.commandId)!
          if (previous.state === "pending") await publishCommand({ ...previous, state: "completed", result: { outcome: "stopped", target: command.target, failure: null, session: matching ? record.session : op?.result?.session ?? null } }, previous)
        })
      } catch { }
      finally { stops.delete(command.commandId) }
    })()
    stops.set(command.commandId, operation)
  }
  function agentView(record: AgentRecord): AgentView {
    const launch = context.mutations.accepted.find(e => e.record.launchAttemptId === record.launch.launchAttemptId)?.record ?? null, op = operations.get(record.definition.agentId)
    const unavailable = issueFor(record.definition.agentId)
    if (launch && (launch.version !== 2 || launch.owner.kind !== "agent" || launch.owner.agentId !== record.definition.agentId || launch.owner.providerGeneration !== record.launch.providerGeneration || launch.handlerGeneration !== record.launch.handlerGeneration)) return { record: structuredClone(record), launch: null, live: false, cleanup: "unknown", unavailable }
    return { record: structuredClone(op?.uncertain && !op.ready ? op.initial : record), launch: structuredClone(launch), live: !closed && record.launch.handlerGeneration === generation && !!op?.owner && !op.fault && !op.controller.signal.aborted && ["starting", "ready", "recoverable", "restoring", "stopping"].includes(record.phase), cleanup: launch === null ? "not_launched" : launch.phase === "cleanup_verified" ? op && !op.cleanupVerified ? "unverified" : "verified" : launch.phase === "quarantined" ? "unknown" : "unverified", unavailable }
  }
  const ordinary = (): void => {
    if (!initialized || accepting || stopping || stops.size || [...operations.values()].some(op => op.prompt) || [...commands.values()].some(c => c.state === "pending") || [...records.values()].some(r => ["starting", "ready", "restoring", "stopping"].includes(r.phase)) || context.mutations.accepted.some(e => e.record.version === 2 && e.record.owner.kind === "agent" && e.record.phase !== "cleanup_verified")) throw new ControlError("ACTIVE_AGENTS")
  }
  return {
    start, restore, stop, prompt, command,
    async initialize() {
      const recovered = await recoverAgents({ context, store })
      for (const record of recovered.inventory.agents) records.set(record.definition.agentId, record)
      for (const command of recovered.inventory.commands) commands.set(command.commandId, command)
      for (const repair of recovered.repairs) {
        if (repair.kind !== "command") { recoveryRepairs.set(`${repair.kind}:${repair.next.definition.agentId}`, repair); dirtyAgents.add(repair.next.definition.agentId) }
        else { recoveryRepairs.set(`command:${repair.next.commandId}`, repair); dirty.add(repair.next.commandId) }
      }
      assessment = recovered.assessment; initialized = true
    },
    async list() {
      return queue.run(async () => {
        const inventory = await verify()
        const legacy = inventory.legacyAgents.map(record => ({ record, launch: context.mutations.accepted.find(entry => entry.record.launchAttemptId === record.spec.launchAttemptId)?.record ?? null, live: false as const, cleanup: "unknown" as const }))
        const result: AgentList = { state: "agents", agents: [...[...records.values()].sort((a, b) => a.definition.agentId.localeCompare(b.definition.agentId)).map(agentView), ...legacy], issues: assessment.issues }
        if (Buffer.byteLength(JSON.stringify(result)) > 7 * 1024 * 1024) throw new AgentError("INCOMPLETE")
        return result
      })
    },
    async current(cwd) {
      return queue.run(async () => {
        await verify()
        const agents = [...records.values()].map(agentView).filter(agent => agent.live && agent.record.definition.cwd === cwd)
        return { state: "current", cwd, agents }
      })
    },
    assertOrdinaryShutdownSafe: ordinary,
    async freezeAndDrain(stopAgents) {
      if (!stopAgents) ordinary()
      frozen = true
      if (!stopAgents) return
      await verify()
      const prompts = [...operations.values()].flatMap(op => op.prompt ? [op.prompt] : [])
      for (const active of prompts) active.controller.abort()
      await Promise.all(prompts.map(active => active.promise.catch(() => undefined)))
      const failures: unknown[] = []
      for (const record of records.values()) {
        const view = agentView(record)
        if (!["starting", "ready", "restoring", "stopping"].includes(record.phase) && ["not_launched", "verified"].includes(view.cleanup)) continue
        const existing = [...commands.values()].find(c => c.op === "stop" && c.target?.agentId === record.definition.agentId && c.state === "pending")
        try { await stop(existing?.input as StopInput ?? { ...agentTuple(record), commandId: randomUUID() }) } catch (error) { failures.push(error) }
      }
      await Promise.all([...stops.values()])
      await queue.run(async () => {
        for (const op of operations.values()) await finishStart(op)
        for (const command of commands.values()) if (dirty.has(command.commandId)) await publishCommand(command, command)
      })
      if (failures.length) throw new AgentError("INCOMPLETE")
    },
    resume() { if (!closed) frozen = false },
    async verifyDischarged() { await verify(); ordinary(); if (dirty.size || dirtyAgents.size || assessment.unavailable.size || runtimeIssues.size) throw new AgentError("INCOMPLETE") },
    close() { closed = true; frozen = true; for (const op of operations.values()) { clearTimeout(op.watchdog); op.prompt?.controller.abort(); op.owner?.dispose(); op.controller.abort() } },
  }
}