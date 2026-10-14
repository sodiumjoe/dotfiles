import { isDeepStrictEqual } from "node:util"
import { hash, id, keys, object } from "../catalog/types.js"
import { BRIDGE_FRAME_BYTES } from "../bridge/protocol.js"
import { checkedTask, invalidTask, parseTaskRecord, parseTaskRef, parseTaskReport, parseTaskIssue, taskId, taskJsonBytes, taskKeys, taskMessages } from "./types.js"
import { parseTaskCreateInput } from "./service.js"
import type { TaskCreateInput, TaskReport, TaskObservation, TaskErrorCode, TaskRef } from "./types.js"
export const TASK_PROTOCOL = "agency-task/1" as const
export type TaskRequest = { protocol: typeof TASK_PROTOCOL; requestId: string; hostId: string; handlerGeneration: string } & (
  { op: "create"; input: TaskCreateInput } | { op: "inspect"; taskId: string } | { op: "report"; taskId: string; report: TaskReport })
export type TaskReply = Pick<TaskRequest, "protocol" | "requestId" | "hostId" | "handlerGeneration" | "op"> & (
  { ok: true; result: TaskObservation } | { ok: false; error: { code: TaskErrorCode; message: string; ref?: TaskRef } })
export function taskRequestRef(request: TaskRequest): TaskRef { return { hostId: request.hostId, taskId: request.op === "create" ? request.input.taskId : request.taskId } }
export function parseTaskRequest(raw: unknown): TaskRequest {
  return checkedTask(() => {
    taskJsonBytes(raw, BRIDGE_FRAME_BYTES - 4096)
    const v = object(raw), common = parseIdentity(v)
    if (v.op === "create") { keys(v, ["protocol", "requestId", "hostId", "handlerGeneration", "op", "input"]); return { ...common, op: "create", input: parseTaskCreateInput(v.input) } }
    if (v.op === "inspect") { keys(v, ["protocol", "requestId", "hostId", "handlerGeneration", "op", "taskId"]); return { ...common, op: "inspect", taskId: taskId(v.taskId) } }
    if (v.op === "report") { keys(v, ["protocol", "requestId", "hostId", "handlerGeneration", "op", "taskId", "report"]); return { ...common, op: "report", taskId: taskId(v.taskId), report: parseTaskReport(v.report) } }
    return invalidTask()
  })
}
function parseIdentity(v: Record<string, unknown>): Pick<TaskRequest, "protocol" | "requestId" | "hostId" | "handlerGeneration"> {
  if (v.protocol !== TASK_PROTOCOL) return invalidTask()
  return { protocol: TASK_PROTOCOL, requestId: id(v.requestId), hostId: hash(v.hostId), handlerGeneration: id(v.handlerGeneration) }
}
export function parseTaskReply(raw: unknown): TaskReply {
  return checkedTask(() => {
    const v = object(raw), identity = parseIdentity(v)
    if (v.op !== "create" && v.op !== "inspect" && v.op !== "report") return invalidTask()
    const common = { ...identity, op: v.op as TaskRequest["op"] }
    keys(v, ["protocol", "requestId", "hostId", "handlerGeneration", "op", "ok", v.ok ? "result" : "error"])
    if (v.ok === false) {
      const e = object(v.error); taskKeys(e, ["code", "message"], ["ref"])
      if (typeof e.code !== "string" || !Object.hasOwn(taskMessages, e.code) || e.message !== taskMessages[e.code as TaskErrorCode]) invalidTask()
      return { ...common, ok: false, error: { code: e.code as TaskErrorCode, message: e.message as string, ...(e.ref === undefined ? {} : { ref: parseTaskRef(e.ref) }) } }
    }
    if (v.ok !== true) return invalidTask()
    const r = object(v.result); keys(r, ["ref", "record", "report", "runtime", "issue"])
    const ref = parseTaskRef(r.ref), record = parseTaskRecord(r.record)
    if (!isDeepStrictEqual(ref, record.ref) || ref.hostId !== identity.hostId || !["starting", "running", "idle", "failed", "interrupted", "unknown"].includes(String(r.runtime))) return invalidTask()
    return { ...common, ok: true, result: { ref, record, report: r.report === null ? null : parseTaskReport(r.report), runtime: r.runtime as TaskObservation["runtime"], issue: parseTaskIssue(r.issue) } }
  })
}
export function validateTaskReply(reply: TaskReply, request: TaskRequest): void {
  if (reply.requestId !== request.requestId || reply.hostId !== request.hostId || reply.handlerGeneration !== request.handlerGeneration || reply.op !== request.op) invalidTask()
  const actual = reply.ok ? reply.result.ref : reply.error.ref
  if (actual && !isDeepStrictEqual(actual, taskRequestRef(request)) || !actual && reply.ok) invalidTask()
}