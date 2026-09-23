import assert from "node:assert/strict"
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readLaunchRecord, writeLaunchRecord } from "../src/platform/private-state.js"
import { reconcileLinuxNamespaceRecord, reconcileRecord } from "../src/platform/reconcile.js"
import {
  RUNTIME_RECORD_VERSION,
  type LaunchRecord,
  type LinuxNamespaceAdapter,
  type PlatformAdapter,
  type ProcessIdentity,
} from "../src/platform/types.js"

const uid = process.getuid!()
const gid = process.getgid!()

function identity(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return {
    bootId: "boot-1",
    pid: 101,
    birth: "birth-101",
    parentPid: 1,
    processGroupId: 101,
    sessionId: 101,
    uid,
    gid,
    ...overrides,
  }
}

function record(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  const leader = identity()
  return {
    version: RUNTIME_RECORD_VERSION,
    checkoutId: "checkout-1",
    leaseId: "lease-1",
    agentId: "agent-1",
    handlerGeneration: "generation-1",
    launchAttemptId: "attempt-1",
    launchBootId: "boot-1",
    launchAttempted: true,
    phase: "active",
    provider: { kind: "process-group", group: { leader, observed: [leader] } },
    reason: null,
    ...overrides,
  }
}

type AdapterOptions = {
  bootId?: string
  leader?: ProcessIdentity | null
  group?: ProcessIdentity[]
  onSignal?: (signal: NodeJS.Signals, adapter: FakeAdapter) => void
}

class FakeAdapter implements PlatformAdapter {
  readonly platform: "darwin" | "linux" = "darwin"
  currentBootId: string
  leader: ProcessIdentity | null
  group: ProcessIdentity[]
  signals: NodeJS.Signals[] = []
  onSignal: AdapterOptions["onSignal"]

  constructor(options: AdapterOptions = {}) {
    this.currentBootId = options.bootId ?? "boot-1"
    this.leader = options.leader === undefined ? identity() : options.leader
    this.group = options.group ?? [identity()]
    this.onSignal = options.onSignal
  }

  async bootId(): Promise<string> {
    return this.currentBootId
  }

  async readProcess(_pid: number): Promise<ProcessIdentity | null> {
    return this.leader
  }

  async readGroup(): Promise<ProcessIdentity[]> {
    return this.group
  }

  async signalGroup(_processGroupId: number, signal: NodeJS.Signals): Promise<void> {
    this.signals.push(signal)
    this.onSignal?.(signal, this)
  }
}

async function recordFixture(t: test.TestContext, value: LaunchRecord): Promise<string> {
  const directory = join(await realpath(tmpdir()), `agency-reconcile-${crypto.randomUUID()}`)
  await mkdir(directory, { mode: 0o700 })
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "launch.json")
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  return path
}

async function assertOutcome(t: test.TestContext, starting: LaunchRecord, adapter: FakeAdapter, expected: { disposition: "released" | "cleaned" | "quarantined"; signals: NodeJS.Signals[] }): Promise<void> {
  const path = await recordFixture(t, starting)
  const result = await reconcileRecord(path, adapter)
  assert.equal(result.disposition, expected.disposition)
  assert.deepEqual(adapter.signals, expected.signals)
  assert.deepEqual(result.record, await readLaunchRecord(path))
  assert.equal(result.record.phase, expected.disposition === "quarantined" ? "quarantined" : "cleanup_verified")
}

