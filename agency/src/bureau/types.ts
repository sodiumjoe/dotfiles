import { id, keys, object } from "../catalog/types.js"
import { boundedText, enumValue, fail, parseAgentRef, parseEventRef, type AgentRef, type EventRef } from "../orchestration/types.js"

export type RunRecord = { version: 1; runId: string; createCommandId: string; root: AgentRef; objective: string; state: "active" | "cancelled" | "completed" | "forgotten"; bindingEpoch: string; journal: EventRef | null }
export function parseRunRecord(value: unknown): RunRecord {
  const v = object(value); keys(v, ["version", "runId", "createCommandId", "root", "objective", "state", "bindingEpoch", "journal"])
  if (v.version !== 1) fail()
  return { version: 1, runId: id(v.runId), createCommandId: id(v.createCommandId), root: parseAgentRef(v.root), objective: boundedText(v.objective, 65536, false), state: enumValue(v.state, ["active", "cancelled", "completed", "forgotten"]), bindingEpoch: id(v.bindingEpoch), journal: v.journal === null ? null : parseEventRef(v.journal) }
}