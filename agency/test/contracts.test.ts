import assert from "node:assert/strict"
import test from "node:test"
import {
  RUNTIME_RECORD_VERSION,
  type HandlerGenerationRecord,
  type HandlerInspection,
  type HandlerPhase,
  type LaunchPhase,
  type LaunchRecord,
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
  birth: "101:fixture",
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

const providers = [processGroupProvider] satisfies ProviderIdentity[]

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

const linuxAdapter = {
  ...platformAdapter,
  platform: "linux",
} satisfies PlatformAdapter

void reconcileResult
void handlerInspection
void platformAdapter
void linuxAdapter

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

test("rejects legacy Linux namespace launch records", async t => {
  const types = await import("../src/platform/types.js") as unknown as {
    processBirthStart(birth: string): string | null
    sameProcessGeneration(a: ProcessIdentity, b: ProcessIdentity): boolean
  }
  await t.test("numeric generations are lossless and exclude mutable authorization fields", () => {
    assert.equal(typeof types.processBirthStart, "function")
    for (const value of ["0", "999999999999999999999999999999"]) assert.equal(types.processBirthStart(`${value}:a/b:c`), value)
    for (const value of ["", "01:x", "-1:x", "1.2:x", "1e3:x", ":x", "NaN:x", "1", " 1:x"]) assert.equal(types.processBirthStart(value), null)
    const changed = { ...processIdentity, birth: "101:changed", uid: 9, gid: 8, processGroupId: 900, sessionId: 900 }
    assert.equal(types.sameProcessGeneration(processIdentity, changed), true)
    assert.equal(sameProcess(processIdentity, changed), false)
    for (const fields of [{ bootId: "other" }, { pid: 99 }, { birth: "102:fixture" }]) assert.equal(types.sameProcessGeneration(processIdentity, { ...processIdentity, ...fields }), false)
  })
  await t.test("runtime parser rejects the legacy union", async () => {
    const { mkdtemp, writeFile, rm, realpath } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { readLaunchRecord } = await import("../src/platform/private-state.js")
    const directory = await mkdtemp(`${await realpath(tmpdir())}/agency-contract-`)
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = `${directory}/record.json`
    await writeFile(path, JSON.stringify({ ...launchRecord, provider: { kind: "linux-pid-namespace", launcher: processIdentity, init: processIdentity, namespaceId: "ns-1", observed: [processIdentity] } }), { mode: 0o600 })
    await assert.rejects(readLaunchRecord(path), /provider|namespace|kind/i)
  })
})