import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { summarizeLaunches } from "../handler/inventory.js"
import type { LaunchContext } from "../handler/launch-transitions.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../platform/private-state.js"
import type { ManagedLaunchRecord } from "../platform/types.js"
import { AgentError, type AgentRecordV3 as AgentRecord, type OwnedAgentRecord, type AgentTuple } from "./types.js"

export function agentTuple(record: OwnedAgentRecord): AgentTuple
export function agentTuple(record: import("./types.js").AgentRecord): AgentTuple
export function agentTuple(record: AgentRecord): AgentTuple | null
export function agentTuple(record: AgentRecord | import("./types.js").AgentRecord): AgentTuple | null { return record.launch ? { agentId: record.definition.agentId, handlerGeneration: record.launch.handlerGeneration, providerGeneration: record.launch.providerGeneration } : null }

export async function retainUnspawnedRestore(context: LaunchContext, agent: AgentRecord): Promise<void> {
  if (agent.phase !== "restoring" || !agent.launch) return
  const path = join(context.paths.persistentRoot, "launches", agent.launch.launchAttemptId + ".json")
  const accepted = context.mutations.accepted.find(entry => entry.record.launchAttemptId === agent.launch!.launchAttemptId)
  if (accepted) {
    if (accepted.path !== path || accepted.record.version !== 2 || accepted.record.owner.kind !== "agent" || accepted.record.owner.agentId !== agent.definition.agentId || accepted.record.owner.providerGeneration !== agent.launch.providerGeneration || accepted.record.handlerGeneration !== agent.launch.handlerGeneration || context.mutations.issues?.some(issue => issue.path === path)) throw new AgentError("CLEANUP_UNVERIFIED")
    return
  }
  const record: ManagedLaunchRecord = { version: 2, owner: { kind: "agent", agentId: agent.definition.agentId, providerGeneration: agent.launch.providerGeneration }, handlerGeneration: agent.launch.handlerGeneration, launchAttemptId: agent.launch.launchAttemptId, launchBootId: await context.adapter.bootId(), launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null }
  try { if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(path), record)) throw new AgentError("CLEANUP_UNVERIFIED") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  await writeLaunchRecord(path, record)
  context.mutations.accepted.push({ path, record })
  context.state.launches = summarizeLaunches(context.mutations.accepted.map(entry => entry.record))
}