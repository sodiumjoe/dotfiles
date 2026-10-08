import { parsePermissionEvent } from "./permission-routing.js"
import { parseStopCommand, parseStopReceipt } from "./receipts.js"
import { parseNotificationReceipt, parseNotificationRetry } from "./scheduler.js"
import { parseDeliveryTransition, parseReportTransition, parseReportAcknowledgment } from "../bureau/inbox.js"
import { parseWaitTransition } from "../bureau/waits.js"
import { parseOriginLaunch, parseOriginReceipt } from "./receipts.js"
import { parseAcceptedReport } from "./reports.js"
import { parseBureauRecord } from "../bureau/types.js"
import { createHash } from "node:crypto"
import { absolutePath, hash, id, keys, object, providerId, text, timestamp, type ProviderId } from "../catalog/types.js"
import { canonicalJson } from "../agent/session-config.js"

export const RECORD_BYTES = 1024 * 1024
export const QUEUE_BYTES = 2 * RECORD_BYTES
export const PAGE_LIMIT = 256
export const TERMINAL_AGE = 7 * 24 * 60 * 60 * 1000
export type AgentRef = { hostId: string; agentId: string }
export type ExecutionRef = AgentRef & { handlerGeneration: string; providerGeneration: string }
export type Lineage = { runId: string; parent: AgentRef; assignmentId: string }
export type GitInput = { remote: string; repository: string; baseOid: string }
export type GitExchange = GitInput & { branch: string }
export type AssignmentSpec = { parent: AgentRef; description: string; hostId: string; cwd: string; backendId: ProviderId; modelId: string; overrides: { modeId?: string; configValues?: Record<string, string | boolean> }; git: GitInput | null }
export type Validation = { argv: string[]; cwd: string; exitCode: number; result: string }
export type Report = { status: "completed" | "blocked" | "failed"; summary: string; issues: string[]; validation: Validation[]; git: (GitExchange & { resultOid: string; published: boolean }) | null }
export type AttemptState = "dispatch_pending" | "running" | "awaiting_report" | "completed" | "failed" | "interrupted" | "cancelled" | "uncertain"
export type AttemptRef = { runId: string; assignmentId: string; attemptId: string }
export type ReportInput = AttemptRef & { commandId: string; execution: ExecutionRef; report: Report }
export type EventRef = { seq: number; eventId: string; digest: string }
export type JournalEntry = EventRef & { kind: string; payload: unknown }
export type JournalPage = { checkpoint: number; lastSeq: number; entries: JournalEntry[]; nextCursor: number }
export type Journal = { append(eventId: string, kind: string, payload: unknown): Promise<JournalEntry>; read(after: number, limit: number): Promise<JournalPage>; retainedRead(after: number, limit: number): Promise<JournalPage>; metadata(): Promise<{ checkpoint: number; lastSeq: number }>; acknowledged(recipient: string, entry: EventRef): Promise<boolean>; acknowledge(recipient: string, entry: EventRef): Promise<void>; watermark(recipient: string): Promise<number>; compact(now: number): Promise<void>; compactTerminal(now: number): Promise<void> }
export class OrchestrationError extends Error {
  constructor(readonly code: string, readonly detail: unknown = null) { super(code); this.name = "OrchestrationError" }
}
export function fail(code = "INVALID_ORCHESTRATION"): never { throw new OrchestrationError(code) }
export function boundedText(value: unknown, max = 65536, empty = true): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0") || Buffer.byteLength(value) > max || (!empty && !value.length)) fail()
  return value
}
export function boundedArray<T>(value: unknown, parser: (input: unknown) => T, max = 128): T[] {
  if (!Array.isArray(value) || value.length > max) fail()
  return value.map(parser)
}
export function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail()
  return value as T
}
export function parseAgentRef(value: unknown): AgentRef {
  const v = object(value); keys(v, ["hostId", "agentId"])
  return { hostId: hash(v.hostId), agentId: id(v.agentId) }
}
export function parseExecutionRef(value: unknown): ExecutionRef {
  const v = object(value); keys(v, ["hostId", "agentId", "handlerGeneration", "providerGeneration"])
  return { hostId: hash(v.hostId), agentId: id(v.agentId), handlerGeneration: id(v.handlerGeneration), providerGeneration: id(v.providerGeneration) }
}
export function parseLineage(value: unknown): Lineage {
  const v = object(value); keys(v, ["runId", "parent", "assignmentId"])
  return { runId: id(v.runId), parent: parseAgentRef(v.parent), assignmentId: id(v.assignmentId) }
}
export function parseAttemptRef(value: unknown): AttemptRef {
  const v = object(value); keys(v, ["runId", "assignmentId", "attemptId"])
  return { runId: id(v.runId), assignmentId: id(v.assignmentId), attemptId: id(v.attemptId) }
}
export function parseEventRef(value: unknown): EventRef {
  const v = object(value); keys(v, ["seq", "eventId", "digest"])
  const seq = timestamp(v.seq); if (!seq) fail()
  return { seq, eventId: id(v.eventId), digest: hash(v.digest) }
}
export function parseOverrides(value: unknown): AssignmentSpec["overrides"] {
  const v = object(value)
  if (Object.keys(v).some(key => key !== "modeId" && key !== "configValues")) fail()
  const result: AssignmentSpec["overrides"] = {}
  if (v.modeId !== undefined) result.modeId = text(v.modeId)
  if (v.configValues !== undefined) {
    const values = object(v.configValues); if (Object.keys(values).length > 128) fail()
    result.configValues = Object.fromEntries(Object.entries(values).map(([key, item]) => [text(key), typeof item === "boolean" ? item : text(item, 4096)]))
  }
  return result
}
function oid(value: unknown): string {
  const v = text(value); if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v)) fail()
  return v
}
export function parseGitInput(value: unknown): GitInput {
  const v = object(value); keys(v, ["remote", "repository", "baseOid"])
  return { remote: text(v.remote, 4096), repository: absolutePath(v.repository), baseOid: oid(v.baseOid) }
}
export function parseGitExchange(value: unknown): GitExchange {
  const v = object(value), { branch, ...input } = v
  keys(v, ["remote", "repository", "baseOid", "branch"])
  const result = { ...parseGitInput(input), branch: text(branch, 4096) }
  if (!result.branch.startsWith("moon/agency/")) fail("INVALID_GIT_PREPARATION")
  return result
}
export function parseAssignmentSpec(value: unknown): AssignmentSpec {
  const v = object(value); keys(v, ["parent", "description", "hostId", "cwd", "backendId", "modelId", "overrides", "git"])
  return { parent: parseAgentRef(v.parent), description: boundedText(v.description, 65536, false), hostId: hash(v.hostId), cwd: absolutePath(v.cwd), backendId: providerId(v.backendId), modelId: text(v.modelId), overrides: parseOverrides(v.overrides), git: v.git === null ? null : parseGitInput(v.git) }
}
export function parseReport(value: unknown): Report {
  const v = object(value); keys(v, ["status", "summary", "issues", "validation", "git"])
  const validation = boundedArray(v.validation, input => {
    const entry = object(input); keys(entry, ["argv", "cwd", "exitCode", "result"])
    if (typeof entry.exitCode !== "number" || !Number.isSafeInteger(entry.exitCode)) fail()
    return { argv: boundedArray(entry.argv, arg => text(arg, 4096)), cwd: absolutePath(entry.cwd), exitCode: entry.exitCode, result: boundedText(entry.result) }
  })
  let git: Report["git"] = null
  if (v.git !== null) {
    const g = object(v.git); keys(g, ["remote", "repository", "baseOid", "branch", "resultOid", "published"])
    if (typeof g.published !== "boolean") fail()
    git = { remote: text(g.remote, 4096), repository: absolutePath(g.repository), baseOid: oid(g.baseOid), branch: text(g.branch, 4096), resultOid: oid(g.resultOid), published: g.published }
  }
  const result: Report = { status: enumValue(v.status, ["completed", "blocked", "failed"]), summary: boundedText(v.summary), issues: boundedArray(v.issues, entry => boundedText(entry)), validation, git }
  encode(result)
  return result
}
export function parseReportInput(value: unknown): ReportInput {
  const v = object(value); keys(v, ["runId", "assignmentId", "attemptId", "commandId", "execution", "report"])
  return { runId: id(v.runId), assignmentId: id(v.assignmentId), attemptId: id(v.attemptId), commandId: id(v.commandId), execution: parseExecutionRef(v.execution), report: parseReport(v.report) }
}
export function encode(value: unknown): Buffer {
  const result = Buffer.from(canonicalJson(value))
  if (result.length > RECORD_BYTES) fail("RECORD_TOO_LARGE")
  return result
}
export const canonicalDigest = (value: unknown): string => createHash("sha256").update(encode(value)).digest("hex")
export function parseEventPayload(kind: string, value: unknown): unknown {
  if (kind === "permission") return parsePermissionEvent(value)
  if (kind === "scoped-stop") return parseStopCommand(value)
  if (kind === "scoped-stop-receipt") return parseStopReceipt(value)
  if (kind === "origin-launch") return parseOriginLaunch(value)
  if (kind === "origin-receipt") return parseOriginReceipt(value)
  if (kind === "report-acknowledgment") return parseReportAcknowledgment(value)
  if (kind === "bureau-report") return parseReportTransition(value)
  if (kind === "bureau-delivery") return parseDeliveryTransition(value)
  if (kind === "notification-retry") return parseNotificationRetry(value)
  if (kind === "notification-receipt") return parseNotificationReceipt(value)
  if (kind === "bureau-wait") return parseWaitTransition(value)
  if (kind === "bureau-record") {
    const v = object(value); keys(v, ["previousDigest", "record"])
    return { previousDigest: v.previousDigest === null ? null : hash(v.previousDigest), record: parseBureauRecord(v.record) }
  }
  if (kind === "report") return parseReport(value)
  if (kind === "report-retained") return parseReportInput(value)
  if (kind === "lineage") {
    const v = object(value); keys(v, ["agent", "lineage"])
    return { agent: parseAgentRef(v.agent), lineage: parseLineage(v.lineage) }
  }
  if (kind === "acknowledgment") {
    const v = object(value); keys(v, ["recipient", "event"])
    return { recipient: text(v.recipient), event: parseEventRef(v.event) }
  }
  return fail("UNKNOWN_EVENT_KIND")
}
export function parseJournalEntry(value: unknown): JournalEntry {
  const v = object(value); keys(v, ["seq", "eventId", "digest", "kind", "payload"])
  const ref = parseEventRef({ seq: v.seq, eventId: v.eventId, digest: v.digest }), kind = text(v.kind), payload = parseEventPayload(kind, v.payload)
  if (canonicalDigest({ kind, payload }) !== ref.digest) fail("CORRUPT_JOURNAL")
  return { ...ref, kind, payload }
}