import { randomUUID } from "node:crypto"
import { hash, object } from "../catalog/types.js"
import type { ControlDependencies } from "../cli/control.js"
import { openHostAccess } from "../hosts/cli.js"
import { createHostTaskClient, type HostTaskClient } from "./client.js"
import { parseTaskCreateInput } from "./service.js"
import { parseTaskTimeout, waitForTask } from "./wait.js"
import { TASK_PROTOCOL } from "./protocol.js"
import { checkedTask, invalidTask, parseTaskReport, taskId, taskKeys, TaskError, type TaskRef } from "./types.js"
export async function runTaskClient(argv: readonly string[], deps: ControlDependencies & { signal?: AbortSignal }): Promise<number> {
  const requestId = randomUUID(), controller = new AbortController(), signal = deps.signal ?? controller.signal
  let ref: TaskRef | undefined, close: (() => void) | undefined, client: HostTaskClient | undefined, executing = false
  const cancel = () => controller.abort()
  const emit = (v: unknown) => deps.stdout(JSON.stringify({ protocol: TASK_PROTOCOL, requestId, ...v as object }) + "\n")
  if (!deps.signal) { process.on("SIGINT", cancel); process.on("SIGTERM", cancel) }
  try {
    const positional: string[] = [], flags = new Map<string, string>(), seen = new Set<string>()
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index]!
      if (!arg.startsWith("-")) { positional.push(arg); continue }
      if (seen.has(arg)) invalidTask(); seen.add(arg)
      if (arg === "--json" || arg === "--local") continue
      if (arg !== "--host" && arg !== "--input-json") invalidTask()
      const value = argv[++index]; if (value === undefined || value.startsWith("--")) invalidTask(); flags.set(arg, value)
    }
    const [group, action, argument] = positional, local = seen.has("--local")
    if (group !== "task" || !seen.has("--json") || local === flags.has("--host") || !["create", "inspect", "wait", "report"].includes(action ?? "")) invalidTask()
    const selected = flags.has("--host") ? checkedTask(() => hash(flags.get("--host"))) : undefined
    const task = action === "create" ? undefined : taskId(argument)
    if (selected && task) ref = { hostId: selected, taskId: task }
    if (positional.length !== (action === "create" ? 2 : 3) || flags.has("--input-json") !== (action !== "inspect")) invalidTask()
    const raw = action === "inspect" ? undefined : checkedTask(() => JSON.parse(flags.get("--input-json")!))
    const create = action === "create" ? parseTaskCreateInput(raw) : undefined
    if (selected && create) ref = { hostId: selected, taskId: create.taskId }
    const report = action === "report" ? parseTaskReport(raw) : undefined
    const timeoutMs = action === "wait" ? checkedTask(() => { const value = object(raw); taskKeys(value, ["timeoutMs"]); return parseTaskTimeout(value.timeoutMs) }) : undefined
    if (signal.aborted) throw new TaskError("CANCELLED", ref)
    executing = true
    const access = await openHostAccess(deps); close = access.close
    const hostId = selected ?? access.env.paths.hostKey
    ref = { hostId, taskId: create?.taskId ?? task! }
    client = createHostTaskClient({ localHostId: access.env.paths.hostKey, route: access.route })
    if (action === "wait") {
      const result = await waitForTask(client, ref, { timeoutMs: timeoutMs!, signal }); emit({ ok: true, result })
      return result.state === "cancelled" ? 130 : result.state === "unavailable" ? 69 : result.state === "reported" && result.observation.report?.outcome === "completed" ? 0 : 75
    }
    const result = create ? await client.create(hostId, create, signal) : report ? await client.report(ref, report, signal) : await client.inspect(ref, signal)
    emit({ ok: true, result }); return 0
  } catch (error) {
    const failure = error instanceof TaskError ? error : new TaskError(executing ? "TASKS_UNAVAILABLE" : "INVALID_INPUT", ref)
    emit({ ok: false, error: { code: failure.code, message: failure.message, ...(failure.ref ?? ref ? { ref: failure.ref ?? ref } : {}) } })
    return failure.code === "CANCELLED" ? 130 : ["INVALID_INPUT", "INPUT_TOO_LARGE"].includes(failure.code) ? 64 : ["OUTCOME_UNKNOWN", "TASK_INCOMPLETE", "TASK_EXISTS"].includes(failure.code) ? 75 : 69
  } finally { client?.close(); close?.(); if (!deps.signal) { process.off("SIGINT", cancel); process.off("SIGTERM", cancel) } }
}