import assert from "node:assert/strict"
import { type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { fstatSync } from "node:fs"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import test, { type TestContext } from "node:test"
import { withStartupLock, type StartupLockGuard } from "../src/platform/singleton.js"
import { type StartupDependencies } from "../src/platform/startup.js"
import { type PlatformAdapter } from "../src/platform/types.js"

function exit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
  Object.assign(child, { exitCode: code, signalCode: signal })
  child.emit("exit", code, signal)
}

function exitOnRelease(code: number | null = 0, signal: NodeJS.Signals | null = null): (child: ChildProcess) => void {
  return child => { setImmediate(() => exit(child, code, signal)) }
}

async function fixture(t: TestContext, onRelease = exitOnRelease()) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agency-lock-errors-"))
  const ready = new PassThrough(), release = new PassThrough(), stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdio: [null, null, stderr, null, ready, release],
  }) as unknown as ChildProcess
  const unused = async (): Promise<never> => { throw new Error("unexpected platform observation or signal") }
  const adapter: PlatformAdapter = {
    platform: process.platform === "darwin" ? "darwin" : "linux",
    bootId: unused,
    readProcess: unused,
    readGroup: unused,
    signalGroup: unused,
  }
  let descriptor: number | undefined
  const entered = Promise.withResolvers<void>()
  const end = release.end.bind(release)
  release.end = (() => {
    end()
    entered.resolve()
    onRelease(child)
    return release
  }) as typeof release.end
  const dependencies: StartupDependencies = {
    spawn(_file, _args, options) {
      assert.ok(Array.isArray(options.stdio))
      assert.equal(typeof options.stdio[3], "number")
      descriptor = options.stdio[3] as number
      setImmediate(() => ready.write("locked\n"))
      return child
    },
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) exit(child, 0, null)
    child.emit("close", child.exitCode, child.signalCode)
    for (const stream of [ready, release, stderr]) stream.destroy()
    await rm(root, { recursive: true, force: true })
  })
  return {
    child,
    releaseEntered: entered.promise,
    async run<T>(work: (guard: StartupLockGuard) => Promise<T>): Promise<T> {
      try {
        return await withStartupLock({ root, adapter }, work, dependencies)
      } finally {
        assert.equal(typeof descriptor, "number")
        assert.throws(() => fstatSync(descriptor!), { code: "EBADF" })
      }
    },
  }
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(() => assert.fail("expected rejection"), error => error)
}

function combined(error: unknown, workFailure: unknown): unknown {
  assert.ok(error instanceof AggregateError)
  assert.equal(error.errors.length, 2)
  assert.strictEqual(error.errors[0], workFailure)
  return error.errors[1]
}

test("returns guarded work after a normal helper exit", async t => {
  const f = await fixture(t)
  const result = { value: "guarded result" }
  assert.strictEqual(await f.run(async () => result), result)
})

for (const [name, code, signal, diagnostic] of [
  ["nonzero exit", 7, null, /7/],
  ["signal termination", null, "SIGTERM", /SIGTERM/],
] as const) {
  test(`rejects helper ${name} during release`, async t => {
    const f = await fixture(t, exitOnRelease(code, signal))
    await assert.rejects(f.run(async () => "result"), diagnostic)
  })

  test(`retains work failure with helper ${name} during release`, async t => {
    const f = await fixture(t, exitOnRelease(code, signal))
    const workFailure = new Error("guarded work failed")
    const releaseFailure = combined(await rejection(f.run(async () => { throw workFailure })), workFailure)
    assert.ok(releaseFailure instanceof Error)
    assert.match(releaseFailure.message, diagnostic)
  })

  test(`rejects already-terminal helper ${name} without losing work failure`, async t => {
    const f = await fixture(t, () => {})
    const workFailure = new Error("guarded work failed")
    const error = await rejection(f.run(async () => {
      Object.assign(f.child, { exitCode: code, signalCode: signal })
      throw workFailure
    }))
    const releaseFailure = combined(error, workFailure)
    assert.ok(releaseFailure instanceof Error)
    assert.match(releaseFailure.message, diagnostic)
  })
}

for (const [name, workFailure] of [
  ["Error", new Error("guarded work failed")],
  ["undefined", undefined],
  ["null", null],
] as const) {
  test(`preserves thrown ${name} with successful release`, async t => {
    const f = await fixture(t)
    assert.strictEqual(await rejection(f.run(async () => { throw workFailure })), workFailure)
  })

  test(`retains thrown ${name} and synchronous release failure in order`, async t => {
    const releaseFailure = new Error("release failed")
    const f = await fixture(t, () => { throw releaseFailure })
    const error = await rejection(f.run(async () => { throw workFailure }))
    assert.strictEqual(combined(error, workFailure), releaseFailure)
  })
}

test("preserves standalone synchronous release failure by identity", async t => {
  const releaseFailure = new Error("release failed")
  const f = await fixture(t, () => { throw releaseFailure })
  assert.strictEqual(await rejection(f.run(async () => "result")), releaseFailure)
})

test("preserves work failure after an already-terminal zero exit", async t => {
  const f = await fixture(t, () => {})
  const workFailure = new Error("guarded work failed")
  const error = await rejection(f.run(async () => {
    Object.assign(f.child, { exitCode: 0, signalCode: null })
    throw workFailure
  }))
  assert.strictEqual(error, workFailure)
})

test("preserves standalone child error during release by identity", async t => {
  const releaseFailure = new Error("child failed")
  const f = await fixture(t, child => { setImmediate(() => child.emit("error", releaseFailure)) })
  assert.strictEqual(await rejection(f.run(async () => "result")), releaseFailure)
})

test("retains work failure and child error during release in order", async t => {
  const workFailure = new Error("guarded work failed"), releaseFailure = new Error("child failed")
  const f = await fixture(t, child => { setImmediate(() => child.emit("error", releaseFailure)) })
  const error = await rejection(f.run(async () => { throw workFailure }))
  assert.strictEqual(combined(error, workFailure), releaseFailure)
})

test("retains work failure with the release timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = await fixture(t, () => {})
  const workFailure = new Error("guarded work failed")
  const result = rejection(f.run(async () => { throw workFailure }))
  await f.releaseEntered
  t.mock.timers.tick(1000)
  const releaseFailure = combined(await result, workFailure)
  assert.ok(releaseFailure instanceof Error)
  assert.match(releaseFailure.message, /startup lock helper did not exit/)
})