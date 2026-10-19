import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { AgentError } from "../agent/types.js"
import type { HandlerStatus } from "../control/protocol.js"
import type { PlatformPaths } from "../platform/paths.js"
import type { PlatformAdapter } from "../platform/types.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../platform/private-state.js"
import { sameProcessGeneration, type ProcessGroupIdentity, type LaunchRecord, type ManagedLaunchRecord } from "../platform/types.js"
import { isLiveProcessGroup, isLiveCleanupEvidence, type LiveProcessGroup, type LiveCleanupEvidence } from "../platform/live-process.js"
import { summarizeLaunches } from "./inventory.js"
import { UUID } from "../control/protocol.js"
import { type HandlerMutations } from "./mutations.js"

export type LaunchContext = { paths: PlatformPaths; adapter: PlatformAdapter; state: HandlerStatus; mutations: HandlerMutations; shutdownPending(): boolean }

export type LaunchTransitionIO = { publish: typeof writeLaunchRecord; read: typeof readLaunchRecordForReconciliation }
const defaults: LaunchTransitionIO = { publish: writeLaunchRecord, read: readLaunchRecordForReconciliation }

async function publishExact(context: LaunchContext, expected: LaunchRecord, next: LaunchRecord, io: LaunchTransitionIO): Promise<void> {
  const path = join(context.paths.persistentRoot, "launches", expected.launchAttemptId + ".json")
  const entry = context.mutations.accepted.find(value => value.path === path)
  if (!UUID.test(expected.launchAttemptId) || !entry || !isDeepStrictEqual(entry.record, expected) || expected.handlerGeneration !== context.state.handlerGeneration) throw new AgentError("INVALID_AGENT_STATE")
  if (context.mutations.issues?.some(issue => issue.path === path) || context.mutations.reconciliationIssues?.some(issue => issue.path === path)) throw new AgentError("UNAVAILABLE")
  try {
    if (!isDeepStrictEqual(await io.read(path), expected)) throw new AgentError("UNAVAILABLE")
  } catch { throw new AgentError("UNAVAILABLE") }
  let matched = false
  try { await io.publish(path, next) }
  finally {
    try {
      const visible = await io.read(path)
      if (isDeepStrictEqual(visible, next)) { entry.record = structuredClone(next); matched = true }
    } catch { }
    context.state.launches = summarizeLaunches(context.mutations.accepted.map(value => value.record))
  }
  if (!matched) throw new AgentError("INVALID_AGENT_STATE")
}

function assertManaged(context: LaunchContext, record: ManagedLaunchRecord): void {
  if (record.version !== 2 || record.owner.kind !== "agent" || record.handlerGeneration !== context.state.handlerGeneration) throw new AgentError("INVALID_AGENT_STATE")
}

function assertOwned(context: LaunchContext, record: ManagedLaunchRecord, group: LiveProcessGroup): ProcessGroupIdentity {
  assertManaged(context, record)
  if (!isLiveProcessGroup(group) || group.owner.launchAttemptId !== record.launchAttemptId || !record.launchAttempted) throw new AgentError("INVALID_AGENT_STATE")
  const initial = group.identity()
  if (record.launchBootId !== initial.leader.bootId || record.provider && !isDeepStrictEqual(record.provider.group.leader, initial.leader)) throw new AgentError("INVALID_AGENT_STATE")
  return initial
}

function combine(existing: ProcessGroupIdentity | undefined, attribution: ProcessGroupIdentity): ProcessGroupIdentity {
  if (!existing) return structuredClone(attribution)
  if (!isDeepStrictEqual(existing.leader, attribution.leader)
    || existing.observed.some(member => !attribution.observed.some(other => isDeepStrictEqual(member, other)))) throw new AgentError("INVALID_AGENT_STATE")
  const observed = structuredClone(existing.observed)
  for (const member of attribution.observed) if (!observed.some(other => sameProcessGeneration(member, other))) observed.push(structuredClone(member))
  return { leader: structuredClone(existing.leader), observed }
}

