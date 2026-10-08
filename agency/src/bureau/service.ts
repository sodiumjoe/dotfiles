import type { JournalPool } from "../orchestration/journal.js"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { absolutePath, hash, id, keys, object, providerId, text, type ProviderId } from "../catalog/types.js"
import { parseLaunchEnvironment, launchEnvironmentDigest } from "../agent/environment.js"
import { parseRequestedSettings } from "../agent/session-config.js"
import { sessionInputs } from "../agent/service.js"
import { MutationQueue } from "../handler/mutations.js"
import { canonicalDigest, boundedText, fail, parseAgentRef, parseExecutionRef, parseAssignmentSpec, parseOverrides, type AgentRef, type AssignmentSpec, type EventRef, type Journal, type JournalEntry } from "../orchestration/types.js"
import { parseBureauRecord, type AssignmentRecord, type AssignmentView, type AttemptRecord, type BureauRecord, type CommandRecord, type RunRecord, type RunView } from "./types.js"
import type { BureauStore } from "./store.js"
import type { HostSnapshot, Invocation, LaunchAssignment, LaunchReceipt, OrchestrationHost, RootLaunch } from "./host.js"
import { transition, unresolved } from "./reducer.js"

export type StartRunInput = { objective: string; hostId: string; cwd: string; backendId: ProviderId; modelId: string; overrides: AssignmentSpec["overrides"] }
export function parseStartRunInput(value: unknown): StartRunInput {
  const v = object(value); keys(v, ["objective", "hostId", "cwd", "backendId", "modelId", "overrides"])
  return { objective: boundedText(v.objective, 65536, false), hostId: hash(v.hostId), cwd: absolutePath(v.cwd), backendId: providerId(v.backendId), modelId: text(v.modelId), overrides: parseOverrides(v.overrides) }
}
export function captureInvocation(value: Invocation): Invocation {
  return { environment: parseLaunchEnvironment(value.environment), nativeParams: structuredClone(value.nativeParams) }
}
export function invocationDigest(cwd: string, value: Invocation): string {
  const environment = parseLaunchEnvironment(value.environment), params = sessionInputs(cwd, value.nativeParams).params
  return canonicalDigest({ environmentDigest: launchEnvironmentDigest(environment), nativeParamsDigest: canonicalDigest(params) })
}
export function createBureauService(input: { store: BureauStore; journals: JournalPool; hosts: OrchestrationHost[] }) {
  const { store, journals } = input, queue = new MutationQueue()
  const recordRunId = (record: BureauRecord) => record.kind === "attempt" ? record.value.ref.runId : record.value.runId
  const journalFor = (runId: string) => journals.forRun(runId)
  let enabled = false, initialized = false, writeFailure: unknown = null
  const requireWrites = (): void => { if (!initialized) fail("NOT_READY"); if (writeFailure !== null) fail("BUREAU_UNAVAILABLE"); if (!enabled) fail("BUREAU_DISABLED") }
  const eventRef = (entry: JournalEntry): EventRef => ({ seq: entry.seq, eventId: entry.eventId, digest: entry.digest })
  async function readRecord(record: BureauRecord): Promise<BureauRecord["value"] | null> {
    switch (record.kind) {
      case "run": return store.readRun(record.value.runId)
      case "assignment": return store.readAssignment(record.value.assignmentId)
      case "attempt": return store.readAttempt(record.value.ref.attemptId)
      case "command": return store.readCommand(record.value.commandId)
    }
  }
  async function writeRecord(record: BureauRecord, prior: BureauRecord["value"] | null): Promise<void> {
    switch (record.kind) {
      case "run": return store.writeRun(record.value, prior as RunRecord | null)
      case "assignment": return store.writeAssignment(record.value, prior as AssignmentRecord | null)
      case "attempt": return store.writeAttempt(record.value, prior as AttemptRecord | null)
      case "command": return store.writeCommand(record.value, prior as CommandRecord | null)
    }
  }
  async function apply(entry: JournalEntry): Promise<BureauRecord["value"]> {
    const payload = object(entry.payload), record = parseBureauRecord(payload.record), prior = await readRecord(record)
    const next = parseBureauRecord({ kind: record.kind, value: { ...record.value, journal: eventRef(entry) } })
    if (prior?.journal && prior.journal.seq > entry.seq) return prior
    if (prior?.journal?.seq === entry.seq) { if (!isDeepStrictEqual(prior, next.value)) fail("CORRUPT_BUREAU"); return prior }
    if ((prior === null ? null : canonicalDigest(prior)) !== payload.previousDigest) fail("CORRUPT_BUREAU")
    await writeRecord(next, prior)
    return next.value
  }
  async function persist(record: BureauRecord, previous: BureauRecord["value"] | null): Promise<BureauRecord["value"]> {
    try {
      const entry = await journalFor(recordRunId(record)).append(randomUUID(), "bureau-record", { previousDigest: previous === null ? null : canonicalDigest(previous), record })
      return await apply(entry)
    } catch (error) { writeFailure = error; throw error }
  }
  const saveRun = (value: RunRecord, previous: RunRecord | null) => persist({ kind: "run", value }, previous) as Promise<RunRecord>
  const saveAssignment = (value: AssignmentRecord, previous: AssignmentRecord | null) => persist({ kind: "assignment", value }, previous) as Promise<AssignmentRecord>
  const saveAttempt = (value: AttemptRecord, previous: AttemptRecord | null) => persist({ kind: "attempt", value }, previous) as Promise<AttemptRecord>
  const saveCommand = (value: CommandRecord, previous: CommandRecord | null) => persist({ kind: "command", value }, previous) as Promise<CommandRecord>
  async function run(runId: string): Promise<RunRecord> {
    const value = await store.readRun(id(runId)); if (!value) fail("RUN_NOT_FOUND"); if (value.state === "forgotten") fail("FORGOTTEN")
    return value
  }
  async function assignment(assignmentId: string): Promise<AssignmentRecord> {
    const value = await store.readAssignment(id(assignmentId)); if (!value) fail("ASSIGNMENT_NOT_FOUND")
    await run(value.runId)
    return value
  }
  async function attempt(record: AssignmentRecord): Promise<AttemptRecord> {
    const value = await store.readAttempt(record.activeAttemptId)
    if (!value || value.ref.assignmentId !== record.assignmentId || value.ref.runId !== record.runId) fail("CORRUPT_BUREAU")
    return value
  }
  async function assignmentView(record: AssignmentRecord): Promise<AssignmentView> {
    const current = await attempt(record)
    return { assignmentId: record.assignmentId, runId: record.runId, agent: current.child, spec: record.spec, lineage: current.lineage, attempt: current, attemptIds: record.attemptIds, journalCursor: (await journalFor(record.runId).read(0, 1)).lastSeq }
  }
  async function view(record: RunRecord, after: string | null = null): Promise<RunView> {
    if (after !== null) id(after)
    const assignments: AssignmentView[] = []
    let bytes = 0, nextAssignmentCursor: string | null = null
    const records = (await store.listAssignments()).filter(value => value.runId === record.runId && (after === null || value.assignmentId > after)).sort((a, b) => a.assignmentId < b.assignmentId ? -1 : 1)
    for (const value of records) {
      const item = await assignmentView(value), size = Buffer.byteLength(JSON.stringify(item))
      if (assignments.length && (assignments.length === 256 || bytes + size > 256 * 1024)) { nextAssignmentCursor = assignments.at(-1)!.assignmentId; break }
      assignments.push(item); bytes += size
    }
    return { ...record, assignments, nextAssignmentCursor, journalCursor: (await journalFor(record.runId).read(0, 1)).lastSeq }
  }
  async function host(hostId: string): Promise<{ adapter: OrchestrationHost; snapshot: HostSnapshot }> {
    for (const adapter of input.hosts) { const snapshot = await adapter.snapshot(); if (snapshot.hostId === hostId) return { adapter, snapshot } }
    return fail("HOST_UNAVAILABLE")
  }
  async function previous(commandId: string, digest: string): Promise<CommandRecord | null> {
    const command = await store.readCommand(id(commandId))
    if (!command) return null
    if (command.digest !== digest) fail("COMMAND_CONFLICT")
    const retained = await store.readRun(command.runId)
    if (retained?.state === "forgotten") fail("FORGOTTEN")
    if (command.state !== "completed" || command.result === null) fail("COMMAND_UNCERTAIN")
    return command
  }
  async function acceptCommand(commandId: string, runId: string, op: CommandRecord["op"], digest: string, targetId: string, handlerGeneration: string | null = null, launchCommandId: string | null = null): Promise<CommandRecord> {
    return saveCommand({ version: 1, commandId: id(commandId), runId, op, digest, state: "pending", targetId, handlerGeneration, launchCommandId, result: null, journal: null }, null)
  }
  async function complete<T extends RunView | AssignmentView>(command: CommandRecord, result: T): Promise<T> {
    await saveCommand({ ...command, state: "completed", result }, command)
    return structuredClone(result)
  }
  async function reconcile(): Promise<void> {
    const snapshots = new Map<string, HostSnapshot>()
    for (const adapter of input.hosts) { const snapshot = await adapter.snapshot(); snapshots.set(snapshot.hostId, snapshot) }
    for (const current of await store.listRuns()) {
      if (current.state !== "starting") continue
      const command = await store.readCommand(current.createCommandId)
      if (!command?.launchCommandId || !command.handlerGeneration) continue
      const snapshot = snapshots.get(current.root.hostId)
      if (!snapshot) continue
      const receipt = snapshot.receipts.find(value => value.commandId === command.launchCommandId)
      if (receipt?.state !== "started") continue
      validateReceipt(receipt, { commandId: command.launchCommandId, agent: current.root, handlerGeneration: command.handlerGeneration })
      await saveRun({ ...current, execution: receipt.execution, state: "active" }, current)
    }
    for (const record of await store.listAssignments()) {
      const current = await attempt(record)
      if (!unresolved(current.state)) continue
      const membership = await store.readRun(record.runId), snapshot = snapshots.get(current.child.hostId)
      let state = current.state
      if (membership?.state === "cancelled") state = "cancelled"
      else if (!snapshot) state = "uncertain"
      else if (snapshot.handlerGeneration !== current.handlerGeneration) state = snapshot.replayFences.some(fence => fence.runId === record.runId) ? "interrupted" : "uncertain"
      else if (current.execution) {
        const observed = snapshot.agents.find(agent => isDeepStrictEqual(agent.agent, current.child))
        if (observed?.execution && !isDeepStrictEqual(observed.execution, current.execution)) state = "interrupted"
        else if (!observed || !["ready", "starting", "restoring"].includes(observed.phase)) state = observed?.phase === "recoverable" || observed?.phase === "stopped" ? "interrupted" : "uncertain"
        else {
          const adapter = (await host(current.child.hostId)).adapter, receipt = await adapter.submission(current.execution, current.submissionId)
          if (receipt?.state === "completed") state = "awaiting_report"
          else if (receipt?.state === "failed") state = "failed"
        }
      }
      if (state !== current.state) await saveAttempt({ ...current, state: transition(current.state, state) }, current)
    }
  }
  async function launchResult(adapter: OrchestrationHost, command: LaunchAssignment | RootLaunch, invocation: Invocation): Promise<LaunchReceipt> {
    try { return "ref" in command ? await adapter.launch(command, invocation) : await adapter.launchRoot(command, invocation) }
    catch {
      const receipt = await adapter.inspectCommand(command.commandId, command.handlerGeneration)
      if (receipt) return receipt
      const snapshot = await adapter.snapshot()
      return { commandId: command.commandId, execution: null, effective: null, state: snapshot.handlerGeneration === command.handlerGeneration ? "uncertain" : "interrupted" }
    }
  }
  function validateReceipt<T extends Pick<RootLaunch, "commandId" | "agent" | "handlerGeneration">>(receipt: LaunchReceipt, command: T): void {
    try {
      keys(object(receipt), ["commandId", "execution", "effective", "state"])
      id(receipt.commandId)
      if (!["accepted", "started", "failed", "interrupted", "uncertain"].includes(receipt.state)) fail("INVALID_RECEIPT")
      if (receipt.execution !== null) parseExecutionRef(receipt.execution)
      if (receipt.effective !== null) parseRequestedSettings(receipt.effective)
    } catch { fail("INVALID_RECEIPT") }
    if (receipt.commandId !== command.commandId || receipt.execution && (receipt.execution.agentId !== command.agent.agentId || receipt.execution.hostId !== command.agent.hostId || receipt.execution.handlerGeneration !== command.handlerGeneration) || receipt.state === "started" && (!receipt.execution || !receipt.effective)) fail("INVALID_RECEIPT")
  }
  async function dispatch(record: AssignmentRecord, current: AttemptRecord, invocation: Invocation, membership: RunRecord): Promise<AttemptRecord> {
    const { adapter } = await host(current.child.hostId)
    const command: LaunchAssignment = { commandId: current.launchCommandId, runId: current.ref.runId, ref: current.ref, agent: current.child, handlerGeneration: current.handlerGeneration, bindingEpoch: membership.bindingEpoch, spec: record.spec, lineage: current.lineage, git: null, retryMode: current.retryMode, savedSettings: current.retryMode === "restore" ? current.effective : null }
    const receipt = await launchResult(adapter, command, invocation)
    validateReceipt(receipt, command)
    const state = receipt.state === "started" ? "running" : receipt.state === "accepted" ? "dispatch_pending" : receipt.state
    const launched = await saveAttempt({ ...current, state: transition(current.state, state), execution: receipt.execution, effective: receipt.effective }, current)
    if (state !== "running" || !launched.execution) return launched
    try { await adapter.submit(launched.execution, { submissionId: launched.submissionId, prompt: [{ type: "text", text: record.spec.description }] }) }
    catch { const observed = await adapter.submission(launched.execution, launched.submissionId); if (!observed) return saveAttempt({ ...launched, state: "uncertain" }, launched) }
    return launched
  }
  async function recover(): Promise<void> {
    try {
      for (const runId of await journals.list()) {
        let after = 0
        while (true) {
          const page = await journalFor(runId).read(after, 256)
          for (const entry of page.entries) if (entry.kind === "bureau-record") {
            const record = parseBureauRecord(object(entry.payload).record)
            if (recordRunId(record) !== runId) fail("CORRUPT_BUREAU")
            await apply(entry)
          }
          after = page.nextCursor; if (after >= page.lastSeq) break
        }
      }
      enabled = await store.readEnabled(); await reconcile(); initialized = true; writeFailure = null
    } catch (error) { writeFailure = error; throw error }
  }
  return {
    async initialize() { await queue.run(recover) },
    async enable() {
      await queue.run(async () => {
        await recover()
        try { await store.writeEnabled(true, enabled); enabled = true }
        catch (error) { writeFailure = error; throw error }
      })
    },
    async disable() { await queue.run(async () => { await store.writeEnabled(false, enabled); enabled = false }) },
    async status() { return { enabled, ready: initialized, writeAvailable: writeFailure === null } },
    reconcile: () => queue.run(reconcile),
    async inspect(runId: string, after: string | null = null) { return queue.run(async () => view(await run(runId), after)) },
    async assignment(assignmentId: string) { return queue.run(async () => assignmentView(await assignment(assignmentId))) },
    async command(commandId: string) { return queue.run(async () => { const value = await store.readCommand(id(commandId)); if (!value) fail("COMMAND_NOT_FOUND"); await run(value.runId); return value }) },
    async list() { return queue.run(async () => (await store.listRuns()).filter(value => value.state !== "forgotten")) },
    async assertBinding(runId: string, bindingEpoch: string, parent: AgentRef) {
      const membership = await run(runId)
      if (membership.bindingEpoch !== bindingEpoch || membership.state !== "active") fail("STALE_BINDING")
      if (!isDeepStrictEqual(membership.root, parseAgentRef(parent)) && !(await store.listAttempts()).some(value => value.ref.runId === runId && isDeepStrictEqual(value.child, parent))) fail("INVALID_PARENT")
    },
    async startRun(commandId: string, raw: StartRunInput, invocation: Invocation): Promise<RunView> {
      invocation = captureInvocation(invocation)
      const spec = parseStartRunInput(raw), digest = canonicalDigest({ op: "start", spec, invocation: invocationDigest(spec.cwd, invocation) })
      return queue.run(async () => {
        requireWrites(); const prior = await previous(commandId, digest); if (prior) return prior.result as RunView
        const { adapter, snapshot } = await host(spec.hostId)
        if (!snapshot.backendChoices.includes(spec.backendId)) fail("UNSUPPORTED_BACKEND")
        const runId = randomUUID(), agent = { hostId: spec.hostId, agentId: randomUUID() }, launchCommandId = randomUUID()
        const command = await acceptCommand(commandId, runId, "start", digest, runId, snapshot.handlerGeneration, launchCommandId)
        const pending = await saveRun({ version: 1, runId, createCommandId: commandId, root: agent, execution: null, objective: spec.objective, state: "starting", bindingEpoch: randomUUID(), journal: null }, null)
        const receipt = await launchResult(adapter, { commandId: launchCommandId, runId, agent, handlerGeneration: snapshot.handlerGeneration, bindingEpoch: pending.bindingEpoch, cwd: spec.cwd, backendId: spec.backendId, modelId: spec.modelId, overrides: spec.overrides }, invocation)
        validateReceipt(receipt, { commandId: launchCommandId, runId, agent, handlerGeneration: snapshot.handlerGeneration, bindingEpoch: pending.bindingEpoch, cwd: spec.cwd, backendId: spec.backendId, modelId: spec.modelId, overrides: spec.overrides })
        const current = await saveRun({ ...pending, execution: receipt.execution, state: receipt.state === "started" ? "active" : "starting" }, pending)
        return complete(command, await view(current))
      })
    },
    async beginRun(commandId: string, rawRoot: AgentRef, objective: string): Promise<RunView> {
      const root = parseAgentRef(rawRoot), description = boundedText(objective, 65536, false), digest = canonicalDigest({ op: "begin", root, objective: description })
      return queue.run(async () => {
        requireWrites(); const prior = await previous(commandId, digest); if (prior) return prior.result as RunView
        const { snapshot } = await host(root.hostId), observed = snapshot.agents.find(value => isDeepStrictEqual(value.agent, root))
        if (!observed || !observed.execution || observed.phase !== "ready") fail("NOT_READY")
        if (observed.lineage || (await store.listAttempts()).some(value => isDeepStrictEqual(value.child, root))) fail("CHILD_AS_ROOT")
        if (!observed.toolsEnabled) fail("SESSION_INPUT_REQUIRED")
        if ((await store.listRuns()).some(value => isDeepStrictEqual(value.root, root) && value.state !== "completed" && value.state !== "forgotten")) fail("RUN_AFFINITY")
        const runId = randomUUID(), command = await acceptCommand(commandId, runId, "begin", digest, runId)
        const current = await saveRun({ version: 1, runId, createCommandId: commandId, root, execution: observed.execution, objective: description, state: "active", bindingEpoch: randomUUID(), journal: null }, null)
        return complete(command, await view(current))
      })
    },
    async delegate(commandId: string, runId: string, raw: AssignmentSpec, invocation: Invocation): Promise<AssignmentView> {
      invocation = captureInvocation(invocation)
      const spec = parseAssignmentSpec(raw), digest = canonicalDigest({ op: "delegate", runId: id(runId), spec, invocation: invocationDigest(spec.cwd, invocation) })
      if (spec.git !== null) fail("UNSUPPORTED_CAPABILITY")
      return queue.run(async () => {
        requireWrites(); const prior = await previous(commandId, digest); if (prior) return prior.result as AssignmentView
        const membership = await run(runId)
        if (membership.state === "cancelled") fail("RUN_CANCELLED")
        if (membership.state !== "active") fail("NOT_READY")
        if (!isDeepStrictEqual(spec.parent, membership.root) && !(await store.listAttempts()).some(value => value.ref.runId === runId && isDeepStrictEqual(value.child, spec.parent))) fail("INVALID_PARENT")
        const { snapshot } = await host(spec.hostId)
        if (!snapshot.backendChoices.includes(spec.backendId)) fail("UNSUPPORTED_BACKEND")
        const assignmentId = randomUUID(), attemptId = randomUUID(), child = { hostId: spec.hostId, agentId: randomUUID() }, launchCommandId = randomUUID()
        const command = await acceptCommand(commandId, runId, "delegate", digest, assignmentId, snapshot.handlerGeneration, launchCommandId)
        const current = await saveAttempt({ version: 1, ref: { runId, assignmentId, attemptId }, child, lineage: { runId, parent: spec.parent, assignmentId }, state: "dispatch_pending", launchCommandId, submissionId: randomUUID(), handlerGeneration: snapshot.handlerGeneration, execution: null, effective: null, retryMode: "new", journal: null }, null)
        const record = await saveAssignment({ version: 1, assignmentId, runId, spec, attemptIds: [attemptId], activeAttemptId: attemptId, journal: null }, null)
        await dispatch(record, current, invocation, membership)
        return complete(command, await assignmentView(record))
      })
    },
    async retry(commandId: string, assignmentId: string, mode: "restore" | "replace", invocation: Invocation): Promise<AssignmentView> {
      invocation = captureInvocation(invocation)
      if (mode !== "restore" && mode !== "replace") fail()
      return queue.run(async () => {
        requireWrites(); const record = await assignment(assignmentId), digest = canonicalDigest({ op: "retry", assignmentId, mode, invocation: invocationDigest(record.spec.cwd, invocation) })
        const prior = await previous(commandId, digest); if (prior) return prior.result as AssignmentView
        const membership = await run(record.runId), old = await attempt(record)
        if (membership.state !== "active") fail("RUN_CANCELLED")
        if (unresolved(old.state)) fail("ACTIVE_ATTEMPT")
        const { snapshot } = await host(record.spec.hostId)
        if (mode === "restore") {
          const observed = snapshot.agents.find(value => isDeepStrictEqual(value.agent, old.child))
          if (!observed || !["recoverable", "stopped"].includes(observed.phase) || !old.effective) fail("NOT_RECOVERABLE")
        }
        const child = mode === "restore" ? old.child : { hostId: record.spec.hostId, agentId: randomUUID() }, attemptId = randomUUID(), launchCommandId = randomUUID()
        const command = await acceptCommand(commandId, record.runId, "retry", digest, assignmentId, snapshot.handlerGeneration, launchCommandId)
        const current = await saveAttempt({ version: 1, ref: { ...old.ref, attemptId }, child, lineage: old.lineage, state: "dispatch_pending", launchCommandId, submissionId: randomUUID(), handlerGeneration: snapshot.handlerGeneration, execution: null, effective: mode === "restore" ? old.effective : null, retryMode: mode, journal: null }, null)
        const next = await saveAssignment({ ...record, attemptIds: [...record.attemptIds, attemptId], activeAttemptId: attemptId }, record)
        await dispatch(next, current, invocation, membership)
        return complete(command, await assignmentView(next))
      })
    },
    async cancel(commandId: string, runId: string): Promise<RunView> {
      return queue.run(async () => {
        requireWrites(); const digest = canonicalDigest({ op: "cancel", runId: id(runId) }), prior = await previous(commandId, digest); if (prior) return prior.result as RunView
        const current = await run(runId)
        if (current.state === "completed") fail("RUN_CLOSED")
        const command = await acceptCommand(commandId, runId, "cancel", digest, runId)
        const cancelled = await saveRun({ ...current, state: "cancelled" }, current)
        await reconcile()
        return complete(command, await view(cancelled))
      })
    },
    async closeRun(commandId: string, runId: string): Promise<RunView> {
      return queue.run(async () => {
        requireWrites(); const digest = canonicalDigest({ op: "close", runId: id(runId) }), prior = await previous(commandId, digest); if (prior) return prior.result as RunView
        const current = await run(runId)
        for (const record of await store.listAssignments()) if (record.runId === runId && unresolved((await attempt(record)).state)) fail("UNRESOLVED")
        if (current.state === "starting" || (await store.listCommands()).some(value => value.runId === runId && value.state === "pending")) fail("UNRESOLVED")
        const command = await acceptCommand(commandId, runId, "close", digest, runId)
        const closed = await saveRun({ ...current, state: "completed", bindingEpoch: randomUUID() }, current)
        return complete(command, await view(closed))
      })
    },
    async forget(commandId: string, runId: string): Promise<RunView> {
      return queue.run(async () => {
        requireWrites(); const current = await run(runId)
        if (current.state !== "completed") fail("UNRESOLVED")
        const digest = canonicalDigest({ op: "forget", runId }), command = await acceptCommand(commandId, runId, "forget", digest, runId)
        const sealed = await saveRun({ ...current, state: "forgotten", objective: "Forgotten run", bindingEpoch: randomUUID() }, current)
        return complete(command, { ...sealed, assignments: [], nextAssignmentCursor: null, journalCursor: (await journalFor(runId).read(0, 1)).lastSeq })
      })
    }
  }
}
export type BureauService = ReturnType<typeof createBureauService>