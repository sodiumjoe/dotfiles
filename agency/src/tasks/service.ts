import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { isDeepStrictEqual } from "node:util"
import { BRIDGE_FRAME_BYTES } from "../bridge/protocol.js"
import { absolutePath, hash, id, object, providerId } from "../catalog/types.js"
import { AgentError, agentFailure, type AgentTuple, type CommandView } from "../agent/types.js"
import { sessionInputs, type AgentService } from "../agent/service.js"
import { EDITOR_TURN_LIMITS, validateTurnInput } from "../agent/session-events.js"
import { canonicalJson, parseRequestedSettings } from "../agent/session-config.js"
import { parseLaunchEnvironment } from "../agent/environment.js"
import { checkedTask, invalidTask, parseTaskRef, parseTaskReport, taskId, taskJsonBytes, taskKeys, taskText, TaskError, type TaskRecord } from "./types.js"
import type { LaunchEnvironment } from "../agent/environment.js"
import type { JsonObject } from "../agent/session-config.js"
import type { TaskStore } from "./store.js"
import type { TaskRef, TaskCreateInput, TaskReport, TaskObservation } from "./types.js"
export type TaskRuntime = Pick<AgentService, "beginSession" | "commandReceipt" | "submit" | "submission" | "sessionRecord">
export type TaskService = { create(input: TaskCreateInput): Promise<TaskObservation>; inspect(taskId: string): Promise<TaskObservation>; report(taskId: string, report: TaskReport): Promise<TaskObservation>; close(): Promise<void> }
export type TaskServiceOptions = { store: TaskStore; runtime: TaskRuntime; hostId: string; generation: string; environment(): LaunchEnvironment; descriptor?(ref: TaskRef): JsonObject }
export function parseTaskCreateInput(raw: unknown): TaskCreateInput {
  return checkedTask(() => {
    taskJsonBytes(raw, BRIDGE_FRAME_BYTES - 4096)
    const v = object(raw); taskKeys(v, ["taskId", "description", "cwd", "backendId", "text"], ["parent", "settings", "nativeParams"])
    const cwd = absolutePath(v.cwd), nativeParams = v.nativeParams === undefined ? undefined : JSON.parse(canonicalJson(object(v.nativeParams))) as JsonObject
    sessionInputs(cwd, nativeParams)
    try { validateTurnInput(v.text as string, EDITOR_TURN_LIMITS) } catch (error) { if (error instanceof AgentError && error.code === "INPUT_TOO_LARGE") throw new TaskError("INPUT_TOO_LARGE"); throw error }
    return { taskId: taskId(v.taskId), description: taskText(v.description, 16 * 1024), cwd, backendId: providerId(v.backendId), text: v.text as string,
      ...(v.parent === undefined ? {} : { parent: parseTaskRef(v.parent) }), ...(v.settings === undefined ? {} : { settings: parseRequestedSettings(v.settings) }), ...(nativeParams ? { nativeParams } : {}) }
  })
}
export function createTaskService(input: TaskServiceOptions): TaskService {
  const hostId = checkedTask(() => hash(input.hostId)), generation = checkedTask(() => id(input.generation)), { store, runtime } = input
  const lifetime = new AbortController(), pipelines = new Map<string, Promise<void>>()
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    lifetime.signal.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const finish = (operation: () => void) => { clearTimeout(timer); lifetime.signal.removeEventListener("abort", abort); operation() }
      const abort = () => finish(() => reject(new TaskError("CANCELLED")))
      const timer = setTimeout(() => finish(() => reject(new TaskError("TASKS_UNAVAILABLE"))), 10000)
      lifetime.signal.addEventListener("abort", abort, { once: true })
      Promise.resolve().then(() => { lifetime.signal.throwIfAborted(); return operation() }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
    })
  }
  const issueFor = (error: unknown): NonNullable<TaskRecord["issue"]> => {
    if (error instanceof AgentError) { const failure = agentFailure(error); return { code: failure.code, message: failure.message } }
    return { code: "OUTCOME_UNKNOWN", message: "Task mutation outcome is unknown; inspect the owner" }
  }
  async function update(task: string, patch: Partial<Pick<TaskRecord, "status" | "stage" | "session" | "issue">>): Promise<void> {
    await bounded(() => store.serialize(task, async () => {
      lifetime.signal.throwIfAborted()
      const prior = await store.read(task)
      if (!prior) throw new TaskError("TASK_NOT_FOUND", { hostId, taskId: task })
      const reported = prior.status === "reported" || await store.readReport(task) !== null
      lifetime.signal.throwIfAborted()
      await store.writeRecord({ ...prior, ...patch, ...(reported ? { status: "reported", stage: null } : {}) })
    }))
  }
  function started(view: CommandView | null): AgentTuple | null {
    if (!view || view.durability !== "verified") throw new TaskError("OUTCOME_UNKNOWN")
    if (view.command.state === "pending") return null
    if (view.command.state !== "completed" || view.command.result?.outcome !== "started" || !view.command.result.target) {
      if (view.command.result?.failure) throw new AgentError(view.command.result.failure.code)
      throw new TaskError("OUTCOME_UNKNOWN")
    }
    const target = view.command.result.target
    if (view.command.handlerGeneration !== generation || target.handlerGeneration !== generation) throw new TaskError("OUTCOME_UNKNOWN")
    return target
  }
  async function execute(record: TaskRecord, request: TaskCreateInput, nativeParams: JsonObject, environment: LaunchEnvironment): Promise<void> {
    try {
      lifetime.signal.throwIfAborted()
      let receipt = await bounded(() => runtime.beginSession({ commandId: record.launch.commandId, cwd: request.cwd, backendId: request.backendId, selection: request.settings ?? {}, nativeParams, environment }))
      let target = started(receipt)
      while (!target) {
        await delay(25, undefined, { signal: lifetime.signal })
        const next = await bounded(() => runtime.commandReceipt(record.launch.commandId, generation))
        target = started(next)
        if (next) receipt = next
      }
      await update(record.ref.taskId, { session: target, stage: "submit" })
      lifetime.signal.throwIfAborted()
      await bounded(() => runtime.submit(target, { submissionId: record.submissionId, text: request.text, limits: EDITOR_TURN_LIMITS }))
      await update(record.ref.taskId, { status: "running", stage: null, issue: null })
    } catch (error) {
      if (lifetime.signal.aborted) return
      await update(record.ref.taskId, { status: error instanceof AgentError && !["INCOMPLETE", "UNAVAILABLE", "CLEANUP_UNVERIFIED"].includes(error.code) ? "failed" : "unknown", issue: issueFor(error) }).catch(() => undefined)
    }
  }
  async function inspect(raw: string): Promise<TaskObservation> {
    const task = taskId(raw), ref = { hostId, taskId: task }, report = await store.readReport(task), record = await store.read(task)
    if (!record) throw new TaskError("TASK_NOT_FOUND", ref)
    const observation: TaskObservation = { ref, record, report, runtime: "unknown", issue: record.issue }
    if (report || lifetime.signal.aborted || record.launch.handlerGeneration !== generation) return observation
    if (record.status === "failed") return { ...observation, runtime: "failed" }
    try {
      let target = record.session
      if (!target) {
        const receipt = await bounded(() => runtime.commandReceipt(record.launch.commandId, record.launch.handlerGeneration))
        if (receipt?.durability !== "verified") return observation
        if (receipt.command.result?.failure) return { ...observation, runtime: "failed", issue: issueFor(new AgentError(receipt.command.result.failure.code)) }
        target = receipt.command.result?.outcome === "started" ? receipt.command.result.target : null
        if (!target) return { ...observation, runtime: pipelines.has(task) && receipt.command.state === "pending" ? "starting" : "unknown" }
      }
      if (target.handlerGeneration !== generation) return observation
      const view = await bounded(() => runtime.sessionRecord(target.agentId))
      const actual = view?.record.launch
      if (!view || !actual || !isDeepStrictEqual({ agentId: view.record.definition.agentId, handlerGeneration: actual.handlerGeneration, providerGeneration: actual.providerGeneration }, target)) return observation
      if (view.record.phase === "failed" || view.record.phase === "interrupted") return { ...observation, runtime: view.record.phase, issue: view.record.failure ? issueFor(new AgentError(view.record.failure.code)) : observation.issue }
      if (!view.live || view.record.phase === "recoverable") return observation
      const submission = await bounded(() => runtime.submission(target, record.submissionId))
      if (!submission) return observation
      if (submission.state === "failed") return { ...observation, runtime: "failed", issue: submission.failure ? issueFor(new AgentError(submission.failure.code)) : observation.issue }
      return { ...observation, runtime: submission.state === "completed" ? "idle" : "running" }
    } catch { return observation }
  }
  return {
    async create(raw) {
      if (lifetime.signal.aborted) throw new TaskError("TASKS_UNAVAILABLE")
      const request = parseTaskCreateInput(raw), ref = { hostId, taskId: request.taskId }, environment = checkedTask(() => parseLaunchEnvironment(input.environment()))
      const supplied = sessionInputs(request.cwd, request.nativeParams)
      if (supplied.names.includes("agency_tasks")) invalidTask()
      const nativeParams = input.descriptor ? sessionInputs(request.cwd, { ...supplied.params, mcpServers: [...supplied.params.mcpServers as JsonObject[], input.descriptor(ref)] }).params : supplied.params
      taskJsonBytes({ ...request, nativeParams }, BRIDGE_FRAME_BYTES - 4096)
      const record: TaskRecord = { version: 1, ref, description: request.description, parent: request.parent ?? null, status: "starting", stage: "launch", launch: { commandId: randomUUID(), handlerGeneration: generation }, submissionId: randomUUID(), session: null, resultPath: `tasks/${ref.taskId}/report.json`, issue: null }
      lifetime.signal.throwIfAborted()
      await store.reserve(record)
      const job = Promise.resolve().then(() => execute(record, request, nativeParams, environment))
      pipelines.set(ref.taskId, job)
      void job.finally(() => pipelines.delete(ref.taskId)).catch(() => undefined)
      return { ref, record, report: null, runtime: "starting", issue: null }
    },
    inspect,
    async report(raw, value) {
      const task = taskId(raw), ref = { hostId, taskId: task }, report = parseTaskReport(value)
      if (lifetime.signal.aborted) throw new TaskError("TASKS_UNAVAILABLE", ref)
      try {
        await store.serialize(task, async () => {
          const record = await store.read(task)
          if (!record) throw new TaskError("TASK_NOT_FOUND", ref)
          await store.writeReport(task, report)
          await store.writeRecord({ ...record, status: "reported", stage: null })
        })
      } catch (error) { if (error instanceof TaskError) throw new TaskError(error.code, ref); throw new TaskError("TASK_INCOMPLETE", ref) }
      return inspect(task)
    },
    async close() { lifetime.abort(); await Promise.allSettled(pipelines.values()) },
  }
}