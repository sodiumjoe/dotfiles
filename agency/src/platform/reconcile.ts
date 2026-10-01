import { LinuxObservationUnavailable } from "./linux.js"
import { isDeepStrictEqual } from "node:util"
import { agencyLaunchMarker, exactAgencyBirth, parseAgencyLaunchMarker } from "./launch-marker.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "./private-state.js"
import { DarwinObservationUnavailable } from "./darwin.js"
import {
  processBirthStart,
  sameProcessGeneration,
  sameProcess,
  type LaunchRecord,
  type PlatformAdapter,
  type ProcessGroupProviderIdentity,
  type ProcessIdentity,
  type ReconcileResult,
} from "./types.js"

const POLL_INTERVAL_MS = 25
const TERM_DEADLINE_MS = 1000
const KILL_DEADLINE_MS = 3000

type GroupObservation = {
  leader: ProcessIdentity | null
  members: ProcessIdentity[]
}

type Continuity =
  | { state: "empty" }
  | { state: "authorized"; observation: GroupObservation }
  | { state: "mismatch" }

function clone<R extends LaunchRecord>(record: R, changes: Partial<Pick<LaunchRecord, "phase" | "provider" | "reason" | "launchAttempted">>): R {
  return { ...record, ...changes }
}

async function persist(path: string, record: LaunchRecord, disposition: ReconcileResult["disposition"]): Promise<ReconcileResult> {
  await writeLaunchRecord(path, record)
  return { record, disposition }
}

async function release(path: string, record: LaunchRecord): Promise<ReconcileResult> {
  return persist(path, clone(record, { phase: "cleanup_verified", provider: record.launchAttempted ? record.provider : null, reason: null }), "released")
}

async function cleaned(path: string, record: LaunchRecord): Promise<ReconcileResult> {
  return persist(path, clone(record, { phase: "cleanup_verified", reason: null }), "cleaned")
}

async function quarantine(path: string, record: LaunchRecord, reason: string): Promise<ReconcileResult> {
  return persist(path, clone(record, { phase: "quarantined", reason }), "quarantined")
}

function uniqueIdentities(identities: ProcessIdentity[]): boolean {
  const keys = new Set<string>()
  for (const identity of identities) {
    const key = `${identity.pid}\u0000${identity.birth}`
    if (keys.has(key)) return false
    keys.add(key)
  }
  return true
}

function sameGroupFields(expected: ProcessIdentity, observed: ProcessIdentity): boolean {
  return expected.bootId === observed.bootId
    && expected.processGroupId === observed.processGroupId
    && expected.sessionId === observed.sessionId
    && expected.uid === observed.uid
    && expected.gid === observed.gid
}

function processGroupIssue(record: LaunchRecord, provider: ProcessGroupProviderIdentity): string | null {
  const { leader, observed } = provider.group
  if (parseAgencyLaunchMarker("agy-provider:" + record.launchAttemptId) === null) return "provider launch UUID is not canonical"
  if (!exactAgencyBirth(leader.birth, agencyLaunchMarker("provider", record.launchAttemptId))) return "provider leader marker is not exact"
  if (leader.bootId !== record.launchBootId) return "provider leader boot does not match launch boot"
  if (leader.processGroupId !== leader.pid || leader.sessionId !== leader.pid) return "provider leader does not own its process group and session"
  if (!uniqueIdentities(observed)) return "provider observed identities are not unique"
  if (!observed.some(member => sameProcess(leader, member))) return "provider evidence omits the leader"
  if (observed.some(member => !sameGroupFields(leader, member))) return "provider evidence has inconsistent group identity"
  return null
}

