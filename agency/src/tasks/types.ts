import { absolutePath, hash, id, keys, object, type ProviderId } from "../catalog/types.js"
import { parseTuple } from "../agent/types.js"
import type { AgentTuple } from "../agent/types.js"
import type { RequestedSettings, JsonObject } from "../agent/session-config.js"

export type TaskRef = { hostId: string; taskId: string }
export type TaskReport = {
  outcome: "completed" | "blocked" | "failed"
  summary: string
  validation?: Array<{ argv: string[]; cwd: string; exitCode: number; result: string }>
  issues?: string[]
  git?: { repository: string; branch?: string; baseOid?: string; resultOid: string }
}
export type TaskRecord = {
  version: 1
  ref: TaskRef
  description: string
  parent: TaskRef | null
  status: "starting" | "running" | "unknown" | "failed" | "reported"
  stage: "launch" | "submit" | null
  launch: { commandId: string; handlerGeneration: string }
  submissionId: string
  session: AgentTuple | null
  resultPath: string
  issue: { code: string; message: string } | null
}
export type TaskObservation = {
  ref: TaskRef
  record: TaskRecord
  report: TaskReport | null
  runtime: "starting" | "running" | "idle" | "failed" | "interrupted" | "unknown"
  issue: { code: string; message: string } | null
}
export type TaskCreateInput = {
  taskId: string
  description: string
  parent?: TaskRef
  cwd: string
  backendId: ProviderId
  settings?: RequestedSettings
  nativeParams?: JsonObject
  text: string
}
export type TaskWaitResult =
  | { state: "reported" | "failed" | "pending"; observation: TaskObservation }
  | { state: "unavailable" | "cancelled"; ref: TaskRef }

export const TASK_RECORD_BYTES = 32 * 1024
export const TASK_REPORT_BYTES = 256 * 1024
export const taskMessages = {
  INVALID_INPUT: "Invalid task input",
  INPUT_TOO_LARGE: "Task input exceeds its byte limit",
  TASK_EXISTS: "Task ID is already reserved; inspect the existing task",
  TASK_NOT_FOUND: "Task does not exist",
  TASK_INCOMPLETE: "Task storage is incomplete; inspect the owner files",
  TASKS_UNAVAILABLE: "Task service is unavailable",
  STALE_HANDLER: "Handler generation changed",
  STALE_HOST: "Task host identity changed",
  NOT_READY: "Handler is not ready",
  OUTCOME_UNKNOWN: "Task mutation outcome is unknown; inspect the owner",
  CANCELLED: "Task request was cancelled",
} as const
export type TaskErrorCode = keyof typeof taskMessages
export class TaskError extends Error {
  constructor(readonly code: TaskErrorCode, readonly ref?: TaskRef) { super(taskMessages[code]) }
}
export function invalidTask(): never { throw new TaskError("INVALID_INPUT") }
export function checkedTask<T>(parse: () => T): T {
  try { return parse() } catch (error) { if (error instanceof TaskError) throw error; return invalidTask() }
}
export function taskText(value: unknown, max = TASK_REPORT_BYTES): string {
  if (typeof value !== "string" || !value.length || !value.isWellFormed()) return invalidTask()
  if (Buffer.byteLength(value) > max) throw new TaskError("INPUT_TOO_LARGE")
  return value
}
export function taskJsonBytes(value: unknown, max: number): void {
  checkedTask(() => {
    const visit = (v: unknown): void => {
      if (typeof v === "string") { if (!v.isWellFormed()) invalidTask(); return }
      if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return
      if (Array.isArray(v)) { v.forEach(visit); return }
      if (typeof v === "object" && v !== null) { for (const [key, item] of Object.entries(v)) { visit(key); visit(item) }; return }
      invalidTask()
    }
    visit(value)
    if (Buffer.byteLength(JSON.stringify(value)) > max) throw new TaskError("INPUT_TOO_LARGE")
  })
}
export function taskKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalidTask()
}
export function parseTaskRef(raw: unknown): TaskRef {
  return checkedTask(() => { const v = object(raw); keys(v, ["hostId", "taskId"]); return { hostId: hash(v.hostId), taskId: id(v.taskId) } })
}
export function taskId(raw: unknown): string { return checkedTask(() => id(raw)) }
export function parseTaskIssue(raw: unknown): TaskRecord["issue"] {
  if (raw === null) return null
  return checkedTask(() => { const v = object(raw); keys(v, ["code", "message"]); return { code: taskText(v.code, 256), message: taskText(v.message, 512) } })
}
export function parseTaskRecord(raw: unknown): TaskRecord {
  return checkedTask(() => {
    taskJsonBytes(raw, TASK_RECORD_BYTES)
    const v = object(raw)
    keys(v, ["version", "ref", "description", "parent", "status", "stage", "launch", "submissionId", "session", "resultPath", "issue"])
    if (v.version !== 1 || !["starting", "running", "unknown", "failed", "reported"].includes(String(v.status)) || v.stage !== null && v.stage !== "launch" && v.stage !== "submit") invalidTask()
    const ref = parseTaskRef(v.ref), launch = object(v.launch)
    keys(launch, ["commandId", "handlerGeneration"])
    const handlerGeneration = id(launch.handlerGeneration), session = v.session === null ? null : parseTuple(v.session)
    if (v.resultPath !== `tasks/${ref.taskId}/report.json` || session && session.handlerGeneration !== handlerGeneration) invalidTask()
    return { version: 1, ref, description: taskText(v.description, 16 * 1024), parent: v.parent === null ? null : parseTaskRef(v.parent),
      status: v.status as TaskRecord["status"], stage: v.stage as TaskRecord["stage"], launch: { commandId: id(launch.commandId), handlerGeneration },
      submissionId: id(v.submissionId), session, resultPath: v.resultPath as string, issue: parseTaskIssue(v.issue) }
  })
}
export function parseTaskReport(raw: unknown): TaskReport {
  return checkedTask(() => {
    taskJsonBytes(raw, TASK_REPORT_BYTES)
    const v = object(raw)
    taskKeys(v, ["outcome", "summary"], ["validation", "issues", "git"])
    if (v.outcome !== "completed" && v.outcome !== "blocked" && v.outcome !== "failed") invalidTask()
    const report: TaskReport = { outcome: v.outcome, summary: taskText(v.summary) }
    const list = (value: unknown): unknown[] => { if (!Array.isArray(value) || value.length > 128) return invalidTask(); return value }
    if (v.validation !== undefined) report.validation = list(v.validation).map(raw => {
      const entry = object(raw); keys(entry, ["argv", "cwd", "exitCode", "result"])
      if (!Number.isSafeInteger(entry.exitCode)) invalidTask()
      return { argv: list(entry.argv).map(arg => typeof arg === "string" && arg.length === 0 ? "" : taskText(arg)), cwd: absolutePath(entry.cwd), exitCode: entry.exitCode as number, result: taskText(entry.result) }
    })
    if (v.issues !== undefined) report.issues = list(v.issues).map(value => taskText(value))
    if (v.git !== undefined) {
      const git = object(v.git); taskKeys(git, ["repository", "resultOid"], ["branch", "baseOid"])
      const oid = (raw: unknown): string => { const result = taskText(raw, 64); if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result)) return invalidTask(); return result }
      report.git = { repository: taskText(git.repository), resultOid: oid(git.resultOid) }
      if (git.branch !== undefined) report.git.branch = taskText(git.branch)
      if (git.baseOid !== undefined) { report.git.baseOid = oid(git.baseOid); if (report.git.baseOid.length !== report.git.resultOid.length) invalidTask() }
    }
    return report
  })
}