import { readLaunchRecordForReconciliation, writeLaunchRecord } from "./private-state.js"
import {
  sameProcess,
  type LaunchRecord,
  type LinuxNamespaceAdapter,
  type LinuxNamespaceProviderIdentity,
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

function clone(record: LaunchRecord, changes: Partial<LaunchRecord>): LaunchRecord {
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
  if (leader.bootId !== record.launchBootId) return "provider leader boot does not match launch boot"
  if (leader.processGroupId !== leader.pid || leader.sessionId !== leader.pid) return "provider leader does not own its process group and session"
  if (!uniqueIdentities(observed)) return "provider observed identities are not unique"
  if (!observed.some(member => sameProcess(leader, member))) return "provider evidence omits the leader"
  if (observed.some(member => !sameGroupFields(leader, member))) return "provider evidence has inconsistent group identity"
  return null
}

function namespaceIssue(record: LaunchRecord, provider: LinuxNamespaceProviderIdentity): string | null {
  if (provider.launcher.bootId !== record.launchBootId || provider.init.bootId !== record.launchBootId) return "namespace identities do not match launch boot"
  if (provider.namespaceId.length === 0) return "namespace identity is empty"
  if (!uniqueIdentities(provider.observed)) return "namespace observed identities are not unique"
  if (provider.observed.some(member => member.bootId !== record.launchBootId)) return "namespace evidence has inconsistent boot identity"
  if (!provider.observed.some(member => sameProcess(provider.launcher, member))) return "namespace evidence omits the launcher"
  if (!provider.observed.some(member => sameProcess(provider.init, member))) return "namespace evidence omits init"
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
  return { state: "authorized", observation }
}

async function sleep(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
}

async function pollContinuity(adapter: PlatformAdapter, provider: ProcessGroupProviderIdentity, timeout: number): Promise<Continuity> {
  const deadline = Date.now() + timeout
  while (true) {
    const continuity = continuedContinuity(provider, await observeGroup(adapter, provider))
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

export async function reconcileRecord(path: string, adapter: PlatformAdapter): Promise<ReconcileResult> {
  const record = await readLaunchRecordForReconciliation(path)
  if (adapter.platform !== "darwin") return quarantine(path, record, "process-group reconciliation requires Darwin")
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
  if (record.phase === "cleanup_verified") return release(path, record)
  const initial = initialContinuity(record.provider, await observeGroup(adapter, record.provider))
  if (initial.state === "empty") return release(path, record)
  if (initial.state === "mismatch") return quarantine(path, record, "process-group identity is ambiguous")
  const verifiedLeader = initial.observation.leader
  if (verifiedLeader === null) return quarantine(path, record, "process-group leader disappeared before cleanup")
  const pendingProvider: ProcessGroupProviderIdentity = {
    kind: "process-group",
    group: {
      leader: verifiedLeader,
      observed: initial.observation.members,
    },
  }
  const pending = clone(record, { phase: "cleanup_pending", provider: pendingProvider, reason: null })
  await writeLaunchRecord(path, pending)
  const authorization = initialContinuity(pendingProvider, await observeGroup(adapter, pendingProvider))
  if (authorization.state === "empty") return release(path, pending)
  if (authorization.state === "mismatch") return quarantine(path, pending, "process-group authorization changed before SIGTERM")
  await signal(adapter, pendingProvider.group.leader.processGroupId, "SIGTERM")
  const afterTerm = await pollContinuity(adapter, pendingProvider, TERM_DEADLINE_MS)
  if (afterTerm.state === "empty") return cleaned(path, pending)
  if (afterTerm.state === "mismatch") return quarantine(path, pending, "process-group identity changed after SIGTERM")
  const killAuthorization = continuedContinuity(pendingProvider, await observeGroup(adapter, pendingProvider))
  if (killAuthorization.state === "empty") return cleaned(path, pending)
  if (killAuthorization.state === "mismatch") return quarantine(path, pending, "process-group authorization changed before SIGKILL")
  await signal(adapter, pendingProvider.group.leader.processGroupId, "SIGKILL")
  const afterKill = await pollContinuity(adapter, pendingProvider, KILL_DEADLINE_MS)
  if (afterKill.state === "empty") return cleaned(path, pending)
  return quarantine(path, pending, afterKill.state === "mismatch" ? "process-group identity changed after SIGKILL" : "process-group survived SIGKILL deadline")
}

export async function reconcileLinuxNamespaceRecord(path: string, adapter: LinuxNamespaceAdapter): Promise<ReconcileResult> {
  const record = await readLaunchRecordForReconciliation(path)
  if (adapter.platform !== "linux") return quarantine(path, record, "namespace reconciliation requires Linux")
  const currentBoot = await adapter.bootId()
  if (record.launchBootId !== currentBoot) return release(path, record)
  if (record.phase === "quarantined") return quarantine(path, record, record.reason ?? "record was already quarantined")
  const semanticIssue = recordIssue(record)
  if (semanticIssue !== null) return quarantine(path, record, semanticIssue)
  if (!record.launchAttempted && record.provider === null) return release(path, record)
  if (record.launchAttempted && record.provider === null) return quarantine(path, record, "launch was attempted without complete namespace identity")
  if (record.provider?.kind !== "linux-pid-namespace") return quarantine(path, record, "record does not contain Linux namespace identity")
  const providerIssue = namespaceIssue(record, record.provider)
  if (providerIssue !== null) return quarantine(path, record, providerIssue)
  if (record.phase === "cleanup_verified") return release(path, record)
  const launcher = await adapter.readProcess(record.provider.launcher.pid)
  const init = await adapter.readProcess(record.provider.init.pid)
  const initNamespace = init === null ? null : await adapter.readNamespace(init.pid)
  const members = await adapter.scanNamespace(record.provider.namespaceId)
  if (!uniqueIdentities(members)) return quarantine(path, record, "namespace scan returned duplicate identities")
  if (members.length > 0) return quarantine(path, record, "namespace still contains live members")
  const exactLauncher = launcher !== null && sameProcess(record.provider.launcher, launcher)
  const exactInit = init !== null && sameProcess(record.provider.init, init)
  if (exactInit && initNamespace !== record.provider.namespaceId) return quarantine(path, record, "recorded init namespace identity changed")
  if (exactLauncher || exactInit) return quarantine(path, record, "recorded identity is live but namespace scan is empty")
  return release(path, record)
}