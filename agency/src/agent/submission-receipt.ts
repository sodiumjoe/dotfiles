import { id, object } from "../catalog/types.js"
import { knownKeys, type StopReason } from "./session-events.js"
import { AgentError, parseAgentFailure } from "./types.js"
import type { SubmissionReceipt } from "./turns.js"

function invalid(): never { throw new AgentError("INVALID_PROTOCOL") }
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid()
  return Number(value)
}
const reason = (value: unknown): StopReason => { if (typeof value !== "string" || !["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"].includes(value)) invalid(); return value as StopReason }
const state = (value: unknown): void => { if (typeof value !== "string" || !["accepted", "running", "completed", "failed"].includes(value)) invalid() }
function exact(value: Record<string, unknown>, fields: readonly string[]): void { knownKeys(value, fields, fields) }
export function parseSubmissionReceipt(value: unknown): SubmissionReceipt {
  const receipt = object(value)
  exact(receipt, ["submissionId", "digest", "state", "stopReason", "failure", "acceptedSeq", "completedSeq"])
  id(receipt.submissionId); state(receipt.state); integer(receipt.acceptedSeq, 1)
  if (typeof receipt.digest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.digest)) invalid()
  if (receipt.completedSeq !== null) integer(receipt.completedSeq, Number(receipt.acceptedSeq) + 1)
  if (receipt.stopReason !== null) reason(receipt.stopReason)
  if (receipt.failure !== null) parseAgentFailure(receipt.failure)
  if (receipt.state === "completed" ? receipt.stopReason === null || receipt.failure !== null || receipt.completedSeq === null : receipt.state === "failed" ? receipt.failure === null || receipt.stopReason !== null || receipt.completedSeq === null : receipt.failure !== null || receipt.stopReason !== null || receipt.completedSeq !== null) invalid()
  return structuredClone(receipt) as SubmissionReceipt
}