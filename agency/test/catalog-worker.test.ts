import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { EventEmitter } from "node:events"
import { ChildProcess, type spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { PassThrough } from "node:stream"
import { runWorker, type WorkerHost } from "../src/catalog/worker.js"
import { NativeFacade, type DriverContext } from "../src/catalog/drivers/transport.js"
import { spawnOwnedChild } from "../src/runtime/owned-child.js"
import { parseNativeSettlement } from "../src/catalog/worker-protocol.js"
import { observeConfig } from "../src/catalog/config.js"
import type { ProbeRequest, ProbeResult } from "../src/catalog/probes.js"
import { gate, profileFixture } from "./catalog-support.js"

const result: ProbeResult = { models: [], providerVersion: null, providerVersionSource: "unknown" }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function fixture(t: TestContext) {
  const f = await profileFixture(t), evidence = await observeConfig(f.profile)
  const binding = { attemptId: randomUUID(), generation: randomUUID() }
  const request: ProbeRequest = { profile: f.profile, evidence, meta: { version: 2, hostId: "a".repeat(64), commandId: randomUUID(), attemptId: binding.attemptId, handlerGeneration: binding.generation, providerId: f.profile.id, fingerprint: evidence.fingerprint, workPath: f.root } }
  const raw = new ChildProcess(), stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  Object.assign(raw, { pid: 20002, stdin, stdout, stderr })
  const events = new EventEmitter(), sent: any[] = [], held = new Map<string, { promise: Promise<void>; resolve(): void }>()
  const context = gate<DriverContext>(), driver = gate<ProbeResult>(), reached = new Map<string, { promise: Promise<void>; resolve(): void }>()
  let connected = true, finishes = 0, calls = 0, throwSpawn = false, failSend: string | undefined
  const host: WorkerHost = {
    cwd: () => request.meta.workPath, connected: () => connected,
    async send(message: any) { sent.push(message); reached.get(message.type)?.resolve(); await held.get(message.type)?.promise; if (message.type === failSend) throw new Error("send failed") },
    on: (event, listener) => { events.on(event, listener) }, off: (event, listener) => { events.off(event, listener) },
    finish() { finishes++ },
  }
  const operation = runWorker(async value => { context.resolve(value); return driver.promise }, { host, spawn: ((_file, _args, options) => {
    calls++; assert.equal(options?.detached, false); assert.equal(options?.shell, false)
    if (throwSpawn) throw new Error("spawn threw")
    return raw
  }) as typeof spawn })
  const emit = (message: object) => events.emit("message", { ...message, ...binding })
  const stop = () => emit({ type: "stop" })
  const signal = () => events.emit("SIGTERM")
  const exit = () => { raw.emit("exit", 23, null) }
  const close = () => { raw.emit("close", 23, null) }
  const start = async () => { emit({ type: "start", request }); return context.promise }
  const waitMessage = (type: string) => { if (sent.some(message => message.type === type)) return Promise.resolve(); const g = gate(); reached.set(type, g); return g.promise }
  t.after(async () => { stop(); signal(); driver.resolve(result); exit(); close(); for (const g of held.values()) g.resolve(); await operation; for (const stream of [stdin, stdout, stderr]) stream.destroy() })
  return { ...f, request, raw, host, events, sent, operation, start, stop, signal, exit, close, emit, driver, waitMessage, calls: () => calls, finishes: () => finishes, held,
    disconnect() { connected = false; events.emit("disconnect") }, throwSpawn() { throwSpawn = true }, failSend(type: string) { failSend = type }, reports: () => sent.filter(message => message.type === "native-settled") }
}

test("facade consumes cached native exit and close", async () => {
  const raw = Object.assign(new ChildProcess(), { pid: 20002, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  const owner = spawnOwnedChild({ launchAttemptId: randomUUID(), spawn: () => raw })
  raw.emit("exit", 23, null); raw.emit("close", 23, null)
  let cleanups = 0
  const facade = new NativeFacade(owner, Promise.resolve(), () => { cleanups++ })
  await facade.terminal
  assert.deepEqual(await owner.terminal, { kind: "exit", code: 23, signal: null })
  assert.equal(cleanups, 0)
  owner.release()
})

test("bound stop before spawn freezes admission and discards a late driver result", async t => {
  const f = await fixture(t), context = await f.start()
  f.stop(); f.stop()
  assert.throws(() => context.spawnNative(f.profile.executable, []))
  f.driver.resolve(result); f.signal()
  await f.operation
  assert.equal(f.calls(), 0)
  assert.deepEqual(f.reports().map(message => message.native), [{ kind: "not-spawned" }])
  assert.equal(f.sent.some(message => message.type === "result"), false)
  assert.equal(f.finishes(), 1)
  assert.equal(f.events.listenerCount("message"), 0)
})

test("stop waits for admitted driver work even without a native child", async t => {
  const f = await fixture(t); await f.start(); f.stop(); await turn()
  assert.equal(f.finishes(), 0)
  f.driver.resolve(result); f.signal(); await f.operation
  assert.equal(f.finishes(), 1)
})

test("native exit alone cannot finish until actual close and report send callback", async t => {
  const f = await fixture(t), context = await f.start()
  context.spawnNative(f.profile.executable, [])
  const report = gate(); f.held.set("native-settled", report)
  f.exit(); f.stop(); f.driver.resolve(result); await turn()
  assert.equal(f.reports().length, 0); assert.equal(f.finishes(), 0)
  f.close(); await f.waitMessage("native-settled")
  assert.equal(f.finishes(), 0)
  report.resolve(); f.signal(); await f.operation
  assert.deepEqual(f.reports()[0].native, { kind: "exit", pid: 20002, code: 23, signal: null })
  assert.equal(f.finishes(), 1)
})

test("PID-bearing error and close cannot manufacture a native terminal", async t => {
  const f = await fixture(t), context = await f.start()
  context.spawnNative(f.profile.executable, [])
  f.raw.emit("error", new Error("transport")); f.close(); f.driver.resolve(result); await turn()
  assert.equal(f.reports().length, 0); assert.equal(f.finishes(), 0)
  assert.equal(f.sent.some(message => message.type === "native-terminal"), false)
  f.exit(); f.signal(); await f.operation
  assert.equal(f.reports().length, 1)
})

test("actual undefined-PID spawn error requires close before reporting", async t => {
  const f = await fixture(t), context = await f.start()
  Object.assign(f.raw, { pid: undefined }); context.spawnNative(f.profile.executable, [])
  f.raw.emit("error", Object.assign(new Error("spawn"), { code: "ENOENT" })); f.driver.resolve(result); await turn()
  assert.equal(f.reports().length, 0)
  f.close(); f.signal(); await f.operation
  assert.deepEqual(f.reports()[0].native, { kind: "spawn-error" })
})

test("synchronously thrown native invocation remains unknown", async t => {
  const f = await fixture(t), context = await f.start(); f.throwSpawn()
  assert.throws(() => context.spawnNative(f.profile.executable, []))
  f.stop(); f.driver.resolve(result); f.signal(); await f.operation
  assert.equal(f.calls(), 1); assert.equal(f.reports().length, 0)
})

test("cancellation rejects registration-gated writes and ends native stdin", async t => {
  const f = await fixture(t), context = await f.start(), child = context.spawnNative(f.profile.executable, [])
  const written = new Promise<Error | null | undefined>(resolve => child.stdin.write("pending", resolve))
  f.stop(); f.driver.resolve(result)
  assert.ok(await written)
  assert.equal(f.raw.stdin!.writableEnded, true)
  assert.throws(() => context.spawnNative(f.profile.executable, []))
  f.exit(); f.close(); f.signal(); await f.operation
})

for (const mode of ["held", "failed", "disconnect"] as const) test("worker drains native ownership with " + mode + " terminal IPC", async t => {
  const f = await fixture(t), context = await f.start(); context.spawnNative(f.profile.executable, [])
  const terminalSend = gate()
  if (mode !== "disconnect") f.held.set("native-terminal", terminalSend)
  if (mode === "failed") f.failSend("native-terminal")
  if (mode === "disconnect") f.disconnect()
  else { f.stop(); f.signal() }
  f.driver.resolve(result); await turn()
  assert.equal(f.finishes(), 0)
  f.exit(); f.close(); await turn()
  if (mode !== "disconnect") { assert.equal(f.finishes(), 0); terminalSend.resolve() }
  await f.operation
  assert.equal(f.reports().length, mode === "held" ? 1 : 0)
})

test("duplicate start fails protocol admission and cannot duplicate native settlement", async t => {
  const f = await fixture(t); await f.start()
  f.emit({ type: "start", request: f.request }); f.driver.resolve(result); f.signal(); await f.operation
  assert.equal(f.sent.filter(message => message.type === "failure").length, 1)
  assert.equal(f.reports().length, 1)
})

test("foreign stop cannot masquerade as the active binding", async t => {
  const f = await fixture(t); await f.start()
  f.events.emit("message", { type: "stop", attemptId: randomUUID(), generation: f.request.meta.handlerGeneration })
  f.driver.resolve(result); f.signal(); await f.operation
  assert.equal(f.sent.some(message => message.type === "failure"), true)
})

test("native settlement parser refuses extra, malformed and contradictory facts", () => {
  for (const value of [{ kind: "exit", pid: 0, code: 0, signal: null }, { kind: "exit", pid: 2, code: null, signal: "bad" }, { kind: "spawn-error", pid: 2 }, { kind: "not-spawned", code: 0 }, { kind: "close" }]) assert.throws(() => parseNativeSettlement(value))
  assert.deepEqual(parseNativeSettlement({ kind: "exit", pid: 2, code: 23, signal: null }), { kind: "exit", pid: 2, code: 23, signal: null })
})

test("settled worker retains its live leader until platform termination or IPC loss", async t => {
  const f = await fixture(t), context = await f.start()
  context.spawnNative(f.profile.executable, [])
  f.exit(); f.close(); f.stop(); f.driver.resolve(result)
  await f.waitMessage("native-settled"); await turn()
  assert.equal(f.finishes(), 0)
  f.signal(); await f.operation
  assert.equal(f.finishes(), 1)
  assert.deepEqual(f.reports()[0].native, { kind: "exit", pid: 20002, code: 23, signal: null })
})