import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { observeConfig, readProfiles } from "../catalog/config.js"
import { createCatalogStore } from "../catalog/store.js"
import type { CatalogService, LaunchEvidence } from "../catalog/service.js"
import { id, isFresh, PROVIDERS } from "../catalog/types.js"
import { digest } from "../catalog/config.js"
import { inventoryPage, launchChoices, parsePageInput, QUERY_BYTES, type AgentChoices, type AgentPage, type PageInput } from "./queries.js"
import { ControlError } from "../control/protocol.js"
import { commitLaunchTransition, type LaunchContext } from "../handler/launch-transitions.js"
import { confirmReconciledLaunch, refreshLaunchState } from "../handler/mutations.js"
import { readLaunchRecordForReconciliation } from "../platform/private-state.js"
import { reconcileRecord } from "../platform/reconcile.js"
import { configureLaunchContract, observeLaunchContract, parseLaunchContract, resolveLaunchSpec, type ConfiguredLaunchContract, type LaunchContract } from "./contracts.js"
import { createAgentProcess, type OwnedAgentProcess } from "./process.js"
import type { LaunchEnvironment } from "./environment.js"
import { agentTuple, crossCheckAgents, recoverAgents, retainUnspawnedRestore, type AgentAssessment, type AgentRecoveryRepair } from "./recovery.js"
import type { AgentInventory, AgentStateIssue, AgentStore } from "./store.js"
import { AgentError, agentFailure, parsePromptInput, parseStartInput, parseStopInput, projectStartInput, specOf, splitLaunchSpec, type AgentCommand, type AgentFailure, type AgentList, type AgentRecord, type AgentView, type CommandResult, type CommandView, type CurrentAgents, type LaunchSpec, type PromptInput, type PromptView, type StartInput, type StopInput } from "./types.js"
import { parseRestoreRequest, projectRestoreInput, type RestoreRequest } from "./types.js"
import { createConversation, type Conversation, type ConversationListener, type ConversationObservation } from "./conversation.js"
import { createTurnCoordinator, type SubmissionReceipt, type SubmissionRequest, type TurnCoordinator } from "./turns.js"
import { LEGACY_TURN_LIMITS, type TurnOptions, type TurnResult } from "./session-events.js"
import type { AgentTuple } from "./types.js"

export type AgentService = { initialize(): Promise<void>; start(input: StartInput): Promise<CommandView>; restore(input: RestoreRequest): Promise<CommandView>; stop(input: StopInput): Promise<CommandView>; prompt(input: PromptInput): Promise<PromptView>; observe(target: AgentTuple, listener: ConversationListener): Promise<ConversationObservation>; submit(target: AgentTuple, request: SubmissionRequest): Promise<SubmissionReceipt>; submission(target: AgentTuple, submissionId: string): Promise<SubmissionReceipt | null>; cancel(target: AgentTuple, submissionId: string): Promise<SubmissionReceipt>; command(commandId: string, generation: string): Promise<CommandView>; choices(): Promise<AgentChoices>; page(input: PageInput): Promise<AgentPage>; current(cwd: string): Promise<CurrentAgents>; list(): Promise<AgentList>; assertOrdinaryShutdownSafe(): void; freezeAndDrain(stopAgents: boolean): Promise<void>; resume(): void; verifyDischarged(): Promise<void>; close(): void }
type LivePrompt = { controller: AbortController; promise: Promise<TurnResult> }
type Live = { initial: AgentRecord; accepted: AgentCommand; environment: LaunchEnvironment | null; declaration: LaunchContract; contract: ConfiguredLaunchContract; evidence: LaunchEvidence; controller: AbortController; deadline: number; watchdog?: NodeJS.Timeout; expired?: boolean; owner?: OwnedAgentProcess; work?: Promise<void>; cleanup?: Promise<void>; prompt: LivePrompt | null; conversation: Conversation; turns?: TurnCoordinator; cleanupVerified: boolean; started: boolean; ready: boolean; uncertain: AgentRecord | null; terminalAgent: { next: AgentRecord; expected: AgentRecord } | null; terminalAgentDurable: boolean; retired: boolean; result: CommandResult | null; fault: AgentFailure | null }

