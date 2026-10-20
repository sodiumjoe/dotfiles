import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { PassThrough } from "node:stream"
import { spawnOwnedChild, isOwnedChild } from "../src/runtime/owned-child.js"

function fixture(t: test.TestContext) {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, unref() {} }) as unknown as ChildProcess
  t.after(() => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy() })
  return child
}

test("an error on a spawned child does not settle terminal", async t => {
  const child = fixture(t)
  const owner = spawnOwnedChild({ launchAttemptId: "a", spawn: () => child })
  child.emit("error", new Error("signal failed"))
  assert.equal(owner.snapshot().terminal, null)
  child.emit("exit", 7, null)
  assert.deepEqual(await owner.terminal, { kind: "exit", code: 7, signal: null })
  assert.equal(owner.release(), false)
  child.emit("close", 7, null)
  await owner.closed
  assert.equal(owner.release(), true)
})

test("no-PID spawn error is terminal but close alone is not", async t => {
  const child = fixture(t); Object.assign(child, { pid: undefined })
  const owner = spawnOwnedChild({ launchAttemptId: "a", spawn: () => child })
  child.emit("close", null, null)
  assert.equal(owner.snapshot().terminal, null)
  const error = new Error("spawn failed")
  child.emit("error", error)
  child.emit("exit", 9, null)
  assert.deepEqual(await owner.terminal, { kind: "spawn-error", error })
  assert.equal(owner.release(), true)
})

test("callbacks see captured state and reentrant events retain the first terminal", async t => {
  const child = fixture(t)
  let callbacks = 0
  const owner = spawnOwnedChild({ launchAttemptId: "a", spawn: () => child, onEvent(event) {
    callbacks++
    if (event.kind === "exit") {
      assert.equal(owner.snapshot().terminal?.kind, "exit")
      if (callbacks === 1) child.emit("close", 2, null)
    }
    throw new Error("consumer callback")
  } })
  child.emit("exit", 2, null); child.emit("exit", 3, null)
  assert.deepEqual(await owner.terminal, { kind: "exit", code: 2, signal: null })
  assert.equal(owner.snapshot().closed, true)
  assert.equal(callbacks, 3)
  assert.equal(isOwnedChild(owner), true)
  assert.equal(isOwnedChild({ ...owner }), false)
})

test("stop coalesces success and retains it on explicit retry", async t => {
  const owner = spawnOwnedChild({ launchAttemptId: "a", spawn: () => fixture(t) })
  let calls = 0
  const operation = async () => { calls++ }
  const first = owner.stop(operation)
  assert.equal(owner.stop(operation), first)
  await first
  assert.equal(owner.retryStop(operation), first)
  assert.equal(calls, 1)
})

test("rejected stop is retained until an explicit coalesced retry", async t => {
  const owner = spawnOwnedChild({ launchAttemptId: "a", spawn: () => fixture(t) })
  let calls = 0
  const operation = async () => { calls++; throw new Error("unresolved") }
  const first = owner.stop(operation)
  await assert.rejects(first, /unresolved/)
  assert.equal(owner.stop(operation), first)
  assert.equal(calls, 1)
  const retry = owner.retryStop(async () => { calls++ })
  assert.notEqual(retry, first)
  assert.equal(owner.retryStop(operation), retry)
  await retry
  assert.equal(calls, 2)
})

test("abandonment closes pipes without fabricating terminal or stop success", async t => {
  const child = fixture(t)
  const owner = spawnOwnedChild({ launchAttemptId: "a", spawn: () => child })
  owner.abandon("fixture owner loss")
  assert.deepEqual(owner.snapshot(), { terminal: null, closed: false, abandoned: true })
  assert.equal(child.stdout!.destroyed, true)
  let calls = 0
  await assert.rejects(owner.stop(async () => { calls++ }), /abandoned/)
  await assert.rejects(owner.retryStop(async () => { calls++ }), /abandoned/)
  assert.equal(calls, 0)
  assert.equal(owner.release(), false)
})

test("terminal owner releases destroyed streams with held close", t => {
  const child = fixture(t)
  const owner = spawnOwnedChild({ launchAttemptId: "a", spawn: () => child })
  child.emit("exit", 0, null)
  child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy()
  assert.equal(owner.release(), true)
})

test("synchronous spawn exception propagates exactly once", () => {
  let calls = 0
  assert.throws(() => spawnOwnedChild({ launchAttemptId: "a", spawn() { calls++; throw new Error("spawn invocation") } }), /spawn invocation/)
  assert.equal(calls, 1)
})