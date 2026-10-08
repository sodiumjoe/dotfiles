import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { readBackendConfig } from "../agent/backend-config.js"
import type { AgentService } from "../agent/service.js"
import type { JsonObject } from "../agent/session-config.js"
import type { AgentRecordV3, AgentTuple } from "../agent/types.js"
import { captureInvocation, invocationDigest } from "../bureau/service.js"
import type { Invocation, LaunchAssignment, RootLaunch, LaunchReceipt, OrchestrationHost, HostAgent } from "../bureau/host.js"
import type { JournalPool } from "./journal.js"
import type { LineageStore } from "./lineage.js"
import { parseOriginLaunch, parseOriginReceipt, loadOrchestrationPins, type OriginLaunch } from "./receipts.js"
import { createReportOutbox, journalEntries, type ReportRelay, type ReportReceipt } from "./reports.js"
import { canonicalDigest, fail, parseExecutionRef, type ExecutionRef } from "./types.js"

export type AgencyTools = { definition(execution: ExecutionRef, launch: OriginLaunch, invocation: Invocation): JsonObject; activate(execution: ExecutionRef): void; revoke(execution: ExecutionRef): void }
export function createOrchestrationService(input: { root: string; hostId: string; agents: AgentService; journals: JournalPool; lineage: LineageStore; tools: AgencyTools; relay(envelope: ReportRelay): Promise<ReportReceipt> }) {
  const settled = new Set<(parent: { hostId: string; agentId: string }) => void>()
  const { agents, journals, lineage } = input, transient = new Map<string, { execution: ExecutionRef; invocation: Invocation }>()
  const tuple = (execution: ExecutionRef): AgentTuple => { if (execution.hostId !== input.hostId) fail("STALE_EXECUTION"); return { agentId: execution.agentId, handlerGeneration: execution.handlerGeneration, providerGeneration: execution.providerGeneration } }
  const executionOf = (record: AgentRecordV3): ExecutionRef | null => record.launch ? { hostId: record.definition.hostId, agentId: record.definition.agentId, handlerGeneration: record.launch.handlerGeneration, providerGeneration: record.launch.providerGeneration } : null
  async function preparations(): Promise<OriginLaunch[]> {
    const records: OriginLaunch[] = []
    for (const runId of await journals.list()) for (const entry of await journalEntries(journals.forRun(runId))) if (entry.kind === "origin-launch") records.push(parseOriginLaunch(entry.payload))
    return records
  }
  async function validate(execution: ExecutionRef): Promise<void> {
    const target = parseExecutionRef(execution), observed = await agents.sessionRecord(target.agentId)
    if (!observed?.live || observed.record.phase !== "ready" || !isDeepStrictEqual(executionOf(observed.record), target)) fail("STALE_EXECUTION")
  }
  const outbox = createReportOutbox({ journals, relay: input.relay, retain: (execution, publish) => agents.withExecution(tuple(execution), publish), async validate(execution, report) {
    await validate(execution)
    if (!(await preparations()).some(launch => isDeepStrictEqual(launch.execution, execution) && isDeepStrictEqual(launch.attempt, { runId: report.runId, assignmentId: report.assignmentId, attemptId: report.attemptId }))) fail("STALE_EXECUTION")
  } })
  async function inspectCommand(commandId: string, handlerGeneration: string): Promise<LaunchReceipt | null> {
    const prepared = (await preparations()).find(launch => launch.commandId === commandId && launch.execution.handlerGeneration === handlerGeneration)
    if (!prepared) return null
    const entries = await journalEntries(journals.forRun(prepared.runId)), saved = entries.find(entry => entry.kind === "origin-receipt" && parseOriginReceipt(entry.payload).receipt.commandId === commandId)
    if (saved) return parseOriginReceipt(saved.payload).receipt
    let view
    try { view = await agents.commandReceipt(commandId, handlerGeneration) } catch { return { commandId, execution: prepared.execution, effective: prepared.settings, state: "uncertain" } }
    if (!view) return { commandId, execution: prepared.execution, effective: prepared.settings, state: "uncertain" }
    const state = view.durability !== "verified" ? "uncertain" : view.command.state === "pending" ? "accepted" : view.command.result?.outcome === "started" || view.command.result?.outcome === "restored" ? "started" : view.command.result?.outcome === "interrupted" ? "interrupted" : "failed"
    const observed = await agents.sessionRecord(prepared.agent.agentId), effective = observed && isDeepStrictEqual(executionOf(observed.record), prepared.execution) ? observed.record.settings : prepared.settings
    return { commandId, execution: prepared.execution, effective, state }
  }
  async function launch(command: LaunchAssignment | RootLaunch, raw: Invocation): Promise<LaunchReceipt> {
    if (command.handlerGeneration !== agents.handlerGeneration || command.agent.hostId !== input.hostId) fail("STALE_HANDLER")
    const invocation = captureInvocation(raw), spec = "spec" in command ? command.spec : command
    if (spec && "git" in spec && spec.git !== null) fail("UNSUPPORTED_CAPABILITY")
    const servers = invocation.nativeParams.mcpServers
    if (Array.isArray(servers) && servers.some(server => server && typeof server === "object" && !Array.isArray(server) && server.name === "agency")) fail("SESSION_INPUT_REQUIRED")
    const previous = await inspectCommand(command.commandId, command.handlerGeneration)
    if (previous) {
      const prepared = (await preparations()).find(launch => launch.commandId === command.commandId)!
      if (prepared.invocationDigest !== invocationDigest(spec.cwd, invocation) || !isDeepStrictEqual(prepared.agent, command.agent) || prepared.runId !== command.runId) fail("COMMAND_CONFLICT")
      return previous
    }
    const kind = "retryMode" in command && command.retryMode === "restore" ? "restore" : "start"
    const request = kind === "restore" ? { commandId: command.commandId, handlerGeneration: command.handlerGeneration, agentId: command.agent.agentId, environment: invocation.environment, nativeParams: invocation.nativeParams } : { commandId: command.commandId, cwd: spec.cwd, backendId: spec.backendId, selection: { modelId: spec.modelId, ...spec.overrides }, environment: invocation.environment, nativeParams: invocation.nativeParams }
    let reserved: OriginLaunch | null = null
    await agents.launchSession(request, kind, { agentId: command.agent.agentId, mcpServerNames: ["agency"], async prepare(record, params) {
      const execution = executionOf(record)!, edge = "lineage" in command ? command.lineage : null
      const preparation: OriginLaunch = { commandId: command.commandId, runId: command.runId, agent: command.agent, execution, launchAttemptId: record.launch.launchAttemptId, lineage: edge, attempt: "ref" in command ? command.ref : null, bindingEpoch: command.bindingEpoch, invocationDigest: invocationDigest(spec.cwd, invocation), toolsDigest: "0".repeat(64), settings: record.settings }
      reserved = preparation
      const definition = input.tools.definition(execution, preparation, invocation)
      preparation.toolsDigest = canonicalDigest({ ...definition, env: Array.isArray(definition.env) ? definition.env.map(value => value && typeof value === "object" && !Array.isArray(value) ? { name: value.name } : value) : [] })
      if (edge) await lineage.publish(command.agent, edge, await lineage.read(command.agent))
      await journals.forRun(command.runId).append(command.commandId, "origin-launch", preparation)
      transient.set(command.agent.agentId, { execution, invocation })
      return { ...params, mcpServers: [...(params.mcpServers as JsonObject[]), definition] }
    }, ready(record) { input.tools.activate(executionOf(record)!) }, settled(record) { for (const listener of settled) listener({ hostId: record.definition.hostId, agentId: record.definition.agentId }) }, revoke() { if (reserved) input.tools.revoke(reserved.execution); transient.delete(command.agent.agentId) } })
    const deadline = performance.now() + 150000
    while (true) {
      const receipt = await inspectCommand(command.commandId, command.handlerGeneration)
      if (receipt && receipt.state !== "accepted") {
        const event = await journals.forRun(command.runId).append(randomUUID(), "origin-receipt", { runId: command.runId, receipt })
        await journals.forRun(command.runId).acknowledge("bureau", { seq: event.seq, eventId: event.eventId, digest: event.digest })
        const preparation = (await journalEntries(journals.forRun(command.runId))).find(entry => entry.eventId === command.commandId)!
        await journals.forRun(command.runId).acknowledge("bureau", { seq: preparation.seq, eventId: preparation.eventId, digest: preparation.digest })
        return receipt
      }
      if (performance.now() >= deadline) return { commandId: command.commandId, execution: (reserved as OriginLaunch | null)?.execution ?? null, effective: null, state: "uncertain" }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const host: OrchestrationHost = {
    launch, launchRoot: launch, inspectCommand,
    onSettled(listener) { settled.add(listener); return () => { settled.delete(listener) } },
    snapshot() { return agents.orchestrationSnapshot(async snapshot => {
      const prepared = await preparations(), observed: HostAgent[] = [], receipts: LaunchReceipt[] = []
      for (const view of snapshot.agents) {
        if (view.record.version !== 3) continue
        const record = view.record, matches = prepared.filter(launch => launch.agent.agentId === record.definition.agentId), current = matches.find(launch => isDeepStrictEqual(launch.execution, executionOf(record))) ?? matches.at(-1)
        observed.push({ agent: { hostId: record.definition.hostId, agentId: record.definition.agentId }, execution: executionOf(record), phase: record.phase, toolsEnabled: !!current, lineage: current?.lineage ?? await lineage.read({ hostId: record.definition.hostId, agentId: record.definition.agentId }), membership: current ? { runId: current.runId, bindingEpoch: current.bindingEpoch } : null, cwd: record.definition.cwd, settings: record.settings })
      }
      for (const launch of prepared) {
        const events = await journalEntries(journals.forRun(launch.runId)), retained = events.find(event => event.kind === "origin-receipt" && parseOriginReceipt(event.payload).receipt.commandId === launch.commandId)
        if (retained) { receipts.push(parseOriginReceipt(retained.payload).receipt); continue }
        const command = snapshot.commands.find(view => view.command.commandId === launch.commandId && view.command.handlerGeneration === launch.execution.handlerGeneration)
        const state = !command || command.durability !== "verified" ? "uncertain" : command.command.state === "pending" ? "accepted" : command.command.result?.outcome === "started" || command.command.result?.outcome === "restored" ? "started" : command.command.result?.outcome === "interrupted" ? "interrupted" : "failed"
        const agent = snapshot.agents.find(view => view.record.definition.agentId === launch.agent.agentId && isDeepStrictEqual(executionOf(view.record), launch.execution))
        receipts.push({ commandId: launch.commandId, execution: launch.execution, effective: agent?.record.settings ?? launch.settings, state })
      }
      const replayFences = []
      for (const runId of await journals.list()) { const page = await journals.forRun(runId).metadata(); const reports = (await journalEntries(journals.forRun(runId))).filter(entry => entry.kind === "report-retained"); const acknowledged = await Promise.all(reports.map(report => journals.forRun(runId).acknowledged("bureau", report))); if (acknowledged.every(Boolean)) replayFences.push({ streamId: runId, runId, throughSeq: page.lastSeq, checkpoint: page.checkpoint }) }
      return { hostId: input.hostId, handlerGeneration: agents.handlerGeneration, backendChoices: (await readBackendConfig(input.root)).backends.map(backend => backend.id), agents: observed, receipts, replayFences }
    }) },
    submission(target, submissionId) { return agents.submission(tuple(target), submissionId) },
    submit(target, request, beforeAccepted) { return agents.submitAcp(tuple(target), request, beforeAccepted) },
    async stop(commandId, target) {
      await validate(target)
      const command = await agents.stop({ ...tuple(target), commandId })
      return { commandId, execution: target, state: command.command.result?.outcome === "stopped" ? "stopped" : "uncertain" }
    }
  }
  return { ...host, report: outbox.report, replay: outbox.replay, pins: () => loadOrchestrationPins(input.root), async invocation(target: ExecutionRef): Promise<Invocation> { await validate(target); const saved = transient.get(target.agentId); if (!saved || !isDeepStrictEqual(saved.execution, target)) fail("SESSION_INPUT_REQUIRED"); return captureInvocation(saved.invocation) } }
}