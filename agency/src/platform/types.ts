export const RUNTIME_RECORD_VERSION = 1 as const

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

export type LinuxNamespaceProviderIdentity = {
  kind: "linux-pid-namespace"
  launcher: ProcessIdentity
  init: ProcessIdentity
  namespaceId: string
  observed: ProcessIdentity[]
}

export type ProviderIdentity = ProcessGroupProviderIdentity | LinuxNamespaceProviderIdentity

export type LaunchPhase =
  | "launch_pending"
  | "readiness"
  | "active"
  | "exited_unverified"
  | "cleanup_pending"
  | "cleanup_verified"
  | "quarantined"

export type LaunchRecord = {
  version: typeof RUNTIME_RECORD_VERSION
  checkoutId: string
  leaseId: string
  agentId: string
  handlerGeneration: string
  launchAttemptId: string
  launchBootId: string
  launchAttempted: boolean
  phase: LaunchPhase
  provider: ProviderIdentity | null
  reason: string | null
}

export type ReconcileResult = {
  record: LaunchRecord
  disposition: "released" | "cleaned" | "quarantined"
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
}

export type PlatformAdapter = {
  platform: "darwin" | "linux"
  bootId(): Promise<string>
  readProcess(pid: number): Promise<ProcessIdentity | null>
  readGroup(processGroupId: number): Promise<ProcessIdentity[]>
  signalGroup(processGroupId: number, signal: NodeJS.Signals): Promise<void>
}

export type LinuxNamespaceAdapter = PlatformAdapter & {
  readNamespace(pid: number): Promise<string | null>
  scanNamespace(namespaceId: string): Promise<ProcessIdentity[]>
}

export function sameProcess(expected: ProcessIdentity, observed: ProcessIdentity): boolean {
  return expected.bootId === observed.bootId
    && expected.pid === observed.pid
    && expected.birth === observed.birth
    && expected.processGroupId === observed.processGroupId
    && expected.sessionId === observed.sessionId
    && expected.uid === observed.uid
    && expected.gid === observed.gid
}