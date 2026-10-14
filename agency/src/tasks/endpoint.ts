import { randomUUID } from "node:crypto"
import { hash, id, object } from "../catalog/types.js"
import type { HandlerBridge } from "../bridge/server.js"
import type { TaskService } from "./service.js"
import { TASK_PROTOCOL, parseTaskRequest, taskRequestRef, type TaskRequest, type TaskReply } from "./protocol.js"
import { TaskError, type TaskRef } from "./types.js"

export function registerTaskEndpoint(input: { bridge: HandlerBridge; service(): TaskService | undefined; hostId: string; generation: string; ready(): boolean }): () => void {
  return input.bridge.register(["task-read", "task-write"], async ({ channel, payload }): Promise<TaskReply> => {
    let request: TaskRequest | undefined, ref: TaskRef | undefined
    try {
      request = parseTaskRequest(payload); ref = taskRequestRef(request)
      if ((request.op === "inspect") !== (channel === "task-read")) throw new TaskError("INVALID_INPUT", ref)
      if (request.hostId !== input.hostId) throw new TaskError("STALE_HOST", ref)
      if (request.handlerGeneration !== input.generation) throw new TaskError("STALE_HANDLER", ref)
      if (!input.ready()) throw new TaskError("NOT_READY", ref)
      const service = input.service()
      if (!service) throw new TaskError("TASKS_UNAVAILABLE", ref)
      const result = request.op === "inspect" ? await service.inspect(request.taskId) : request.op === "create" ? await service.create(request.input) : await service.report(request.taskId, request.report)
      return { protocol: TASK_PROTOCOL, requestId: request.requestId, hostId: request.hostId, handlerGeneration: request.handlerGeneration, op: request.op, ok: true, result }
    } catch (error) {
      const failure = error instanceof TaskError ? error : new TaskError("TASK_INCOMPLETE", ref)
      const fallback = (() => { try { const value = object(payload); return { requestId: id(value.requestId), hostId: hash(value.hostId), handlerGeneration: id(value.handlerGeneration), op: ["create", "inspect", "report"].includes(String(value.op)) ? value.op as TaskRequest["op"] : "inspect" as const } } catch { return { requestId: randomUUID(), hostId: input.hostId, handlerGeneration: input.generation, op: "inspect" as const } } })()
      return { protocol: TASK_PROTOCOL, ...fallback, ok: false, error: { code: failure.code, message: failure.message, ...(ref || failure.ref ? { ref: ref ?? failure.ref! } : {}) } }
    }
  })
}