export async function beginOwnedCleanup(context: LaunchContext, expected: ManagedLaunchRecord, group: LiveProcessGroup, io: LaunchTransitionIO = defaults): Promise<ManagedLaunchRecord> {
  const initial = assertOwned(context, expected, group)
  if (!["launch_pending", "readiness", "active", "exited_unverified", "cleanup_pending"].includes(expected.phase) || expected.reason !== null) throw new AgentError("INVALID_AGENT_STATE")
  const next: ManagedLaunchRecord = { ...expected, phase: "cleanup_pending", provider: { kind: "process-group", group: combine(expected.provider?.group, initial) }, reason: null }
  await publishExact(context, expected, next, io)
  return structuredClone(next)
}

export async function finishOwnedCleanup(context: LaunchContext, expected: ManagedLaunchRecord, group: LiveProcessGroup, evidence: LiveCleanupEvidence, io: LaunchTransitionIO = defaults): Promise<ManagedLaunchRecord> {
  assertOwned(context, expected, group)
  if (!isLiveCleanupEvidence(evidence, group) || evidence.launchAttemptId !== expected.launchAttemptId || !expected.provider || expected.reason !== null
    || !["cleanup_pending", "cleanup_verified"].includes(expected.phase)) throw new AgentError("INVALID_AGENT_STATE")
  const next: ManagedLaunchRecord = { ...expected, phase: "cleanup_verified", provider: { kind: "process-group", group: combine(expected.provider.group, evidence.group) }, reason: null }
  if (expected.phase === "cleanup_verified" && !isDeepStrictEqual(expected, next)) throw new AgentError("INVALID_AGENT_STATE")
  await publishExact(context, expected, next, io)
  return structuredClone(next)
}

export async function finishUnspawnedCleanup(context: LaunchContext, expected: ManagedLaunchRecord, proof: { spawnInvoked: false }, io: LaunchTransitionIO = defaults): Promise<ManagedLaunchRecord> {
  assertManaged(context, expected)
  if (proof.spawnInvoked !== false || expected.provider !== null || expected.reason !== null || !["launch_pending", "cleanup_verified"].includes(expected.phase)
    || expected.phase === "cleanup_verified" && expected.launchAttempted) throw new AgentError("INVALID_AGENT_STATE")
  const next: ManagedLaunchRecord = { ...expected, launchAttempted: false, phase: "cleanup_verified" }
  await publishExact(context, expected, next, io)
  return structuredClone(next)
}

export async function commitLaunchTransition(context: LaunchContext, expected: LaunchRecord, next: LaunchRecord, io: LaunchTransitionIO = defaults): Promise<void> {
  if (!isDeepStrictEqual({ ...next, phase: expected.phase, launchAttempted: expected.launchAttempted, provider: expected.provider, reason: expected.reason }, expected)) throw new AgentError("INVALID_AGENT_STATE")
  const legal = expected.phase === "launch_pending" ? ["launch_pending", "readiness"] : expected.phase === "readiness" ? ["readiness", "active", "exited_unverified"] : expected.phase === "active" ? ["active", "exited_unverified"] : [expected.phase]
  if (!legal.includes(next.phase) || expected.launchAttempted && !next.launchAttempted) throw new AgentError("INVALID_AGENT_STATE")
  if (expected.provider && (!next.provider || !isDeepStrictEqual(expected.provider.group.leader, next.provider.group.leader) || expected.provider.group.observed.some(member => !next.provider!.group.observed.some(value => isDeepStrictEqual(member, value))))) throw new AgentError("INVALID_AGENT_STATE")
  if (!["launch_pending", "readiness", "active"].includes(expected.phase) && !isDeepStrictEqual(next, expected)) throw new AgentError("INVALID_AGENT_STATE")
  await publishExact(context, expected, next, io)
}

export async function restoreUninvokedLaunch(context: LaunchContext, expected: LaunchRecord, proof: { spawnInvoked: false }, io: LaunchTransitionIO = defaults): Promise<LaunchRecord> {
  if (proof.spawnInvoked !== false || !expected.launchAttempted || expected.provider !== null || expected.phase !== "launch_pending" || expected.reason !== null) throw new AgentError("INVALID_AGENT_STATE")
  const restored = { ...expected, launchAttempted: false }
  await publishExact(context, expected, restored, io)
  return restored
}