function recordIssue(record: LaunchRecord): string | null {
  if (!record.launchAttempted && record.provider !== null) return "unattempted launch has provider identity"
  if ((record.phase === "readiness" || record.phase === "active") && record.provider === null) return `${record.phase} lacks provider identity`
  if (record.phase === "cleanup_verified" && record.launchAttempted && record.provider === null) return "cleanup_verified lacks provider identity for an attempted launch"
  if (record.phase === "exited_unverified" && !record.launchAttempted) return "exited_unverified lacks an attempted launch"
  if (record.phase === "cleanup_pending" && (!record.launchAttempted || record.provider === null)) return "cleanup_pending lacks an attempted launch or provider identity"
  if ((record.phase === "exited_unverified" || record.phase === "quarantined") && record.reason === null) return `${record.phase} lacks a reason`
  if (record.phase !== "exited_unverified" && record.phase !== "quarantined" && record.reason !== null) return `${record.phase} has an unexpected reason`
  return null
}

async function observeGroup(adapter: PlatformAdapter, provider: ProcessGroupProviderIdentity): Promise<GroupObservation> {
  const leader = await adapter.readProcess(provider.group.leader.pid)
  const members = await adapter.readGroup(provider.group.leader.processGroupId)
  return { leader, members }
}

function groupMembersAuthorized(provider: ProcessGroupProviderIdentity, members: ProcessIdentity[]): boolean {
  return uniqueIdentities(members) && members.every(member => sameGroupFields(provider.group.leader, member) && (member.pid !== provider.group.leader.pid || sameProcess(provider.group.leader, member)))
}

function initialContinuity(provider: ProcessGroupProviderIdentity, observation: GroupObservation): Continuity {
  if (observation.members.length === 0) {
    if (observation.leader !== null && sameProcess(provider.group.leader, observation.leader)) return { state: "mismatch" }
    return { state: "empty" }
  }
  if (observation.leader === null || !sameProcess(provider.group.leader, observation.leader)) return { state: "mismatch" }
  if (!groupMembersAuthorized(provider, observation.members)) return { state: "mismatch" }
  const leader = observation.leader
  if (!observation.members.some(member => sameProcess(leader, member))) return { state: "mismatch" }
  return { state: "authorized", observation }
}

function continuedContinuity(provider: ProcessGroupProviderIdentity, observation: GroupObservation): Continuity {
  if (observation.members.length === 0) {
    if (observation.leader !== null && sameProcess(provider.group.leader, observation.leader)) return { state: "mismatch" }
    return { state: "empty" }
  }
  if (observation.leader !== null && !sameProcess(provider.group.leader, observation.leader)) return { state: "mismatch" }
  if (!groupMembersAuthorized(provider, observation.members)) return { state: "mismatch" }
  const leader = observation.leader
  if (leader !== null && !observation.members.some(member => sameProcess(leader, member))) return { state: "mismatch" }
  if (leader === null && !observation.members.some(member => provider.group.observed.some(retained => sameProcess(retained, member)))) return { state: "mismatch" }
  return { state: "authorized", observation }
}

async function sleep(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
}

async function pollContinuity(adapter: PlatformAdapter, provider: ProcessGroupProviderIdentity, timeout: number, retain: (observation: GroupObservation) => Promise<void>): Promise<Continuity> {
  const deadline = Date.now() + timeout
  while (true) {
    const continuity = continuedContinuity(provider, await observeGroup(adapter, provider))
    if (continuity.state === "authorized") await retain(continuity.observation)
    if (continuity.state !== "authorized" || Date.now() >= deadline) return continuity
    await sleep()
  }
}

async function signal(adapter: PlatformAdapter, processGroupId: number, value: NodeJS.Signals): Promise<void> {
  try {
    await adapter.signalGroup(processGroupId, value)
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH") throw error
  }
}

function unionMembers(first: ProcessIdentity[], second: ProcessIdentity[]): ProcessIdentity[] {
  const result = [...first]
  for (const member of second) if (!result.some(prior => sameProcess(prior, member))) result.push(member)
  return result
}

function sameMembers(first: ProcessIdentity[], second: ProcessIdentity[]): boolean {
  return first.length === second.length && first.every(member => second.some(other => sameProcess(member, other)))
}

