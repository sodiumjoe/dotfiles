import { setTimeout as delay } from "node:timers/promises"
import type { HostTaskClient } from "./client.js"
import { invalidTask, parseTaskRef, TaskError, type TaskObservation, type TaskRef, type TaskWaitResult } from "./types.js"
export function parseTaskTimeout(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 60000) return invalidTask(); return value }
export async function waitForTask(client: Pick<HostTaskClient, "inspect">, raw: TaskRef, options: { timeoutMs: number; signal?: AbortSignal; intervalMs?: number }): Promise<TaskWaitResult> {
  const ref = parseTaskRef(raw), timeoutMs = parseTaskTimeout(options.timeoutMs), interval = options.intervalMs ?? 250
  if (!Number.isInteger(interval) || interval < 1) invalidTask()
  const deadline = performance.now() + timeoutMs
  let last: TaskObservation | undefined
  const expired = (): TaskWaitResult => last ? { state: "pending", observation: last } : { state: "unavailable", ref }
  while (true) {
    if (options.signal?.aborted) return { state: "cancelled", ref }
    const remaining = timeoutMs === 0 ? 10000 : Math.max(0, deadline - performance.now())
    if (remaining <= 0) return expired()
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])])
    let timer: NodeJS.Timeout | undefined, abort: (() => void) | undefined
    try {
      const stopped = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new TaskError("CANCELLED", ref))
        signal.addEventListener("abort", abort, { once: true })
        timer = setTimeout(() => controller.abort(), Math.ceil(remaining))
      })
      last = await Promise.race([client.inspect(ref, signal), stopped])
    } catch (error) {
      if (options.signal?.aborted) return { state: "cancelled", ref }
      if (controller.signal.aborted) return expired()
      if (error instanceof TaskError && ["TASK_NOT_FOUND", "TASK_INCOMPLETE", "INVALID_INPUT", "INPUT_TOO_LARGE"].includes(error.code)) throw error
      return { state: "unavailable", ref }
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort) }
    if (last.report) return { state: "reported", observation: last }
    if (last.runtime === "failed" || last.runtime === "interrupted") return { state: "failed", observation: last }
    if (timeoutMs === 0 || performance.now() >= deadline) return expired()
    try { await delay(Math.min(interval, Math.max(0, deadline - performance.now())), undefined, options.signal ? { signal: options.signal } : {}) }
    catch { return { state: "cancelled", ref } }
  }
}