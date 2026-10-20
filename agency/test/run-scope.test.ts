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
function fixture(deadlineMs = 1000) {
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
  const ref = scope.intent("provider")
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