test("reconciles the process-group safety matrix", async t => {
  await t.test("releases a same-boot provably unattempted launch", async t => {
    await assertOutcome(t, record({ launchAttempted: false, provider: null, phase: "launch_pending" }), new FakeAdapter(), { disposition: "released", signals: [] })
  })
  await t.test("quarantines a same-boot attempted launch without provider identity", async t => {
    await assertOutcome(t, record({ provider: null, phase: "launch_pending" }), new FakeAdapter(), { disposition: "quarantined", signals: [] })
  })
  await t.test("releases an attempted prior-boot launch without provider identity", async t => {
    await assertOutcome(t, record({ launchBootId: "boot-old", provider: null, phase: "launch_pending" }), new FakeAdapter(), { disposition: "released", signals: [] })
  })
  await t.test("releases contradictory prior-boot evidence without signaling", async t => {
    await assertOutcome(t, record({ launchBootId: "boot-old", launchAttempted: false }), new FakeAdapter(), { disposition: "released", signals: [] })
  })
  await t.test("releases a prior-boot provider without signaling", async t => {
    await assertOutcome(t, record(), new FakeAdapter({ bootId: "boot-2" }), { disposition: "released", signals: [] })
  })
  await t.test("terminates an exact live group and reports cleaned", async t => {
    await assertOutcome(t, record(), new FakeAdapter({ onSignal: (_signal, adapter) => { adapter.leader = null; adapter.group = [] } }), { disposition: "cleaned", signals: ["SIGTERM"] })
  })
  await t.test("releases an absent leader with an empty group", async t => {
    await assertOutcome(t, record(), new FakeAdapter({ leader: null, group: [] }), { disposition: "released", signals: [] })
  })
  await t.test("releases a reused leader pid when the old group is empty", async t => {
    await assertOutcome(t, record(), new FakeAdapter({ leader: identity({ birth: "new-birth" }), group: [] }), { disposition: "released", signals: [] })
  })
  await t.test("quarantines a reused leader pid with a nonempty group", async t => {
    await assertOutcome(t, record(), new FakeAdapter({ leader: identity({ birth: "new-birth" }), group: [identity({ birth: "new-birth" })] }), { disposition: "quarantined", signals: [] })
  })
  await t.test("quarantines an exact leader with an outside-session member", async t => {
    await assertOutcome(t, record(), new FakeAdapter({ group: [identity(), identity({ pid: 102, birth: "birth-102", sessionId: 202 })] }), { disposition: "quarantined", signals: [] })
  })
  await t.test("quarantines a surviving group after TERM and KILL", async t => {
    await assertOutcome(t, record(), new FakeAdapter(), { disposition: "quarantined", signals: ["SIGTERM", "SIGKILL"] })
  })
  await t.test("quarantines an unattempted record with a provider", async t => {
    await assertOutcome(t, record({ launchAttempted: false }), new FakeAdapter(), { disposition: "quarantined", signals: [] })
  })
  await t.test("quarantines a provider whose leader pgid differs from its pid", async t => {
    const leader = identity({ processGroupId: 202 })
    await assertOutcome(t, record({ provider: { kind: "process-group", group: { leader, observed: [leader] } } }), new FakeAdapter(), { disposition: "quarantined", signals: [] })
  })
  await t.test("quarantines a provider whose leader session differs from its pid", async t => {
    const leader = identity({ sessionId: 202 })
    await assertOutcome(t, record({ provider: { kind: "process-group", group: { leader, observed: [leader] } } }), new FakeAdapter({ leader, group: [leader] }), { disposition: "quarantined", signals: [] })
  })
  await t.test("quarantines inconsistent recorded members", async t => {
    const fields: Array<Partial<ProcessIdentity>> = [{ bootId: "boot-2" }, { processGroupId: 202 }, { sessionId: 202 }]
    for (const changed of fields) {
      const member = identity({ pid: 102, birth: "birth-102", ...changed })
      await assertOutcome(t, record({ provider: { kind: "process-group", group: { leader: identity(), observed: [identity(), member] } } }), new FakeAdapter(), { disposition: "quarantined", signals: [] })
    }
  })
  await t.test("quarantines readiness and active records without a provider", async t => {
    await assertOutcome(t, record({ provider: null, phase: "readiness" }), new FakeAdapter(), { disposition: "quarantined", signals: [] })
    await assertOutcome(t, record({ provider: null, phase: "active" }), new FakeAdapter(), { disposition: "quarantined", signals: [] })
  })
  await t.test("kills continuous same-session members after the leader exits", async t => {
    const member = identity({ pid: 102, birth: "birth-102" })
    const adapter = new FakeAdapter({
      group: [identity(), member],
      onSignal: (signal, current) => {
        if (signal === "SIGTERM") { current.leader = null; current.group = [member] }
        if (signal === "SIGKILL") current.group = []
      },
    })
    await assertOutcome(t, record(), adapter, { disposition: "cleaned", signals: ["SIGTERM", "SIGKILL"] })
  })
  await t.test("quarantines a reappearing group before KILL", async t => {
    const adapter = new FakeAdapter({ onSignal: (signal, current) => {
      if (signal === "SIGTERM") {
        current.leader = identity({ birth: "replacement" })
        current.group = [current.leader]
      }
    } })
    await assertOutcome(t, record(), adapter, { disposition: "quarantined", signals: ["SIGTERM"] })
  })
  await t.test("quarantines a replacement at the session leader pid after a racy read", async t => {
    const adapter = new FakeAdapter({ onSignal: (signal, current) => {
      if (signal === "SIGTERM") {
        current.leader = null
        current.group = [identity({ birth: "replacement" })]
      }
    } })
    await assertOutcome(t, record(), adapter, { disposition: "quarantined", signals: ["SIGTERM"] })
  })
})