async function retainedState(adapter: PlatformAdapter, provider: ProcessGroupProviderIdentity, groupAbsent = false): Promise<{ state: "absent" | "live" | "ambiguous"; detached: ProcessIdentity[] }> {
  let live = false
  const detached: ProcessIdentity[] = []
  for (const retained of unionMembers([provider.group.leader], provider.group.observed)) {
    let current: ProcessIdentity | null
    try { current = await adapter.readProcess(retained.pid) } catch { if (groupAbsent) continue; return { state: "ambiguous", detached } }
    if (current === null) continue
    if (current.pid !== retained.pid || current.bootId !== retained.bootId) continue
    if (current.processGroupId !== provider.group.leader.processGroupId) {
      if (sameProcessGeneration(retained, current) && current.birth === retained.birth && current.uid === retained.uid && current.gid === retained.gid) detached.push(current)
      continue
    }
    const expectedStart = processBirthStart(retained.birth)
    const currentStart = processBirthStart(current.birth)
    if (expectedStart === null || currentStart === null) return { state: "ambiguous", detached }
    if (expectedStart !== currentStart) continue
    if (!sameProcess(retained, current)) return { state: "ambiguous", detached }
    live = true
  }
  return { state: live ? "live" : "absent", detached }
}

async function discharge(path: string, adapter: PlatformAdapter, record: LaunchRecord, disposition: "released" | "cleaned"): Promise<ReconcileResult> {
  if (record.provider === null) return quarantine(path, record, "attempted launch has no retained provider")
  if ((await adapter.readGroup(record.provider.group.leader.processGroupId)).length > 0) return quarantine(path, record, "recorded process group survived cleanup")
  const { state, detached } = await retainedState(adapter, record.provider, true)
  if (state !== "absent") return quarantine(path, record, state === "ambiguous" ? "retained member observation is ambiguous" : "retained group member survived cleanup")
  const result = disposition === "cleaned" ? await cleaned(path, record) : await release(path, record)
  return detached.length ? { ...result, diagnostics: detached.map(identity => ({ kind: "detached-helper" as const, identity })) } : result
}

