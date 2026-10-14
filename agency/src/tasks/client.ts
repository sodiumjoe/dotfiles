import { randomUUID } from "node:crypto"
import { hash, id, keys, object } from "../catalog/types.js"
import { BRIDGE_FRAME_BYTES } from "../bridge/protocol.js"
import type { HostRoute } from "../hosts/router.js"
import { TASK_PROTOCOL, parseTaskReply, validateTaskReply, type TaskRequest } from "./protocol.js"
import { parseTaskCreateInput } from "./service.js"
import { checkedTask, parseTaskRef, parseTaskReport, taskJsonBytes, TaskError, type TaskCreateInput, type TaskObservation, type TaskRef, type TaskReport } from "./types.js"
export type HostTaskClient = { create(hostId: string, input: TaskCreateInput, signal?: AbortSignal): Promise<TaskObservation>; inspect(ref: TaskRef, signal?: AbortSignal): Promise<TaskObservation>; report(ref: TaskRef, report: TaskReport, signal?: AbortSignal): Promise<TaskObservation>; close(): void }
export class TaskOutcomeUnknown extends TaskError {
  constructor(readonly ref: TaskRef, readonly cause: unknown) { super("OUTCOME_UNKNOWN", ref) }
}
export function createHostTaskClient(input: { localHostId: string; route(route: HostRoute, signal?: AbortSignal): Promise<unknown> }): HostTaskClient {
  checkedTask(() => hash(input.localHostId))
  const lifetime = new AbortController()
  async function send(ref: TaskRef, operation: { op: "create"; input: TaskCreateInput } | { op: "inspect"; taskId: string } | { op: "report"; taskId: string; report: TaskReport }, signal?: AbortSignal): Promise<TaskObservation> {
    const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])])
    const check = () => { if (combined.aborted) throw new TaskError("CANCELLED", ref) }
    check(); taskJsonBytes(operation, BRIDGE_FRAME_BYTES - 4096)
    let generation: string
    try {
      const owner = object(await input.route({ hostId: ref.hostId, channel: "host-identity", payload: {} }, combined))
      keys(owner, ["hostId", "handlerGeneration"])
      if (hash(owner.hostId) !== ref.hostId) throw new TaskError("STALE_HOST", ref)
      generation = id(owner.handlerGeneration)
    } catch (error) { check(); throw error instanceof TaskError ? error : new TaskError("TASKS_UNAVAILABLE", ref) }
    const request: TaskRequest = { protocol: TASK_PROTOCOL, requestId: randomUUID(), hostId: ref.hostId, handlerGeneration: generation, ...operation }
    taskJsonBytes(request, BRIDGE_FRAME_BYTES - 4096); check()
    let reply
    try {
      reply = parseTaskReply(await input.route({ hostId: ref.hostId, channel: operation.op === "inspect" ? "task-read" : "task-write", payload: request }, combined))
      validateTaskReply(reply, request)
    } catch (error) {
      if (operation.op !== "inspect") throw new TaskOutcomeUnknown(ref, error)
      check(); throw new TaskError("TASKS_UNAVAILABLE", ref)
    }
    if (!reply.ok) throw new TaskError(reply.error.code, ref)
    return reply.result
  }
  return {
    create(hostId, raw, signal) { return checkedTask(async () => { const request = parseTaskCreateInput(raw), ref = parseTaskRef({ hostId, taskId: request.taskId }); return send(ref, { op: "create", input: request }, signal) }) },
    async inspect(raw, signal) { const ref = parseTaskRef(raw); return send(ref, { op: "inspect", taskId: ref.taskId }, signal) },
    async report(raw, value, signal) { const ref = parseTaskRef(raw), report = parseTaskReport(value); return send(ref, { op: "report", taskId: ref.taskId, report }, signal) },
    close() { lifetime.abort() },
  }
}