export type AgentServiceDependencies = {
  processFactory: typeof createAgentProcess
  observeLaunchEvidence(spec: LaunchSpec, expected: LaunchEvidence): Promise<void>
  fatalStartupTimeout(spec: LaunchSpec): never
  onOperationRetired?(agentId: string, commandId: string): void
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
  const recoveryRepairs = new Map<string, AgentRecoveryRepair>()
  let initialized = false, closed = false, frozen = false, accepting = 0, stopping = 0
  let assessment: AgentAssessment = { unavailable: new Map(), issues: [] }
  const runtimeIssues = new Map<string, AgentStateIssue>()
  let inventoryRevision = randomUUID(), inventoryFingerprint = ""
  const changed = (): void => { inventoryRevision = randomUUID() }
  const errorFor = (error: unknown): AgentError => error instanceof AgentError ? error : new AgentError("STARTUP_FAILED")
  const note = (agentId: string, kind: AgentStateIssue["kind"], id: string, path: string, error: unknown): void => {
    const next = { kind, id, path, message: String(error).slice(0, 512) }
    if (!isDeepStrictEqual(runtimeIssues.get(agentId), next)) changed()
    runtimeIssues.set(agentId, next)
  }
  const noteOperation = (op: Live, error: unknown): void => note(op.initial.definition.agentId, "agent", op.initial.definition.agentId, join(root, "launches", op.initial.launch.launchAttemptId + ".json"), error)
  const issueFor = (agentId: string): AgentStateIssue | null => assessment.unavailable.get(agentId) ?? runtimeIssues.get(agentId) ?? null
  const targetFailure = (issue: AgentStateIssue): AgentError => new AgentError(issue.path.startsWith(join(root, "launches") + "/") ? "CLEANUP_UNVERIFIED" : "INVALID_AGENT_STATE")
  const repairTargetsTuple = (repair: AgentRecoveryRepair, tuple: ReturnType<typeof agentTuple>): boolean => repair.kind === "command" ? !!repair.next.target && isDeepStrictEqual(repair.next.target, tuple) : isDeepStrictEqual(agentTuple(repair.next), tuple)
  function retire(op: Live): void {
    const agentId = op.initial.definition.agentId, tuple = agentTuple(op.initial)
    const related = [...commands.values()].filter(command => command.target && isDeepStrictEqual(command.target, tuple))
    const original = commands.get(op.accepted.commandId)
    const repairing = [...recoveryRepairs.values()].some(repair => repairTargetsTuple(repair, tuple))
    if (op.retired || !op.cleanupVerified || !op.terminalAgent || !op.terminalAgentDurable || op.prompt || dirtyAgents.has(agentId) || repairing) return
    if (!original || original.state !== "completed" || dirty.has(original.commandId)) return
    if (!related.length || related.some(command => command.state === "pending" || dirty.has(command.commandId))) return
    op.retired = true
    if (operations.get(agentId) === op) operations.delete(agentId)
    for (const [commandId, retained] of intents) if (retained === op) intents.delete(commandId)
    op.environment = null
    op.turns?.close(op.fault)
    op.conversation.close()
    op.owner?.dispose()
    delete op.owner
    delete op.work
    delete op.cleanup
    dependencies.onOperationRetired?.(agentId, op.initial.launch.commandId)
  }
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
    if (inventory.issues.some(issue => issue.path === join(root, "agents"))) throw new AgentError("UNAVAILABLE")
    const agentIds = new Set(inventory.agents.map(record => record.definition.agentId)), commandIds = new Set(inventory.commands.map(command => command.commandId))
    for (const agentId of records.keys()) if (!agentIds.has(agentId) && !dirtyAgents.has(agentId)) records.delete(agentId)
    for (const commandId of commands.keys()) if (!commandIds.has(commandId) && !dirty.has(commandId)) commands.delete(commandId)
    for (const record of inventory.agents) if (!dirtyAgents.has(record.definition.agentId)) records.set(record.definition.agentId, record)
    for (const command of inventory.commands) if (!dirty.has(command.commandId)) commands.set(command.commandId, command)
    const fingerprint = digest(JSON.stringify([inventory, context.state.launches, assessment.issues, [...assessment.unavailable], [...runtimeIssues]]))
    if (fingerprint !== inventoryFingerprint) { changed(); inventoryFingerprint = fingerprint }
    return inventory
  }
  async function publishCommand(next: AgentCommand, expected: AgentCommand | null): Promise<void> {
    dirty.add(next.commandId)
    try { await store.writeCommand(next, expected); dirty.delete(next.commandId); if (!isDeepStrictEqual(next, expected)) changed() }
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
    const op = intents.get(next.commandId)
    if (op) retire(op)
  }
  async function publishAgent(next: AgentRecord, expected: AgentRecord | null): Promise<void> {
    dirtyAgents.add(next.definition.agentId)
    try { await store.writeAgent(next, expected); dirtyAgents.delete(next.definition.agentId); if (!isDeepStrictEqual(next, expected)) changed() }
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
  async function publishTerminalAgent(op: Live, next: AgentRecord, expected: AgentRecord): Promise<void> {
    if (!op.terminalAgent) op.terminalAgent = { next: structuredClone(next), expected: structuredClone(expected) }
    else if (!isDeepStrictEqual(op.terminalAgent, { next, expected })) throw new AgentError("INVALID_AGENT_STATE")
    await publishAgent(op.terminalAgent.next, op.terminalAgent.expected)
    if (!isDeepStrictEqual(records.get(next.definition.agentId), next) || dirtyAgents.has(next.definition.agentId)) throw new AgentError("INCOMPLETE")
    if (!op.terminalAgentDurable) op.conversation.append({ kind: "lifecycle", phase: next.phase, failure: next.failure })
    op.terminalAgentDurable = true
    retire(op)
  }
  const view = (command: AgentCommand): CommandView => ({ state: "command", command: structuredClone(command), durability: dirty.has(command.commandId) || !!command.target && (dirtyAgents.has(command.target.agentId) || [...recoveryRepairs.values()].some(repair => repairTargetsTuple(repair, command.target!))) ? "unverified" : "verified" })
  async function retryRecovery(tuple: ReturnType<typeof agentTuple> | null, commandId: string): Promise<void> {
    for (const [key, repair] of recoveryRepairs) {
      if (repair.kind === "command" ? repair.next.commandId !== commandId && (!tuple || !repairTargetsTuple(repair, tuple)) : !tuple || !repairTargetsTuple(repair, tuple)) continue
      if (repair.kind === "launch") {
        await retainUnspawnedRestore(context, repair.expected)
        if (!context.mutations.accepted.some(entry => entry.record.launchAttemptId === repair.expected.launch.launchAttemptId && entry.record.phase === "cleanup_verified")) throw new AgentError("CLEANUP_UNVERIFIED")
        await publishAgent(repair.next, repair.expected)
      } else if (repair.kind === "agent") await publishAgent(repair.next, repair.expected)
      else await publishCommand(repair.next, repair.expected)
      recoveryRepairs.delete(key)
    }
    await verify()
    for (const op of new Set(intents.values())) retire(op)
  }
  async function validateLiveOperation(op: Live): Promise<void> {
    if (closed || op.controller.signal.aborted || op.fault) throw new AgentError("STARTUP_FAILED")
    if (context.state.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
    if (context.state.phase !== "ready") throw new AgentError("NOT_READY")
    await verify()
    if (assessment.unavailable.has(op.initial.definition.agentId) || runtimeIssues.has(op.initial.definition.agentId)) throw new AgentError("INVALID_AGENT_STATE")
    const observed = records.get(op.initial.definition.agentId)
    if (!observed || !isDeepStrictEqual(observed.definition, op.initial.definition) || !isDeepStrictEqual(observed.launch, op.initial.launch)) throw new AgentError("INVALID_AGENT_STATE")
  }
  async function revalidate(op: Live): Promise<void> {
    await validateLiveOperation(op)
    const spec = specOf(op.initial)
    if (performance.now() >= op.deadline) throw new AgentError("STARTUP_TIMEOUT")
    if (!isFresh(spec.catalogEvidence.verifiedAt, Date.now())) throw new AgentError("MODEL_UNAVAILABLE")
    await dependencies.observeLaunchEvidence(spec, op.evidence)
    const configured = await configureLaunchContract(op.declaration, op.evidence.profile, op.evidence.configuration)
    if (!isDeepStrictEqual(configured, op.contract) || await observeLaunchContract(configured, spec.configuration.fingerprint) !== spec.contractFingerprint) throw new AgentError("CONFIG_CHANGED")
    if (op.controller.signal.aborted || op.fault || closed) throw new AgentError("STARTUP_FAILED")
    if (performance.now() >= op.deadline) throw new AgentError("STARTUP_TIMEOUT")
  }
  async function finishStart(op: Live): Promise<void> {
    if (op.expired) return
    if (!op.result) return
    if (op.owner && op.result.outcome === "failed" && !op.cleanupVerified) return
    const command = commands.get(op.initial.launch.commandId)
    if (!command) return
    if (command.state === "pending") await publishCommand({ ...command, state: "completed", result: op.result }, command)
    retire(op)
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
      retire(op)
    }).catch(error => { delete op.cleanup; noteOperation(op, new AgentError("CLEANUP_UNVERIFIED")); throw error })
    return op.cleanup
  }
  async function failOperation(op: Live, error: unknown): Promise<void> {
    if (op.expired) return
    op.fault ??= agentFailure(errorFor(error)); op.controller.abort(); op.uncertain = null
    if (!op.ready) op.result = { outcome: "failed", target: agentTuple(op.initial), failure: op.fault, session: null }
    await queue.run(async () => {
      const record = records.get(op.initial.definition.agentId)
      if (record && ["starting", "ready"].includes(record.phase)) await publishTerminalAgent(op, { ...record, phase: "failed", failure: op.fault }, record)
    }).catch(error => noteOperation(op, error))
    await cleanup(op).catch(() => undefined)
    if (op.accepted.op === "restore" && op.cleanupVerified) await queue.run(async () => {
      const record = records.get(op.initial.definition.agentId)
      if (record?.phase === "restoring") await publishTerminalAgent(op, { ...record, phase: op.fault!.code === "SESSION_UNAVAILABLE" ? "failed" : "recoverable", failure: op.fault }, record)
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
    op.conversation.append({ kind: "lifecycle", phase: "ready", session: record.session })
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
        const environment = op.environment
        if (!environment) throw new AgentError("STARTUP_FAILED")
        try { op.owner = dependencies.processFactory({ context, spec, session: op.accepted.op === "restore" ? { kind: "load", sessionId: op.initial.session!.sessionId } : { kind: "new" }, environment, contract: op.contract, deadline: op.deadline, isReady: () => op.ready, onUpdate: event => { op.conversation.append({ kind: "update", ...event }) }, revalidate: () => revalidate(op) }) }
        finally { op.environment = null }
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
    if (op.terminalAgent && !op.terminalAgentDurable) await publishTerminalAgent(op, op.terminalAgent.next, op.terminalAgent.expected)
    await finishStart(op)
    retire(op)
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
        await retryRecovery(command.target, commandId)
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
      const declaration = parseLaunchContract(candidates[0])
      if (kind === "restore" && !declaration.sessionLoad) throw new AgentError("RESTORE_UNSUPPORTED")
      let evidence: LaunchEvidence
      try { evidence = await catalog.launchEvidence(selection.providerId) } catch { throw new AgentError("MODEL_UNAVAILABLE") }
      const contract = await configureLaunchContract(declaration, evidence.profile, evidence.configuration), fingerprint = await observeLaunchContract(contract, evidence.configuration.fingerprint)
      let timedOut = false, acceptingOperation: Live | undefined, timer: NodeJS.Timeout | undefined
      const commandDeadline = performance.now() + contract.deadlines.commandMs
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
        const spec = resolveLaunchSpec({ ids: { hostId: context.paths.hostKey, handlerGeneration: generation, agentId: previousAgent?.definition.agentId ?? randomUUID(), providerGeneration: randomUUID(), launchAttemptId: randomUUID(), commandId: request.commandId }, cwd, selection, snapshotId: evidence.snapshotId, provider: evidence.provider, configuration: evidence.configuration, contract })
        if (previousAgent) spec.createdCommandId = previousAgent.definition.createdCommandId
        if (await observeLaunchContract(contract, evidence.configuration.fingerprint) !== fingerprint) throw new AgentError("CONFIG_CHANGED")
        const record: AgentRecord = { version: 2, ...splitLaunchSpec(spec), phase: kind === "restore" ? "restoring" : "starting", session: previousAgent?.session ?? null, failure: null }
        const accepted: AgentCommand = { version: 2, hostId: spec.hostId, commandId: request.commandId, handlerGeneration: generation, op: kind, input: durableInput, target: agentTuple(record), state: "pending", result: null }
        const conversation = createConversation(agentTuple(record))
        conversation.append({ kind: "lifecycle", phase: record.phase, cwd: record.definition.cwd, selection: record.definition.selection, session: record.session })
        const op: Live = { initial: record, accepted, environment: request.environment, declaration, contract, evidence, controller: new AbortController(), deadline: performance.now() + contract.deadlines.overallMs, prompt: null, conversation, cleanupVerified: false, ready: false, started: false, uncertain: null, terminalAgent: null, terminalAgentDurable: false, retired: false, result: null, fault: null }
        op.turns = createTurnCoordinator({ target: agentTuple(record), conversation, queue, validate: async () => { await requireTarget(agentTuple(record)) }, invoke: (text, limits) => invoke(op, text, limits), cancel: () => op.owner!.cancelPrompt(), onSettled: () => retire(op) })
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
          const candidate = operations.get(request.agentId)
          if (!intents.has(prior.commandId) && candidate && isDeepStrictEqual(agentTuple(candidate.initial), prior.target)) intents.set(prior.commandId, candidate)
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
        const candidate = operations.get(request.agentId)
        if (candidate && isDeepStrictEqual(agentTuple(candidate.initial), accepted.target)) intents.set(request.commandId, candidate)
        scheduleStop(accepted)
        return view(accepted)
      })
    } finally { stopping-- }
  }
  async function requireTarget(request: AgentTuple): Promise<Live> {
      for (const value of [request.agentId, request.handlerGeneration, request.providerGeneration]) id(value)
      available()
      if (request.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
      const record = records.get(request.agentId)
      if (!record) throw new AgentError("UNAVAILABLE")
      if (issueFor(request.agentId)) throw new AgentError("INVALID_AGENT_STATE")
      if (record.launch.handlerGeneration !== request.handlerGeneration) throw new AgentError("STALE_HANDLER")
      if (record.launch.providerGeneration !== request.providerGeneration) throw new AgentError("STALE_PROVIDER")
      const op = operations.get(request.agentId)
      if (record.phase !== "ready" || !op?.ready || !op.owner || op.controller.signal.aborted || op.fault || op.cleanupVerified) throw new AgentError("NOT_READY")
      await validateLiveOperation(op)
      return op
  }
  function invoke(op: Live, text: string, limits: TurnOptions): Promise<TurnResult> {
      let pending!: Promise<TurnResult>
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      op.controller.signal.addEventListener("abort", abort, { once: true })
      if (op.controller.signal.aborted) controller.abort()
      pending = Promise.resolve().then(async () => {
        try {
          await queue.run(() => validateLiveOperation(op))
          if (controller.signal.aborted) throw new AgentError("STARTUP_FAILED")
          const result = await op.owner!.prompt(text, controller.signal, limits)
          await queue.run(() => validateLiveOperation(op))
          return result
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
    return pending
  }
  async function prompt(raw: PromptInput): Promise<PromptView> {
    const request = parsePromptInput(raw), op = await queue.run(() => requireTarget(request)), submissionId = randomUUID()
    await op.turns!.submit({ submissionId, text: request.text, limits: LEGACY_TURN_LIMITS })
    const result = await op.turns!.settled(submissionId)
    if (result.stopReason !== "end_turn" || !result.text.length) throw new AgentError("INCOMPLETE")
    return { state: "prompt", target: agentTuple(op.initial), stopReason: "end_turn", text: result.text }
  }
  function scheduleStop(command: AgentCommand): void {
    if (stops.has(command.commandId) || command.state !== "pending") return
    const retained = intents.get(command.commandId), candidate = retained ?? operations.get(command.target!.agentId)
    const op = candidate && isDeepStrictEqual(agentTuple(candidate.initial), command.target) ? candidate : undefined
    if (op) intents.set(command.commandId, op)
    const activePrompt = op?.prompt?.promise
    op?.controller.abort()
    const operation = (async () => {
      try {
        await activePrompt?.catch(() => undefined)
        await queue.run(async () => {
          if (closed) throw new AgentError("NOT_READY")
          if (op?.terminalAgent && !op.terminalAgentDurable) await publishTerminalAgent(op, op.terminalAgent.next, op.terminalAgent.expected)
          const record = records.get(command.target!.agentId)!
          if (!isDeepStrictEqual(agentTuple(record), command.target)) return
          if (["starting", "restoring", "ready"].includes(record.phase)) {
            await publishAgent({ ...record, phase: "stopping" }, record)
            op?.conversation.append({ kind: "lifecycle", phase: "stopping" })
          }
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
          if (matching && record.phase === "stopping") {
            const next = { ...record, phase: "stopped" as const }
            if (op) await publishTerminalAgent(op, next, record)
            else await publishAgent(next, record)
          }
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
    async choices() {
      available()
      const result: AgentChoices = { state: "choices", choices: [], unavailable: [] }
      for (const providerId of PROVIDERS) {
        const candidates = input.contracts.filter(c => c.providerId === providerId)
        if (candidates.length !== 1) { result.unavailable.push({ providerId, reason: new AgentError("ADAPTER_UNQUALIFIED").message }); continue }
        try {
          const evidence = await catalog.launchEvidence(providerId)
          const contract = await configureLaunchContract(candidates[0]!, evidence.profile, evidence.configuration)
          const choices = launchChoices(evidence, contract, context.paths.hostKey, generation)
          result.choices.push(...choices)
          if (!choices.length) result.unavailable.push({ providerId, reason: new AgentError("MODEL_UNAVAILABLE").message })
        } catch (error) {
          if (error instanceof AgentError && error.code === "INCOMPLETE") throw error
          result.unavailable.push({ providerId, reason: new AgentError(error instanceof AgentError ? error.code : "MODEL_UNAVAILABLE").message })
        }
      }
      if (Buffer.byteLength(JSON.stringify(result)) > QUERY_BYTES) throw new AgentError("INCOMPLETE")
      return result
    },
    async page(raw) {
      const options = parsePageInput(raw)
      return queue.run(async () => {
        const inventory = await verify()
        const legacy = inventory.legacyAgents.map(record => ({ record, launch: context.mutations.accepted.find(entry => entry.record.launchAttemptId === record.spec.launchAttemptId)?.record ?? null, live: false as const, cleanup: "unknown" as const }))
        const active = (record: AgentRecord): boolean => record.launch.handlerGeneration === generation && (record.phase === "ready" || ["starting", "restoring", "stopping"].includes(record.phase) && (!!operations.get(record.definition.agentId) || [...commands.values()].some(c => c.state === "pending" && c.target && isDeepStrictEqual(c.target, agentTuple(record)))))
        const agents = [...records.values()].filter(record => !options.activeOnly || active(record)).map(agentView)
        return inventoryPage({ revision: inventoryRevision, agents: options.activeOnly ? agents : [...agents, ...legacy], issues: [...assessment.issues, ...assessment.unavailable.values(), ...runtimeIssues.values()].filter((issue, index, all) => all.findIndex(other => isDeepStrictEqual(issue, other)) === index) }, options)
      })
    },
    observe(target, listener) { return queue.run(async () => (await requireTarget(target)).conversation.observe(listener)) },
    async submit(target, request) { const op = await queue.run(() => requireTarget(target)); return op.turns!.submit(request) },
    submission(target, submissionId) { id(submissionId); return queue.run(async () => (await requireTarget(target)).turns!.inspect(submissionId)) },
    async cancel(target, submissionId) { const op = await queue.run(() => requireTarget(target)); return op.turns!.cancel(submissionId) },
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
        for (const op of new Set(intents.values())) await finishStart(op)
        for (const command of commands.values()) if (dirty.has(command.commandId)) await publishCommand(command, command)
      })
      if (failures.length) throw new AgentError("INCOMPLETE")
    },
    resume() { if (!closed) frozen = false },
    async verifyDischarged() { await verify(); ordinary(); if (dirty.size || dirtyAgents.size || assessment.unavailable.size || runtimeIssues.size) throw new AgentError("INCOMPLETE") },
    close() { closed = true; frozen = true; for (const op of new Set([...operations.values(), ...intents.values()])) { clearTimeout(op.watchdog); op.prompt?.controller.abort(); op.owner?.dispose(); op.controller.abort(); op.turns?.close(op.fault); op.conversation.close() } },
  }
}