import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { spawnOwnedChild } from "../src/runtime/owned-child.js"
import { captureLiveProcess, LiveProcessError, isLiveCleanupEvidence, type LiveProcessGroup } from "../src/platform/live-process.js"
import { LinuxObservationUnavailable } from "../src/platform/linux.js"
import { DarwinObservationUnavailable } from "../src/platform/darwin.js"
import type { PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"

const attempt = "11111111-1111-4111-8111-111111111111", marker = "agy-provider:" + attempt
function fixture(t: test.TestContext) {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, unref() {} }) as unknown as ChildProcess
  t.after(() => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy() })
  const owner = spawnOwnedChild({ launchAttemptId: attempt, spawn: () => child })
  const identity: ProcessIdentity = { bootId: "boot-a", pid: 12345, birth: "100:" + marker, parentPid: process.pid, processGroupId: 12345, sessionId: 12345, uid: process.getuid!(), gid: process.getgid!() }
  let members = [identity], live = true
  const signals: NodeJS.Signals[] = []
  const exit = (close = true) => { live = false; members = []; Object.assign(child, { exitCode: 0 }); child.emit("exit", 0, null); if (close) child.emit("close", 0, null) }
  const adapter: PlatformAdapter = {
    platform: "linux", bootId: async () => "boot-a",
    readProcess: async pid => live && pid === identity.pid ? structuredClone(identity) : null,
    readGroup: async () => structuredClone(members),
    signalGroup: async (pgid, signal) => { assert.equal(pgid, 12345); signals.push(signal); exit() },
  }
  const capture = () => captureLiveProcess({ owner, adapter, launchBootId: "boot-a", marker, deadline: Date.now() + 5000, now: () => Date.now() })
  const limits = () => ({ deadline: Date.now() + 1000, terminateMs: 200, absenceMs: 200, transportCloseMs: 100 })
  return { child, owner, identity, adapter, signals, exit, capture, limits, setMembers(value: ProcessIdentity[]) { members = value } }
}


test("a reused PID prevents cleanup from signaling another process", async t => {
  const f = fixture(t), group = await f.capture()
  f.identity.birth = "200:" + marker
  await assert.rejects(group.cleanup(f.limits()), LiveProcessError)
  assert.deepEqual(f.signals, [])
})

const descendant = (f: ReturnType<typeof fixture>): ProcessIdentity => ({ ...f.identity, pid: 12346, parentPid: f.identity.pid, birth: "101:descendant" })
const verified = (value: Awaited<ReturnType<LiveProcessGroup["cleanup"]>>, group: LiveProcessGroup) => {
  assert.equal(isLiveCleanupEvidence(value, group), true)
  assert.equal(value.terminal.kind, "exit")
  assert.equal(value.transport, "closed")
}


test("cleanup waits for a lingering descendant within the absence budget", async t => {
  const f = fixture(t), group = await f.capture(), member = descendant(f), original = f.adapter.readGroup
  group.observeMember(member)
  let remaining = 2
  f.adapter.readGroup = async pgid => f.owner.snapshot().terminal ? remaining-- > 0 ? [member] : [] : original(pgid)
  const evidence = await group.cleanup(f.limits())
  verified(evidence, group)
  assert.deepEqual(f.signals, ["SIGTERM"])
})

for (const [name, ErrorType] of [["Linux", LinuxObservationUnavailable], ["Darwin", DarwinObservationUnavailable]] as const) {
  test(`cleanup retries a transient ${name} group observation`, async t => {
    const f = fixture(t), group = await f.capture(), original = f.adapter.readGroup
    let failed = false
    f.adapter.readGroup = async pgid => {
      if (!f.owner.snapshot().terminal) return original(pgid)
      if (!failed) { failed = true; throw new ErrorType("temporarily unavailable") }
      return []
    }
    verified(await group.cleanup(f.limits()), group)
    assert.deepEqual(f.signals, ["SIGTERM"])
  })
}

