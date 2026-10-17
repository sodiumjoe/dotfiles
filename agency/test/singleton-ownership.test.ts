import assert from "node:assert/strict"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import childProcess, { spawn, type ChildProcess } from "node:child_process"
import { pathToFileURL } from "node:url"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
const nativeSpawn = childProcess.spawn
import { appendFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { admitSingletonChild, settleSingletonStarts, createSingletonRecorder, finishSingletonOwnership, installSingletonOwnership, retainSingletonIdentity, preserveSingletonFixture, registerSingletonChildBeforeRelease } from "./fixtures/singleton-ownership.js"
import type { PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"

const expected: ProcessIdentity = { bootId: "actual-test-boot", pid: 123, birth: "123:unmarked:node", parentPid: 12, processGroupId: 123, sessionId: 123, uid: 501, gid: 20 }

async function fixture(t: TestContext, observe: (pid: number) => Promise<ProcessIdentity | null> = async () => expected) {
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
async function withControlClosure(operation: () => Promise<void>, close: () => Promise<void>): Promise<void> {
  let failure: unknown
  try { await operation() } catch (error) { failure = error }
  try { await close() } catch (closure) {
    if (failure !== undefined) throw new AggregateError([failure, closure], "control operation and closure failed", { cause: failure })
    throw closure
  }
  if (failure !== undefined) throw failure
}

async function realControl(t: TestContext) {
  const parent = process.env.AGENCY_TEST_FIXTURE_ROOT ?? tmpdir()
  const root = await mkdtemp(join(parent, "singleton-preload-control-"))
  const evidence = join(process.env.AGENCY_TEST_EVIDENCE_ROOT ?? root, "preload-control-" + crypto.randomUUID())
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  const real = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  const recorder = createSingletonRecorder(evidence, real)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, evidence, recorder, real }
}

async function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode }
  return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })) })
}

async function controlLine(child: ChildProcess): Promise<string> {
  let line = ""
  for await (const chunk of child.stdout!) {
    line += String(chunk)
    if (line.includes("\n")) return line.slice(0, line.indexOf("\n"))
  }
  throw new Error("control fixture closed without publication")
}

