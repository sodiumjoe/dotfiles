import { fail, type AttemptState } from "../orchestration/types.js"

export function unresolved(state: AttemptState): boolean { return ["dispatch_pending", "running", "awaiting_report", "uncertain"].includes(state) }
export function transition(current: AttemptState, next: AttemptState): AttemptState {
  if (current === next) return current
  const allowed: Record<AttemptState, readonly AttemptState[]> = {
    dispatch_pending: ["running", "failed", "interrupted", "cancelled", "uncertain"],
    running: ["awaiting_report", "completed", "failed", "interrupted", "cancelled", "uncertain"],
    awaiting_report: ["completed", "failed", "interrupted", "cancelled", "uncertain"],
    uncertain: ["running", "awaiting_report", "completed", "failed", "interrupted", "cancelled"],
    completed: [], failed: [], interrupted: [], cancelled: []
  }
  if (!allowed[current].includes(next)) fail("INVALID_TRANSITION")
  return next
}