test("quarantine is scoped to one checkout record", async t => {
  const first = await recordFixture(t, record({ checkoutId: "first" }))
  const second = await recordFixture(t, record({ checkoutId: "second", launchAttempted: false, provider: null, phase: "launch_pending" }))
  const quarantined = await reconcileRecord(first, new FakeAdapter({ leader: identity({ birth: "replacement" }), group: [identity({ birth: "replacement" })] }))
  const released = await reconcileRecord(second, new FakeAdapter())
  assert.equal(quarantined.disposition, "quarantined")
  assert.equal(released.disposition, "released")
})

test("ignores parent pid changes but quarantines stable identity changes without signaling", async t => {
  const parentChanged = new FakeAdapter({ leader: identity({ parentPid: 999 }), group: [identity({ parentPid: 999 })], onSignal: (_signal, adapter) => { adapter.leader = null; adapter.group = [] } })
  await assertOutcome(t, record(), parentChanged, { disposition: "cleaned", signals: ["SIGTERM"] })
  for (const changed of [{ processGroupId: 202 }, { sessionId: 202 }]) {
    const observed = identity(changed)
    await assertOutcome(t, record(), new FakeAdapter({ leader: observed, group: [observed] }), { disposition: "quarantined", signals: [] })
  }
})

test("validates semantics before the unattempted release rule", async t => {
  await assertOutcome(t, record({ launchAttempted: false, phase: "launch_pending" }), new FakeAdapter(), { disposition: "quarantined", signals: [] })
  await assertOutcome(t, record({ launchAttempted: false, provider: null, phase: "cleanup_pending" }), new FakeAdapter(), { disposition: "quarantined", signals: [] })
  await assertOutcome(t, record({ launchAttempted: false, provider: null, phase: "exited_unverified", reason: "invalid exit" }), new FakeAdapter(), { disposition: "quarantined", signals: [] })
  await assertOutcome(t, record({ launchAttempted: false, phase: "cleanup_verified" }), new FakeAdapter(), { disposition: "quarantined", signals: [] })
})

test("retains malformed core records instead of releasing the checkout", async t => {
  const path = await recordFixture(t, record())
  const malformed = { ...record(), checkoutId: 42, launchAttempted: false, provider: null, phase: "launch_pending" }
  await writeFile(path, JSON.stringify(malformed), { mode: 0o600 })
  await assert.rejects(reconcileRecord(path, new FakeAdapter()), /checkoutId|record/i)
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), malformed)
})

class FakeLinuxAdapter extends FakeAdapter implements LinuxNamespaceAdapter {
  override readonly platform: "darwin" | "linux" = "linux"
  namespaceByPid = new Map<number, string | null>()
  namespaceMembers: ProcessIdentity[] = []

  async readNamespace(pid: number): Promise<string | null> {
    return this.namespaceByPid.get(pid) ?? null
  }

  async scanNamespace(): Promise<ProcessIdentity[]> {
    return this.namespaceMembers
  }
}

test("process-group reconciliation quarantines a Linux adapter without signaling", async t => {
  const adapter = new FakeLinuxAdapter({ leader: identity(), group: [identity()] })
  await assertOutcome(t, record(), adapter, { disposition: "quarantined", signals: [] })
})

class FakeDarwinNamespaceAdapter extends FakeAdapter implements LinuxNamespaceAdapter {
  async readNamespace(): Promise<string | null> {
    return null
  }

  async scanNamespace(): Promise<ProcessIdentity[]> {
    return []
  }
}

function namespaceRecord(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  const launcher = identity({ pid: 201, birth: "birth-201", processGroupId: 201, sessionId: 201 })
  const init = identity({ pid: 202, birth: "birth-202", parentPid: 201, processGroupId: 201, sessionId: 201 })
  return record({
    provider: { kind: "linux-pid-namespace", launcher, init, namespaceId: "pid:[4026532000]", observed: [launcher, init] },
    ...overrides,
  })
}

function linuxAdapter(options: { bootId?: string; launcher?: ProcessIdentity | null; init?: ProcessIdentity | null; namespaceId?: string | null; members?: ProcessIdentity[] } = {}): FakeLinuxAdapter {
  const value = namespaceRecord().provider
  if (value?.kind !== "linux-pid-namespace") throw new Error("namespace fixture invalid")
  const adapter = new FakeLinuxAdapter({ ...(options.bootId === undefined ? {} : { bootId: options.bootId }), leader: null, group: [] })
  adapter.readProcess = async pid => {
    if (pid === value.launcher.pid) return options.launcher === undefined ? null : options.launcher
    if (pid === value.init.pid) return options.init === undefined ? null : options.init
    return null
  }
  adapter.namespaceByPid.set(value.init.pid, options.namespaceId ?? null)
  adapter.namespaceMembers = options.members ?? []
  return adapter
}

