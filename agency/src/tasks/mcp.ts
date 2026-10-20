import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { hash, object } from "../catalog/types.js"
import { toolResult, type ToolResult } from "../mcp/server.js"
import type { JsonObject } from "../agent/session-config.js"
import type { HostTaskClient } from "./client.js"
import { parseTaskCreateInput } from "./service.js"
import { waitForTask, parseTaskTimeout } from "./wait.js"
import { checkedTask, invalidTask, parseTaskRef, parseTaskReport, taskKeys, TaskError, type TaskRef } from "./types.js"

const uuid = { type: "string", format: "uuid" }, text = { type: "string", minLength: 1 }, host = { type: "string", pattern: "^[a-f0-9]{64}$" }
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false })
const ref = closed({ hostId: host, taskId: uuid }), oid = { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }, cwd = { type: "string", pattern: "^/" }
const list = (items: object) => ({ type: "array", items, maxItems: 128 })
const report = closed({ outcome: { enum: ["completed", "blocked", "failed"] }, summary: text,
  validation: list(closed({ argv: list({ type: "string" }), cwd, exitCode: { type: "integer" }, result: text })), issues: list(text),
  git: closed({ repository: text, branch: text, baseOid: oid, resultOid: oid }, ["repository", "resultOid"]) }, ["outcome", "summary"])
const create = closed({ taskId: uuid, description: text, parent: ref, cwd, backendId: { enum: ["codex-acp", "claude-agent-acp"] }, text,
  settings: closed({ modelId: text, modeId: text, configValues: { type: "object", maxProperties: 128, additionalProperties: { type: ["string", "boolean"] } } }, []), nativeParams: { type: "object" } }, ["taskId", "description", "cwd", "backendId", "text"])
export const taskToolSchemas = [
  { name: "agency_task_create", description: "Start one task on a selected host using a preselected task UUID. Retain the reference before dispatch. Inspect an uncertain outcome; never resend a create automatically. Input JSON must fit the bridge byte limit.", inputSchema: closed({ hostId: host, input: create }) },
  { name: "agency_task_inspect", description: "Read the owner record and explicit report. Reports are retained and repeatable; end_turn does not complete a task.", inputSchema: closed({ ref }) },
  { name: "agency_task_report", description: "Replace the complete owner report (at most 256 KiB serialized JSON). Use the worker default reference or an explicit reference. Git data is descriptive only.", inputSchema: closed({ ref, report }, ["report"]) },
  { name: "agency_task_wait", description: "Poll the owner for up to 60 seconds. Cancellation leaves the worker running. Zero performs one inspection with the ordinary 10-second read bound. No wait ID or durable wait is created.", inputSchema: closed({ ref, timeoutMs: { type: "integer", minimum: 0, maximum: 60000 } }) },
]
export function taskToolDescriptor(ref: TaskRef): JsonObject {
  return { name: "agency_tasks", command: process.execPath, args: [fileURLToPath(new URL("../main.js", import.meta.url)), "internal-task-tools"], env: [{ name: "AGENCY_TASK_REF", value: JSON.stringify(parseTaskRef(ref)) }] }
}
export function createTaskToolBindings(input: { client: HostTaskClient; defaultRef?: TaskRef }) {
  const defaultRef = input.defaultRef === undefined ? undefined : parseTaskRef(input.defaultRef)
  return { async call(name: string, raw: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    let ref: TaskRef | undefined
    try {
      const args = checkedTask(() => object(raw))
      if (args.ref !== undefined) ref = parseTaskRef(args.ref)
      if (name === "agency_task_create") {
        checkedTask(() => taskKeys(args, ["hostId", "input"]))
        const hostId = checkedTask(() => hash(args.hostId)), request = parseTaskCreateInput(args.input)
        ref = { hostId, taskId: request.taskId }
        return toolResult(await input.client.create(hostId, request, signal))
      }
      if (name === "agency_task_report") {
        taskKeys(args, ["report"], ["ref"])
        if (ref && defaultRef && !isDeepStrictEqual(ref, defaultRef)) invalidTask()
        ref ??= defaultRef
        if (!ref) invalidTask()
        return toolResult(await input.client.report(ref, parseTaskReport(args.report), signal))
      }
      if (name === "agency_task_inspect" || name === "agency_task_wait") {
        taskKeys(args, name === "agency_task_wait" ? ["ref", "timeoutMs"] : ["ref"])
        if (!ref) invalidTask()
        if (name === "agency_task_inspect") return toolResult(await input.client.inspect(ref, signal))
        const result = await waitForTask(input.client, ref, { timeoutMs: parseTaskTimeout(args.timeoutMs), ...(signal ? { signal } : {}) })
        return toolResult(result, result.state === "unavailable")
      }
      return invalidTask()
    } catch (error) {
      const failure = error instanceof TaskError ? error : new TaskError("TASKS_UNAVAILABLE", ref)
      return toolResult({ error: { code: failure.code, message: failure.message, ...(failure.ref ?? ref ? { ref: failure.ref ?? ref } : {}) } }, true)
    }
  } }
}