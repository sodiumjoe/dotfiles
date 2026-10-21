import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import type { PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"
import { createSyntheticFixtureScope } from "./fixtures/run-scope.js"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(deadlineMs = 1000, reporting: import("./fixtures/run-scope.js").Reporting = "direct", ownGroup = false) {
  const identity: ProcessIdentity = { bootId: "boot", pid: 123, birth: "10:fixture", parentPid: process.pid, processGroupId: 123, sessionId: 123, uid: 1, gid: 1 }
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null }) as unknown as ChildProcess
  let current: ProcessIdentity | null = identity
  const signals: Array<[number, NodeJS.Signals]> = []
  const adapter: PlatformAdapter = {
    platform: "linux", bootId: async () => "boot",
    readProcess: async () => current,
    readGroup: async () => current ? [current] : [],
    signalGroup: async () => { throw new Error("synthetic adapter cannot signal") },
  }
  const scope = createSyntheticFixtureScope({ runId: "run", workerFile: "scope.test", deadlineMs, adapter, signal: (pid, value) => { signals.push([pid, value]) } })
  const ref = scope.intent("provider", { reporting, ownGroup })
  const register = () => scope.spawn(ref, () => child, { closeAdmission() {} })
  const exit = (close = true) => { current = null; Object.assign(child, { exitCode: 0 }); child.emit("exit", 0, null); if (close) child.emit("close", 0, null) }
  return { child, scope, ref, register, exit, adapter, identity, signals, setCurrent(value: ProcessIdentity | null) { current = value } }
}

test("synchronous registration preserves exit before observation and waits for close", async () => {
  const f = fixture()
  assert.equal(f.register(), f.child)
  f.exit(false)
  assert.equal(f.scope.snapshot().launches[0]!.close, false)
  assert.deepEqual(f.scope.snapshot().launches[0]!.exit, { code: 0, signal: null })
  assert.equal(await f.scope.observe(f.ref), null)
  const pending = f.scope.finish()
  let finished = false
  void pending.then(() => { finished = true })
  await Promise.resolve()
  assert.equal(finished, false)
  f.child.emit("close", 0, null)
  assert.equal((await pending).state, "settled")
  assert.equal(f.scope.finish(), pending)
})

test("spawn errors and throws retain actual attempts without invented identities", async () => {
  const f = fixture()
  Object.assign(f.child, { pid: undefined })
  f.register()
  f.child.emit("error", new Error("ENOENT"))
  f.child.emit("close", -2, null)
  const ref = f.scope.intent("throw")
  assert.throws(() => f.scope.spawn(ref, () => { throw new Error("thrown") }, { closeAdmission() {} }), /thrown/)
  const result = await f.scope.finish()
  assert.equal(result.state, "settled")
  assert.deepEqual(result.launches.map(value => value.pid), [null, null])
  assert.deepEqual(result.launches.map(value => value.error), ["ENOENT", "thrown"])
})

test("foreign and duplicate refs fail before invoking another spawn", async () => {
  const f = fixture()
  f.register()
  let invoked = false
  for (const ref of [f.ref, { ...f.ref, runId: "foreign" }, { ...f.ref, launchId: "unknown" }]) {
    assert.throws(() => f.scope.spawn(ref, () => { invoked = true; return f.child }, { closeAdmission() {} }))
  }
  assert.equal(invoked, false)
  f.exit()
  await f.scope.finish()
})

test("early operation rejection cannot release other admitted work", async () => {
  const f = fixture(), held = deferred<number>()
  f.register(); f.exit()
  const failed = f.scope.operation("expected failure", async () => { throw new Error("body") })
  const good = f.scope.operation("held", () => held.promise)
  await assert.rejects(failed, /body/)
  const done = f.scope.finish()
  assert.equal(f.scope.snapshot().operations.find(value => value.label === "held")!.state, "pending")
  held.resolve(7)
  assert.equal(await good, 7)
  assert.equal((await done).state, "settled")
  assert.throws(() => f.scope.intent("late"))
})

