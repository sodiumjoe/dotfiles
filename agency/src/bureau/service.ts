import { pendingScopedStops, parseStopCommand, parseStopReceipt } from "../orchestration/receipts.js"
import { createScheduler, parseNotificationRetry } from "../orchestration/scheduler.js"
import { createInbox, parseReportTransition, acknowledges, type ReportAcknowledgment } from "./inbox.js"
import { createWaits } from "./waits.js"
import { journalEntries, parseAcceptedReport, type ReportRelay, type ReportReceipt } from "../orchestration/reports.js"
import type { JournalPool } from "../orchestration/journal.js"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { absolutePath, hash, id, keys, object, providerId, text, type ProviderId } from "../catalog/types.js"
import { parseLaunchEnvironment, launchEnvironmentDigest } from "../agent/environment.js"
import { parseRequestedSettings } from "../agent/session-config.js"
import { sessionInputs } from "../agent/service.js"
import { MutationQueue } from "../handler/mutations.js"
import { canonicalDigest, boundedText, fail, parseAgentRef, parseExecutionRef, parseAssignmentSpec, parseOverrides, type ExecutionRef, type AgentRef, type AssignmentSpec, type EventRef, type Journal, type JournalEntry, parseReportInput, parseEventRef } from "../orchestration/types.js"
import { parseBureauRecord, type AssignmentRecord, type AssignmentView, type AttemptRecord, type BureauRecord, type CommandRecord, type RunRecord, type RunView } from "./types.js"
import type { BureauStore } from "./store.js"
import type { HostSnapshot, Invocation, LaunchAssignment, LaunchReceipt, OrchestrationHost, RootLaunch, StopReceipt } from "./host.js"
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
export function createBureauService(input: { store: BureauStore; journals: JournalPool; origins?: JournalPool; hosts: OrchestrationHost[]; notifications?: boolean }) {
  const { store, journals } = input, queue = new MutationQueue()
  const recordRunId = (record: BureauRecord) => record.kind === "attempt" ? record.value.ref.runId : record.value.runId
  const journalFor = (runId: string) => journals.forRun(runId)
  let enabled = false, initialized = false, closed = false, writeFailure: unknown = null
  const requireWrites = (): void => { if (closed) fail("BUREAU_UNAVAILABLE"); if (!initialized) fail("NOT_READY"); if (writeFailure !== null) fail("BUREAU_UNAVAILABLE"); if (!enabled) fail("BUREAU_DISABLED") }
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
      const saved = await apply(entry)
      waits.notify(); scheduler.notify()
      return saved
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
  async function checkForgotten(kind: "commands" | "assignments" | "waits", recordId: string): Promise<void> {
    const runId = await store.readForgotten(kind, id(recordId))
    if (runId && (await store.readRun(runId))?.state === "forgotten") fail("FORGOTTEN")
  }
  async function assignment(assignmentId: string): Promise<AssignmentRecord> {
    await checkForgotten("assignments", assignmentId)
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
    return { assignmentId: record.assignmentId, runId: record.runId, agent: current.child, spec: record.spec, lineage: current.lineage, attempt: current, attemptIds: record.attemptIds, journalCursor: (await journalFor(record.runId).metadata()).lastSeq }
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
    return { ...record, assignments, nextAssignmentCursor, journalCursor: (await journalFor(record.runId).metadata()).lastSeq }
  }
  async function host(hostId: string): Promise<{ adapter: OrchestrationHost; snapshot: HostSnapshot }> {
    for (const adapter of input.hosts) { const snapshot = await adapter.snapshot(); if (snapshot.hostId === hostId) return { adapter, snapshot } }
    return fail("HOST_UNAVAILABLE")
  }
  async function previous(commandId: string, digest: string): Promise<CommandRecord | null> {
    await checkForgotten("commands", commandId)
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
      const command = (await store.listCommands()).filter(command => command.runId === current.runId && ["start", "restore-root"].includes(command.op) && command.launchCommandId).sort((a, b) => (b.journal?.seq ?? 0) - (a.journal?.seq ?? 0))[0]
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
          const adapter = (await host(current.child.hostId)).adapter
          try {
            const receipt = await adapter.submission(current.execution, current.submissionId)
            if (receipt?.state === "completed") state = "awaiting_report"
            else if (receipt?.state === "failed") state = "failed"
          } catch (error) {
            const code = error instanceof Error ? (error as { code?: string }).code ?? error.message : null
            if (!["NOT_READY", "STALE_EXECUTION", "STALE_HANDLER", "STALE_PROVIDER", "UNAVAILABLE", "HOST_UNAVAILABLE"].includes(code ?? "")) throw error
            state = "uncertain"
          }
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
  async function applyReport(entry: JournalEntry): Promise<ReportReceipt> {
    const report = parseReportTransition(entry.payload), current = await store.readAttempt(report.input.attemptId)
    if (!current || !isDeepStrictEqual(current.execution, report.input.execution) || !isDeepStrictEqual(current.ref, { runId: report.input.runId, assignmentId: report.input.assignmentId, attemptId: report.input.attemptId })) fail("STALE_EXECUTION")
    await store.writeReport({ input: report.input, origin: report.origin, receipt: report.receipt })
    if (report.recipient) await store.writeInbox({ version: 1, eventId: report.input.commandId, runId: report.input.runId, parent: report.recipient, source: eventRef(entry), report: report.input })
    if (report.receipt.state === "accepted" && unresolved(current.state)) {
      const state = report.input.report.status === "completed" ? "completed" : "failed"
      await store.writeAttempt({ ...current, state, journal: eventRef(entry) }, current)
    }
    waits.notify(); scheduler.notify()
    return report.receipt
  }
  async function acceptReport(raw: ReportRelay): Promise<ReportReceipt> {
    const value = object(raw); keys(value, ["input", "origin"])
    const report = parseReportInput(value.input), origin = parseEventRef(value.origin)
    await run(report.runId)
    const current = await store.readAttempt(report.attemptId)
    if (!current || !isDeepStrictEqual(current.execution, report.execution) || !isDeepStrictEqual(current.ref, { runId: report.runId, assignmentId: report.assignmentId, attemptId: report.attemptId })) fail("STALE_EXECUTION")
    const entries = input.origins ? await journalEntries(input.origins.forRun(report.runId)) : []
    const source = entries.find(entry => entry.eventId === origin.eventId)
    if (!source || source.kind !== "report-retained" || !isDeepStrictEqual(source.payload, report) || !isDeepStrictEqual(eventRef(source), origin)) fail("INVALID_ORIGIN")
    await input.origins!.forRun(report.runId).append(source.eventId, source.kind, source.payload)
    const retained = await store.readReport(report.attemptId)
    if (retained) {
      if (!isDeepStrictEqual(retained.input.report, report.report)) fail("REPORT_CONFLICT")
      await store.writeReport(retained)
      return retained.receipt
    }
    const assignment = await store.readAssignment(report.assignmentId), membership = await store.readRun(report.runId)
    if (!assignment || !membership) fail("INVALID_REPORT")
    const state = assignment.activeAttemptId !== report.attemptId || membership.state !== "active" || !unresolved(current.state) ? "late" : "accepted"
    const receipt: ReportReceipt = { commandId: report.commandId, runId: report.runId, assignmentId: report.assignmentId, attemptId: report.attemptId, digest: canonicalDigest(report.report), originSeq: origin.seq, state }
    try {
      const entry = await journalFor(report.runId).append(report.commandId, "bureau-report", { input: report, origin, receipt, recipient: state === "late" ? null : current.lineage.parent })
      return await applyReport(entry)
    } catch (error) { writeFailure = error; throw error }
  }
  async function replayOriginReports(): Promise<void> {
    if (!input.origins) return
    for (const runId of await input.origins.list()) for (const entry of await journalEntries(input.origins.forRun(runId))) if (entry.kind === "report-retained" && !await input.origins.forRun(runId).acknowledged("bureau", eventRef(entry))) {
      const receipt = await acceptReport({ input: parseReportInput(entry.payload), origin: eventRef(entry) })
      if (receipt.state !== "retained") await input.origins.forRun(runId).acknowledge("bureau", eventRef(entry))
    }
  }
  async function refreshLocked(): Promise<void> { await replayOriginReports(); await reconcile(); await waits.recoverLocked() }
  async function recover(): Promise<void> {
    if (closed) fail("BUREAU_UNAVAILABLE")
    try {
      for (const run of await store.listRuns()) if (run.state === "forgotten") { await store.writeRun(run, run); await eraseForgotten(run.runId) }
      for (const runId of await journals.list()) {
        let after = 0
        while (true) {
          const page = await journalFor(runId).retainedRead(after, 256)
          for (const entry of page.entries) {
            await journalFor(runId).append(entry.eventId, entry.kind, entry.payload)
            if (entry.kind === "report-acknowledgment") await inbox.applyAcknowledgment(entry); else if (entry.kind === "bureau-report") await applyReport(entry); else if (entry.kind === "bureau-delivery") await inbox.apply(entry); else if (entry.kind === "bureau-wait") await waits.apply(entry); else if (entry.kind === "notification-retry") await applyNotificationRetry(entry); else if (entry.kind === "bureau-record") {
            const record = parseBureauRecord(object(entry.payload).record)
            if (recordRunId(record) !== runId) fail("CORRUPT_BUREAU")
            await apply(entry)
            }
          }
          after = page.nextCursor; if (after >= page.lastSeq) break
        }
      }
      enabled = await store.readEnabled()
      await refreshLocked(); initialized = true; writeFailure = null; scheduler.notify()
    } catch (error) { writeFailure = error; throw error }
  }
  async function applyNotificationRetry(entry: JournalEntry): Promise<void> {
    const retry = parseNotificationRetry(entry.payload), previous = await store.readDelivery(retry.previousDeliveryId)
    if (!previous || previous.runId !== retry.result.runId || !isDeepStrictEqual(previous.parent, retry.result.parent) || !isDeepStrictEqual(previous.sources, retry.result.sources)) fail("INVALID_DELIVERY")
    const existing = await store.readDelivery(retry.commandId)
    if (!existing) await inbox.save(retry.result, null)
    if (previous.state !== "superseded") await inbox.save({ ...previous, state: "superseded" }, previous)
  }
  async function eraseForgotten(runId: string): Promise<void> {
    await store.eraseRun(runId); await journals.erase(runId); await input.origins?.erase(runId)
  }
  async function assertNoRoutes(runId: string): Promise<void> {
    if (input.origins && pendingScopedStops(await journalEntries(input.origins.forRun(runId))).length) fail("UNRESOLVED")
    if ((await store.listWaits()).some(wait => wait.input.runId === runId && !wait.ended)) fail("UNRESOLVED")
    const deliveries = (await store.listDeliveries()).filter(delivery => delivery.runId === runId)
    const acknowledgments = await store.listAcknowledgments()
    if (deliveries.some(delivery => !["queued", "delivered", "superseded"].includes(delivery.state) && !delivery.sources.every(source => acknowledges(acknowledgments, runId, source)))) fail("UNRESOLVED")
    for (const entry of await store.listInbox()) if (entry.runId === runId && !acknowledges(acknowledgments, runId, entry.source) && !deliveries.some(delivery => delivery.state === "delivered" && delivery.sources.some(source => isDeepStrictEqual(source, entry.source)))) fail("UNRESOLVED")
  }
  const inbox = createInbox({ store, journals, failed(error) { writeFailure = error } })
  const waits = createWaits({ store, journals, queue, inbox, requireWrites, async beforeAdmission() { await replayOriginReports(); await reconcile() }, failed(error) { writeFailure = error },
    async binding(parent, runId) {
      const membership = await run(runId)
      if (membership.state !== "active") return null
      const { snapshot } = await host(parent.hostId), observed = snapshot.agents.find(agent => isDeepStrictEqual(agent.agent, parent))
      if (!observed || !observed.execution || observed.phase !== "ready") return null
      if (!isDeepStrictEqual(parent, membership.root) && !(await store.listAttempts()).some(attempt => attempt.ref.runId === runId && isDeepStrictEqual(attempt.child, parent))) fail("INVALID_PARENT")
      return { target: observed.execution, bindingEpoch: membership.bindingEpoch }
    },
    async validateAssignments(parent, runId, assignmentIds) {
      const attempts = await store.listAttempts()
      for (const assignmentId of assignmentIds) {
        const assignment = await store.readAssignment(assignmentId)
        if (!assignment || assignment.runId !== runId) fail("INVALID_WAIT")
        let ancestor = assignment.spec.parent
        const seen = new Set<string>()
        while (!isDeepStrictEqual(ancestor, parent)) {
          const key = ancestor.hostId + "/" + ancestor.agentId
          if (seen.has(key)) fail("INVALID_WAIT")
          seen.add(key)
          const edge = attempts.find(attempt => attempt.ref.runId === runId && isDeepStrictEqual(attempt.child, ancestor))
          if (!edge) fail("INVALID_WAIT")
          ancestor = edge.lineage.parent
        }
      }
    }
  })
  const scheduler = createScheduler({ store, journals: input.origins ?? journals, queue, inbox, hosts: input.hosts, requireWrites, failed(error) { writeFailure = error }, beforeClaim: refreshLocked, automatic: input.notifications ?? false })
  const unsubscribe = input.hosts.flatMap(adapter => adapter.onSettled ? [adapter.onSettled(() => {
    void queue.run(async () => { requireWrites(); await refreshLocked() }).then(() => scheduler.notify()).catch(error => { if (initialized && enabled && !closed) writeFailure = error })
  })] : [])
  return {
    schedule: scheduler.schedule,
    reserveScopedStop: <T>(runId: string, bindingEpoch: string, execution: ExecutionRef, publish: () => Promise<T>): Promise<T> => queue.run(async () => {
      requireWrites()
      const membership = await run(runId), { snapshot } = await host(execution.hostId)
      if (membership.state !== "active" || membership.bindingEpoch !== bindingEpoch) fail("STALE_BINDING")
      if (!snapshot.agents.some(agent => agent.phase === "ready" && isDeepStrictEqual(agent.execution, execution))) fail("STALE_EXECUTION")
      return publish()
    }),
    async wait(raw: Parameters<typeof waits.wait>[0], signal?: AbortSignal, authority?: { execution: ExecutionRef; bindingEpoch: string }) { await checkForgotten("waits", raw.waitId); return waits.wait(raw, signal, authority) },
    async cancelWait(waitId: string) { await checkForgotten("waits", waitId); return waits.cancel(waitId) }, close() { closed = true; for (const stop of unsubscribe) stop(); waits.close(); scheduler.close(); return queue.run(async () => undefined) },
    waitRecord: (waitId: string) => queue.run(async () => { await checkForgotten("waits", waitId); return store.readWait(id(waitId)) }),
    inbox: (parent: AgentRef, runId: string, after = 0) => queue.run(async () => { await run(runId); return inbox.inspect(parseAgentRef(parent), runId, after) }),
    acceptReport: (envelope: ReportRelay) => queue.run(async () => { requireWrites(); return acceptReport(envelope) }),
    async initialize() { await queue.run(recover) },
    async enable() {
      await queue.run(async () => {
        await recover()
        try { await store.writeEnabled(true, enabled); enabled = true }
        catch (error) { writeFailure = error; throw error }
      })
    },
    async disable() { await queue.run(async () => { if (closed) fail("BUREAU_UNAVAILABLE"); await store.writeEnabled(false, enabled); enabled = false }) },
    async status() { return { enabled, ready: initialized, writeAvailable: !closed && writeFailure === null } },
    reconcile: () => queue.run(refreshLocked),
    async inspect(runId: string, after: string | null = null) { return queue.run(async () => { if (initialized && enabled && !closed && writeFailure === null) await refreshLocked(); return view(await run(runId), after) }) },
    async assignment(assignmentId: string) { return queue.run(async () => { if (initialized && enabled && !closed && writeFailure === null) await refreshLocked(); return assignmentView(await assignment(assignmentId)) }) },
    async command(commandId: string) { return queue.run(async () => { await checkForgotten("commands", commandId); const value = await store.readCommand(id(commandId)); if (!value) fail("COMMAND_NOT_FOUND"); await run(value.runId); return value }) },
    async list() { return queue.run(async () => (await store.listRuns()).filter(value => value.state !== "forgotten")) },
    assignmentEvidence: (assignmentId: string, attemptId?: string) => queue.run(async () => {
      const record = await assignment(assignmentId); await run(record.runId)
      const selected = attemptId === undefined ? record.activeAttemptId : id(attemptId), attempt = await store.readAttempt(selected)
      if (!attempt || attempt.ref.assignmentId !== assignmentId || attempt.ref.runId !== record.runId) fail("INVALID_REPORT")
      return store.readReport(selected)
    }),
    assertDescendant: (runId: string, parent: AgentRef, target: AgentRef) => queue.run(async () => {
      await run(runId); parseAgentRef(parent); parseAgentRef(target)
      if (isDeepStrictEqual(parent, target)) fail("INVALID_TARGET")
      let current = target
      const attempts = (await store.listAttempts()).filter(attempt => attempt.ref.runId === runId), seen = new Set<string>()
      while (!isDeepStrictEqual(current, parent)) {
        const key = current.hostId + "/" + current.agentId
        if (seen.has(key)) fail("INVALID_TARGET")
        seen.add(key)
        const edge = attempts.find(attempt => isDeepStrictEqual(attempt.child, current))
        if (!edge) fail("INVALID_TARGET")
        current = edge.lineage.parent
      }
    }),
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
    async restoreRun(commandId: string, runId: string, invocation: Invocation): Promise<RunView> {
      invocation = captureInvocation(invocation)
      return queue.run(async () => {
        requireWrites(); const current = await run(runId), { adapter, snapshot } = await host(current.root.hostId), observed = snapshot.agents.find(agent => isDeepStrictEqual(agent.agent, current.root))
        if (!observed || !adapter.restoreRoot) fail("UNSUPPORTED_CAPABILITY")
        const digest = canonicalDigest({ op: "restore-root", runId, invocation: invocationDigest(observed.cwd, invocation) }), previousResult = await previous(commandId, digest)
        if (previousResult) return previousResult.result as RunView
        if (!["active", "starting"].includes(current.state) || !["stopped", "recoverable"].includes(observed.phase)) fail("NOT_RECOVERABLE")
        const launchCommandId = randomUUID(), command = await acceptCommand(commandId, runId, "restore-root", digest, runId, snapshot.handlerGeneration, launchCommandId)
        let receipt: LaunchReceipt
        try { receipt = await adapter.restoreRoot({ commandId: launchCommandId, runId, agent: current.root, handlerGeneration: snapshot.handlerGeneration, bindingEpoch: current.bindingEpoch }, invocation) }
        catch { receipt = await adapter.inspectCommand(launchCommandId, snapshot.handlerGeneration) ?? { commandId: launchCommandId, execution: null, effective: null, state: "uncertain" } }
        validateReceipt(receipt, { commandId: launchCommandId, agent: current.root, handlerGeneration: snapshot.handlerGeneration })
        const next = await saveRun({ ...current, execution: receipt.execution ?? current.execution, state: receipt.state === "started" ? "active" : "starting" }, current)
        return complete(command, await view(next))
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
    async delegate(commandId: string, runId: string, raw: AssignmentSpec, invocation: Invocation, authority?: { execution: ExecutionRef; bindingEpoch: string }): Promise<AssignmentView> {
      invocation = captureInvocation(invocation)
      const spec = parseAssignmentSpec(raw), digest = canonicalDigest({ op: "delegate", runId: id(runId), spec, invocation: invocationDigest(spec.cwd, invocation) })
      if (spec.git !== null) fail("UNSUPPORTED_CAPABILITY")
      return queue.run(async () => {
        requireWrites(); if (authority) { const current = await run(runId); if (current.state !== "active" || current.bindingEpoch !== authority.bindingEpoch || authority.execution.agentId !== spec.parent.agentId || authority.execution.hostId !== spec.parent.hostId) fail("STALE_BINDING"); const { snapshot } = await host(authority.execution.hostId); if (!snapshot.agents.some(agent => agent.phase === "ready" && isDeepStrictEqual(agent.execution, authority.execution))) fail("STALE_EXECUTION") }; const prior = await previous(commandId, digest); if (prior) return prior.result as AssignmentView
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
        requireWrites(); await refreshLocked(); const record = await assignment(assignmentId), digest = canonicalDigest({ op: "retry", assignmentId, mode, invocation: invocationDigest(record.spec.cwd, invocation) })
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
        await assertNoRoutes(runId)
        const command = await acceptCommand(commandId, runId, "close", digest, runId)
        const closed = await saveRun({ ...current, state: "completed", bindingEpoch: randomUUID() }, current)
        return complete(command, await view(closed))
      })
    },
    async acknowledgeReports(commandId: string, runId: string, sources: EventRef[]): Promise<ReportAcknowledgment> {
      return queue.run(async () => {
        requireWrites(); await checkForgotten("commands", commandId); await run(runId)
        if (await store.readCommand(commandId) || await store.readDelivery(commandId)) fail("COMMAND_CONFLICT")
        const receipt = await inbox.acknowledge(commandId, runId, sources)
        scheduler.notify()
        return receipt
      })
    },
    async recoverScopedStop(runId: string, commandId: string): Promise<StopReceipt> {
      id(runId); id(commandId)
      const reserved = await queue.run(async () => {
        requireWrites(); await run(runId)
        if (!input.origins) fail("UNSUPPORTED_CAPABILITY")
        const journal = input.origins.forRun(runId), events = await journalEntries(journal), intent = events.find(entry => entry.eventId === commandId)
        if (!intent || intent.kind !== "scoped-stop") fail("COMMAND_NOT_FOUND")
        const command = parseStopCommand(intent.payload)
        if (command.runId !== runId) fail("INVALID_STOP")
        await journal.append(intent.eventId, intent.kind, intent.payload)
        const retained = events.find(entry => entry.kind === "scoped-stop-receipt" && isDeepStrictEqual(parseStopReceipt(entry.payload).command, command))
        if (retained) { await journal.append(retained.eventId, retained.kind, retained.payload); return { command, receipt: parseStopReceipt(retained.payload).receipt } }
        return { command, receipt: null }
      })
      if (reserved.receipt) return reserved.receipt
      const { adapter } = await host(reserved.command.target.hostId)
      let receipt: StopReceipt
      try { receipt = await adapter.stop(commandId, reserved.command.target) }
      catch (error) {
        const code = error instanceof Error ? (error as { code?: string }).code ?? error.message : null
        if (!["STALE_EXECUTION", "STALE_HANDLER", "STALE_PROVIDER"].includes(code ?? "")) throw error
        receipt = { commandId, execution: reserved.command.target, state: "stale" }
      }
      const saved = parseStopReceipt({ command: reserved.command, receipt })
      await queue.run(async () => { requireWrites(); await input.origins!.forRun(runId).append(randomUUID(), "scoped-stop-receipt", saved); await refreshLocked() })
      return saved.receipt
    },
    async retryNotification(commandId: string, deliveryId: string, rawTarget: Parameters<typeof parseExecutionRef>[0], bindingEpoch: string) {
      const target = parseExecutionRef(rawTarget); id(commandId); id(deliveryId); id(bindingEpoch)
      return queue.run(async () => {
        requireWrites(); await checkForgotten("commands", commandId)
        const previous = await store.readDelivery(deliveryId)
        if (!previous || previous.channel !== "prompt" || previous.parent.agentId !== target.agentId || previous.parent.hostId !== target.hostId) fail("INVALID_DELIVERY")
        const prior = (await journalEntries(journalFor(previous.runId))).find(entry => entry.eventId === commandId)
        if (prior) {
          if (prior.kind !== "notification-retry") fail("COMMAND_CONFLICT")
          const retry = parseNotificationRetry(prior.payload)
          if (retry.previousDeliveryId !== deliveryId || !isDeepStrictEqual(retry.result.target, target) || retry.result.bindingEpoch !== bindingEpoch) fail("COMMAND_CONFLICT")
          return structuredClone(retry.result)
        }
        if (await store.readCommand(commandId) || await store.readDelivery(commandId)) fail("COMMAND_CONFLICT")
        const membership = await run(previous.runId), { snapshot } = await host(target.hostId)
        if (membership.state !== "active" || membership.bindingEpoch !== bindingEpoch || !snapshot.agents.some(agent => agent.phase === "ready" && isDeepStrictEqual(agent.execution, target))) fail("STALE_BINDING")
        if (!["interrupted", "uncertain"].includes(previous.state)) fail("NOT_RETRYABLE")
        const retry = parseNotificationRetry({ commandId, previousDeliveryId: deliveryId, result: { ...previous, deliveryId: commandId, target, bindingEpoch, state: "queued", receiptId: null, journal: null } })
        try { await applyNotificationRetry(await journalFor(previous.runId).append(commandId, "notification-retry", retry)) } catch (error) { writeFailure = error; throw error }
        scheduler.notify()
        return structuredClone(retry.result)
      })
    },
    async compact(runId: string, time: number): Promise<void> {
      await queue.run(async () => {
        requireWrites(); const current = await run(runId)
        if (current.state !== "completed") fail("UNRESOLVED")
        await assertNoRoutes(runId)
        for (const pool of [journals, input.origins].filter((pool): pool is JournalPool => !!pool)) {
          const journal = pool.forRun(runId), entries = await journalEntries(journal)
          if (pool === input.origins) for (const entry of entries) if (entry.kind === "report-retained" && !await journal.acknowledged("bureau", entry)) fail("UNRESOLVED")
          for (const entry of entries) await journal.acknowledge("bureau", entry)
          let before: number
          do { before = (await journal.metadata()).checkpoint; await journal.compactTerminal(time) } while ((await journal.metadata()).checkpoint > before)
        }
      })
    },
    async forget(commandId: string, runId: string): Promise<RunView> {
      return queue.run(async () => {
        requireWrites(); const current = await run(runId)
        if (current.state !== "completed") fail("UNRESOLVED")
        await assertNoRoutes(runId)
        if (input.origins) for (const entry of await journalEntries(input.origins.forRun(runId))) if (entry.kind === "report-retained" && !await input.origins.forRun(runId).acknowledged("bureau", entry)) fail("UNRESOLVED")
        try {
          await store.sealIds(runId, commandId)
          const sealed: RunRecord = { ...current, state: "forgotten", objective: "Forgotten run", execution: null, bindingEpoch: randomUUID(), journal: null }
          await store.writeRun(sealed, current)
          await eraseForgotten(runId)
          return { ...sealed, assignments: [], nextAssignmentCursor: null, journalCursor: 0 }
        } catch (error) { writeFailure = error; throw error }
      })
    }
  }
}
export type BureauService = ReturnType<typeof createBureauService>