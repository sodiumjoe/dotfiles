import type { TaskObservation } from "../src/tasks/types.js"
export function runningTaskSession(value: TaskObservation): TaskObservation | undefined {
  return value.runtime === "running" && value.record.session !== null ? value : undefined
}