async function assertLinuxOutcome(t: test.TestContext, starting: LaunchRecord, adapter: FakeLinuxAdapter, disposition: "released" | "quarantined"): Promise<void> {
  const path = await recordFixture(t, starting)
  const result = await reconcileLinuxNamespaceRecord(path, adapter)
  assert.equal(result.disposition, disposition)
  assert.equal(result.record.phase, disposition === "released" ? "cleanup_verified" : "quarantined")
  assert.deepEqual(adapter.signals, [])
  assert.deepEqual(result.record, await readLaunchRecord(path))
}

test("namespace reconciliation quarantines a Darwin adapter", async t => {
  const path = await recordFixture(t, namespaceRecord())
  const adapter = new FakeDarwinNamespaceAdapter({ leader: null, group: [] })
  const result = await reconcileLinuxNamespaceRecord(path, adapter)
  assert.equal(result.disposition, "quarantined")
  assert.deepEqual(adapter.signals, [])
})

test("reconciles the Linux namespace safety matrix without signaling", async t => {
  const provider = namespaceRecord().provider
  if (provider?.kind !== "linux-pid-namespace") throw new Error("namespace fixture invalid")
  await t.test("releases a prior-boot record", async t => {
    await assertLinuxOutcome(t, namespaceRecord(), linuxAdapter({ bootId: "boot-2" }), "released")
  })
  await t.test("releases an empty namespace with both identities gone", async t => {
    await assertLinuxOutcome(t, namespaceRecord(), linuxAdapter(), "released")
  })
  await t.test("quarantines any surviving namespace member", async t => {
    await assertLinuxOutcome(t, namespaceRecord(), linuxAdapter({ members: [provider.init] }), "quarantined")
  })
  await t.test("quarantines a changed namespace link", async t => {
    await assertLinuxOutcome(t, namespaceRecord(), linuxAdapter({ init: provider.init, namespaceId: "pid:[changed]" }), "quarantined")
  })
  await t.test("releases when launcher pid is reused and the old tree is gone", async t => {
    await assertLinuxOutcome(t, namespaceRecord(), linuxAdapter({ launcher: { ...provider.launcher, birth: "replacement" } }), "released")
  })
  await t.test("releases when init pid is reused and the old tree is gone", async t => {
    await assertLinuxOutcome(t, namespaceRecord(), linuxAdapter({ init: { ...provider.init, birth: "replacement" } }), "released")
  })
  await t.test("quarantines reused identities with a nonempty namespace", async t => {
    await assertLinuxOutcome(t, namespaceRecord(), linuxAdapter({ launcher: { ...provider.launcher, birth: "replacement" }, members: [provider.init] }), "quarantined")
    await assertLinuxOutcome(t, namespaceRecord(), linuxAdapter({ init: { ...provider.init, birth: "replacement" }, members: [provider.init] }), "quarantined")
  })
  await t.test("quarantines an exact live identity with an empty namespace", async t => {
    await assertLinuxOutcome(t, namespaceRecord(), linuxAdapter({ launcher: provider.launcher }), "quarantined")
    await assertLinuxOutcome(t, namespaceRecord(), linuxAdapter({ init: provider.init, namespaceId: provider.namespaceId }), "quarantined")
  })
  await t.test("quarantines malformed namespace evidence", async t => {
    const wrongBoot = { ...provider.launcher, bootId: "boot-2" }
    await assertLinuxOutcome(t, namespaceRecord({ provider: { ...provider, launcher: wrongBoot } }), linuxAdapter(), "quarantined")
    await assertLinuxOutcome(t, namespaceRecord({ provider: { ...provider, namespaceId: "" } }), linuxAdapter(), "quarantined")
    await assertLinuxOutcome(t, namespaceRecord({ provider: { ...provider, observed: [provider.launcher, provider.launcher] } }), linuxAdapter(), "quarantined")
  })
  await t.test("validates semantics before releasing cleanup_verified", async t => {
    await assertLinuxOutcome(t, namespaceRecord({ launchAttempted: false, phase: "cleanup_verified" }), linuxAdapter(), "quarantined")
  })
})