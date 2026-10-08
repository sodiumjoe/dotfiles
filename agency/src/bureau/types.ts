import { parseRequestedSettings, type RequestedSettings } from "../agent/session-config.js"
import { hash, id, keys, object, timestamp } from "../catalog/types.js"
import { boundedText, enumValue, fail, parseAgentRef, parseEventRef, parseAssignmentSpec, parseAttemptRef, parseExecutionRef, parseLineage, boundedArray, type AssignmentSpec, type AttemptRef, type AttemptState, type ExecutionRef, type Lineage, type AgentRef, type EventRef } from "../orchestration/types.js"

export type RunRecord = { version: 1; runId: string; createCommandId: string; root: AgentRef; execution: ExecutionRef | null; objective: string; state: "starting" | "active" | "cancelled" | "completed" | "forgotten"; bindingEpoch: string; journal: EventRef | null }
export function parseRunRecord(value: unknown): RunRecord {
  const v = object(value); keys(v, ["version", "runId", "createCommandId", "root", "execution", "objective", "state", "bindingEpoch", "journal"])
  if (v.version !== 1) fail()
  return { version: 1, runId: id(v.runId), createCommandId: id(v.createCommandId), root: parseAgentRef(v.root), execution: v.execution === null ? null : parseExecutionRef(v.execution), objective: boundedText(v.objective, 65536, false), state: enumValue(v.state, ["starting", "active", "cancelled", "completed", "forgotten"]), bindingEpoch: id(v.bindingEpoch), journal: v.journal === null ? null : parseEventRef(v.journal) }
}

export type AssignmentRecord = { version: 1; assignmentId: string; runId: string; spec: AssignmentSpec; attemptIds: string[]; activeAttemptId: string; journal: EventRef | null }
export type AttemptRecord = { version: 1; ref: AttemptRef; child: AgentRef; lineage: Lineage; state: AttemptState; launchCommandId: string; submissionId: string; handlerGeneration: string; execution: ExecutionRef | null; effective: RequestedSettings | null; retryMode: "new" | "restore" | "replace"; journal: EventRef | null }
export type AssignmentView = { assignmentId: string; runId: string; agent: AgentRef; spec: AssignmentSpec; lineage: Lineage; attempt: AttemptRecord; attemptIds: string[]; journalCursor: number }
export type RunView = RunRecord & { assignments: AssignmentView[]; nextAssignmentCursor: string | null; journalCursor: number }
export type CommandRecord = { version: 1; commandId: string; runId: string; op: "start" | "restore-root" | "begin" | "delegate" | "retry" | "cancel" | "close" | "forget"; digest: string; state: "pending" | "completed"; targetId: string; handlerGeneration: string | null; launchCommandId: string | null; result: RunView | AssignmentView | null; journal: EventRef | null }
export type BureauRecord = { kind: "run"; value: RunRecord } | { kind: "assignment"; value: AssignmentRecord } | { kind: "attempt"; value: AttemptRecord } | { kind: "command"; value: CommandRecord }
const journalRef = (v: unknown) => v === null ? null : parseEventRef(v)
export function parseAssignmentRecord(value: unknown): AssignmentRecord {
  const v = object(value); keys(v, ["version", "assignmentId", "runId", "spec", "attemptIds", "activeAttemptId", "journal"])
  if (v.version !== 1) fail()
  const attemptIds = boundedArray(v.attemptIds, id, 128), activeAttemptId = id(v.activeAttemptId)
  if (!attemptIds.includes(activeAttemptId) || new Set(attemptIds).size !== attemptIds.length) fail()
  return { version: 1, assignmentId: id(v.assignmentId), runId: id(v.runId), spec: parseAssignmentSpec(v.spec), attemptIds, activeAttemptId, journal: journalRef(v.journal) }
}
export function parseAttemptRecord(value: unknown): AttemptRecord {
  const v = object(value); keys(v, ["version", "ref", "child", "lineage", "state", "launchCommandId", "submissionId", "handlerGeneration", "execution", "effective", "retryMode", "journal"])
  if (v.version !== 1) fail()
  const ref = parseAttemptRef(v.ref), lineage = parseLineage(v.lineage), child = parseAgentRef(v.child), execution = v.execution === null ? null : parseExecutionRef(v.execution)
  if (lineage.runId !== ref.runId || lineage.assignmentId !== ref.assignmentId || execution && (execution.agentId !== child.agentId || execution.hostId !== child.hostId)) fail()
  return { version: 1, ref, child, lineage, state: enumValue(v.state, ["dispatch_pending", "running", "awaiting_report", "completed", "failed", "interrupted", "cancelled", "uncertain"]), launchCommandId: id(v.launchCommandId), submissionId: id(v.submissionId), handlerGeneration: id(v.handlerGeneration), execution, effective: v.effective === null ? null : parseRequestedSettings(v.effective), retryMode: enumValue(v.retryMode, ["new", "restore", "replace"]), journal: journalRef(v.journal) }
}
export function parseAssignmentView(value: unknown): AssignmentView {
  const v = object(value); keys(v, ["assignmentId", "runId", "agent", "spec", "lineage", "attempt", "attemptIds", "journalCursor"])
  return { assignmentId: id(v.assignmentId), runId: id(v.runId), agent: parseAgentRef(v.agent), spec: parseAssignmentSpec(v.spec), lineage: parseLineage(v.lineage), attempt: parseAttemptRecord(v.attempt), attemptIds: boundedArray(v.attemptIds, id), journalCursor: timestamp(v.journalCursor) }
}
export function parseRunView(value: unknown): RunView {
  const v = object(value), { assignments, nextAssignmentCursor, journalCursor, ...run } = v
  return { ...parseRunRecord(run), assignments: boundedArray(assignments, parseAssignmentView, 256), nextAssignmentCursor: nextAssignmentCursor === null ? null : id(nextAssignmentCursor), journalCursor: timestamp(journalCursor) }
}
export function parseCommandRecord(value: unknown): CommandRecord {
  const v = object(value); keys(v, ["version", "commandId", "runId", "op", "digest", "state", "targetId", "handlerGeneration", "launchCommandId", "result", "journal"])
  if (v.version !== 1) fail()
  const result = v.result === null ? null : Object.hasOwn(object(v.result), "assignmentId") ? parseAssignmentView(v.result) : parseRunView(v.result)
  const state = enumValue(v.state, ["pending", "completed"])
  if ((state === "completed") !== (result !== null)) fail()
  return { version: 1, commandId: id(v.commandId), runId: id(v.runId), op: enumValue(v.op, ["start", "restore-root", "begin", "delegate", "retry", "cancel", "close", "forget"]), digest: hash(v.digest), state, targetId: id(v.targetId), handlerGeneration: v.handlerGeneration === null ? null : id(v.handlerGeneration), launchCommandId: v.launchCommandId === null ? null : id(v.launchCommandId), result, journal: journalRef(v.journal) }
}
export function parseBureauRecord(value: unknown): BureauRecord {
  const v = object(value); keys(v, ["kind", "value"])
  switch (v.kind) {
    case "run": return { kind: "run", value: parseRunRecord(v.value) }
    case "assignment": return { kind: "assignment", value: parseAssignmentRecord(v.value) }
    case "attempt": return { kind: "attempt", value: parseAttemptRecord(v.value) }
    case "command": return { kind: "command", value: parseCommandRecord(v.value) }
    default: return fail()
  }
}