test("finish attempts all finalizers and preserves their failures", async () => {
  const f = fixture(), called: string[] = []
  f.scope.finalizer("first", async () => { called.push("first"); throw new Error("cleanup failed") })
  f.scope.finalizer("second", async () => { called.push("second") })
  f.scope.artifact("/unusable/historical/ownership.jsonl")
  const result = await f.scope.finish()
  assert.deepEqual(called, ["first", "second"])
  assert.equal(result.state, "incomplete")
  assert.match(result.failures.join(" "), /cleanup failed/)
  assert.deepEqual(result.artifacts, ["/unusable/historical/ownership.jsonl"])
})

for (const group of [false, true]) test("signals require fresh exact identity, group=" + group, async () => {
  const f = fixture()
  const ref = group ? f.scope.intent("group", { ownGroup: true }) : f.ref
  f.scope.spawn(ref, () => f.child, { closeAdmission() {} })
  await f.scope.observe(ref)
  await f.scope.signal(ref, "SIGTERM")
  assert.deepEqual(f.signals, [[group ? -123 : 123, "SIGTERM"]])
  f.setCurrent({ ...f.identity, birth: "11:replacement" })
  await assert.rejects(f.scope.signal(ref, "SIGKILL"), /identity/)
  assert.equal(f.signals.length, 1)
  f.exit()
  assert.equal((await f.scope.finish()).state, "incomplete")
})

test("leader exit never authorizes a signal to surviving group members", async () => {
  const f = fixture(), ref = f.scope.intent("group", { ownGroup: true })
  f.scope.spawn(ref, () => f.child, { closeAdmission() {} })
  await f.scope.observe(ref)
  f.exit()
  f.adapter.readGroup = async () => [{ ...f.identity, pid: 124, birth: "11:survivor" }]
  await assert.rejects(f.scope.signal(ref, "SIGKILL"), /identity|terminal/)
  assert.deepEqual(f.signals, [])
  assert.equal((await f.scope.finish()).state, "incomplete")
})

test("failed observation keeps one launch and closes admission before normal finalization", async () => {
  const f = fixture()
  let closed = false
  f.scope.spawn(f.ref, () => f.child, { closeAdmission() { closed = true; throw new Error("descriptor") } })
  f.adapter.readProcess = async () => { throw new Error("observe") }
  await assert.rejects(f.scope.observe(f.ref), /observe/)
  f.exit()
  const result = await f.scope.finish()
  assert.equal(closed, true)
  assert.equal(result.launches.length, 1)
  assert.match(result.failures.join(" "), /observe/)
  assert.match(result.failures.join(" "), /descriptor/)
})

test("missing close times out as incomplete even after exit and physical absence", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
  const f = fixture(20)
  f.register(); f.exit(false)
  const done = f.scope.finish()
  for (let index = 0; index < 20; index++) await Promise.resolve()
  t.mock.timers.tick(21)
  const result = await done
  assert.equal(result.state, "incomplete")
  assert.equal(result.launches[0]!.close, false)
  assert.match(result.failures.join(" "), /deadline|close/)
})

test("unspawned intent never grants identity or cleanup authority", async () => {
  const f = fixture()
  await assert.rejects(f.scope.signal(f.ref, "SIGTERM"))
  assert.deepEqual(f.signals, [])
  const result = await f.scope.finish()
  assert.equal(result.launches[0]!.identity, null)
  assert.equal(result.state, "incomplete")
})

test("a retained generation that changes groups is not physically absent", async () => {
  const f = fixture(20)
  f.register()
  await f.scope.observe(f.ref)
  f.exit()
  f.setCurrent({ ...f.identity, processGroupId: 999, sessionId: 999 })
  const result = await f.scope.finish()
  assert.equal(result.state, "incomplete")
  assert.equal(result.launches[0]!.absent, false)
})

test("an unregistered group member refuses group cleanup without signaling it", async () => {
  const f = fixture(20), ref = f.scope.intent("group", { ownGroup: true })
  f.scope.spawn(ref, () => f.child, { closeAdmission() {} })
  await f.scope.observe(ref)
  f.adapter.readGroup = async () => [f.identity, { ...f.identity, pid: 124, birth: "11:unknown" }]
  await assert.rejects(f.scope.signal(ref, "SIGKILL"), /group|registered/)
  assert.deepEqual(f.signals, [])
  f.exit()
  await f.scope.finish()
})

