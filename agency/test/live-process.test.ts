import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { spawnOwnedChild } from "../src/runtime/owned-child.js"
import { captureLiveProcess, isLiveProcessGroup, isLiveCleanupEvidence, LiveProcessError } from "../src/platform/live-process.js"
import type { PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"

const attempt = "11111111-1111-4111-8111-111111111111", marker = "agy-provider:" + attempt
function barrier<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
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

test("startup captures only the registered PID without group sampling", async t => {
  const f = fixture(t)
  f.adapter.readGroup = async () => { throw new Error("startup group observation") }
  const group = await f.capture()
  assert.deepEqual(group.identity(), { leader: f.identity, observed: [f.identity] })
  assert.deepEqual(f.signals, [])
  assert.equal(isLiveProcessGroup(group), true)
  assert.equal(isLiveProcessGroup({ ...group }), false)
  await assert.rejects(captureLiveProcess({ owner: { ...f.owner }, adapter: f.adapter, launchBootId: "boot-a", marker, deadline: Date.now() + 5000 }), LiveProcessError)
})

for (const survivor of [false, true]) test("exit during authorization suppresses signals, survivor=" + survivor, async t => {
  const f = fixture(t), group = await f.capture(), entered = barrier<void>(), held = barrier<ProcessIdentity[]>()
  f.adapter.readGroup = async () => { entered.resolve(); return held.promise }
  const cleanup = group.cleanup(f.limits())
  await entered.promise
  f.exit()
  const descendant = { ...f.identity, pid: 12346, birth: "101:helper", parentPid: 12345 }
  f.adapter.readGroup = async () => survivor ? [descendant] : []
  held.resolve([f.identity, descendant])
  if (survivor) await assert.rejects(cleanup, LiveProcessError)
  else assert.equal(isLiveCleanupEvidence(await cleanup, group), true)
  assert.deepEqual(f.signals, [])
})

for (const field of ["bootId", "birth", "uid", "gid", "processGroupId", "sessionId"] as const) test("changed " + field + " refuses signal authority", async t => {
  const f = fixture(t), group = await f.capture()
  Object.assign(f.identity, { [field]: typeof f.identity[field] === "number" ? 44 : field === "birth" ? "200:" + marker : "boot-b" })
  await assert.rejects(group.cleanup(f.limits()), LiveProcessError)
  assert.deepEqual(f.signals, [])
})

test("mutable command and parent preserve generation and initial attribution", async t => {
  const f = fixture(t), initial = structuredClone(f.identity), group = await f.capture()
  f.identity.birth += " command suffix"; f.identity.parentPid = 1
  const evidence = await group.cleanup(f.limits())
  assert.deepEqual(f.signals, ["SIGTERM"])
  assert.deepEqual(evidence.group.leader, initial)
  assert.equal(isLiveCleanupEvidence(evidence, group), true)
  assert.equal(isLiveCleanupEvidence({ ...evidence }, group), false)
  assert.throws(() => { evidence.group.leader.birth = "forged" }, TypeError)
  const other = await fixture(t).capture()
  assert.equal(isLiveCleanupEvidence(evidence, other), false)
})

for (const duplicate of [false, true]) test("inconsistent or duplicate group refuses signals, duplicate=" + duplicate, async t => {
  const f = fixture(t), group = await f.capture()
  f.setMembers(duplicate ? [f.identity, f.identity] : [f.identity, { ...f.identity, pid: 12346, uid: 42 }])
  await assert.rejects(group.cleanup(f.limits()), LiveProcessError)
  assert.deepEqual(f.signals, [])
})

test("a failed signal needs explicit retry with fresh authorization", async t => {
  const f = fixture(t), group = await f.capture(), signal = f.adapter.signalGroup
  f.adapter.signalGroup = async () => { throw new Error("EPERM") }
  const first = group.cleanup(f.limits())
  await assert.rejects(first, LiveProcessError)
  assert.equal(group.cleanup(f.limits()), first)
  f.adapter.signalGroup = signal
  const retry = group.cleanup({ ...f.limits(), retry: true })
  assert.equal(group.cleanup({ ...f.limits(), retry: true }), retry)
  const evidence = await retry
  assert.equal(await group.cleanup({ ...f.limits(), retry: true }), evidence)
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("retry after exit verifies absence without signaling the old group", async t => {
  const f = fixture(t), group = await f.capture()
  f.adapter.signalGroup = async () => { throw new Error("EPERM") }
  await assert.rejects(group.cleanup(f.limits()))
  f.exit()
  assert.equal(isLiveCleanupEvidence(await group.cleanup({ ...f.limits(), retry: true }), group), true)
  assert.deepEqual(f.signals, [])
})

test("registered error without exit cannot prove cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
  const f = fixture(t), group = await f.capture(), entered = barrier<void>()
  f.child.emit("error", new Error("IPC failure"))
  f.adapter.signalGroup = async () => { entered.resolve(); throw Object.assign(new Error("gone"), { code: "ESRCH" }) }
  const pending = group.cleanup(f.limits()), rejected = assert.rejects(pending, LiveProcessError)
  await entered.promise
  await Promise.resolve(); await Promise.resolve()
  t.mock.timers.tick(1001)
  await rejected
  assert.equal(f.owner.snapshot().terminal, null)
})

for (const phase of ["boot", "process", "group"] as const) test("hanging " + phase + " expires without late work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
  const f = fixture(t), group = await f.capture(), entered = barrier<void>(), held = barrier<any>()
  const method = phase === "boot" ? "bootId" : phase === "process" ? "readProcess" : "readGroup"
  Object.assign(f.adapter, { [method]: async () => { entered.resolve(); return held.promise } })
  const pending = group.cleanup(f.limits()), rejected = assert.rejects(pending, LiveProcessError)
  await entered.promise; t.mock.timers.tick(1001); await rejected
  held.resolve(phase === "boot" ? "boot-a" : phase === "group" ? [f.identity] : f.identity)
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(f.signals, [])
})

test("ignored TERM is followed by reauthorized KILL", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
  const f = fixture(t), group = await f.capture(), term = barrier<void>(), kill = barrier<void>()
  f.adapter.signalGroup = async (_, signal) => { f.signals.push(signal); if (signal === "SIGTERM") term.resolve(); else { f.exit(); kill.resolve() } }
  const pending = group.cleanup(f.limits())
  await term.promise
  for (let i = 0; i < 8; i++) await Promise.resolve()
  t.mock.timers.tick(100)
  await kill.promise
  assert.equal(isLiveCleanupEvidence(await pending, group), true)
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"])
})

