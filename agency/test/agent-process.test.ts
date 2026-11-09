import assert from "node:assert/strict"
import test from "node:test"
import { queryObjects } from "node:v8"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess, spawn } from "node:child_process"
import { createAgentProcess, type OwnedAgentProcess } from "../src/agent/process.js"
import { MutationQueue } from "../src/handler/mutations.js"
import type { LaunchContext } from "../src/handler/launch-transitions.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import type { PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"
import { sampleSpec, sampleContract } from "./agent-support.js"

class NativeStartupInput { [key: string]: string; marker = "native startup input" }

async function fixture(t: test.TestContext, options: { holdPreparation?: boolean; loseCapture?: boolean; expireOnRelease?: boolean; failPublication?: boolean; holdReadiness?: boolean; trackInputs?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-process-"))), spec = sampleSpec({ cwd: root }), contract = sampleContract()
  await mkdir(join(root, "launches"), { mode: 0o700 })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), readiness = Promise.withResolvers<void>()
  let time = 0, live = true, spawnCount = 0, failPublication = options.failPublication, expired = false
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, unref() { if (options.expireOnRelease && !expired) { expired = true; time = 9000 } } }) as unknown as ChildProcess
  const identity: ProcessIdentity = { bootId: "boot-a", pid: 12345, birth: "100:agy-provider:" + spec.launchAttemptId, parentPid: process.pid, processGroupId: 12345, sessionId: 12345, uid: process.getuid!(), gid: process.getgid!() }
  const signals: NodeJS.Signals[] = []
  const adapter: PlatformAdapter = { platform: "linux", bootId: async () => "boot-a", readProcess: async () => live ? { ...identity, ...(options.loseCapture ? { birth: "100:wrong" } : {}) } : null, readGroup: async () => live ? [identity] : [], signalGroup: async (pid, signal) => {
    assert.equal(pid, 12345); signals.push(signal); live = false; Object.assign(child, { exitCode: 0 }); child.emit("exit", 0, null); child.emit("close", 0, null)
  } }
  child.stdin!.on("data", bytes => {
    const frame = JSON.parse(bytes.toString())
    const result = frame.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { loadSession: true } } : frame.method === "session/load" ? { configOptions: [] } : {}
    if (frame.id !== undefined) child.stdout!.push(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n")
  })
  const context: LaunchContext = { paths: { hostKey: spec.hostId, persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "handler.sock") }, adapter, state: { hostId: spec.hostId, handlerGeneration: spec.handlerGeneration, phase: "ready", reconciliation: { classified: 0, total: 0, uncertain: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] }, mutations: { queue: new MutationQueue(), accepted: [] }, shutdownPending: () => false }
  const owner = createAgentProcess({ context, spec, contract, environment: {}, session: { kind: "load", sessionId: "fixture-session", params: options.trackInputs ? { input: new NativeStartupInput() } : {} }, async revalidate() { entered.resolve(); if (options.holdPreparation) await release.promise } }, { now: () => time, spawn: (() => { spawnCount++; return child }) as typeof spawn, transitionIO: { read: readLaunchRecordForReconciliation, async publish(path, record) {
    if (failPublication && record.phase === "cleanup_pending") { failPublication = false; throw new Error("publication failed") }
    await writeLaunchRecord(path, record)
    if (options.holdReadiness && record.phase === "readiness") { readiness.resolve(); await release.promise }
  } } })
  t.after(async () => { release.resolve(); owner.dispose(); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); await rm(root, { recursive: true, force: true }) })
  const discharge = () => { const promise = (owner as OwnedAgentProcess & { discharged: Promise<void> }).discharged; assert.ok(promise instanceof Promise); return promise }
  return { owner, entered: entered.promise, readiness: readiness.promise, release: () => release.resolve(), signals, discharge, spawnCount: () => spawnCount }
}

test("never-spawned discharge waits for preparation to settle and prevents a later spawn", async t => {
  const f = await fixture(t, { holdPreparation: true })
  const initialized = f.owner.initialize(new AbortController().signal).catch(error => error)
  await f.entered
  let discharged = false
  void f.discharge().then(() => { discharged = true })
  const cleanup = f.owner.cleanup()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(discharged, false); assert.equal(f.spawnCount(), 0)
  f.release()
  await cleanup; await initialized; await f.discharge()
  assert.equal(f.spawnCount(), 0)
})

test("failed capture never reports discharge even after disposal", async t => {
  const f = await fixture(t, { loseCapture: true })
  await assert.rejects(f.owner.initialize(new AbortController().signal))
  let discharged = false
  void f.discharge().then(() => { discharged = true })
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  f.owner.dispose(); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(discharged, false); assert.deepEqual(f.signals, [])
})

test("retry announces cached discharge after the first evidence deadline check fails", async t => {
  const f = await fixture(t, { expireOnRelease: true })
  await f.owner.initialize(new AbortController().signal)
  let discharged = false
  void f.discharge().then(() => { discharged = true })
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.equal(discharged, false); assert.deepEqual(f.signals, ["SIGTERM"])
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  await f.discharge()
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("disposed native state stays inaccessible while launch publication can retry", async t => {
  const f = await fixture(t, { failPublication: true })
  await f.owner.initialize(new AbortController().signal)
  assert.deepEqual(f.owner.snapshot().configOptions, [])
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  f.owner.dispose()
  assert.throws(() => f.owner.snapshot(), { code: "NOT_READY" })
  await assert.rejects(f.owner.initialize(new AbortController().signal), { code: "NOT_READY" })
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("cleanup during captured preparation prevents late initialization from restoring native state", async t => {
  const f = await fixture(t, { holdReadiness: true })
  const initialized = f.owner.initialize(new AbortController().signal).catch(error => error)
  await f.readiness
  const cleanup = f.owner.cleanup()
  await f.discharge()
  f.owner.dispose()
  f.release()
  assert.equal((await initialized).code, "STARTUP_FAILED")
  assert.equal((await cleanup).phase, "cleanup_verified")
  assert.throws(() => f.owner.snapshot(), { code: "NOT_READY" })
  await assert.rejects(f.owner.initialize(new AbortController().signal), { code: "NOT_READY" })
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("disposed process callbacks do not retain native startup inputs", async t => {
  const f = await fixture(t, { trackInputs: true, failPublication: true, holdReadiness: true })
  const initialized = f.owner.initialize(new AbortController().signal)
  await f.readiness
  assert.equal(queryObjects(NativeStartupInput, { format: "count" }), 1)
  f.release(); await initialized
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  f.owner.dispose()
  assert.equal(queryObjects(NativeStartupInput, { format: "count" }), 0)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.deepEqual(f.signals, ["SIGTERM"])
})