test("final absence waits through an unstable exit observation without treating uncertainty as absence", async () => {
  const f = fixture(1000)
  f.register(); f.exit()
  let reads = 0
  f.adapter.readProcess = async () => { if (++reads < 3) throw new Error("unstable exit"); return null }
  const result = await f.scope.finish()
  assert.equal(result.state, "settled", JSON.stringify(result.failures))
  assert.equal(result.launches[0]!.absent, true)
  assert.equal(reads, 3)
})

test("a detached launch with no executable records error and close without a terminal event", async () => {
  const f = fixture(1000, "detached-handler")
  const ref = f.ref
  f.scope.spawn(ref, () => { Object.assign(f.child, { pid: undefined }); return f.child }, { closeAdmission() {} })
  f.child.emit("error", new Error("ENOENT"))
  f.child.emit("close", -2, null)
  assert.equal((await f.scope.finish()).state, "settled")
})

for (const change of ["declared", "other-command", "new-start", "other-owner"]) test("exec identity adoption is confined to the declared Darwin helper: " + change, async () => {
  let identity: ProcessIdentity | null = { bootId: "exec-boot", pid: 123, birth: "10:unmarked:/bin/sh", parentPid: process.pid, processGroupId: 456, sessionId: 456, uid: 1, gid: 1 }
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null }) as unknown as ChildProcess
  const scope = createSyntheticFixtureScope({ runId: "exec", workerFile: "exec.test", deadlineMs: 20,
    adapter: { platform: "darwin", bootId: async () => "exec-boot", readProcess: async () => identity, readGroup: async () => [], signalGroup: async () => assert.fail("unexpected signal") }, signal: () => assert.fail("unexpected signal") })
  const ref = scope.intent("darwin-exec-helper")
  scope.spawn(ref, () => child, { closeAdmission() {} })
  await scope.observe(ref)
  identity = { ...identity, birth: change === "other-command" ? "10:unmarked:/bin/cat" : change === "new-start" ? "11:unmarked:/bin/sleep" : "10:unmarked:/bin/sleep", uid: change === "other-owner" ? 2 : 1 }
  if (change === "declared") assert.equal((await scope.observe(ref))!.birth, "10:unmarked:/bin/sleep")
  else await assert.rejects(scope.observe(ref), /identity mismatch/)
  identity = null
  child.emit("exit", 0, null); child.emit("close", 0, null)
  assert.equal((await scope.finish()).state, change === "declared" ? "settled" : "incomplete")
})

test("finish waits for admitted signal checks before publishing a settled boundary", async () => {
  const f = fixture(), entered = deferred<void>(), held = deferred<string>()
  f.register()
  await f.scope.observe(f.ref)
  let reads = 0
  f.adapter.bootId = async () => {
    if (++reads === 1) { entered.resolve(); return held.promise }
    return "boot"
  }
  const stop = assert.rejects(f.scope.signal(f.ref, "SIGTERM"), /boot mismatch/)
  await entered.promise
  f.exit()
  const done = f.scope.finish()
  let finished = false
  void done.then(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve))
  const publishedEarly = finished
  held.resolve("changed-boot")
  await stop
  const result = await done
  assert.equal(publishedEarly, false)
  assert.equal(result.state, "incomplete")
  assert.match(result.failures.join(";"), /boot mismatch/)
  assert.deepEqual(f.signals, [])
})

test("owner cleanup releases an unresolved operation before the final join", async () => {
  const f = fixture(100), held = deferred<number>()
  f.register()
  f.scope.operation("held application", () => held.promise)
  f.scope.finalizer("owner cleanup", async () => { f.exit(); held.resolve(7) })
  const result = await f.scope.finish()
  assert.equal(result.state, "settled", JSON.stringify(result.failures))
  assert.equal(result.operations[0]!.state, "fulfilled")
  assert.equal(result.launches[0]!.absent, true)
})

test("a timed out finalizer does not suppress another owner cleanup", async () => {
  const f = fixture(100), called: string[] = []
  f.register()
  f.scope.finalizer("held cleanup", () => new Promise<void>(() => {}))
  f.scope.finalizer("resource cleanup", async () => { called.push("resource"); f.exit() })
  const result = await f.scope.finish()
  assert.deepEqual(called, ["resource"])
  assert.equal(result.state, "incomplete")
  assert.match(result.failures.join(";"), /held cleanup deadline/)
})

