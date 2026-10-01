import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { AgentError } from "../agent/types.js"
import type { HandlerStatus } from "../control/protocol.js"
import type { PlatformPaths } from "../platform/paths.js"
import type { PlatformAdapter } from "../platform/types.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../platform/private-state.js"
import type { LaunchRecord } from "../platform/types.js"
import { refreshLaunchState, type HandlerMutations } from "./mutations.js"

export type LaunchContext = { paths: PlatformPaths; adapter: PlatformAdapter; state: HandlerStatus; mutations: HandlerMutations; shutdownPending(): boolean }

export type LaunchTransitionIO = { publish: typeof writeLaunchRecord; read: typeof readLaunchRecordForReconciliation }
const defaults: LaunchTransitionIO = { publish: writeLaunchRecord, read: readLaunchRecordForReconciliation }

async function publish(context: LaunchContext, expected: LaunchRecord, next: LaunchRecord, io: LaunchTransitionIO): Promise<void> {
  const directory = join(context.paths.persistentRoot, "launches")
  await refreshLaunchState(context.state, context.mutations, directory)
  const entry = context.mutations.accepted.find(value => value.record.launchAttemptId === expected.launchAttemptId)
  if (!entry || !isDeepStrictEqual(entry.record, expected) || expected.handlerGeneration !== context.state.handlerGeneration) throw new AgentError("INVALID_AGENT_STATE")
  if (context.mutations.issues?.some(issue => issue.path === entry.path)) throw new AgentError("UNAVAILABLE")
  try {
    if (!isDeepStrictEqual(await io.read(entry.path), expected)) throw new AgentError("UNAVAILABLE")
  } catch { throw new AgentError("UNAVAILABLE") }
  try { await io.publish(entry.path, next) }
  finally {
    try {
      const visible = await io.read(entry.path)
      if (isDeepStrictEqual(visible, next)) entry.record = structuredClone(next)
    } catch { }
    await refreshLaunchState(context.state, context.mutations, directory)
  }
  if (context.mutations.issues?.some(issue => issue.path === entry.path)) throw new AgentError("UNAVAILABLE")
  if (!isDeepStrictEqual(entry.record, next)) throw new AgentError("INVALID_AGENT_STATE")
}

export async function commitLaunchTransition(context: LaunchContext, expected: LaunchRecord, next: LaunchRecord, io: LaunchTransitionIO = defaults): Promise<void> {
  if (!isDeepStrictEqual({ ...next, phase: expected.phase, launchAttempted: expected.launchAttempted, provider: expected.provider, reason: expected.reason }, expected)) throw new AgentError("INVALID_AGENT_STATE")
  const legal = expected.phase === "launch_pending" ? ["launch_pending", "readiness"] : expected.phase === "readiness" ? ["readiness", "active", "exited_unverified"] : expected.phase === "active" ? ["active", "exited_unverified"] : [expected.phase]
  if (!legal.includes(next.phase) || expected.launchAttempted && !next.launchAttempted) throw new AgentError("INVALID_AGENT_STATE")
  if (expected.provider && (!next.provider || !isDeepStrictEqual(expected.provider.group.leader, next.provider.group.leader) || expected.provider.group.observed.some(member => !next.provider!.group.observed.some(value => isDeepStrictEqual(member, value))))) throw new AgentError("INVALID_AGENT_STATE")
  if (!["launch_pending", "readiness", "active"].includes(expected.phase) && !isDeepStrictEqual(next, expected)) throw new AgentError("INVALID_AGENT_STATE")
  await publish(context, expected, next, io)
}

export async function restoreUninvokedLaunch(context: LaunchContext, expected: LaunchRecord, proof: { spawnInvoked: false }, io: LaunchTransitionIO = defaults): Promise<LaunchRecord> {
  if (proof.spawnInvoked !== false || !expected.launchAttempted || expected.provider !== null || expected.phase !== "launch_pending" || expected.reason !== null) throw new AgentError("INVALID_AGENT_STATE")
  const restored = { ...expected, launchAttempted: false }
  await publish(context, expected, restored, io)
  return restored
}