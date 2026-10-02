import assert from "node:assert/strict"
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readLaunchRecord, writeLaunchRecord } from "../src/platform/private-state.js"
import { DarwinObservationUnavailable } from "../src/platform/darwin.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import {
  RUNTIME_RECORD_VERSION,
  type LaunchRecord,
  type LegacyLaunchRecord,
  type PlatformAdapter,
  type ProcessIdentity,
} from "../src/platform/types.js"

const uid = process.getuid!()
const gid = process.getgid!()

function identity(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return {
    bootId: "boot-1",
    pid: 101,
    birth: "101:agy-provider:123e4567-e89b-12d3-a456-426614174000",
    parentPid: 1,
    processGroupId: 101,
    sessionId: 101,
    uid,
    gid,
    ...overrides,
  }
}

function record(overrides: Partial<LegacyLaunchRecord> = {}): LegacyLaunchRecord {
  const leader = identity()
  return {
    version: RUNTIME_RECORD_VERSION,
    checkoutId: "checkout-1",
    leaseId: "lease-1",
    agentId: "agent-1",
    handlerGeneration: "generation-1",
    launchAttemptId: "123e4567-e89b-12d3-a456-426614174000",
    launchBootId: "boot-1",
    launchAttempted: true,
    phase: "active",
    provider: { kind: "process-group", group: { leader, observed: [leader] } },
    reason: null,
    ...overrides,
  }
}

type AdapterOptions = {
  platform?: "darwin" | "linux"
  bootId?: string
  leader?: ProcessIdentity | null
  group?: ProcessIdentity[]
  onSignal?: (signal: NodeJS.Signals, adapter: FakeAdapter) => void
}

class FakeAdapter implements PlatformAdapter {
  readonly platform: "darwin" | "linux"
  currentBootId: string
  leader: ProcessIdentity | null
  group: ProcessIdentity[]
  signals: NodeJS.Signals[] = []
  onSignal: AdapterOptions["onSignal"]

  constructor(options: AdapterOptions = {}) {
    this.platform = options.platform ?? "darwin"
    this.currentBootId = options.bootId ?? "boot-1"
    this.leader = options.leader === undefined ? identity() : options.leader
    this.group = options.group ?? [identity()]
    this.onSignal = options.onSignal
  }

  async bootId(): Promise<string> {
    return this.currentBootId
  }

