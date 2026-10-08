import { id, keys, object, hash } from "../catalog/types.js"
import { parseRequestedSettings, type RequestedSettings } from "../agent/session-config.js"
import { createBureauStore } from "../bureau/store.js"
import { unresolved } from "../bureau/reducer.js"
import { createJournalPool } from "./journal.js"
import { journalEntries } from "./reports.js"
import { enumValue, fail, parseAgentRef, parseAttemptRef, parseExecutionRef, parseLineage, type AgentRef, type AttemptRef, type ExecutionRef, type Lineage } from "./types.js"
import type { LaunchReceipt } from "../bureau/host.js"

export type OriginLaunch = { commandId: string; runId: string; agent: AgentRef; execution: ExecutionRef; launchAttemptId: string; lineage: Lineage | null; attempt: AttemptRef | null; bindingEpoch: string; invocationDigest: string; toolsDigest: string; settings: RequestedSettings }
export function parseOriginLaunch(raw: unknown): OriginLaunch {
  const v = object(raw); keys(v, ["commandId", "runId", "agent", "execution", "launchAttemptId", "lineage", "attempt", "bindingEpoch", "invocationDigest", "toolsDigest", "settings"])
  const agent = parseAgentRef(v.agent), execution = parseExecutionRef(v.execution), runId = id(v.runId), lineage = v.lineage === null ? null : parseLineage(v.lineage), attempt = v.attempt === null ? null : parseAttemptRef(v.attempt)
  if (agent.agentId !== execution.agentId || agent.hostId !== execution.hostId || lineage && lineage.runId !== runId || attempt && (attempt.runId !== runId || attempt.assignmentId !== lineage?.assignmentId)) fail("INVALID_ORIGIN")
  return { commandId: id(v.commandId), runId, agent, execution, launchAttemptId: id(v.launchAttemptId), lineage, attempt, bindingEpoch: id(v.bindingEpoch), invocationDigest: hash(v.invocationDigest), toolsDigest: hash(v.toolsDigest), settings: parseRequestedSettings(v.settings) }
}
export function parseOriginReceipt(raw: unknown): { runId: string; receipt: LaunchReceipt } {
  const v = object(raw); keys(v, ["runId", "receipt"])
  const r = object(v.receipt); keys(r, ["commandId", "execution", "effective", "state"])
  return { runId: id(v.runId), receipt: { commandId: id(r.commandId), execution: r.execution === null ? null : parseExecutionRef(r.execution), effective: r.effective === null ? null : parseRequestedSettings(r.effective), state: enumValue(r.state, ["accepted", "started", "failed", "interrupted", "uncertain"]) } }
}
export async function loadOrchestrationPins(root: string): Promise<{ paths: string[] }> {
  const store = createBureauStore(root), runs = new Map((await store.listRuns()).map(run => [run.runId, run])), attempts = await store.listAttempts(), commands = await store.listCommands(), paths = new Set<string>()
  for (const run of runs.values()) if (run.state === "forgotten") await store.writeRun(run, run)
  const pinAgent = (agentId: string) => paths.add(`agents/records/${agentId}.json`)
  for (const run of runs.values()) if (!["completed", "forgotten"].includes(run.state)) pinAgent(run.root.agentId)
  for (const attempt of attempts) if (unresolved(attempt.state)) { pinAgent(attempt.child.agentId); paths.add(`agents/commands/${attempt.launchCommandId}.json`) }
  for (const command of commands) if (command.state === "pending" && command.launchCommandId) paths.add(`agents/commands/${command.launchCommandId}.json`)
  const waits = await store.listWaits(), deliveries = await store.listDeliveries(), inbox = await store.listInbox()
  const referenced = new Set<string>()
  for (const wait of waits) if (!wait.ended) { pinAgent(wait.target.agentId); for (const assignmentId of wait.input.assignmentIds) for (const attempt of attempts) if (attempt.ref.assignmentId === assignmentId) referenced.add(attempt.ref.attemptId) }
  for (const entry of inbox) {
    const delivered = deliveries.some(delivery => delivery.runId === entry.runId && delivery.sources.some(source => source.eventId === entry.eventId && source.digest === entry.source.digest) && delivery.state === "delivered" && delivery.channel === "prompt")
    if (!delivered) { pinAgent(entry.parent.agentId); referenced.add(entry.report.attemptId) }
  }
  for (const attempt of attempts) if (referenced.has(attempt.ref.attemptId)) { pinAgent(attempt.child.agentId); paths.add(`agents/commands/${attempt.launchCommandId}.json`) }
  const origins = createJournalPool(root, undefined, Date.now, "origin")
  for (const runId of await origins.list()) {
    const journal = origins.forRun(runId), entries = await journalEntries(journal), unacknowledged = new Set<number>()
    for (const entry of entries) if (entry.kind === "report-retained" && !await journal.acknowledged("bureau", entry)) unacknowledged.add(entry.seq)
    for (const entry of entries) if (entry.kind === "origin-launch") {
      const launch = parseOriginLaunch(entry.payload), run = runs.get(runId), attempt = launch.attempt && attempts.find(attempt => attempt.ref.attemptId === launch.attempt!.attemptId)
      const pendingReport = entries.some(event => event.kind === "report-retained" && unacknowledged.has(event.seq) && object(event.payload).execution && object(object(event.payload).execution).providerGeneration === launch.execution.providerGeneration)
      if (!run || !["completed", "forgotten"].includes(run.state) || attempt && unresolved(attempt.state) || commands.some(command => command.launchCommandId === launch.commandId && command.state === "pending") || referenced.has(launch.attempt?.attemptId ?? "") || pendingReport) {
        pinAgent(launch.agent.agentId); paths.add(`agents/commands/${launch.commandId}.json`); paths.add(`launches/${launch.launchAttemptId}.json`)
      }
    }
  }
  return { paths: [...paths].sort() }
}