import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { admitSingletonChild, createSingletonRecorder, preserveSingletonFixture, registerSingletonChildBeforeRelease } from "./fixtures/singleton-ownership.js"
import type { PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"

const expected: ProcessIdentity = { bootId: "actual-test-boot", pid: 123, birth: "123:unmarked:node", parentPid: 12, processGroupId: 123, sessionId: 123, uid: 501, gid: 20 }

async function fixture(t: TestContext, observe: () => Promise<ProcessIdentity | null> = async () => expected) {
  const parent = process.env.AGENCY_TEST_FIXTURE_ROOT ?? tmpdir()
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, "singleton-recorder-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
  const adapter: PlatformAdapter = { platform: "darwin", bootId: async () => expected.bootId, readProcess: observe, readGroup: async () => [], signalGroup: async () => assert.fail("unexpected group signal") }
  return { root, signals, recorder: createSingletonRecorder(root, adapter, (pid, signal) => { signals.push({ pid, signal }) }), rows: async () => (await readFile(join(root, "ownership.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) }
}

test("singleton ownership retains intent, spawn and actual identity in order", async t => {
  const { recorder, rows } = await fixture(t)
  const launch = recorder.intent("handler")
  assert.deepEqual(await recorder.spawn(launch, expected.pid), expected)
  const recorded = await rows()
  assert.deepEqual(recorded.map(row => row.type), ["intent", "spawn", "identity"])
  assert.ok(recorded.every(row => row.launchId === launch.launchId))
  assert.deepEqual(recorded[2].identity, expected)
})

test("singleton ownership closes a missing executable without an identity", async t => {
  const { recorder, rows } = await fixture(t, async () => assert.fail("unexpected observation"))
  const launch = recorder.intent("handler")
  assert.equal(await recorder.spawn(launch, undefined), null)
  assert.deepEqual((await rows()).map(row => row.type), ["intent", "spawn", "no-process"])
})

test("singleton ownership retains and rejects unavailable registration", async t => {
  const { recorder, rows } = await fixture(t, async () => { throw new Error("observation unavailable") })
  const launch = recorder.intent("handler")
  await assert.rejects(recorder.spawn(launch, expected.pid), /observation unavailable/)
  const failure = (await rows()).at(-1)
  assert.equal(failure.type, "registration-failure")
  assert.equal(failure.launchId, launch.launchId)
})

test("singleton ownership refuses a reused PID before signaling", async t => {
  const { recorder, rows, signals } = await fixture(t, async () => ({ ...expected, birth: "456:unmarked:node" }))
  await assert.rejects(recorder.kill(expected, "SIGKILL"), /identity mismatch/)
  assert.deepEqual(signals, [])
  assert.equal((await rows()).at(-1).type, "signal-refused")
})

test("singleton ownership records exact signal authorization", async t => {
  const { recorder, rows, signals } = await fixture(t)
  await recorder.kill(expected, "SIGKILL")
  assert.deepEqual(signals, [{ pid: expected.pid, signal: "SIGKILL" }])
  const authorization = (await rows()).at(-1)
  assert.equal(authorization.type, "signal-authorized")
  assert.deepEqual(authorization.expected, expected)
  assert.deepEqual(authorization.observed, expected)
})

function gatedChild() {
  const status = new PassThrough(), gate = new PassThrough()
  const mutableChild = Object.assign(new EventEmitter(), { pid: 123, stdio: [null, null, null, status, gate], exitCode: null as number | null, signalCode: null })
  const child = mutableChild as unknown as ChildProcess
  status.once("close", () => setImmediate(() => { mutableChild.exitCode = 1; child.emit("exit", 1, null) }))
  return { child, status, gate }
}

test("singleton contender registration failure closes admission and reaps before returning", async () => {
  const { child, status } = gatedChild()
  let admitted = false
  status.on("data", () => { admitted = true })
  await assert.rejects(admitSingletonChild(child, async () => { throw new Error("registration unavailable") }), /registration unavailable/)
  assert.equal(status.destroyed, true)
  assert.equal(child.exitCode, 1)
  assert.equal(admitted, false)
})

test("singleton Handler registration failure closes both descriptors and reaps before returning", async () => {
  const { child, status, gate } = gatedChild()
  await assert.rejects(registerSingletonChildBeforeRelease(child, async () => { throw new Error("registration unavailable") }), /registration unavailable/)
  assert.equal(status.destroyed, true)
  assert.equal(gate.destroyed, true)
  assert.equal(child.exitCode, 1)
})

for (const [name, register] of [["contender", admitSingletonChild], ["Handler", registerSingletonChildBeforeRelease]] as const) {
  test(`singleton ${name} preserves registration and closure failures when the child does not exit`, async () => {
    const status = new PassThrough(), gate = new PassThrough()
    const child = Object.assign(new EventEmitter(), { pid: 123, stdio: [null, null, null, status, gate], exitCode: null, signalCode: null }) as unknown as ChildProcess
    const registration = new Error("registration unavailable")
    let admitted = false
    status.on("data", () => { admitted = true })
    await assert.rejects(register(child, async () => { throw registration }), error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.cause, registration)
      assert.equal(error.errors[0], registration)
      assert.match(String(error.errors[1]), /did not exit/)
      return true
    })
    assert.equal(status.destroyed, true)
    if (name === "Handler") assert.equal(gate.destroyed, true)
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
    assert.equal(admitted, false)
    child.emit("exit", 1, null)
  })
}

test("singleton fixture preservation records symlink targets without following them", async t => {
  const { root } = await fixture(t)
  const source = join(root, "source"), destination = join(root, "snapshot")
  await mkdir(source)
  await writeFile(join(source, "regular"), "retained")
  await symlink("../missing-target", join(source, "unsafe-entry"))
  await preserveSingletonFixture(source, destination)
  assert.equal(await readFile(join(destination, "regular"), "utf8"), "retained")
  await assert.rejects(lstat(join(destination, "unsafe-entry")), { code: "ENOENT" })
  assert.deepEqual(JSON.parse(await readFile(join(destination, "singleton-symlinks.json"), "utf8")), [{ path: "unsafe-entry", target: "../missing-target" }])
})