test("exact-path preload retains a fixture and its nested child before release", async t => {
  const { root, evidence, recorder } = await realControl(t)
  const fixturePath = join(root, "nested-fixture.mjs")
  await writeFile(fixturePath, `import { spawn } from "node:child_process"
import { Socket } from "node:net"
const gate = new Socket({ fd: 3, readable: true, writable: true })
const released = new Promise(resolve => { gate.once("data", resolve); gate.once("end", resolve) })
let child
if (process.argv[2] !== "child") {
  child = spawn(process.execPath, [process.argv[1], "child"], { stdio: ["ignore", "pipe", "pipe", "pipe"] })
  let line = ""
  for await (const chunk of child.stdout) { line += String(chunk); if (line.includes("\\n")) break }
  process.stdout.write(JSON.stringify({ pid: process.pid, nestedPid: JSON.parse(line).pid }) + "\\n")
} else process.stdout.write(JSON.stringify({ pid: process.pid }) + "\\n")
await released
if (child) {
  const exited = new Promise(resolve => child.once("exit", resolve))
  child.stdio[3].end("release\\n")
  await exited
}
gate.destroy()`)
  const rootLaunch = recorder.intent("darwin-control-root"), nestedLaunch = recorder.intent("darwin-control-nested")
  const previousRoot = process.env.AGENCY_SINGLETON_EVIDENCE_ROOT
  process.env.AGENCY_SINGLETON_EVIDENCE_ROOT = evidence
  try { installSingletonOwnership([fixturePath]) } finally { if (previousRoot === undefined) delete process.env.AGENCY_SINGLETON_EVIDENCE_ROOT; else process.env.AGENCY_SINGLETON_EVIDENCE_ROOT = previousRoot }
  const child = spawn(process.execPath, [fixturePath], { env: { ...process.env, AGENCY_SINGLETON_EVIDENCE_ROOT: evidence }, stdio: ["ignore", "pipe", "pipe", "pipe"] })
  const exited = childExit(child)
  await withControlClosure(async () => {
    const leader = await recorder.spawn(rootLaunch, child.pid)
    assert.notEqual(leader, null)
    const published = JSON.parse(await controlLine(child)) as { pid: number; nestedPid: number }
    assert.equal(published.pid, child.pid)
    await recorder.spawn(nestedLaunch, published.nestedPid)
    const before = (await readFile(join(evidence, "ownership.jsonl"), "utf8")).trim().split("\n").length
    retainSingletonIdentity("darwin-group-member", leader!)
    const rows = (await readFile(join(evidence, "ownership.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
    assert.equal(rows.length, before + 1)
    assert.deepEqual(rows.at(-1), { at: rows.at(-1).at, type: "observation", role: "darwin-group-member", identity: leader })
    const automatic = rows.filter(row => row.type === "identity" && row.role === "darwin-fixture")
    assert.deepEqual(automatic.map(row => row.identity.pid).sort((a: number, b: number) => a - b), [published.pid, published.nestedPid].sort((a, b) => a - b))
    assert.equal(child.exitCode, null)
  }, async () => withControlClosure(async () => {
    ;(child.stdio[3] as PassThrough).end("release\n")
    const outcome = await exited
    await appendFile(join(evidence, "ownership.jsonl"), JSON.stringify({ type: "control-exit", ...rootLaunch, pid: child.pid, ...outcome }) + "\n")
    assert.deepEqual(outcome, { code: 0, signal: null })
  }, finishSingletonOwnership))
})

test("preload registration refusal retains actual exit before fixture source entry", async t => {
  const { root, evidence, recorder } = await realControl(t)
  const admission = join(root, "admission.mjs"), fixturePath = join(root, "entry.mjs"), marker = join(root, "entered"), invalid = join(root, "invalid-root")
  await writeFile(admission, `import { Socket } from "node:net"
const gate = new Socket({ fd: 5, readable: true, writable: true })
await new Promise(resolve => { gate.once("data", resolve); gate.once("end", resolve) })
gate.destroy()`)
  await writeFile(fixturePath, `import { writeFile } from "node:fs/promises";await writeFile(${JSON.stringify(marker)}, "entered")`)
  await writeFile(invalid, "not a directory")
  const launch = recorder.intent("darwin-control-refusal")
  const token = { launch: { launchId: crypto.randomUUID(), role: "darwin-fixture" }, root: invalid, fixturePaths: [fixturePath] }
  const child = nativeSpawn(process.execPath, [fixturePath], { env: { ...process.env, AGENCY_FIXTURE_LAUNCH: JSON.stringify(token), NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import=" + pathToFileURL(admission).href, "--import=" + new URL("./fixtures/singleton-ownership.js", import.meta.url).href].filter(Boolean).join(" ") }, stdio: ["ignore", "ignore", "pipe", "ignore", "ignore", "pipe"] })
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()))
  let stderr = ""
  child.stderr!.on("data", chunk => { stderr += String(chunk) })
  const exited = childExit(child)
  let outcome: Awaited<ReturnType<typeof childExit>> | undefined
  await withControlClosure(async () => { await recorder.spawn(launch, child.pid) }, async () => {
    ;(child.stdio as Array<PassThrough | null | undefined>)[5]!.end("release\n")
    outcome = await exited
    await closed
    await appendFile(join(evidence, "ownership.jsonl"), JSON.stringify({ type: "control-refusal-exit", ...launch, pid: child.pid, ...outcome, stderr, descriptorsClosed: child.stdio.every(stream => stream == null || stream.destroyed), attemptedLaunch: token.launch, expectedRegistrationRefusal: true }) + "\n")
  })
  assert.notEqual(outcome, undefined)
  assert.notEqual(outcome!.code, 0)
  assert.equal(outcome!.signal, null)
  await assert.rejects(lstat(marker), { code: "ENOENT" })
  assert.match(stderr, /fixture ownership registration failed/)
  assert.ok(child.stdio.every(stream => stream == null || stream.destroyed))
})

async function durabilityControl<T>(root: string, operation: () => Promise<T>, barrier: (rows: Array<{ type: string }>) => void = () => undefined): Promise<{ result: T; snapshots: Array<Array<{ type: string }>> }> {
  const nativeSync = fs.fsyncSync
  const snapshots: Array<Array<{ type: string }>> = []
  fs.fsyncSync = fd => {
    const rows = fs.readFileSync(join(root, "ownership.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
    snapshots.push(rows)
    nativeSync(fd)
    barrier(rows)
  }
  syncBuiltinESMExports()
  try { return { result: await operation(), snapshots } } finally { fs.fsyncSync = nativeSync; syncBuiltinESMExports() }
}

test("singleton lock registration durably flushes ordered actual identities once before source entry", async t => {
  const helper = { launchId: "helper", role: "singleton-lock-helper" }, holder = { launchId: "holder", role: "singleton-lock-holder" }
  const parent = { ...expected, pid: 122 }, child = { ...expected, parentPid: 122 }
  const reads: number[] = []
  const { root, recorder, rows } = await fixture(t, async pid => { reads.push(pid); return reads.length === 1 ? parent : child })
  let sourceEntered = false, snapshotsBeforeSource = 0
  const { snapshots } = await durabilityControl(root, async () => {
    await recorder.lock(helper, holder, parent.pid, child.pid)
    assert.equal(snapshotsBeforeSource, 1)
    sourceEntered = true
  }, observed => { assert.equal(sourceEntered, false); snapshotsBeforeSource += 1; assert.deepEqual(observed.map(row => row.type), ["identity", "spawn", "identity"]) })
  assert.equal(sourceEntered, true)
  assert.deepEqual(reads, [parent.pid, child.pid])
  assert.equal(snapshots.length, 1)
  const recorded = await rows()
  assert.deepEqual(recorded.map(row => [row.type, row.launchId]), [["identity", "helper"], ["spawn", "holder"], ["identity", "holder"]])
  assert.deepEqual(recorded[0].identity, parent)
  assert.deepEqual(recorded[2].identity, child)
  assert.ok(recorded.filter(row => row.type === "identity").every(row => typeof row.elapsedMs === "number"))
})

test("singleton lock registration flushes its actual helper and failed holder before rejecting", async t => {
  const failure = new Error("holder observation unavailable")
  let reads = 0
  const { root, recorder, rows } = await fixture(t, async () => { if (++reads === 2) throw failure; return expected })
  const helper = { launchId: "helper", role: "singleton-lock-helper" }, holder = { launchId: "holder", role: "singleton-lock-holder" }
  const { snapshots } = await durabilityControl(root, async () => assert.rejects(recorder.lock(helper, holder, expected.pid, expected.pid + 1), error => error === failure))
  assert.equal(reads, 2)
  assert.equal(snapshots.length, 1)
  const recorded = await rows()
  assert.deepEqual(recorded.map(row => row.type), ["identity", "spawn", "registration-failure"])
  assert.equal(recorded[2].launchId, holder.launchId)
  assert.equal(recorded[2].pid, expected.pid + 1)
  assert.deepEqual(recorded[0].identity, expected)
})

test("singleton lock registration flushes a refused helper without claiming a holder", async t => {
  const failure = new Error("helper observation unavailable")
  const { root, recorder, rows } = await fixture(t, async () => { throw failure })
  const helper = { launchId: "helper", role: "singleton-lock-helper" }, holder = { launchId: "holder", role: "singleton-lock-holder" }
  const { snapshots } = await durabilityControl(root, async () => assert.rejects(recorder.lock(helper, holder, expected.pid, expected.pid + 1), error => error === failure))
  assert.equal(snapshots.length, 1)
  assert.deepEqual((await rows()).map(row => [row.type, row.launchId]), [["registration-failure", "helper"]])
})

test("singleton lock registration refuses source entry when its durability barrier fails", async t => {
  const failure = new Error("durability unavailable")
  const { root, recorder } = await fixture(t)
  const helper = { launchId: "helper", role: "singleton-lock-helper" }, holder = { launchId: "holder", role: "singleton-lock-holder" }
  let sourceEntered = false
  await durabilityControl(root, async () => {
    await assert.rejects(async () => { await recorder.lock(helper, holder, expected.pid, expected.pid + 1); sourceEntered = true }, error => error === failure)
  }, () => { throw failure })
  assert.equal(sourceEntered, false)
})

test("singleton lock registration preserves observation and durability failures together", async t => {
  const observation = new Error("actual observation unavailable"), durability = new Error("durability unavailable")
  const { root, recorder } = await fixture(t, async () => { throw observation })
  const helper = { launchId: "helper", role: "singleton-lock-helper" }, holder = { launchId: "holder", role: "singleton-lock-holder" }
  await durabilityControl(root, async () => {
    await assert.rejects(recorder.lock(helper, holder, expected.pid, expected.pid + 1), error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.cause, observation)
      assert.deepEqual(error.errors, [observation, durability])
      return true
    })
  }, () => { throw durability })
})

test("singleton startup failure waits for every contender before teardown", async () => {
  const failure = new Error("first startup refused")
  const release = Promise.withResolvers<number>()
  let finished = false
  const starting = settleSingletonStarts([Promise.reject(failure), release.promise])
  const result = starting.then(value => ({ value }), error => ({ error })).finally(() => { finished = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false)
  } finally { release.resolve(2) }
  const outcome = await result
  assert.ok("error" in outcome)
  assert.ok(outcome.error instanceof AggregateError)
  assert.deepEqual(outcome.error.errors, [failure])
  assert.deepEqual(await settleSingletonStarts([Promise.resolve(1), Promise.resolve(2)]), [1, 2])
})