import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { observeConfig, readProfiles } from "../catalog/config.js"
import type { CatalogService } from "../catalog/service.js"
import { id, PROVIDERS, absolutePath, object, type ProviderId, type ProviderProfile, type ConfigEvidence } from "../catalog/types.js"
import { digest } from "../catalog/config.js"
import { inventoryPage, launchChoices, parsePageInput, QUERY_BYTES, type AgentChoices, type AgentPage, type PageInput } from "./queries.js"
import { ControlError } from "../control/protocol.js"
import { commitLaunchTransition, type LaunchContext } from "../handler/launch-transitions.js"
import { confirmReconciledLaunch, refreshLaunchState } from "../handler/mutations.js"
import { readLaunchRecordForReconciliation } from "../platform/private-state.js"
import { reconcileRecord } from "../platform/reconcile.js"
import { cleanupBudget, configureLaunchContract, observeLaunchContract, parseLaunchContract, type ConfiguredLaunchContract, type LaunchContract } from "./contracts.js"
import { createAgentProcess, type OwnedAgentProcess } from "./process.js"
import type { LaunchEnvironment } from "./environment.js"
import { agentTuple, crossCheckAgents, recoverAgents, retainUnspawnedRestore, type AgentAssessment, type AgentRecoveryRepair } from "./recovery.js"
import type { AgentInventory, AgentStateIssue, AgentStore } from "./store.js"
import { AGENT_LIMITS, AgentError, agentFailure, parseAgentRecordV3, parseAgentCommandV3, parsePromptInput, parseStartInput, parseStopInput, requestedSettingsDigest, startSelectionDigest, runtimeSpec as specOf, ownedRecord, type AgentCommand as AgentCommandV2, type AgentCommandV3, type OwnedAgentRecord, type AgentFailure, type AgentList, type AgentRecordV3 as AgentRecord, type AgentView, type CommandView, type CurrentAgents, type RuntimeLaunchSpec as LaunchSpec, type PromptInput, type PromptView, type StartInput, type StopInput, type NativeSessionIdentity } from "./types.js"
import { parseRestoreRequest, projectRestoreInput, type RestoreRequest } from "./types.js"
import { createConversation, type Conversation, type ConversationListener, type ConversationObservation } from "./conversation.js"
import { createTurnCoordinator, type AcpSubmissionRequest, type SubmissionReceipt, type SubmissionRequest, type TurnCoordinator } from "./turns.js"
import { LEGACY_TURN_LIMITS, type AcpObservation, type TurnOptions, type TurnResult } from "./session-events.js"
import type { AgentTuple } from "./types.js"
import type { RetentionPins } from "../retention/policy.js"
import type { RemovalEvidence, RetirementView } from "../retention/store.js"
import { backendFingerprint, readBackendConfig, mergeBackendEnvironment, type Backend } from "./backend-config.js"
import { canonicalJson, parseRequestedSettings, projectRestorableSettings, nonRestorableOptionIds, type RequestedSettings, type JsonObject, type SessionConfiguration } from "./session-config.js"
import { withNativeSession, withoutAgencyMetadata, type ProviderSession } from "./acp.js"
import { launchEnvironmentDigest, parseLaunchEnvironment } from "./environment.js"
import { createPermissionBroker, type PermissionClient } from "../acp/permissions.js"
import { parseImportInput, type ImportInput } from "./types.js"
import { backendSelection } from "./backend-selection.js"
type AgentCommand = AgentCommandV2 | AgentCommandV3
type CommandResult = { outcome: "started" | "restored" | "stopped" | "failed" | "interrupted"; target: AgentTuple | null; failure: AgentFailure | null; session: NativeSessionIdentity | null }
export type CreateSessionInput = { commandId: string; cwd: string; backendId?: ProviderId; selection?: RequestedSettings; environment: LaunchEnvironment; nativeParams: JsonObject }
type BackendEvidence = { profile: ProviderProfile; configuration: ConfigEvidence; backend: Backend }

export function sessionInputs(cwd: string, raw: JsonObject | undefined, required: string[] = []): { params: JsonObject; names: string[] } {
  const params = withoutAgencyMetadata({ cwd, mcpServers: [], ...raw })
  if (params.cwd !== cwd || !Array.isArray(params.mcpServers)) throw new AgentError("SESSION_INPUT_REQUIRED")
  const names = params.mcpServers.map(value => {
    if (!value || Array.isArray(value) || typeof value !== "object" || typeof value.name !== "string" || !value.name.trim()) throw new AgentError("SESSION_INPUT_REQUIRED")
    const strings = (values: unknown): boolean => Array.isArray(values) && values.every(value => typeof value === "string")
    const pairs = (values: unknown): boolean => Array.isArray(values) && values.every(value => value && typeof value === "object" && !Array.isArray(value) && typeof value.name === "string" && typeof value.value === "string")
    if (value.type === "http" || value.type === "sse") {
      if (typeof value.url !== "string" || !URL.canParse(value.url) || !["http:", "https:"].includes(new URL(value.url).protocol) || !pairs(value.headers)) throw new AgentError("SESSION_INPUT_REQUIRED")
    } else if (value.type !== undefined || typeof value.command !== "string" || !value.command.trim() || !strings(value.args) || !pairs(value.env)) throw new AgentError("SESSION_INPUT_REQUIRED")
    return value.name
  })
  if (names.length > 128 || new Set(names).size !== names.length || required.some(name => !names.includes(name))) throw new AgentError("SESSION_INPUT_REQUIRED")
  return { params, names: names.sort() }
}