  async readProcess(pid: number): Promise<ProcessIdentity | null> {
    return pid === 101 ? this.leader : this.group.find(member => member.pid === pid) ?? null
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

test("late detached group members retain quarantine after every recorded process exits", async t => {
  const leader = identity(), codex = identity({ pid: 102, birth: "102:unmarked:/managed/codex", parentPid: leader.pid })
  const detached = identity({ pid: 103, birth: "103:unmarked:/managed/git", parentPid: 1 })
  const starting = record({ provider: { kind: "process-group", group: { leader, observed: [leader, codex] } } })
  const adapter = new FakeAdapter({ leader: null, group: [detached] })
  const path = await recordFixture(t, starting)
  const result = await reconcileRecord(path, adapter)
  assert.equal(result.disposition, "quarantined")
  assert.equal(result.record.phase, "quarantined")
  assert.deepEqual(result.record.provider, starting.provider)
  assert.deepEqual(result.record, await readLaunchRecord(path))
  assert.deepEqual(adapter.signals, [])
  assert.deepEqual(adapter.group, [detached])
})

test("late detached group members cannot authorize escalation after SIGTERM", async t => {
  const adapter = new FakeAdapter({ onSignal: (signal, state) => {
    assert.equal(signal, "SIGTERM")
    state.leader = null
    state.group = [identity({ pid: 103, birth: "103:unmarked:/managed/git", parentPid: 1 })]
  } })
  await assertOutcome(t, record(), adapter, { disposition: "quarantined", signals: ["SIGTERM"] })
})

test("an observed helper outside the recorded group is diagnostic after group cleanup", async t => {
  const leader = identity(), member = identity({ pid: 102, birth: "102:descendant" })
  const detached = { ...member, processGroupId: 202, sessionId: 202 }
  const adapter = new FakeAdapter({ leader: null, group: [] })
  adapter.readProcess = async pid => pid === member.pid ? detached : null
  const path = await recordFixture(t, record({ provider: { kind: "process-group", group: { leader, observed: [leader, member] } } }))
  const result = await reconcileRecord(path, adapter)
  assert.equal(result.disposition, "released")
  assert.equal(result.record.phase, "cleanup_verified")
  assert.deepEqual(result.diagnostics, [{ kind: "detached-helper", identity: detached }])
  assert.deepEqual(adapter.signals, [])
})

test("a changed former helper outside the recorded group is not an exact detached diagnostic", async t => {
  const leader = identity(), member = identity({ pid: 102, birth: "102:descendant" })
  for (const change of [{ birth: "102:replacement" }, { uid: member.uid + 1 }, { gid: member.gid + 1 }]) {
    const adapter = new FakeAdapter({ leader: null, group: [] })
    adapter.readProcess = async pid => pid === member.pid ? { ...member, ...change, processGroupId: 202, sessionId: 202 } : null
    const path = await recordFixture(t, record({ provider: { kind: "process-group", group: { leader, observed: [leader, member] } } }))
    const result = await reconcileRecord(path, adapter)
    assert.equal(result.disposition, "released")
    assert.deepEqual(result.diagnostics, undefined)
    assert.deepEqual(adapter.signals, [])
  }
})

test("an unreadable former helper does not invalidate an empty owned group", async t => {
  const leader = identity(), member = identity({ pid: 102, birth: "102:descendant" })
  const adapter = new FakeAdapter({ leader: null, group: [] })
  adapter.readProcess = async pid => { if (pid === member.pid) throw new Error("former helper unavailable"); return null }
  const path = await recordFixture(t, record({ provider: { kind: "process-group", group: { leader, observed: [leader, member] } } }))
  const result = await reconcileRecord(path, adapter)
  assert.equal(result.disposition, "released")
  assert.deepEqual(adapter.signals, [])
})

test("transient child exit between signal authorization snapshots retains cleanup authority", async t => {
  const leader = identity(), child = identity({ pid: 102, birth: "102:descendant", parentPid: leader.pid })
  const starting = record({ provider: { kind: "process-group", group: { leader, observed: [leader, child] } } })
  const adapter = new FakeAdapter({ group: [leader, child], onSignal: (_signal, state) => { state.leader = null; state.group = [] } })
  let reads = 0
  adapter.readGroup = async () => adapter.signals.length ? [] : ++reads === 1 ? [leader, child] : [leader]
  const path = await recordFixture(t, starting)
  const result = await reconcileRecord(path, adapter)
  assert.equal(result.disposition, "cleaned")
  assert.deepEqual(adapter.signals, ["SIGTERM"])
})

test("an exact live leader authorizes a new same-session child before SIGTERM", async t => {
  const leader = identity(), child = identity({ pid: 102, birth: "102:descendant", parentPid: leader.pid })
  const adapter = new FakeAdapter({ group: [leader], onSignal: (_signal, state) => { state.leader = null; state.group = [] } })
  let reads = 0
  adapter.readGroup = async () => adapter.signals.length ? [] : ++reads === 1 ? [leader] : [leader, child]
  const path = await recordFixture(t, record())
  const result = await reconcileRecord(path, adapter)
  assert.equal(result.disposition, "cleaned")
  assert.deepEqual(adapter.signals, ["SIGTERM"])
  assert.ok(result.record.provider?.group.observed.some(member => member.pid === child.pid))
})

test("expected inventory rejects a replaced record before any write or signal", async t => {
  const expected = record()
  const actual = { ...expected, checkoutId: "replacement" }
  const path = await recordFixture(t, actual)
  const before = await readFile(path)
  const adapter = new FakeAdapter()
  await assert.rejects(reconcileRecord(path, adapter, expected), /RETAINED_INVENTORY_CHANGED/)
  assert.deepEqual(adapter.signals, [])
  assert.deepEqual(await readFile(path), before)
})

for (const platform of ["darwin", "linux"] as const) {
 test("reconciles the process-group safety matrix on " + platform, async t => {
  const fake = (options: AdapterOptions = {}) => new FakeAdapter({ ...options, platform })
  await t.test("releases a same-boot provably unattempted launch", async t => {
    await assertOutcome(t, record({ launchAttempted: false, provider: null, phase: "launch_pending" }), fake(), { disposition: "released", signals: [] })
  })
  await t.test("quarantines a same-boot attempted launch without provider identity", async t => {
    await assertOutcome(t, record({ provider: null, phase: "launch_pending" }), fake(), { disposition: "quarantined", signals: [] })
  })
  await t.test("releases an attempted prior-boot launch without provider identity", async t => {
    await assertOutcome(t, record({ launchBootId: "boot-old", provider: null, phase: "launch_pending" }), fake(), { disposition: "released", signals: [] })
  })
  await t.test("releases contradictory prior-boot evidence without signaling", async t => {
    await assertOutcome(t, record({ launchBootId: "boot-old", launchAttempted: false }), fake(), { disposition: "released", signals: [] })
  })
  await t.test("releases a prior-boot provider without signaling", async t => {
    await assertOutcome(t, record(), fake({ bootId: "boot-2" }), { disposition: "released", signals: [] })
  })
  await t.test("terminates an exact live group and reports cleaned", async t => {
    await assertOutcome(t, record(), fake({ onSignal: (_signal, adapter) => { adapter.leader = null; adapter.group = [] } }), { disposition: "cleaned", signals: ["SIGTERM"] })
  })
  await t.test("releases an absent leader with an empty group", async t => {
    await assertOutcome(t, record(), fake({ leader: null, group: [] }), { disposition: "released", signals: [] })
  })
  await t.test("releases a reused leader pid when the old group is empty", async t => {
    await assertOutcome(t, record(), fake({ leader: identity({ birth: "999:fixture" }), group: [] }), { disposition: "released", signals: [] })
  })
  await t.test("quarantines a reused leader pid with a nonempty group", async t => {
    await assertOutcome(t, record(), fake({ leader: identity({ birth: "999:fixture" }), group: [identity({ birth: "999:fixture" })] }), { disposition: "quarantined", signals: [] })
  })
  await t.test("quarantines an exact leader with an outside-session member", async t => {
    await assertOutcome(t, record(), fake({ group: [identity(), identity({ pid: 102, birth: "102:fixture", sessionId: 202 })] }), { disposition: "quarantined", signals: [] })
  })
  await t.test("quarantines a surviving group after TERM and KILL", async t => {
    await assertOutcome(t, record(), fake(), { disposition: "quarantined", signals: ["SIGTERM", "SIGKILL"] })
  })
  await t.test("quarantines an unattempted record with a provider", async t => {
    await assertOutcome(t, record({ launchAttempted: false }), fake(), { disposition: "quarantined", signals: [] })
  })
  await t.test("quarantines a provider whose leader pgid differs from its pid", async t => {
    const leader = identity({ processGroupId: 202 })
    await assertOutcome(t, record({ provider: { kind: "process-group", group: { leader, observed: [leader] } } }), fake(), { disposition: "quarantined", signals: [] })
  })
  await t.test("quarantines a provider whose leader session differs from its pid", async t => {
    const leader = identity({ sessionId: 202 })
    await assertOutcome(t, record({ provider: { kind: "process-group", group: { leader, observed: [leader] } } }), fake({ leader, group: [leader] }), { disposition: "quarantined", signals: [] })
  })
  await t.test("quarantines inconsistent recorded members", async t => {
    const fields: Array<Partial<ProcessIdentity>> = [{ bootId: "boot-2" }, { processGroupId: 202 }, { sessionId: 202 }]
    for (const changed of fields) {
      const member = identity({ pid: 102, birth: "102:fixture", ...changed })
      await assertOutcome(t, record({ provider: { kind: "process-group", group: { leader: identity(), observed: [identity(), member] } } }), fake(), { disposition: "quarantined", signals: [] })
    }
  })
  await t.test("quarantines readiness and active records without a provider", async t => {
    await assertOutcome(t, record({ provider: null, phase: "readiness" }), fake(), { disposition: "quarantined", signals: [] })
    await assertOutcome(t, record({ provider: null, phase: "active" }), fake(), { disposition: "quarantined", signals: [] })
  })
  await t.test("kills continuous same-session members after the leader exits", async t => {
    const member = identity({ pid: 102, birth: "102:fixture" })
    const adapter = fake({
      group: [identity(), member],
      onSignal: (signal, current) => {
        if (signal === "SIGTERM") { current.leader = null; current.group = [member] }
        if (signal === "SIGKILL") current.group = []
      },
    })
    await assertOutcome(t, record(), adapter, { disposition: "cleaned", signals: ["SIGTERM", "SIGKILL"] })
  })
  await t.test("quarantines a reappearing group before KILL", async t => {
    const adapter = fake({ onSignal: (signal, current) => {
      if (signal === "SIGTERM") {
        current.leader = identity({ birth: "999:replacement" })
        current.group = [current.leader]
      }
    } })
    await assertOutcome(t, record(), adapter, { disposition: "quarantined", signals: ["SIGTERM"] })
  })
  await t.test("quarantines a replacement at the session leader pid after a racy read", async t => {
    const adapter = fake({ onSignal: (signal, current) => {
      if (signal === "SIGTERM") {
        current.leader = null
        current.group = [identity({ birth: "999:replacement" })]
      }
    } })
    await assertOutcome(t, record(), adapter, { disposition: "quarantined", signals: ["SIGTERM"] })
  })
  await t.test("observation failure quarantines only the affected checkout", async t => {
    const failing = fake()
    failing.readGroup = async () => { throw new DarwinObservationUnavailable("injected observation failure") }
    const first = await recordFixture(t, record({ checkoutId: "unavailable" }))
    const second = await recordFixture(t, record({ checkoutId: "unrelated", launchAttempted: false, provider: null, phase: "launch_pending" }))
    assert.equal((await reconcileRecord(first, failing)).disposition, "quarantined")
    assert.deepEqual(failing.signals, [])
    assert.equal((await reconcileRecord(second, fake())).disposition, "released")
  })

})
}


test("quarantine is scoped to one checkout record", async t => {
  const first = await recordFixture(t, record({ checkoutId: "first" }))
  const second = await recordFixture(t, record({ checkoutId: "second", launchAttempted: false, provider: null, phase: "launch_pending" }))
  const quarantined = await reconcileRecord(first, new FakeAdapter({ leader: identity({ birth: "999:replacement" }), group: [identity({ birth: "999:replacement" })] }))
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

test("quarantines unavailable Darwin observations without unsafe escalation", async t => {
  for (const stage of ["boot", "process", "group"] as const) {
    const adapter = new FakeAdapter()
    if (stage === "boot") adapter.bootId = async () => { throw new DarwinObservationUnavailable("boot unavailable") }
    else if (stage === "process") adapter.readProcess = async () => { throw new DarwinObservationUnavailable("process unavailable") }
    else adapter.readGroup = async () => { throw new DarwinObservationUnavailable("group unavailable") }
    const path = await recordFixture(t, record())
    const result = await reconcileRecord(path, adapter)
    assert.equal(result.disposition, "quarantined")
    assert.equal(result.record.phase, "quarantined")
    assert.match(result.record.reason ?? "", /observation|unavailable/i)
    assert.ok((result.record.reason ?? "").length <= 512)
    assert.deepEqual(adapter.signals, [])
  }
  let groupReads = 0
  const afterTerm = new FakeAdapter({
    onSignal: (signal, current) => {
      if (signal === "SIGTERM") {
        current.leader = null
        current.group = [identity({ pid: 102, birth: "102:fixture" })]
      }
    },
  })
  afterTerm.readGroup = async () => {
    groupReads += 1
    if (afterTerm.signals.includes("SIGTERM")) throw new DarwinObservationUnavailable("post-TERM group unavailable")
    return afterTerm.group
  }
  const path = await recordFixture(t, record())
  const result = await reconcileRecord(path, afterTerm)
  assert.equal(result.disposition, "quarantined")
  assert.ok(groupReads >= 3)
  assert.deepEqual(afterTerm.signals, ["SIGTERM"])
})

test("requires an exact cleanup-pending member before leaderless KILL", async t => {
  const retained = identity({ pid: 102, birth: "102:fixture" })
  const replacement = identity({ pid: 103, birth: "103:replacement" })
  const adapter = new FakeAdapter({
    group: [identity(), retained],
    onSignal: (signal, current) => {
      if (signal === "SIGTERM") {
        current.leader = null
        current.group = [replacement]
      }
    },
  })
  await assertOutcome(t, record(), adapter, { disposition: "quarantined", signals: ["SIGTERM"] })
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



test("reconciles retained-member escape without unauthorized signaling", async t => {
  for (const platform of ["darwin", "linux"] as const) for (const scenario of ["empty", "leader", "omitted", "marker", "uid", "gid", "malformed"]) await t.test(`${platform}: ${scenario}`, async t => {
    const leader = identity()
    const member = identity({ pid: 102, birth: "102:descendant" })
    const changed = { ...member, ...(scenario === "marker" ? { birth: "102:changed" } : scenario === "uid" ? { uid: member.uid + 1 } : scenario === "gid" ? { gid: member.gid + 1 } : scenario === "malformed" ? { birth: "invalid" } : { processGroupId: 202, sessionId: 202 }) }
    const adapter = new FakeAdapter({ platform, leader: scenario === "empty" ? null : leader, group: scenario === "empty" ? [] : [leader], onSignal: (_signal, state) => { state.leader = null; state.group = [] } })
    adapter.readProcess = async pid => pid === 102 ? changed : adapter.leader
    const path = await recordFixture(t, record({ phase: scenario === "omitted" ? "cleanup_pending" : "active", provider: { kind: "process-group", group: { leader, observed: [leader, member] } } }))
    const result = await reconcileRecord(path, adapter)
    assert.equal(result.disposition, ["empty", "leader", "omitted"].includes(scenario) ? scenario === "empty" ? "released" : "cleaned" : "quarantined")
    assert.deepEqual(adapter.signals, ["leader", "omitted"].includes(scenario) ? ["SIGTERM"] : [])
    if (["empty", "leader", "omitted"].includes(scenario)) assert.deepEqual(result.diagnostics, [{ kind: "detached-helper", identity: changed }])
    assert.ok(result.record.provider?.kind === "process-group" && result.record.provider.group.observed.some(value => value.pid === 102))
  })
})

test("retained-member escape preserves members first observed during signal polling", async t => {
  for (const platform of ["darwin", "linux"] as const) for (const phase of ["SIGTERM", "SIGKILL"] as const) await t.test(platform + " " + phase, async t => {
    const leader = identity(), member = identity({ pid: 102, birth: "102:descendant" })
    const path = await recordFixture(t, record())
    const adapter = new FakeAdapter({ platform })
    let polling = 0
    adapter.readGroup = async () => {
      if (!adapter.signals.includes(phase)) return [leader]
      if (++polling === 1) return [leader, member]
      const durable = await readLaunchRecord(path)
      assert.ok(durable.provider?.group.observed.some(value => value.pid === member.pid), "new member must be durable before next observation")
      adapter.leader = null
      return []
    }
    adapter.readProcess = async pid => pid === 101 ? adapter.signals.includes(phase) && polling > 0 ? null : adapter.leader : polling > 0 ? { ...member, processGroupId: 202, sessionId: 202 } : null
    const result = await reconcileRecord(path, adapter)
    assert.equal(result.disposition, "cleaned")
    assert.deepEqual(adapter.signals, phase === "SIGTERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"])
    assert.equal(result.diagnostics?.[0]?.kind, "detached-helper")
    assert.ok(result.record.provider?.group.observed.some(value => value.pid === member.pid))
  })
})

test("marker-bound provider semantic UUID failure remains checkout-scoped", async t => {
  for (const platform of ["darwin", "linux"] as const) await t.test(platform, async t => {
    const invalid = await recordFixture(t, record({ launchAttemptId: "not-a-canonical-uuid" }))
    const valid = await recordFixture(t, record({ checkoutId: "unrelated", launchAttempted: false, provider: null, phase: "launch_pending" }))
    const adapter = new FakeAdapter({ platform })
    const results = []
    for (const path of [invalid, valid]) results.push((await reconcileRecord(path, adapter)).disposition)
    assert.deepEqual(results, ["quarantined", "released"])
    assert.deepEqual(adapter.signals, [])
  })
})