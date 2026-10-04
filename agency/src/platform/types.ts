export const RUNTIME_RECORD_VERSION = 1 as const
import type { ProviderId } from "../catalog/types.js"

export type ProcessIdentity = {
  bootId: string
  pid: number
  birth: string
  parentPid: number
  processGroupId: number
  sessionId: number
  uid: number
  gid: number
}

export type ProcessGroupIdentity = {
  leader: ProcessIdentity
  observed: ProcessIdentity[]
}

export type ProcessGroupProviderIdentity = {
  kind: "process-group"
  group: ProcessGroupIdentity
}

export type ProviderIdentity = ProcessGroupProviderIdentity

export type LaunchPhase =
  | "launch_pending"
  | "readiness"
  | "active"
  | "exited_unverified"
  | "cleanup_pending"
  | "cleanup_verified"
  | "quarantined"

export type LaunchOwner =
  | { kind: "agent"; agentId: string; providerGeneration: string }
  | { kind: "catalog-probe"; providerId: ProviderId; commandId: string }

type LaunchFields = {
  handlerGeneration: string
  launchAttemptId: string
  launchBootId: string
  launchAttempted: boolean
  phase: LaunchPhase
  provider: ProviderIdentity | null
  reason: string | null
}

export type ManagedLaunchRecord = LaunchFields & {
  version: 2
  owner: LaunchOwner
  checkoutId?: never
  leaseId?: never
  agentId?: never
}

export type LegacyLaunchRecord = LaunchFields & {
  version: 1
  checkoutId: string
  leaseId: string
  agentId: string
  owner?: never
}

export type LaunchRecord = ManagedLaunchRecord | LegacyLaunchRecord

export function launchOwner(record: LaunchRecord):
  | { kind: "agent"; id: string; generation: string }
  | { kind: "catalog-probe"; id: string; providerId: ProviderId }
  | { kind: "legacy-agent"; id: string; handlerGeneration: string } {
  if (record.version === 1) return { kind: "legacy-agent", id: record.agentId, handlerGeneration: record.handlerGeneration }
  return record.owner.kind === "agent"
    ? { kind: "agent", id: record.owner.agentId, generation: record.owner.providerGeneration }
    : { kind: "catalog-probe", id: record.owner.commandId, providerId: record.owner.providerId }
}

export type ReconcileResult = {
  record: LaunchRecord
  disposition: "released" | "cleaned" | "quarantined"
  diagnostics?: Array<{ kind: "detached-helper"; identity: ProcessIdentity }>
}

export type HandlerPhase =
  | "launch_pending"
  | "identity_published"
  | "socket_bound"
  | "reconciling"
  | "ready"
  | "exited_unverified"

export type HandlerGenerationRecord = {
  version: typeof RUNTIME_RECORD_VERSION
  hostId: string
  launchBootId: string
  generation: string
  launchAttemptId: string
  launchAttempted: boolean
  phase: HandlerPhase
  process: ProcessIdentity | null
  socketPath: string
  writer: "launcher" | "handler" | "reconciler"
  reconciliation: { classified: number; total: number; quarantined: number } | null
  reason: string | null
}

export type HandlerInspection = {
  record: HandlerGenerationRecord
  disposition: "live" | "stale" | "ambiguous"
  diagnostic?: { reason: string; expected: ProcessIdentity | null; observed: ProcessIdentity | null }
}

export type PlatformAdapter = {
  platform: "darwin" | "linux"
  bootId(): Promise<string>
  readProcess(pid: number): Promise<ProcessIdentity | null>
  readGroup(processGroupId: number): Promise<ProcessIdentity[]>
  signalGroup(processGroupId: number, signal: NodeJS.Signals): Promise<void>
}

export function processBirthStart(birth: string): string | null {
  const separator = birth.indexOf(":")
  if (separator <= 0) return null
  const prefix = birth.slice(0, separator)
  return /^(0|[1-9]\d*)$/.test(prefix) ? prefix : null
}

export function sameProcessGeneration(expected: ProcessIdentity, observed: ProcessIdentity): boolean {
  const expectedStart = processBirthStart(expected.birth)
  const observedStart = processBirthStart(observed.birth)
  return expectedStart !== null && observedStart !== null
    && expected.bootId === observed.bootId
    && expected.pid === observed.pid
    && expectedStart === observedStart
}

export function sameProcess(expected: ProcessIdentity, observed: ProcessIdentity): boolean {
  return sameProcessGeneration(expected, observed)
    && expected.birth === observed.birth
    && expected.processGroupId === observed.processGroupId
    && expected.sessionId === observed.sessionId
    && expected.uid === observed.uid
    && expected.gid === observed.gid
}