export type AcpSessionObservation = ConversationObservation & { native: ProviderSession; backendId: ProviderId }
export type AgentService = {
  importSession(input: ImportInput): Promise<CommandView>
  readonly handlerGeneration: string
  backendChoices(): Promise<JsonObject>
  acpCapabilities(): Promise<JsonObject>
  sessionRecord(agentId: string): Promise<AgentView | null>
  attachPermissions(target: AgentTuple, client: PermissionClient): Promise<void>
  permissionDecision(connectionId: string, requestId: string | number, result: JsonObject): Promise<boolean>
  detachPermissions(connectionId: string, target?: AgentTuple): void
  observeSession(target: AgentTuple, listener: ConversationListener, configuration: (snapshot: SessionConfiguration) => void): Promise<AcpSessionObservation>
  createSession(input: CreateSessionInput): Promise<AgentRecord>; sessionSnapshot(target: AgentTuple): Promise<SessionConfiguration>; nativeSession(target: AgentTuple): Promise<ProviderSession>; setSession(target: AgentTuple, method: string, params: JsonObject): Promise<JsonObject>; submitAcp(target: AgentTuple, request: AcpSubmissionRequest): Promise<SubmissionReceipt>; settledAcp(target: AgentTuple, submissionId: string): Promise<JsonObject>; retentionPins(): RetentionPins; forgetRemoved(entry: RemovalEvidence): void; initialize(): Promise<void>; start(input: StartInput): Promise<CommandView>; restore(input: RestoreRequest): Promise<CommandView>; stop(input: StopInput): Promise<CommandView>; prompt(input: PromptInput): Promise<PromptView>; observe(target: AgentTuple, listener: ConversationListener): Promise<ConversationObservation>; submit(target: AgentTuple, request: SubmissionRequest): Promise<SubmissionReceipt>; submission(target: AgentTuple, submissionId: string): Promise<SubmissionReceipt | null>; cancel(target: AgentTuple, submissionId: string): Promise<SubmissionReceipt>; command(commandId: string, generation: string): Promise<CommandView>; choices(): Promise<AgentChoices>; page(input: PageInput): Promise<AgentPage>; current(cwd: string): Promise<CurrentAgents>; list(): Promise<AgentList>; assertOrdinaryShutdownSafe(): void; freezeAndDrain(stopAgents: boolean): Promise<void>; resume(): void; verifyDischarged(): Promise<void>; close(): void
}
type LivePrompt = { controller: AbortController; promise: Promise<TurnResult | JsonObject> }
type Live = { initial: OwnedAgentRecord; accepted: AgentCommandV3; environment: LaunchEnvironment | null; nativeParams: JsonObject; providerSession?: ProviderSession; declaration: LaunchContract; contract: ConfiguredLaunchContract; evidence: BackendEvidence; controller: AbortController; deadline: number; watchdog?: NodeJS.Timeout; expired?: boolean; owner?: OwnedAgentProcess; work?: Promise<void>; cleanup?: Promise<void>; prompt: LivePrompt | null; conversation: Conversation; turns?: TurnCoordinator; cleanupVerified: boolean; started: boolean; ready: boolean; uncertain: AgentRecord | null; terminalAgent: { next: AgentRecord; expected: AgentRecord } | null; terminalAgentDurable: boolean; retired: boolean; result: CommandResult | null; fault: AgentFailure | null }

export type AgentServiceDependencies = {
  processFactory: typeof createAgentProcess
  observeLaunchEvidence(spec: LaunchSpec, expected: BackendEvidence): Promise<void>
  fatalStartupTimeout(spec: LaunchSpec): never
  onOperationRetired?(agentId: string, commandId: string): void
}