for (const change of ["boot", "parent", "terminal", "unavailable"]) test("fresh signals refuse changed ownership: " + change, async () => {
  const f = fixture(100)
  f.register()
  await f.scope.observe(f.ref)
  if (change === "boot") f.adapter.bootId = async () => "other-boot"
  if (change === "parent") f.setCurrent({ ...f.identity, parentPid: 999 })
  if (change === "terminal") f.exit()
  if (change === "unavailable") f.adapter.readProcess = async () => { throw new Error("observation unavailable") }
  await assert.rejects(f.scope.signal(f.ref, "SIGTERM"))
  assert.deepEqual(f.signals, [])
  f.adapter.readProcess = async () => null
  f.adapter.bootId = async () => "boot"
  f.exit()
  assert.equal((await f.scope.finish()).state, "incomplete")
})

for (const change of ["none", "continue", "birth", "boot", "owner", "parent", "unknown-member", "terminal", "unavailable", "owner-after-group", "target-after-group"]) test("owner-local signal authorization: " + change, async () => {
  const { signalOwnedProcess } = await import("./fixtures/fixture-signal.js")
  const f = fixture(100), owner = { ...f.identity, pid: process.pid, parentPid: 1, processGroupId: 456, sessionId: 456 }
  let current: ProcessIdentity | null = { ...f.identity }, currentOwner = { ...owner }
  if (change === "birth") current.birth = "11:replacement"
  if (change === "boot") f.adapter.bootId = async () => "new-boot"
  if (change === "owner") currentOwner.birth = "12:other-owner"
  if (change === "parent") current.parentPid = 999
  if (change === "terminal") current.birth = "10:unmarked:(node)"
  f.adapter.readProcess = async pid => {
    if (change === "unavailable") throw new Error("observation unavailable")
    return pid === owner.pid ? currentOwner : current
  }
  f.adapter.readGroup = async () => {
    if (change === "owner-after-group") currentOwner = { ...owner, birth: "12:other-owner" }
    if (change === "target-after-group") current = { ...f.identity, birth: "11:replacement" }
    return change === "unknown-member" ? [current!, { ...f.identity, pid: 124 }] : [f.identity]
  }
  const signal = change === "continue" ? "SIGCONT" : "SIGTERM"
  const run = () => signalOwnedProcess(f.adapter, { identity: f.identity, ownerIdentity: owner, knownMembers: [f.identity], signal, group: true }, (pid, signal) => { f.signals.push([pid, signal]) })
  if (change === "none" || change === "continue") { assert.equal(await run(), "delivered"); assert.deepEqual(f.signals, [[-123, signal]]) }
  else { await assert.rejects(run()); assert.deepEqual(f.signals, []) }
})

for (const state of ["absent", "terminal", "unavailable"]) test("launch capture refuses delayed or unavailable identity: " + state, async () => {
  const { captureOwnedProcess } = await import("./fixtures/fixture-signal.js")
  const f = fixture(100)
  f.adapter.readProcess = async () => {
    if (state === "unavailable") throw new Error("observation unavailable")
    return state === "absent" ? null : { ...f.identity, birth: "10:unmarked:<defunct>" }
  }
  await assert.rejects(captureOwnedProcess(f.adapter, 123, process.pid, true))
  assert.deepEqual(f.signals, [])
})

for (const delayed of ["process", "group"]) test("expired signal authorization cannot deliver after a delayed " + delayed + " observation", async () => {
  const f = fixture(40, "direct", delayed === "group"), held = deferred<ProcessIdentity | null>(), group = deferred<ProcessIdentity[]>()
  const ref = f.ref
  f.register()
  await f.scope.observe(ref)
  if (delayed === "process") f.adapter.readProcess = () => held.promise
  else f.adapter.readGroup = () => group.promise
  await assert.rejects(f.scope.signal(ref, "SIGTERM"), /signal authorization deadline/)
  const result = await f.scope.finish()
  assert.equal(result.state, "incomplete")
  assert.match(result.failures.join(";"), /signal authorization deadline/)
  assert.equal(f.child.exitCode, null)
  held.resolve(f.identity); group.resolve([f.identity])
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(f.signals, [])
  assert.equal(f.scope.snapshot().state, "incomplete")
  f.exit()
})