test("terminal before escalation suppresses KILL", async t => {
  const f = fixture(t), group = await f.capture()
  f.adapter.signalGroup = async (_, signal) => { f.signals.push(signal); f.exit() }
  await group.cleanup(f.limits())
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("held close destroys transport then checks absence", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
  const f = fixture(t), group = await f.capture(), entered = barrier<void>()
  f.adapter.signalGroup = async () => { f.exit(false); entered.resolve() }
  const pending = group.cleanup(f.limits())
  await entered.promise
  for (let i = 0; i < 12; i++) await Promise.resolve()
  t.mock.timers.tick(100)
  assert.equal((await pending).transport, "destroyed")
  assert.equal(f.child.stdout!.destroyed, true)
})

for (const reused of [false, true]) test("escaped retained member is checked by generation, reused=" + reused, async t => {
  const f = fixture(t), group = await f.capture(), descendant = { ...f.identity, pid: 12346, birth: "101:helper" }
  f.setMembers([f.identity, descendant])
  f.adapter.signalGroup = async () => {
    f.exit()
    f.adapter.readProcess = async pid => pid === 12346 ? { ...descendant, processGroupId: 20000, birth: reused ? "102:replacement" : descendant.birth } : null
  }
  if (reused) await group.cleanup(f.limits())
  else await assert.rejects(group.cleanup(f.limits()), LiveProcessError)
})

test("abandoned and failed-spawn owners never acquire authority", async t => {
  const f = fixture(t), group = await f.capture()
  f.owner.abandon("owner lost")
  await assert.rejects(group.cleanup(f.limits()), LiveProcessError)
  await assert.rejects(f.capture(), LiveProcessError)
  const g = fixture(t); Object.assign(g.child, { pid: undefined }); g.child.emit("error", new Error("spawn"))
  await assert.rejects(g.capture(), LiveProcessError)
  assert.deepEqual(f.signals, [])
})

for (const phase of ["boot", "group", "process"] as const) test("hanging final absence " + phase + " remains unresolved", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
  const f = fixture(t), group = await f.capture(), entered = barrier<void>(), held = barrier<any>()
  f.exit()
  const method = phase === "boot" ? "bootId" : phase === "process" ? "readProcess" : "readGroup"
  Object.assign(f.adapter, { [method]: async () => { entered.resolve(); return held.promise } })
  const pending = group.cleanup(f.limits()), rejected = assert.rejects(pending, LiveProcessError)
  await entered.promise; t.mock.timers.tick(201); await rejected
  held.resolve(phase === "boot" ? "boot-a" : phase === "group" ? [] : null)
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(f.signals, [])
})

test("hanging capture expires and cannot publish a late identity", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
  const f = fixture(t), entered = barrier<void>(), held = barrier<ProcessIdentity | null>()
  f.adapter.readProcess = async () => { entered.resolve(); return held.promise }
  const rejected = assert.rejects(f.capture(), LiveProcessError)
  await entered.promise; t.mock.timers.tick(5001); await rejected
  held.resolve(f.identity)
  await Promise.resolve()
  assert.deepEqual(f.signals, [])
})

test("late authorization cannot act during an explicit fresh attempt", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
  const f = fixture(t), group = await f.capture(), entered = barrier<void>(), held = barrier<ProcessIdentity[]>()
  f.adapter.readGroup = async () => { entered.resolve(); return held.promise }
  const first = assert.rejects(group.cleanup(f.limits()), LiveProcessError)
  await entered.promise; t.mock.timers.tick(201); await first
  f.adapter.readGroup = async () => [f.identity]
  f.adapter.signalGroup = async (_, signal) => { f.signals.push(signal); f.exit(); f.adapter.readGroup = async () => [] }
  const second = group.cleanup({ ...f.limits(), retry: true })
  held.resolve([f.identity])
  await second
  assert.deepEqual(f.signals, ["SIGTERM"])
})