function productionDependencies(root: string): AgentServiceDependencies {
  const handlerPid = process.pid
  return {
    processFactory: createAgentProcess,
    async observeLaunchEvidence(spec, expected) {
      const backend = (await readBackendConfig(root)).backends.find(value => value.id === spec.backendId)
      const profile = (await readProfiles(root)).find(value => value.id === spec.backendId)
      if (!backend || !isDeepStrictEqual(backend, expected.backend)
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

export function createAgentService(input: { context: LaunchContext; catalog: CatalogService; contracts: readonly LaunchContract[]; store: AgentStore; retirement?: RetirementView; onTerminal?: () => void; cleanupIssues?: () => readonly string[] }, dependencies: AgentServiceDependencies = productionDependencies(input.context.paths.persistentRoot)): AgentService {
  const { context, store, catalog } = input, { queue } = context.mutations, root = context.paths.persistentRoot, generation = context.state.handlerGeneration
  const commands = new Map<string, AgentCommand>(), records = new Map<string, AgentRecord>(), operations = new Map<string, Live>(), intents = new Map<string, Live>()
  const importIntents = new Map<string, AgentCommandV3>()
  const dirty = new Set<string>(), dirtyAgents = new Set<string>(), stops = new Map<string, Promise<void>>()
  const permissions = createPermissionBroker({ respond(target, requestId, result) {
    const op = operations.get(target.agentId)
    if (!op?.owner || op.controller.signal.aborted || !isDeepStrictEqual(agentTuple(op.initial), target)) throw new AgentError("STALE_ATTACHMENT")
    op.owner.respond(requestId, result)
  } })
  const recoveryRepairs = new Map<string, AgentRecoveryRepair>()
  const configuring = new Set<string>()
  const echoes = new Map<Live, { blocks: JsonObject[]; index: number; offset: number; held: AcpObservation[]; bytes: number }>()
  const displayUpdates = (op: Live, event: AcpObservation): AcpObservation[] => {
    const echo = echoes.get(op), actual = event.update.content as JsonObject, expected = echo?.blocks[echo.index]
    if (!echo) return [event]
    const flush = (): AcpObservation[] => { echoes.delete(op); return [...echo.held, event] }
    if (event.replay || !op.ready || event.update.sessionUpdate !== "user_message_chunk") return echo.held.length ? flush() : [event]
    if (!expected) return flush()
    if (expected.type === "text" && actual.type === "text" && typeof expected.text === "string" && typeof actual.text === "string") {
      const suffix = expected.text.slice(echo.offset)
      const { text: _expectedText, ...expectedFields } = expected, { text: _actualText, ...actualFields } = actual
      if (!actual.text.length || !suffix.startsWith(actual.text) || canonicalJson(expectedFields) !== canonicalJson(actualFields)) return flush()
      echo.offset += actual.text.length
      echo.held.push(event); echo.bytes += Buffer.byteLength(JSON.stringify(event))
      if (echo.offset === expected.text.length) { echo.index++; echo.offset = 0; echo.held = []; echo.bytes = 0 }
      else if (echo.held.length >= 8192 || echo.bytes >= 4194304) { echoes.delete(op); return echo.held }
      return []
    }
    if (canonicalJson(expected) !== canonicalJson(actual)) return flush()
    echo.index++; return []
  }
  const configurationListeners = new Map<Live, Set<(snapshot: SessionConfiguration) => void>>()
  const publishConfiguration = (op: Live): void => {
    for (const listener of configurationListeners.get(op) ?? []) {
      try { listener(op.owner!.snapshot()) } catch {}
    }
  }
  let initialized = false, closed = false, frozen = false, accepting = 0, stopping = 0
  let assessment: AgentAssessment = { unavailable: new Map(), issues: [], configurationPending: new Map() }
  const runtimeIssues = new Map<string, AgentStateIssue>()
  let inventoryRevision = randomUUID(), inventoryFingerprint = ""
  const changed = (): void => { inventoryRevision = randomUUID() }
  const cleanupDiagnostics = (): AgentStateIssue[] => (input.cleanupIssues?.() ?? []).map(message => ({ kind: "unknown", id: null, path: join(root, "retention/pending.json"), message }))
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
    input.onTerminal?.()
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
    for (const agentId of records.keys()) if (!agentIds.has(agentId) && !dirtyAgents.has(agentId) && !input.retirement?.hides("agents/records/" + agentId + ".json")) records.delete(agentId)
    for (const commandId of commands.keys()) if (!commandIds.has(commandId) && !dirty.has(commandId) && !input.retirement?.hides("agents/commands/" + commandId + ".json")) commands.delete(commandId)
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
    if (next.state !== "pending") input.onTerminal?.()
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
  const view = (command: AgentCommand): CommandView => ({ state: "command", command: structuredClone(command), durability: dirty.has(command.commandId) || command.version === 3 && dirtyAgents.has(command.agentId) || !!command.target && (dirtyAgents.has(command.target.agentId) || [...recoveryRepairs.values()].some(repair => repairTargetsTuple(repair, command.target!))) ? "unverified" : "verified" })
  async function retryRecovery(tuple: ReturnType<typeof agentTuple> | null, commandId: string): Promise<void> {
    let repaired = false
    for (const [key, repair] of recoveryRepairs) {
      if (repair.kind === "command" ? repair.next.commandId !== commandId && (!tuple || !repairTargetsTuple(repair, tuple)) : !tuple || !repairTargetsTuple(repair, tuple)) continue
      if (repair.kind === "launch") {
        await retainUnspawnedRestore(context, repair.expected)
        if (!context.mutations.accepted.some(entry => entry.record.launchAttemptId === repair.expected.launch!.launchAttemptId && entry.record.phase === "cleanup_verified")) throw new AgentError("CLEANUP_UNVERIFIED")
        await publishAgent(repair.next, repair.expected)
      } else if (repair.kind === "agent") await publishAgent(repair.next, repair.expected)
      else await publishCommand(repair.next, repair.expected)
      recoveryRepairs.delete(key)
      repaired = true
    }
    await verify()
    for (const op of new Set(intents.values())) retire(op)
    if (repaired) input.onTerminal?.()
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
    await dependencies.observeLaunchEvidence(spec, op.evidence)
    const configured = await configureLaunchContract(op.declaration, op.evidence.profile, op.evidence.configuration)
    if (!isDeepStrictEqual(configured, op.contract) || backendFingerprint(op.evidence.backend, configured) !== spec.backendFingerprint) throw new AgentError("CONFIG_CHANGED")
    if (op.controller.signal.aborted || op.fault || closed) throw new AgentError("STARTUP_FAILED")
    if (performance.now() >= op.deadline) throw new AgentError("STARTUP_TIMEOUT")
  }
  async function finishStart(op: Live): Promise<void> {
    if (op.expired) return
    if (!op.result) return
    if (op.owner && op.result.outcome === "failed" && !op.cleanupVerified) return
    const command = commands.get(op.initial.launch.commandId)
    if (!command) return
    if (command.state === "pending" && command.version === 3) await publishCommand({ ...command, state: "completed", result: op.result }, command)
    retire(op)
  }
  function cleanup(op: Live): Promise<void> {
    permissions.invalidate(agentTuple(op.initial))
    if (op.cleanup) return op.cleanup
    const checkCleanup = (): void => { if (op.expired || !op.ready && performance.now() >= op.deadline + cleanupBudget(op.contract)) throw new AgentError("CLEANUP_UNVERIFIED") }
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
    permissions.invalidate(agentTuple(op.initial))
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
    void new Promise<void>(resolve => { op.watchdog = setTimeout(resolve, Math.max(1, op.deadline + cleanupBudget(op.contract) - performance.now())) }).then(() => {
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
        try { op.owner = dependencies.processFactory({ context, spec, agentRecord: op.initial, args: op.evidence.backend.args, session: op.accepted.op === "restore" ? { kind: "load", sessionId: op.initial.session!.sessionId, params: op.nativeParams } : { kind: "new", params: op.nativeParams }, environment, contract: op.contract, deadline: op.deadline, isReady: () => op.ready, onUpdate: event => { for (const value of displayUpdates(op, event)) retainUpdate(op, value) }, onRequest: message => { void queue.run(async () => {
          await requireTarget(agentTuple(op.initial))
          if (!op.turns?.busy()) throw new AgentError("INVALID_PROTOCOL")
          permissions.open(agentTuple(op.initial), message.id as string | number, message.params as JsonObject)
        }).catch(error => { void failOperation(op, error).catch(error => noteOperation(op, error)) }) }, revalidate: () => revalidate(op) }) }
        finally { op.environment = null }
        void op.owner.fault.then(failure => { if (!closed && !op.controller.signal.aborted) void failOperation(op, new AgentError(failure.code)).catch(error => noteOperation(op, error)) })
        if (op.controller.signal.aborted) throw new AgentError("STARTUP_FAILED")
        const session = await op.owner.initialize(op.controller.signal)
        op.providerSession = session
        op.nativeParams = {}
        await queue.run(async () => {
          await revalidate(op)
          const record = op.owner!.record()
          await commitLaunchTransition(context, record, { ...record, phase: "active" })
          const settings = projectRestorableSettings(session.configuration), missing = nonRestorableOptionIds(session.configuration)
          if (op.accepted.op === "restore") verifyLoadedConfiguration(op, session)
          await ready(op, { ...op.initial, phase: "ready", session: { sessionId: session.sessionId, protocolVersion: 1 }, settings, configurationState: { verification: { kind: "verified" }, nonRestorableOptionIds: missing } })
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
      const command = commands.get(commandId) ?? intents.get(commandId)?.accepted
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
        return { ...view(commands.get(commandId) ?? command), durability: "unverified" }
      }
      return view(commands.get(commandId)!)
    })
  }
  async function acceptLaunch(raw: StartInput | RestoreRequest | CreateSessionInput, kind: "start" | "restore"): Promise<CommandView> {
    const native = kind === "start" && !("handlerGeneration" in raw)
    const request = native ? { ...raw, commandId: id(raw.commandId), handlerGeneration: generation, environment: parseLaunchEnvironment(raw.environment) } : kind === "start" ? parseStartInput(raw) : parseRestoreRequest(raw)
    accepting++
    try {
      await queue.run(async () => { await verify(); available() })
      if (request.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
      const previousAgent = kind === "restore" ? records.get((request as RestoreRequest).agentId) : undefined
      const checkRestorable = (): void => {
        if (kind !== "restore") return
        const issue = issueFor((request as RestoreRequest).agentId)
        if (issue) throw targetFailure(issue)
        if (!previousAgent || !previousAgent.session || !["stopped", "recoverable"].includes(previousAgent.phase) || !isDeepStrictEqual(records.get(previousAgent.definition.agentId), previousAgent)) throw new AgentError("NOT_READY")
        if (previousAgent.launch && !context.mutations.accepted.some(entry => entry.record.launchAttemptId === previousAgent.launch!.launchAttemptId && entry.record.phase === "cleanup_verified")) throw new AgentError("CLEANUP_UNVERIFIED")
      }
      const existing = commands.get(request.commandId) ?? intents.get(request.commandId)?.accepted
      if (!existing) checkRestorable()
      const config = await readBackendConfig(root)
      const backendId = previousAgent?.definition.backendId ?? (native ? (raw as CreateSessionInput).backendId ?? config.defaultBackendId : (raw as StartInput).selection.providerId)
      const backend = config.backends.find(value => value.id === backendId), profile = (await readProfiles(root)).find(value => value.id === backendId && value.enabled)
      const candidates = input.contracts.filter(value => value.providerId === backendId && value.id === backend?.compatibilityId)
      if (!backend || !profile) throw new AgentError("UNAVAILABLE")
      if (candidates.length !== 1) throw new AgentError("ADAPTER_UNQUALIFIED")
      const declaration = parseLaunchContract(candidates[0])
      if (kind === "restore" && !declaration.sessionLoad) throw new AgentError("RESTORE_UNSUPPORTED")
      const configuration = await observeConfig(profile), evidence: BackendEvidence = { profile, configuration, backend }
      const contract = await configureLaunchContract(declaration, profile, configuration)
      const cwd = absolutePath(previousAgent?.definition.cwd ?? (raw as CreateSessionInput | StartInput).cwd)
      const selected = native ? parseRequestedSettings((raw as CreateSessionInput).selection ?? {}) : kind === "start" ? {
        modelId: (raw as StartInput).selection.modelId,
        ...((raw as StartInput).selection.mode ? { modeId: (raw as StartInput).selection.mode! } : {}),
        ...((raw as StartInput).selection.reasoning.kind === "value" && declaration.reasoningOption ? { configValues: { [declaration.reasoningOption]: ((raw as StartInput).selection.reasoning as { kind: "value"; value: string }).value } } : {})
      } : {}
      const merged = parseRequestedSettings({ ...backend.initial, ...selected, ...((backend.initial.configValues || selected.configValues) ? { configValues: { ...backend.initial.configValues, ...selected.configValues } } : {}) })
      for (const [field, option] of [["modelId", declaration.modelOption], ["modeId", declaration.modeOption]] as const) {
        if (!option) continue
        if (selected.configValues?.[option] !== undefined && selected[field] === undefined) delete merged[field]
        if (selected[field] !== undefined && selected.configValues?.[option] === undefined && merged.configValues) delete merged.configValues[option]
      }
      const settings = previousAgent?.settings ?? merged
      const { params, names } = sessionInputs(cwd, "nativeParams" in raw ? raw.nativeParams : undefined, previousAgent?.inputRequirements.mcpServerNames)
      const selectionDigest = kind === "start" ? native ? requestedSettingsDigest(settings) : startSelectionDigest((raw as StartInput).selection) : null
      const durableInput: JsonObject = kind === "start" ? { cwd, backendId, selectionDigest, environmentDigest: launchEnvironmentDigest(request.environment), mcpServerNames: names } : { agentId: (request as RestoreRequest).agentId, environmentDigest: launchEnvironmentDigest(request.environment), mcpServerNames: names }
      if (existing) {
        if (existing.op !== kind || existing.version !== 3 || !isDeepStrictEqual(existing.input, durableInput)) throw new AgentError("COMMAND_CONFLICT")
        return command(request.commandId, request.handlerGeneration)
      }
      let timedOut = false, acceptingOperation: Live | undefined, timer: NodeJS.Timeout | undefined
      const commandDeadline = performance.now() + contract.deadlines.commandMs
      const checkCommandDeadline = (): void => {
        if (timedOut || performance.now() >= commandDeadline) { timedOut = true; acceptingOperation?.controller.abort(); throw new AgentError("STARTUP_TIMEOUT") }
      }
      const acceptance = queue.run(async () => {
        checkCommandDeadline()
        await verify(); available()
        const previous = commands.get(request.commandId) ?? intents.get(request.commandId)?.accepted
        if (previous) {
          if (previous.op !== kind || !isDeepStrictEqual(previous.input, durableInput)) throw new AgentError("COMMAND_CONFLICT")
          const retained = intents.get(request.commandId)
          if (retained) await repair(retained)
          return view(commands.get(request.commandId) ?? previous)
        }
        checkRestorable()
        const agentId = previousAgent?.definition.agentId ?? randomUUID()
        const record = ownedRecord(parseAgentRecordV3({
          version: 3, definition: previousAgent?.definition ?? { hostId: context.paths.hostKey, agentId, createdCommandId: request.commandId, cwd, backendId, origin: "new" },
          launch: { handlerGeneration: generation, providerGeneration: randomUUID(), launchAttemptId: randomUUID(), commandId: request.commandId, configuration, backendFingerprint: backendFingerprint(backend, contract), compatibilityId: declaration.id, containment: "direct-process-group-v1", authority: "normal-user", limits: AGENT_LIMITS },
          phase: kind === "restore" ? "restoring" : "starting", session: previousAgent?.session ?? null, failure: null,
          settings, inputRequirements: { mcpServerNames: names }, configurationState: previousAgent?.configurationState ?? { verification: { kind: "unknown" }, nonRestorableOptionIds: [] }
        }))
        if (previousAgent && (assessment.configurationPending.get(agentId)?.length ?? 0) > 0 && record.configurationState.verification.kind === "verified") record.configurationState.verification = { kind: "unknown" }
        const accepted = parseAgentCommandV3({ version: 3, hostId: context.paths.hostKey, commandId: request.commandId, handlerGeneration: generation, op: kind, input: durableInput, agentId, target: agentTuple(record), state: "pending", result: null })
        const conversation = createConversation(agentTuple(record))
        conversation.append({ kind: "lifecycle", phase: record.phase, cwd, session: record.session })
        const op: Live = { initial: record, accepted, environment: mergeBackendEnvironment(request.environment, backend.environmentDefaults), nativeParams: params, declaration, contract, evidence, controller: new AbortController(), deadline: performance.now() + AGENT_LIMITS.startupMs, prompt: null, conversation, cleanupVerified: false, ready: false, started: false, uncertain: null, terminalAgent: null, terminalAgentDurable: false, retired: false, result: null, fault: null }
        op.turns = createTurnCoordinator({ target: agentTuple(record), conversation, queue, validate: async () => { await requireTarget(agentTuple(record)); assertConfigurationReady(op) }, invoke: (text, limits) => invoke(op, text, limits), invokeAcp: params => invokeAcp(op, params), cancel: () => { permissions.invalidate(agentTuple(op.initial)); return op.owner!.cancelPrompt() }, onSettled: () => { permissions.invalidate(agentTuple(op.initial)); retire(op) } })
        checkCommandDeadline(); acceptingOperation = op
        operations.set(agentId, op); intents.set(request.commandId, op)
        const durableRecord = previousAgent ? record : parseAgentRecordV3({ ...record, settings: {} })
        try { await publishCommand(accepted, null); checkCommandDeadline(); await publishAgent(durableRecord, previousAgent ?? null) }
        catch (error) { if (error instanceof AgentError && error.code === "STARTUP_TIMEOUT") throw error; throw new AgentError("INCOMPLETE") }
        checkCommandDeadline(); launch(op); return view(accepted)
      })
      try {
        return await Promise.race([acceptance, new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; acceptingOperation?.controller.abort(); reject(new AgentError("STARTUP_TIMEOUT")) }, Math.max(1, commandDeadline - performance.now())) })])
      } finally { clearTimeout(timer) }
    } finally { accepting-- }
  }
  const start = (request: StartInput): Promise<CommandView> => acceptLaunch(request, "start")
  const restore = (request: RestoreRequest): Promise<CommandView> => acceptLaunch(request, "restore")
  async function importSession(raw: ImportInput): Promise<CommandView> {
    const request = parseImportInput(raw), selection = { backendId: request.backendId, nativeSessionId: request.nativeSessionId, cwd: request.cwd }
    return queue.run(async () => {
      await verify(); available()
      if (request.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
      if (request.backendId !== "codex-acp") throw new AgentError("UNSUPPORTED_SESSION_FEATURE")
      const finish = async (command: AgentCommandV3): Promise<CommandView> => {
        const visible = await store.readCommand(command.commandId)
        if (!visible || dirty.has(command.commandId)) await publishCommand(command, visible)
        let record = records.get(command.agentId)
        if (!record) {
          record = parseAgentRecordV3({ version: 3, definition: { hostId: context.paths.hostKey, agentId: command.agentId, createdCommandId: command.commandId, cwd: command.input.cwd, backendId: command.input.backendId, origin: "import" }, launch: null, phase: "stopped", session: { sessionId: command.input.nativeSessionId, protocolVersion: 1 }, inputRequirements: { mcpServerNames: [] }, settings: {}, configurationState: { verification: { kind: "unknown" }, nonRestorableOptionIds: [] }, failure: null })
          await publishAgent(record, null)
        } else if (dirtyAgents.has(command.agentId)) await publishAgent(record, record)
        if (record.definition.hostId !== command.hostId || record.definition.cwd !== command.input.cwd || record.definition.backendId !== command.input.backendId || record.session?.sessionId !== command.input.nativeSessionId) throw new AgentError("COMMAND_CONFLICT")
        const current = commands.get(command.commandId) ?? command
        if (current.state === "pending") await publishCommand({ ...command, state: "completed", result: { outcome: "imported", target: null, failure: null, session: record.session } }, current)
        importIntents.delete(command.commandId)
        return view(commands.get(command.commandId)!)
      }
      const previous = commands.get(request.commandId) ?? importIntents.get(request.commandId)
      if (previous) {
        if (previous.version !== 3 || previous.op !== "import" || previous.hostId !== context.paths.hostKey || !isDeepStrictEqual(previous.input, selection)) throw new AgentError("COMMAND_CONFLICT")
        return finish(previous)
      }
      const config = await readBackendConfig(root), profiles = await readProfiles(root)
      const backend = config.backends.find(value => value.id === request.backendId)
      if (!backend || !profiles.some(value => value.enabled && value.id === request.backendId) || !input.contracts.some(value => value.providerId === request.backendId && value.id === backend.compatibilityId && value.sessionLoad)) throw new AgentError("UNAVAILABLE")
      for (const command of [...commands.values(), ...importIntents.values()]) if (command.version === 3 && command.op === "import" && command.hostId === context.paths.hostKey && command.input.backendId === request.backendId && command.input.nativeSessionId === request.nativeSessionId && command.state === "pending") {
        if (command.input.cwd !== request.cwd) throw new AgentError("COMMAND_CONFLICT")
        await finish(command)
      }
      const matching = [...records.values()].filter(record => record.definition.hostId === context.paths.hostKey && record.definition.backendId === request.backendId && record.session?.sessionId === request.nativeSessionId)
      if (matching.length > 1 || matching.some(record => record.definition.cwd !== request.cwd)) throw new AgentError("COMMAND_CONFLICT")
      const record = matching[0]
      if (record && issueFor(record.definition.agentId)) throw targetFailure(issueFor(record.definition.agentId)!)
      const command = parseAgentCommandV3({ version: 3, hostId: context.paths.hostKey, commandId: request.commandId, handlerGeneration: generation, op: "import", input: selection, agentId: record?.definition.agentId ?? randomUUID(), target: null, state: "pending", result: null })
      importIntents.set(command.commandId, command)
      return finish(command)
    })
  }
  async function stop(raw: StopInput): Promise<CommandView> {
    const request = parseStopInput(raw)
    stopping++
    try {
      return await queue.run(async () => {
        await verify()
        const prior = commands.get(request.commandId)
        if (prior) {
          if (prior.op !== "stop" || !isDeepStrictEqual(prior.input, prior.version === 3 ? { target: { agentId: request.agentId, handlerGeneration: request.handlerGeneration, providerGeneration: request.providerGeneration } } : request)) throw new AgentError("COMMAND_CONFLICT")
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
        if (!record.launch) throw new AgentError("NOT_READY")
        if (record.launch.handlerGeneration !== request.handlerGeneration) throw new AgentError("STALE_HANDLER")
        if (record.launch.providerGeneration !== request.providerGeneration) throw new AgentError("STALE_PROVIDER")
        const accepted = parseAgentCommandV3({ version: 3, hostId: context.paths.hostKey, commandId: request.commandId, handlerGeneration: generation, input: { target: agentTuple(record) }, op: "stop", agentId: request.agentId, target: agentTuple(record), state: "pending", result: null })
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
      if (!record.launch) throw new AgentError("NOT_READY")
      if (record.launch.handlerGeneration !== request.handlerGeneration) throw new AgentError("STALE_HANDLER")
      if (record.launch.providerGeneration !== request.providerGeneration) throw new AgentError("STALE_PROVIDER")
      const op = operations.get(request.agentId)
      if (record.phase !== "ready" || !op?.ready || !op.owner || op.controller.signal.aborted || op.fault || op.cleanupVerified) throw new AgentError("NOT_READY")
      await validateLiveOperation(op)
      return op
  }
  function invoke(op: Live, text: string, limits: TurnOptions): Promise<TurnResult> {
    return invokeProvider(op, (owner, signal) => owner.prompt(text, signal, limits))
  }
  function assertConfigurationReady(op: Live): void {
    const agentId = op.initial.definition.agentId
    if (configuring.has(agentId)) throw new AgentError("BUSY")
    if (records.get(agentId)?.configurationState.verification.kind !== "verified" || (assessment.configurationPending.get(agentId)?.length ?? 0) > 0 || dirtyAgents.has(agentId)) throw new AgentError("NOT_READY")
  }
  function verifyLoadedConfiguration(op: Live, session: ProviderSession): void {
    const settings = projectRestorableSettings(session.configuration), saved = op.initial.settings
    const required = new Set(op.initial.configurationState.nonRestorableOptionIds)
    for (const commandId of assessment.configurationPending.get(op.initial.definition.agentId) ?? []) {
      const command = commands.get(commandId)
      if (command?.version !== 3 || command.op !== "configure") continue
      for (const optionId of command.input.priorNonRestorableOptionIds as string[]) required.add(optionId)
      const desired = command.input.desired as RequestedSettings
      for (const optionId of command.input.optionIds as string[]) {
        if (optionId === "model" && desired.modelId && settings.modelId) continue
        if (optionId === "mode" && desired.modeId && settings.modeId) continue
        if (settings.configValues?.[optionId] === undefined && !(Object.hasOwn(session.result, "configOptions") && !session.configuration.configOptions.some(option => option.id === optionId))) throw new AgentError("SESSION_INPUT_REQUIRED")
      }
    }
    if (saved.modelId && !settings.modelId && !settings.configValues?.[op.contract.modelOption] || saved.modeId && !settings.modeId && (!op.contract.modeOption || !settings.configValues?.[op.contract.modeOption])) throw new AgentError("SESSION_INPUT_REQUIRED")
    if (Object.keys(saved.configValues ?? {}).some(optionId => settings.configValues?.[optionId] === undefined)) throw new AgentError("SESSION_INPUT_REQUIRED")
    if (required.size && (!Object.hasOwn(session.result, "configOptions") || [...required].some(optionId => session.configuration.configOptions.some(option => option.id === optionId) && settings.configValues?.[optionId] === undefined))) throw new AgentError("SESSION_INPUT_REQUIRED")
  }
  async function setSession(target: AgentTuple, method: string, raw: JsonObject): Promise<JsonObject> {
    const params = withoutAgencyMetadata(raw)
    const admitted = await queue.run(async () => {
      const op = await requireTarget(target)
      assertConfigurationReady(op)
      if (op.turns!.busy()) throw new AgentError("BUSY")
      const record = records.get(target.agentId)!, snapshot = op.owner!.snapshot(), desired = structuredClone(record.settings)
      let optionId: string, transient = false
      if (method === "session/set_model" || method === "session/set_mode") {
        const model = method === "session/set_model", value = params[model ? "modelId" : "modeId"], state = model ? snapshot.models : snapshot.modes
        const available = state?.[model ? "availableModels" : "availableModes"]
        if (typeof value !== "string" || !Array.isArray(available) || !available.some(entry => object(entry)[model ? "modelId" : "id"] === value)) throw new AgentError("SELECTION_UNSUPPORTED")
        optionId = model ? "model" : "mode"
        if (model) desired.modelId = value; else desired.modeId = value
      } else if (method === "session/set_config_option") {
        if (typeof params.configId !== "string" || !Object.hasOwn(params, "value")) throw new AgentError("INVALID_PROTOCOL")
        optionId = params.configId
        const option = snapshot.configOptions.find(value => value.id === optionId)
        if (!option) throw new AgentError("SELECTION_UNSUPPORTED")
        const projected = projectRestorableSettings({ configOptions: [{ ...option, currentValue: params.value }] }).configValues?.[optionId]
        transient = projected === undefined
        if (transient && (option.type === "select" || option.type === "boolean")) throw new AgentError("SELECTION_UNSUPPORTED")
        if (!transient) desired.configValues = { ...desired.configValues, [optionId]: projected! }
      } else throw new AgentError("UNSUPPORTED_SESSION_FEATURE")
      const command = parseAgentCommandV3({ version: 3, hostId: context.paths.hostKey, commandId: randomUUID(), handlerGeneration: generation, agentId: target.agentId, op: "configure", target, input: { target, method, optionIds: [optionId], prior: record.settings, desired, priorNonRestorableOptionIds: record.configurationState.nonRestorableOptionIds }, state: "pending", result: null })
      const pending = { ...record, configurationState: { verification: { kind: "pending" as const, commandId: command.commandId }, nonRestorableOptionIds: [...new Set([...record.configurationState.nonRestorableOptionIds, ...(transient ? [optionId] : [])])].sort() } }
      try { await publishCommand(command, null); await publishAgent(pending, record) }
      catch { throw new AgentError("INCOMPLETE") }
      configuring.add(target.agentId)
      return { op, command, prior: record, pending, desired, optionId, transient }
    })
    const { op, command, prior, pending, desired, optionId, transient } = admitted
    try {
      let result: JsonObject
      try { result = await op.owner!.request(method, withNativeSession(params, op.providerSession!.sessionId), op.controller.signal) }
      catch (error) {
        if ((error as { noMutation?: boolean }).noMutation) await queue.run(async () => {
          await publishAgent({ ...pending, configurationState: prior.configurationState }, pending)
          await publishCommand({ ...command, state: "completed", result: { outcome: "failed", target, failure: agentFailure(error), session: prior.session } }, command)
        })
        throw error
      }
      await queue.run(async () => {
        await requireTarget(target)
        const snapshot = op.owner!.snapshot(), settings = projectRestorableSettings(snapshot)
        if (!transient && (method === "session/set_model" ? settings.modelId !== desired.modelId : method === "session/set_mode" ? settings.modeId !== desired.modeId : settings.configValues?.[optionId] !== desired.configValues?.[optionId])) throw new AgentError("INCOMPLETE")
        const authoritative = Object.hasOwn(result, "configOptions")
        const ids = pending.configurationState.nonRestorableOptionIds.filter(id => !authoritative || snapshot.configOptions.some(option => option.id === id) && settings.configValues?.[id] === undefined)
        const next = { ...pending, settings, configurationState: { verification: { kind: "verified" as const }, nonRestorableOptionIds: [...new Set([...ids, ...nonRestorableOptionIds(snapshot)])].sort() } }
        await publishAgent(next, pending)
        await publishCommand({ ...command, state: "completed", result: { outcome: "configured", target, failure: null, session: next.session } }, command)
        publishConfiguration(op)
      })
      return result
    } catch (error) { if (error instanceof AgentError) throw error; throw new AgentError("INCOMPLETE") }
    finally { configuring.delete(target.agentId) }
  }
  function invokeAcp(op: Live, params: JsonObject): Promise<JsonObject> {
    return invokeProvider(op, (owner, signal) => {
      echoes.set(op, { blocks: params.prompt as JsonObject[], index: 0, offset: 0, held: [], bytes: 0 })
      return owner.request("session/prompt", withNativeSession(params, op.providerSession!.sessionId), signal).finally(() => { const held = echoes.get(op)?.held ?? []; echoes.delete(op); for (const event of held) retainUpdate(op, event) })
    })
  }
  function retainUpdate(op: Live, event: AcpObservation): void {
    const changesSettings = ["config_option_update", "current_mode_update"].includes(event.update.sessionUpdate)
    if (op.ready && changesSettings && !configuring.has(op.initial.definition.agentId)) {
      const snapshot = op.owner!.snapshot()
      void queue.run(async () => {
        const prior = records.get(op.initial.definition.agentId)
        if (!prior || prior.phase !== "ready" || !isDeepStrictEqual(prior.launch, op.initial.launch)) return
        const unknown = { ...prior, configurationState: { ...prior.configurationState, verification: { kind: "unknown" as const } } }
        try {
          await publishAgent(unknown, prior)
          const settings = projectRestorableSettings(snapshot)
          const ids = prior.configurationState.nonRestorableOptionIds.filter(id => snapshot.configOptions.some(option => option.id === id) && settings.configValues?.[id] === undefined)
          await publishAgent({ ...unknown, settings, configurationState: { verification: { kind: "verified" }, nonRestorableOptionIds: [...new Set([...ids, ...nonRestorableOptionIds(snapshot)])].sort() } }, unknown)
        } catch { dirtyAgents.add(prior.definition.agentId) }
        op.conversation.append({ kind: "update", ...event }); publishConfiguration(op)
      }).catch(error => noteOperation(op, error))
    } else op.conversation.append({ kind: "update", ...event })
  }
  function invokeProvider<T extends TurnResult | JsonObject>(op: Live, call: (owner: OwnedAgentProcess, signal: AbortSignal) => Promise<T>): Promise<T> {
      let pending!: Promise<T>
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      op.controller.signal.addEventListener("abort", abort, { once: true })
      if (op.controller.signal.aborted) controller.abort()
      pending = Promise.resolve().then(async () => {
        try {
          await queue.run(() => validateLiveOperation(op))
          if (controller.signal.aborted) throw new AgentError("STARTUP_FAILED")
          const result = await call(op.owner!, controller.signal)
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
    if (op) permissions.invalidate(agentTuple(op.initial))
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
          if (previous.state === "pending" && previous.version === 3) await publishCommand({ ...previous, state: "completed", result: { outcome: "stopped", target: command.target, failure: null, session: matching ? record.session : op?.result?.session ?? null } }, previous)
        })
      } catch { }
      finally { stops.delete(command.commandId) }
    })()
    stops.set(command.commandId, operation)
  }
  function agentView(record: AgentRecord): AgentView {
    if (!record.launch) return { record: structuredClone(record), launch: null, live: false, cleanup: "not_launched", unavailable: issueFor(record.definition.agentId) }
    const launch = context.mutations.accepted.find(e => e.record.launchAttemptId === record.launch!.launchAttemptId)?.record ?? null, op = operations.get(record.definition.agentId)
    const unavailable = issueFor(record.definition.agentId)
    if (launch && (launch.version !== 2 || launch.owner.kind !== "agent" || launch.owner.agentId !== record.definition.agentId || launch.owner.providerGeneration !== record.launch.providerGeneration || launch.handlerGeneration !== record.launch.handlerGeneration)) return { record: structuredClone(record), launch: null, live: false, cleanup: "unknown", unavailable }
    return { record: structuredClone(op?.uncertain && !op.ready ? op.initial : record), launch: structuredClone(launch), live: !closed && record.launch.handlerGeneration === generation && !!op?.owner && !op.fault && !op.controller.signal.aborted && ["starting", "ready", "recoverable", "restoring", "stopping"].includes(record.phase), cleanup: launch === null ? "not_launched" : launch.phase === "cleanup_verified" ? op && !op.cleanupVerified ? "unverified" : "verified" : launch.phase === "quarantined" ? "unknown" : "unverified", unavailable }
  }
  const ordinary = (): void => {
    if (!initialized || accepting || stopping || stops.size || [...operations.values()].some(op => op.prompt) || [...commands.values()].some(c => c.state === "pending") || [...records.values()].some(r => ["starting", "ready", "restoring", "stopping"].includes(r.phase)) || context.mutations.accepted.some(e => e.record.version === 2 && e.record.owner.kind === "agent" && e.record.phase !== "cleanup_verified")) throw new ControlError("ACTIVE_AGENTS")
  }
  return {
    start, restore, stop, prompt, command, setSession, importSession,
    handlerGeneration: generation,
    attachPermissions(target, client) { return queue.run(async () => { await requireTarget(target); permissions.attach(target, client) }) },
    permissionDecision(connectionId, requestId, result) { return queue.run(() => permissions.decision(connectionId, requestId, result)) },
    detachPermissions: (connectionId, target) => permissions.detach(connectionId, target),
    async backendChoices() {
      const config = await readBackendConfig(root), profiles = await readProfiles(root)
      const backends = config.backends.filter(backend => profiles.some(profile => profile.id === backend.id && profile.enabled)
        && input.contracts.some(contract => contract.id === backend.compatibilityId && contract.providerId === backend.id))
      const choices: JsonObject[] = []
      for (const backend of backends) {
        const declaration = input.contracts.find(contract => contract.id === backend.compatibilityId && contract.providerId === backend.id)!
        const profile = profiles.find(profile => profile.id === backend.id)!
        try { await configureLaunchContract(declaration, profile, await observeConfig(profile)) } catch { continue }
        let provider
        try { provider = (await catalog.launchEvidence(backend.id)).provider } catch {}
        choices.push(backendSelection(backend, declaration, provider))
      }
      return { defaultBackendId: config.defaultBackendId, backends: choices }
    },
    async acpCapabilities() {
      const capabilities = { image: false, audio: false, embeddedContext: false }
      try {
        const backends = await readBackendConfig(root), profiles = await readProfiles(root)
        for (const backend of backends.backends) {
          const profile = profiles.find(value => value.id === backend.id && value.enabled), declaration = input.contracts.find(value => value.id === backend.compatibilityId && value.providerId === backend.id)
          if (!profile || !declaration) continue
          try {
            const contract = await configureLaunchContract(declaration, profile, await observeConfig(profile))
            for (const key of ["image", "audio", "embeddedContext"] as const) capabilities[key] ||= contract.promptCapabilities?.[key] === true
          } catch {}
        }
      } catch (error) { if (!(error instanceof AgentError && error.code === "UNAVAILABLE") && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      return { loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: capabilities }
    },
    observeSession(target, listener, configuration) {
      return queue.run(async () => {
        const op = await requireTarget(target), observation = op.conversation.observe(listener)
        const listeners = configurationListeners.get(op) ?? new Set<(snapshot: SessionConfiguration) => void>()
        configurationListeners.set(op, listeners); listeners.add(configuration)
        return { ...observation, native: { ...structuredClone(op.providerSession!), configuration: op.owner!.snapshot() }, backendId: op.initial.definition.backendId,
          close() { observation.close(); listeners.delete(configuration); if (!listeners.size) configurationListeners.delete(op) },
        }
      })
    },
    async createSession(request) {
      const accepted = await acceptLaunch(request, "start"), target = accepted.command.target
      if (!target) throw new AgentError("INCOMPLETE")
      const op = operations.get(target.agentId)
      if (op) await op.work
      const record = records.get(target.agentId)
      if (!record || record.phase !== "ready" || dirtyAgents.has(target.agentId)) throw new AgentError(record?.failure?.code ?? "INCOMPLETE")
      return structuredClone(record)
    },
    sessionSnapshot(target) { return queue.run(async () => (await requireTarget(target)).owner!.snapshot()) },
    nativeSession(target) { return queue.run(async () => { const op = await requireTarget(target); return { ...structuredClone(op.providerSession!), configuration: op.owner!.snapshot() } }) },
    async submitAcp(target, request) { const op = await queue.run(() => requireTarget(target)); return op.turns!.submitAcp(request) },
    async settledAcp(target, submissionId) { const op = await queue.run(() => requireTarget(target)); return op.turns!.settledAcp(submissionId) },
    retentionPins() {
      const paths = new Set<string>()
      const pinAgent = (agentId: string) => paths.add("agents/records/" + agentId + ".json")
      for (const op of new Set([...operations.values(), ...intents.values()])) if (!op.retired) {
        pinAgent(op.initial.definition.agentId)
        paths.add("agents/commands/" + op.accepted.commandId + ".json")
        paths.add("launches/" + op.initial.launch.launchAttemptId + ".json")
      }
      for (const id of dirty) paths.add("agents/commands/" + id + ".json")
      for (const id of dirtyAgents) pinAgent(id)
      for (const id of stops.keys()) { paths.add("agents/commands/" + id + ".json"); const target = commands.get(id)?.target; if (target) pinAgent(target.agentId) }
      for (const [id, issue] of [...assessment.unavailable, ...runtimeIssues]) { pinAgent(id); if (issue.path.startsWith(root + "/")) paths.add(issue.path.slice(root.length + 1)) }
      for (const issue of assessment.issues) {
        const path = issue.path.startsWith(root + "/") ? issue.path.slice(root.length + 1) : null
        if (path && /^(?:agents\/(?:records|commands)|launches)\/[0-9a-f-]{36}\.json$/.test(path)) paths.add(path)
        else {
          for (const id of records.keys()) pinAgent(id)
          for (const id of commands.keys()) paths.add("agents/commands/" + id + ".json")
          for (const entry of context.mutations.accepted) if (entry.path.startsWith(root + "/")) paths.add(entry.path.slice(root.length + 1))
        }
      }
      return { paths: [...paths] }
    },
    forgetRemoved(entry) {
      store.forgetRemoved(entry)
      const match = /^agents\/(records|commands)\/([0-9a-f-]+)\.json$/.exec(entry.path)
      if (match) { if (match[1] === "records") records.delete(match[2]!); else commands.delete(match[2]!); changed() }
    },
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
        const active = (record: AgentRecord): boolean => record.launch?.handlerGeneration === generation && (record.phase === "ready" || ["starting", "restoring", "stopping"].includes(record.phase) && (!!operations.get(record.definition.agentId) || [...commands.values()].some(c => c.state === "pending" && c.target && isDeepStrictEqual(c.target, agentTuple(record)))))
        const agents = [...records.values()].filter(record => !input.retirement?.hides("agents/records/" + record.definition.agentId + ".json") && (!options.activeOnly || active(record))).map(agentView)
        return inventoryPage({ revision: inventoryRevision, agents: options.activeOnly ? agents : [...agents, ...legacy], issues: [...assessment.issues, ...assessment.unavailable.values(), ...runtimeIssues.values(), ...cleanupDiagnostics()].filter((issue, index, all) => all.findIndex(other => isDeepStrictEqual(issue, other)) === index) }, options)
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
        const result: AgentList = { state: "agents", agents: [...[...records.values()].filter(record => !input.retirement?.hides("agents/records/" + record.definition.agentId + ".json")).sort((a, b) => a.definition.agentId.localeCompare(b.definition.agentId)).map(agentView), ...legacy], issues: [...assessment.issues, ...cleanupDiagnostics()] }
        if (Buffer.byteLength(JSON.stringify(result)) > 7 * 1024 * 1024) throw new AgentError("INCOMPLETE")
        return result
      })
    },
    sessionRecord(agentId) {
      id(agentId)
      return queue.run(async () => {
        await verify()
        const record = records.get(agentId)
        return record && !input.retirement?.hides("agents/records/" + agentId + ".json") ? agentView(record) : null
      })
    },
    async current(cwd) {
      return queue.run(async () => {
        await verify()
        const agents = [...records.values()].filter(record => !input.retirement?.hides("agents/records/" + record.definition.agentId + ".json")).map(agentView).filter(agent => agent.live && agent.record.definition.cwd === cwd)
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
        try { await stop({ ...agentTuple(record)!, commandId: existing?.commandId ?? randomUUID() }) } catch (error) { failures.push(error) }
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