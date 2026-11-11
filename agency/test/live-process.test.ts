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
  return { child, owner, identity, adapter, signals, exit, capture, limits, getMembers: () => structuredClone(members), setMembers(value: ProcessIdentity[]) { members = value } }
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


test("cleanup waits for a lingering descendant within the termination budget", async t => {
  const f = survivors(t), group = await f.capture(), original = f.adapter.readGroup
  let remaining = 2
  f.adapter.readGroup = async pgid => {
    if (f.owner.snapshot().terminal && remaining-- <= 0) f.setMembers([])
    return original(pgid)
  }
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
  test(`persistent unverified ${kind} group rejects cleanup without another signal`, async t => {
    const f = fixture(t), group = await f.capture(), member = descendant(f), original = f.adapter.readGroup
    f.adapter.readGroup = async pgid => {
      if (!f.owner.snapshot().terminal) return original(pgid)
      if (kind === "unavailable") throw new LinuxObservationUnavailable("unavailable")
      return [{ ...member, ...(kind === "reused" ? { birth: "999:foreign", uid: member.uid + 1 } : {}) }]
    }
    const started = Date.now()
    await assert.rejects(group.cleanup({ ...f.limits(), absenceMs: 60 }), error => error instanceof LiveProcessError && error.reason === (kind === "unavailable" ? "deadline" : "identity"))
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

test("abandoning the owner during survivor waiting rejects cleanup", async t => {
  const f = survivors(t), group = await f.capture(), original = f.adapter.readGroup
  let abandonment: NodeJS.Timeout | undefined
  t.after(() => clearTimeout(abandonment))
  f.adapter.readGroup = async pgid => {
    if (f.owner.snapshot().terminal) abandonment ??= setTimeout(() => f.owner.abandon("test abandonment"), 5)
    return original(pgid)
  }
  await assert.rejects(group.cleanup(f.limits()), error => error instanceof LiveProcessError && error.reason === "abandoned")
  assert.deepEqual(f.signals, ["SIGTERM"])
})

function survivors(t: test.TestContext) {
  const f = fixture(t), native = descendant(f), helper = { ...native, pid: 12347, parentPid: native.pid, birth: "102:helper" }
  f.setMembers([f.identity, native])
  f.adapter.readProcess = async pid => f.getMembers().find(member => member.pid === pid) ?? null
  f.adapter.signalGroup = async (pgid, signal) => {
    assert.equal(pgid, f.identity.processGroupId)
    f.signals.push(signal)
    if (signal === "SIGTERM") { f.exit(); f.setMembers([{ ...native, parentPid: 1 }]) }
    else f.setMembers([])
  }
  return { ...f, native, helper }
}

test("cleanup escalates after leader exit and retains a late helper through overlapping generations", async t => {
  const f = survivors(t), group = await f.capture(), original = f.adapter.readGroup
  let reads = 0
  f.adapter.readGroup = async pgid => {
    if (f.owner.snapshot().terminal && f.signals.length === 1) {
      if (++reads === 1) f.setMembers([f.native, f.helper])
      else f.setMembers([{ ...f.helper, parentPid: 1 }])
    }
    return original(pgid)
  }
  const evidence = await group.cleanup(f.limits())
  verified(evidence, group)
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"])
  assert.deepEqual(evidence.group.observed.map(member => member.pid).sort(), [12345, 12346, 12347])
})

for (const failure of ["exit", "unavailable"] as const) test(`a helper in an anchored snapshot survives its last retained anchor ${failure}`, async t => {
  const f = survivors(t), group = await f.capture(), read = f.adapter.readProcess
  let transferred = false
  f.adapter.readGroup = async () => {
    if (f.owner.snapshot().terminal && !transferred) f.setMembers([f.native, f.helper])
    return f.getMembers()
  }
  f.adapter.readProcess = async pid => {
    if (f.owner.snapshot().terminal && pid === f.native.pid && !transferred) {
      transferred = true; f.setMembers([{ ...f.helper, parentPid: 1 }])
      if (failure === "unavailable") throw new DarwinObservationUnavailable("anchor exited during observation")
      return null
    }
    return read(pid)
  }
  const evidence = await group.cleanup(f.limits())
  verified(evidence, group)
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"])
  assert.ok(evidence.group.observed.some(member => member.pid === f.helper.pid))
})

test("a retained survivor authorizes cleanup when the leader exited before cleanup began", async t => {
  const f = survivors(t), group = await f.capture()
  group.observeMember(f.native)
  f.exit(); f.setMembers([f.native])
  verified(await group.cleanup(f.limits()), group)
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"])
})

test("authenticated survivors that exit during grace do not receive SIGKILL", async t => {
  const f = survivors(t), group = await f.capture(), original = f.adapter.readGroup
  let remaining = 2
  f.adapter.readGroup = async pgid => {
    if (f.owner.snapshot().terminal && remaining-- <= 0) f.setMembers([])
    return original(pgid)
  }
  verified(await group.cleanup(f.limits()), group)
  assert.deepEqual(f.signals, ["SIGTERM"])
})

for (const field of ["birth", "uid", "gid", "processGroupId", "sessionId", "bootId"] as const) {
  test(`a known survivor ${field} mismatch prevents escalation despite another valid anchor`, async t => {
    const f = survivors(t)
    f.setMembers([f.identity, f.native, f.helper])
    const group = await f.capture(), original = f.adapter.readGroup
    f.adapter.readGroup = async pgid => {
      if (f.owner.snapshot().terminal) {
        const changed = { ...f.native, [field]: field === "birth" ? "999:foreign" : field === "bootId" ? "boot-b" : (f.native[field] as number) + 1 }
        f.setMembers([changed, f.helper])
      }
      return original(pgid)
    }
    await assert.rejects(group.cleanup(f.limits()), error => error instanceof LiveProcessError && error.reason === "identity")
    assert.deepEqual(f.signals, ["SIGTERM"])
    await assert.rejects(group.cleanup({ ...f.limits(), retry: true }), LiveProcessError)
    assert.deepEqual(f.signals, ["SIGTERM"])
  })
}

test("a changing anchor prevents retaining late members or signaling them", async t => {
  const f = survivors(t), group = await f.capture(), original = f.adapter.readProcess
  f.adapter.readGroup = async () => {
    if (f.owner.snapshot().terminal) f.setMembers([f.native, f.helper])
    return f.getMembers()
  }
  f.adapter.readProcess = async pid => f.owner.snapshot().terminal && pid === f.native.pid ? { ...f.native, birth: "999:foreign" } : original(pid)
  await assert.rejects(group.cleanup(f.limits()), error => error instanceof LiveProcessError && error.reason === "identity")
  assert.deepEqual(f.signals, ["SIGTERM"])
  assert.equal(group.identity().observed.some(member => member.pid === f.helper.pid), false)
})

test("an unanchored late group permanently loses signal authority on retry", async t => {
  const f = survivors(t), group = await f.capture(), original = f.adapter.readGroup
  f.adapter.readGroup = async pgid => {
    if (f.owner.snapshot().terminal) f.setMembers([f.helper])
    return original(pgid)
  }
  await assert.rejects(group.cleanup(f.limits()), error => error instanceof LiveProcessError && error.reason === "identity")
  f.adapter.readGroup = original; f.setMembers([f.native, f.helper])
  await assert.rejects(group.cleanup({ ...f.limits(), retry: true }), LiveProcessError)
  assert.deepEqual(f.signals, ["SIGTERM"])
  f.setMembers([])
  verified(await group.cleanup({ ...f.limits(), retry: true }), group)
})

test("an empty group cannot regain signal authority after repopulation", async t => {
  const f = survivors(t), group = await f.capture(), original = f.adapter.readGroup
  let emptyRead = false
  f.adapter.readGroup = async pgid => {
    if (f.owner.snapshot().terminal) {
      f.setMembers(emptyRead ? [f.native] : []); emptyRead = true
    }
    return original(pgid)
  }
  await assert.rejects(group.cleanup(f.limits()), LiveProcessError)
  await assert.rejects(group.cleanup({ ...f.limits(), retry: true }), LiveProcessError)
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("a helper first observed after KILL remains an absence obligation if it escapes", async t => {
  const f = survivors(t), group = await f.capture(), original = f.adapter.readGroup, read = f.adapter.readProcess
  let killed = false, seen = false
  f.adapter.signalGroup = async (_, signal) => {
    f.signals.push(signal)
    if (signal === "SIGTERM") { f.exit(); f.setMembers([f.native]) }
    else { killed = true; f.setMembers([f.native, f.helper]) }
  }
  f.adapter.readGroup = async pgid => {
    if (killed && seen) f.setMembers([])
    else if (killed) seen = true
    return original(pgid)
  }
  f.adapter.readProcess = async pid => killed && seen && pid === f.helper.pid && f.getMembers().length === 0 ? { ...f.helper, processGroupId: 98765, sessionId: 98765 } : read(pid)
  await assert.rejects(group.cleanup({ ...f.limits(), absenceMs: 60 }), LiveProcessError)
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"])
  assert.ok(group.identity().observed.some(member => member.pid === f.helper.pid))
})

test("a vanished anchor can yield to another already verified survivor", async t => {
  const f = survivors(t)
  f.setMembers([f.identity, f.native, f.helper])
  const group = await f.capture(), read = f.adapter.readProcess
  f.adapter.signalGroup = async (_, signal) => {
    f.signals.push(signal)
    if (signal === "SIGTERM") { f.exit(); f.setMembers([f.native, f.helper]) }
    else f.setMembers([])
  }
  f.adapter.readProcess = async pid => f.owner.snapshot().terminal && pid === f.native.pid ? null : read(pid)
  verified(await group.cleanup(f.limits()), group)
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"])
})

test("a leader exit between observations preserves a verified surviving child", async t => {
  const f = survivors(t), group = await f.capture(), readGroup = f.adapter.readGroup
  f.adapter.signalGroup = async (_, signal) => { f.signals.push(signal); if (signal === "SIGKILL") f.setMembers([]) }
  f.adapter.readGroup = async pgid => {
    if (f.signals.length === 1 && !f.owner.snapshot().terminal) { f.exit(); f.setMembers([f.native]) }
    return readGroup(pgid)
  }
  verified(await group.cleanup(f.limits()), group)
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"])
})

test("a reused leader outside an empty group permits absence-only cleanup and retry", async t => {
  const f = fixture(t), group = await f.capture(), foreign = { ...f.identity, birth: "999:foreign", processGroupId: 98765, sessionId: 98765 }
  f.exit()
  f.adapter.readProcess = async pid => pid === foreign.pid ? foreign : null
  verified(await group.cleanup(f.limits()), group)
  verified(await group.cleanup({ ...f.limits(), retry: true }), group)
  assert.deepEqual(f.signals, [])
})

test("the last survivor disappearing during its identity read permits absence-only completion", async t => {
  const f = survivors(t), group = await f.capture(), read = f.adapter.readProcess
  f.adapter.readProcess = async pid => {
    if (f.owner.snapshot().terminal && pid === f.native.pid) { f.setMembers([]); return null }
    return read(pid)
  }
  verified(await group.cleanup(f.limits()), group)
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("a still-live original leader omitted from its group prevents a signal", async t => {
  const f = survivors(t), group = await f.capture(), read = f.adapter.readProcess
  group.observeMember(f.native)
  f.setMembers([f.native])
  f.adapter.readProcess = async pid => pid === f.identity.pid ? f.identity : read(pid)
  await assert.rejects(group.cleanup(f.limits()), error => error instanceof LiveProcessError && error.reason === "identity")
  assert.deepEqual(f.signals, [])
})

for (const failure of ["exit", "unavailable"] as const) test(`a late helper escaping during anchor ${failure} blocks evidence across retry`, async t => {
  const f = survivors(t), group = await f.capture(), read = f.adapter.readProcess
  let nativeGone = false, helperAlive = true
  f.adapter.readGroup = async () => {
    if (f.owner.snapshot().terminal && !nativeGone) f.setMembers([f.native, f.helper])
    return f.getMembers()
  }
  f.adapter.readProcess = async pid => {
    if (f.owner.snapshot().terminal && pid === f.native.pid && !nativeGone) {
      nativeGone = true; f.setMembers([])
      if (failure === "unavailable") throw new DarwinObservationUnavailable("anchor exited during observation")
      return null
    }
    if (nativeGone && pid === f.helper.pid && helperAlive) return { ...f.helper, processGroupId: 99999, sessionId: 99999 }
    return read(pid)
  }
  await assert.rejects(group.cleanup({ ...f.limits(), absenceMs: 40 }), LiveProcessError)
  assert.equal(group.identity().observed.some(member => member.pid === f.helper.pid), false)
  await assert.rejects(group.cleanup({ ...f.limits(), absenceMs: 40, retry: true }), LiveProcessError)
  assert.deepEqual(f.signals, ["SIGTERM"])
  helperAlive = false
  const evidence = await group.cleanup({ ...f.limits(), retry: true })
  verified(evidence, group)
  assert.ok(evidence.group.observed.some(member => member.pid === f.helper.pid))
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("an unanchored helper remains an absence obligation after it escapes", async t => {
  const f = survivors(t), group = await f.capture(), readGroup = f.adapter.readGroup, read = f.adapter.readProcess
  let escaped = false, alive = true
  f.adapter.readGroup = async pgid => {
    if (f.owner.snapshot().terminal) f.setMembers(escaped ? [] : [f.helper])
    return readGroup(pgid)
  }
  f.adapter.readProcess = async pid => escaped && alive && pid === f.helper.pid ? { ...f.helper, processGroupId: 99999, sessionId: 99999 } : read(pid)
  await assert.rejects(group.cleanup(f.limits()), error => error instanceof LiveProcessError && error.reason === "identity")
  escaped = true
  await assert.rejects(group.cleanup({ ...f.limits(), absenceMs: 40, retry: true }), LiveProcessError)
  assert.equal(group.identity().observed.some(member => member.pid === f.helper.pid), false)
  assert.deepEqual(f.signals, ["SIGTERM"])
  alive = false
  const evidence = await group.cleanup({ ...f.limits(), retry: true })
  verified(evidence, group)
  assert.ok(evidence.group.observed.some(member => member.pid === f.helper.pid))
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("a valid helper in a partly invalid snapshot still blocks absence-only retry", async t => {
  const f = survivors(t), group = await f.capture(), read = f.adapter.readProcess
  let escaped = false, alive = true
  f.adapter.readGroup = async () => f.owner.snapshot().terminal ? escaped ? [] : [{ ...f.native, uid: f.native.uid + 1 }, f.helper] : f.getMembers()
  f.adapter.readProcess = async pid => escaped && alive && pid === f.helper.pid ? { ...f.helper, processGroupId: 99999, sessionId: 99999 } : read(pid)
  await assert.rejects(group.cleanup(f.limits()), error => error instanceof LiveProcessError && error.reason === "identity")
  escaped = true; f.setMembers([])
  await assert.rejects(group.cleanup({ ...f.limits(), absenceMs: 40, retry: true }), LiveProcessError)
  assert.equal(group.identity().observed.some(member => member.pid === f.helper.pid), false)
  assert.deepEqual(f.signals, ["SIGTERM"])
  alive = false
  const evidence = await group.cleanup({ ...f.limits(), retry: true })
  verified(evidence, group)
  assert.ok(evidence.group.observed.some(member => member.pid === f.helper.pid))
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("a helper first seen in the last-anchor reread blocks absence-only retry", async t => {
  const f = survivors(t), group = await f.capture(), read = f.adapter.readProcess
  let nativeGone = false, escaped = false, alive = true
  f.adapter.readGroup = async () => {
    if (!f.owner.snapshot().terminal) return f.getMembers()
    return nativeGone ? escaped ? [] : [f.helper] : [f.native]
  }
  f.adapter.readProcess = async pid => {
    if (f.owner.snapshot().terminal && pid === f.native.pid && !nativeGone) { nativeGone = true; f.setMembers([]); return null }
    if (escaped && alive && pid === f.helper.pid) return { ...f.helper, processGroupId: 99999, sessionId: 99999 }
    return read(pid)
  }
  await assert.rejects(group.cleanup(f.limits()), error => error instanceof LiveProcessError && error.reason === "identity")
  escaped = true
  await assert.rejects(group.cleanup({ ...f.limits(), absenceMs: 40, retry: true }), LiveProcessError)
  assert.equal(group.identity().observed.some(member => member.pid === f.helper.pid), false)
  assert.deepEqual(f.signals, ["SIGTERM"])
  alive = false
  const evidence = await group.cleanup({ ...f.limits(), retry: true })
  verified(evidence, group)
  assert.ok(evidence.group.observed.some(member => member.pid === f.helper.pid))
  assert.deepEqual(f.signals, ["SIGTERM"])
})