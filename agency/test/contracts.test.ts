import assert from "node:assert/strict"
import test from "node:test"
import {
  RUNTIME_RECORD_VERSION,
  type HandlerGenerationRecord,
  type HandlerInspection,
  type HandlerPhase,
  type LaunchPhase,
  type LaunchRecord,
  type LinuxNamespaceAdapter,
  type LinuxNamespaceProviderIdentity,
  type PlatformAdapter,
  type ProcessGroupIdentity,
  type ProcessGroupProviderIdentity,
  type ProcessIdentity,
  type ProviderIdentity,
  type ReconcileResult,
  sameProcess,
} from "../src/platform/types.js"

const processIdentity = {
  bootId: "boot-1",
  pid: 101,
  birth: "birth-101",
  parentPid: 1,
  processGroupId: 101,
  sessionId: 101,
  uid: 501,
  gid: 20,
} satisfies ProcessIdentity

const observedIdentity = {
  ...processIdentity,
  parentPid: 2,
} satisfies ProcessIdentity

const processGroup = {
  leader: processIdentity,
  observed: [processIdentity, observedIdentity],
} satisfies ProcessGroupIdentity

const processGroupProvider = {
  kind: "process-group",
  group: processGroup,
} satisfies ProcessGroupProviderIdentity

const linuxNamespaceProvider = {
  kind: "linux-pid-namespace",
  launcher: processIdentity,
  init: processIdentity,
  namespaceId: "ns-1",
  observed: [processIdentity],
} satisfies LinuxNamespaceProviderIdentity

const providers = [processGroupProvider, linuxNamespaceProvider] satisfies ProviderIdentity[]

const launchPhases = [
  "launch_pending",
  "readiness",
  "active",
  "exited_unverified",
  "cleanup_pending",
  "cleanup_verified",
  "quarantined",
] satisfies LaunchPhase[]

const handlerPhases = {
  launch_pending: "launch_pending",
  identity_published: "identity_published",
  socket_bound: "socket_bound",
  reconciling: "reconciling",
  ready: "ready",
  exited_unverified: "exited_unverified",
} satisfies Record<HandlerPhase, HandlerPhase>

const launchRecord = {
  version: RUNTIME_RECORD_VERSION,
  checkoutId: "checkout-1",
  leaseId: "lease-1",
  agentId: "agent-1",
  handlerGeneration: "generation-1",
  launchAttemptId: "attempt-1",
  launchBootId: "boot-1",
  launchAttempted: true,
  phase: "launch_pending",
  provider: processGroupProvider,
  reason: null,
} satisfies LaunchRecord

const handlerGenerationRecord = {
  version: RUNTIME_RECORD_VERSION,
  hostId: "host-1",
  launchBootId: "boot-1",
  generation: "generation-1",
  launchAttemptId: "attempt-1",
  launchAttempted: true,
  phase: "launch_pending",
  process: processIdentity,
  socketPath: "/tmp/agency.sock",
  writer: "handler",
  reconciliation: { classified: 1, total: 1, quarantined: 0 },
  reason: null,
} satisfies HandlerGenerationRecord

const reconcileResult = {
  record: launchRecord,
  disposition: "cleaned",
} satisfies ReconcileResult

const handlerInspection = {
  record: handlerGenerationRecord,
  disposition: "live",
} satisfies HandlerInspection

const platformAdapter = {
  platform: "darwin",
  bootId: async () => "boot-1",
  readProcess: async () => processIdentity,
  readGroup: async () => [processIdentity],
  signalGroup: async () => undefined,
} satisfies PlatformAdapter

const linuxNamespaceAdapter = {
  ...platformAdapter,
  platform: "linux",
  readNamespace: async () => "ns-1",
  scanNamespace: async () => [processIdentity],
} satisfies LinuxNamespaceAdapter

void reconcileResult
void handlerInspection
void platformAdapter
void linuxNamespaceAdapter

test("exports the runtime record version", () => {
  assert.equal(RUNTIME_RECORD_VERSION, 1)
})

test("sameProcess ignores only parentPid", () => {
  assert.equal(sameProcess(processIdentity, observedIdentity), true)
  assert.equal(sameProcess(processIdentity, { ...observedIdentity, bootId: "boot-2" }), false)
  assert.equal(sameProcess(processIdentity, { ...observedIdentity, pid: 102 }), false)
  assert.equal(sameProcess(processIdentity, { ...observedIdentity, birth: "birth-102" }), false)
  assert.equal(sameProcess(processIdentity, { ...observedIdentity, processGroupId: 102 }), false)
  assert.equal(sameProcess(processIdentity, { ...observedIdentity, sessionId: 102 }), false)
  assert.equal(sameProcess(processIdentity, { ...observedIdentity, uid: 502 }), false)
  assert.equal(sameProcess(processIdentity, { ...observedIdentity, gid: 21 }), false)
})