test("cleanup retries a transient captured-process observation", async t => {
  const f = fixture(t), group = await f.capture(), original = f.adapter.readProcess
  let failed = false
  f.adapter.readProcess = async pid => {
    if (!f.owner.snapshot().terminal) return original(pid)
    if (!failed) { failed = true; throw new DarwinObservationUnavailable("temporarily unavailable") }
    return null
  }
  verified(await group.cleanup(f.limits()), group)
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("an empty group does not prove an observed generation outside it absent", async t => {
  const f = fixture(t), group = await f.capture(), member = descendant(f), original = f.adapter.readProcess
  group.observeMember(member)
  let remaining = 2
  f.adapter.readProcess = async pid => f.owner.snapshot().terminal && pid === member.pid ? remaining-- > 0 ? { ...member, processGroupId: 98765 } : null : original(pid)
  verified(await group.cleanup(f.limits()), group)
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("a transient error resets consecutive full absence observations", async t => {
  const f = fixture(t), group = await f.capture(), original = f.adapter.readGroup
  let reads = 0
  f.adapter.readGroup = async pgid => {
    if (!f.owner.snapshot().terminal) return original(pgid)
    if (++reads === 2) throw new LinuxObservationUnavailable("interrupted observation")
    return []
  }
  verified(await group.cleanup(f.limits()), group)
  assert.equal(reads, 4)
})

for (const kind of ["lingering", "unavailable", "reused"] as const) {
  test(`persistent ${kind} absence fails within the stage budget without another signal`, async t => {
    const f = fixture(t), group = await f.capture(), member = descendant(f), original = f.adapter.readGroup
    f.adapter.readGroup = async pgid => {
      if (!f.owner.snapshot().terminal) return original(pgid)
      if (kind === "unavailable") throw new LinuxObservationUnavailable("unavailable")
      return [{ ...member, ...(kind === "reused" ? { birth: "999:foreign", uid: member.uid + 1 } : {}) }]
    }
    const started = Date.now()
    await assert.rejects(group.cleanup({ ...f.limits(), absenceMs: 60 }), error => error instanceof LiveProcessError && error.reason === "deadline")
    assert.ok(Date.now() - started < 500)
    assert.deepEqual(f.signals, ["SIGTERM"])
    assert.equal(f.child.stdout!.destroyed, false)
  })
}

test("a boot change between absence passes rejects cleanup evidence", async t => {
  const f = fixture(t), group = await f.capture()
  let terminalBootReads = 0
  f.adapter.bootId = async () => f.owner.snapshot().terminal && ++terminalBootReads > 1 ? "boot-b" : "boot-a"
  await assert.rejects(group.cleanup(f.limits()), error => error instanceof LiveProcessError && error.reason === "absence")
  assert.deepEqual(f.signals, ["SIGTERM"])
  assert.equal(f.child.stdout!.destroyed, false)
})

test("unexpected absence errors reject without retrying", async t => {
  const f = fixture(t), group = await f.capture(), original = f.adapter.readGroup
  let reads = 0
  f.adapter.readGroup = async pgid => {
    if (!f.owner.snapshot().terminal) return original(pgid)
    reads++; throw new Error("unexpected failure")
  }
  await assert.rejects(group.cleanup(f.limits()), LiveProcessError)
  assert.equal(reads, 1)
  assert.deepEqual(f.signals, ["SIGTERM"])
  assert.equal(f.child.stdout!.destroyed, false)
})

test("a hung observation cannot publish late cleanup evidence", async t => {
  const f = fixture(t), group = await f.capture(), original = f.adapter.readGroup, delayed = Promise.withResolvers<ProcessIdentity[]>()
  f.adapter.readGroup = async pgid => f.owner.snapshot().terminal ? delayed.promise : original(pgid)
  const cleanup = group.cleanup({ ...f.limits(), absenceMs: 40 }), started = Date.now()
  await assert.rejects(cleanup, error => error instanceof LiveProcessError && error.reason === "deadline")
  assert.ok(Date.now() - started < 500)
  delayed.resolve([])
  await new Promise(resolve => setTimeout(resolve, 30))
  await assert.rejects(cleanup, LiveProcessError)
  assert.equal(f.child.stdout!.destroyed, false)
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("abandoning the owner during absence waiting rejects cleanup", async t => {
  const f = fixture(t), group = await f.capture(), member = descendant(f), original = f.adapter.readGroup
  let abandonment: NodeJS.Timeout | undefined
  t.after(() => clearTimeout(abandonment))
  f.adapter.readGroup = async pgid => {
    if (!f.owner.snapshot().terminal) return original(pgid)
    abandonment ??= setTimeout(() => f.owner.abandon("test abandonment"), 5)
    return [member]
  }
  await assert.rejects(group.cleanup(f.limits()), error => error instanceof LiveProcessError && error.reason === "abandoned")
  assert.deepEqual(f.signals, ["SIGTERM"])
})