async function reconcileProcessGroupRecord(path: string, adapter: PlatformAdapter, record: LaunchRecord, pendingRecord: (record: LaunchRecord) => void): Promise<ReconcileResult> {
  const currentBoot = await adapter.bootId()
  if (record.launchBootId !== currentBoot) return release(path, record)
  if (record.phase === "quarantined") return quarantine(path, record, record.reason ?? "record was already quarantined")
  const semanticIssue = recordIssue(record)
  if (semanticIssue !== null) return quarantine(path, record, semanticIssue)
  if (!record.launchAttempted && record.provider === null) return release(path, record)
  if (record.launchAttempted && record.provider === null) return quarantine(path, record, "launch was attempted without complete provider identity")
  if (record.provider?.kind !== "process-group") return quarantine(path, record, "record does not contain process-group identity")
  const providerIssue = processGroupIssue(record, record.provider)
  if (providerIssue !== null) return quarantine(path, record, providerIssue)
  if (record.phase === "cleanup_verified") return discharge(path, adapter, record, "released")
  const initial = (record.phase === "cleanup_pending" ? continuedContinuity : initialContinuity)(record.provider, await observeGroup(adapter, record.provider))
  if (initial.state === "empty") return discharge(path, adapter, record, "released")
  if (initial.state === "mismatch") return quarantine(path, record, "process-group identity is ambiguous")
  if ((await retainedState(adapter, record.provider)).state === "ambiguous") return quarantine(path, record, "retained member observation is ambiguous")
  const verifiedLeader = record.provider.group.leader
  const pendingProvider: ProcessGroupProviderIdentity = {
    kind: "process-group",
    group: {
      leader: verifiedLeader,
      observed: unionMembers(record.provider.group.observed, initial.observation.members),
    },
  }
  const pending = clone(record, { phase: "cleanup_pending", provider: pendingProvider, reason: null })
  await writeLaunchRecord(path, pending)
  pendingRecord(pending)
  const retain = async (observation: GroupObservation): Promise<void> => {
    const members = unionMembers(pendingProvider.group.observed, observation.members)
    if (sameMembers(members, pendingProvider.group.observed)) return
    pendingProvider.group.observed = members
    await writeLaunchRecord(path, pending)
    pendingRecord(pending)
  }
  if ((await retainedState(adapter, pendingProvider)).state === "ambiguous") return quarantine(path, pending, "retained member changed before SIGTERM")
  const authorization = (record.phase === "cleanup_pending" ? continuedContinuity : initialContinuity)(pendingProvider, await observeGroup(adapter, pendingProvider))
  if (authorization.state === "empty") return discharge(path, adapter, pending, "released")
  if (authorization.state === "mismatch") return quarantine(path, pending, "process-group authorization changed before SIGTERM")
  await retain(authorization.observation)
  if (authorization.state !== "authorized" || !sameMembers(initial.observation.members, authorization.observation.members)) return quarantine(path, pending, "process-group snapshot changed before SIGTERM")
  await signal(adapter, pendingProvider.group.leader.processGroupId, "SIGTERM")
  const afterTerm = await pollContinuity(adapter, pendingProvider, TERM_DEADLINE_MS, retain)
  if (afterTerm.state === "empty") return discharge(path, adapter, pending, "cleaned")
  if (afterTerm.state === "mismatch") return quarantine(path, pending, "process-group identity changed after SIGTERM")
  const killAuthorization = continuedContinuity(pendingProvider, await observeGroup(adapter, pendingProvider))
  if (killAuthorization.state === "empty") return discharge(path, adapter, pending, "cleaned")
  if (killAuthorization.state === "mismatch") return quarantine(path, pending, "process-group authorization changed before SIGKILL")
  await retain(killAuthorization.observation)
  if (killAuthorization.state !== "authorized" || !sameMembers(afterTerm.observation.members, killAuthorization.observation.members)) return quarantine(path, pending, "process-group snapshot changed before SIGKILL")
  pendingProvider.group.observed = unionMembers(pendingProvider.group.observed, killAuthorization.observation.members)
  await writeLaunchRecord(path, pending)
  if ((await retainedState(adapter, pendingProvider)).state === "ambiguous") return quarantine(path, pending, "retained member changed before SIGKILL")
  const finalKill = continuedContinuity(pendingProvider, await observeGroup(adapter, pendingProvider))
  if (finalKill.state === "empty") return discharge(path, adapter, pending, "cleaned")
  if (finalKill.state === "authorized") await retain(finalKill.observation)
  if (finalKill.state !== "authorized" || !sameMembers(killAuthorization.observation.members, finalKill.observation.members)) return quarantine(path, pending, "process-group snapshot changed before SIGKILL")
  await signal(adapter, pendingProvider.group.leader.processGroupId, "SIGKILL")
  const afterKill = await pollContinuity(adapter, pendingProvider, KILL_DEADLINE_MS, retain)
  if (afterKill.state === "empty") return discharge(path, adapter, pending, "cleaned")
  return quarantine(path, pending, afterKill.state === "mismatch" ? "process-group identity changed after SIGKILL" : "process-group survived SIGKILL deadline")
}

export async function reconcileRecord(path: string, adapter: PlatformAdapter, expectedRecord?: LaunchRecord): Promise<ReconcileResult> {
  const record = await readLaunchRecordForReconciliation(path)
  if (expectedRecord !== undefined && !isDeepStrictEqual(record, expectedRecord)) throw new Error("RETAINED_INVENTORY_CHANGED")
  let affected = record
  try {
    return await reconcileProcessGroupRecord(path, adapter, record, pending => affected = pending)
  } catch (error) {
    if (!(error instanceof DarwinObservationUnavailable) && !(error instanceof LinuxObservationUnavailable)) throw error
    const reason = `${adapter.platform} observation unavailable: ${error.message}`.slice(0, 512)
    return quarantine(path, affected, reason)
  }
}