import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { createConnection } from "node:net"
import { once } from "node:events"
import test from "node:test"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { assertRuntime } from "../src/handler/environment.js"
import { receiveStart } from "../src/handler/daemon.js"
import { productionControlDependencies, runControl } from "../src/cli/control.js"
import { inspectHandlerGeneration } from "../src/platform/singleton.js"
import { readHandlerRecord, writeLaunchRecord } from "../src/platform/private-state.js"
import { fixtureRuntime } from "./fixtures/fixture-spawn.js"
import { workerReceiver } from "./fixtures/run-boundary.js"
import { controlFixture, fileExists, until, launch } from "./control-support.js"

test("runtime rejects unsupported Node and platform before production state access", () => {
  assert.throws(() => assertRuntime("23.0.0", "darwin"), /Node 24\.13\.0/)
  assert.throws(() => assertRuntime("24.13.0", "win32"), /unsupported platform/)
  assert.doesNotThrow(() => assertRuntime("24.13.0", "darwin"))
})

test("a failed companion bind rolls back the control socket before publishing readiness", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), path = join(f.paths.runtimeRoot, "attachment.sock")
  await writeFile(path, "preserved", { mode: 0o600 })
  await assert.rejects(f.start())
  assert.notEqual((await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).phase, "ready")
  await until(async () => !await fileExists(f.paths.handlerSocketPath) ? true : undefined)
  assert.equal(await readFile(path, "utf8"), "preserved")
})

test("startup gate accepts fragmented exact token and rejects EOF, invalid bytes and timeout", async () => {
  const gate = new PassThrough(), status = new PassThrough()
  const result = receiveStart(gate, status, 100)
  gate.write("sta"); gate.write("rt\n")
  await result
  for (const kind of ["gate EOF", "status EOF", "invalid", "extra", "timeout"]) {
    const g = new PassThrough(), s = new PassThrough(), pending = receiveStart(g, s, 20)
    if (kind === "gate EOF") g.end()
    if (kind === "status EOF") s.end()
    if (kind === "invalid") g.write("wrong\n")
    if (kind === "extra") g.write("start\nextra")
    await assert.rejects(pending)
    g.destroy(); s.destroy()
  }
  gate.destroy(); status.destroy()
})

test("an ACP bind failure rolls back both existing listeners before readiness", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), path = join(f.paths.runtimeRoot, "acp.sock")
  await writeFile(path, "preserved", { mode: 0o600 })
  await assert.rejects(f.start())
  assert.notEqual((await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).phase, "ready")
  await until(async () => !await fileExists(f.paths.handlerSocketPath) ? true : undefined)
  await until(async () => !await fileExists(join(f.paths.runtimeRoot, "attachment.sock")) ? true : undefined)
  assert.equal(await readFile(path, "utf8"), "preserved")
})

test("daemon starts with empty ownership and leaves retained launch bytes unchanged", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), boot = await f.adapter.bootId()
  const records = [launch({ launchBootId: boot }), launch({ launchBootId: boot, launchAttempted: false, checkoutId: "unattempted" })]
  const paths = records.map(record => join(f.paths.persistentRoot, "launches", record.launchAttemptId + ".json"))
  for (const [index, path] of paths.entries()) await writeLaunchRecord(path, records[index]!)
  const before = await Promise.all(paths.map(path => readFile(path)))
  const started = await f.start(), reply = await f.call()
  assert.equal(started.record.phase, "ready")
  assert.ok(reply.ok && "launches" in reply.result)
  assert.deepEqual(reply.result.launches, [])
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before)
  assert.equal((await f.start()).record.generation, started.record.generation)
})

test("daemon identity claim precedes launcher publication and survives launcher detach", { timeout: 20000 }, async t => {
  const f = await controlFixture(t)
  let verified = false
  const first = await f.start(5000, async transition => {
    if (transition === "identity_verified") { assert.equal((await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).process, null); verified = true }
  })
  assert.ok(verified)
  assert.equal((await f.start()).record.generation, first.record.generation)
  assert.ok((await f.call()).ok)
})

test("malformed and unwritable retained launches do not prevent current readiness or shutdown", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), directory = join(f.paths.persistentRoot, "launches"), path = join(directory, randomUUID() + ".json")
  await writeFile(path, "{", { mode: 0o600 }); await chmod(directory, 0o500)
  try {
    const started = await f.start()
    assert.equal(started.record.phase, "ready")
    const reply = await f.call({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: started.record.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true })
    assert.equal(reply.ok, true)
    assert.equal(await readFile(path, "utf8"), "{")
  } finally { await chmod(directory, 0o700) }
})

test("shutdown requests before readiness have no side effects", { timeout: 20000 }, async t => {
  const f = await controlFixture(t, { pauseAt: "ready" })
  const started = f.start()
  await until(async () => await fileExists(join(f.root, "paused")) ? true : undefined)
  const current = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  const reply = await f.call({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: current.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true })
  assert.ok(!reply.ok)
  assert.equal(reply.error.code, "INCOMPLETE")
  await writeFile(join(f.root, "release"), "release", { mode: 0o600 })
  assert.equal((await started).record.phase, "ready")
})

test("termination before readiness preserves retained history", { timeout: 20000 }, async t => {
  const f = await controlFixture(t, { pauseAt: "ready" })
  const record = launch({ launchBootId: await f.adapter.bootId(), launchAttempted: false })
  const path = join(f.paths.persistentRoot, "launches", `${record.launchAttemptId}.json`)
  await writeLaunchRecord(path, record)
  const started = assert.rejects(f.start())
  await until(async () => await fileExists(join(f.root, "paused")) ? true : undefined)
  await f.signal(f.owned[0]!, "SIGTERM")
  await f.signal(f.owned[0]!, "SIGINT")
  const before = JSON.stringify(record)
  await started
  await until(async () => await f.observe(f.owned[0]!.pid) === null ? true : undefined)
  const child = await until(async () => f.registrations().find(value => value.pid === f.owned[0]!.pid && value.close) ?? undefined)
  assert.deepEqual(child.exit, { code: 70, signal: null })
  assert.equal(JSON.stringify(JSON.parse(await readFile(path, "utf8"))), before)
  assert.notEqual((await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).phase, "ready")
  await assertSocketsAbsent(f)
})

test("production Handler eventually publishes a private generation-bound bridge after readiness", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), handler = await f.start().catch(async error => { throw new Error(await readFile(join(f.root, "failure"), "utf8").catch(() => String(error)), { cause: error }) })
  await until(async () => await lstat(join(f.paths.runtimeRoot, "bridge.sock")).then(stat => stat.isSocket(), () => false) ? true : undefined)
  const peer = await connectHandlerBridge({ root: f.paths.runtimeRoot, hostId: f.paths.hostKey, handlerGeneration: handler.record.generation })
  f.beforeCleanup(async () => { peer.close(); await peer.closed })
  const hello = await peer.ready
  assert.ok(hello.capabilities.includes("runtime-read")); assert.ok(hello.capabilities.includes("runtime-write"))
  assert.equal(hello.capabilities.includes("snapshot"), false)
  const identity = await peer.request("host-identity", {}) as { hostId: string; handlerGeneration: string }
  assert.equal(identity.hostId, f.paths.hostKey)
  assert.equal(identity.handlerGeneration, handler.record.generation)
})

test("malformed legacy settings remain inert and byte-preserved", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), settings = join(f.paths.persistentRoot, "bureau/settings/state.json")
  const content = JSON.stringify({ enabled: "invalid" })
  await mkdir(join(f.paths.persistentRoot, "bureau/settings"), { recursive: true, mode: 0o700 })
  await writeFile(settings, content, { mode: 0o600 })
  const handler = await f.start()
  assert.equal(handler.record.phase, "ready")
  await until(async () => await lstat(join(f.paths.runtimeRoot, "bridge.sock")).then(stat => stat.isSocket(), () => false) ? true : undefined)
  const reply = await f.call()
  assert.ok(reply.ok && "phase" in reply.result)
  assert.equal(reply.result.phase, "ready")
  assert.equal(reply.result.issues?.some(issue => issue.message.includes("BUREAU")), false)
  const output: string[] = []
  assert.equal(await runControl(["doctor", "--json"], { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), inspect: env => inspectHandlerGeneration(env.paths.runtimeRoot, env.adapter), call: (_env, request) => f.call(request), stdout: text => output.push(text) }), 0)
  const diagnostic = JSON.parse(output.join(""))
  assert.deepEqual(diagnostic.result.runtimeIssues ?? [], [])
  assert.equal(await readFile(settings, "utf8"), content)
})

test("control cleanup joins accepted shutdown completing during asynchronous cleanup", { timeout: 20000 }, async t => {
  const f = await controlFixture(t, { pauseAt: "handler-completed" }), started = await f.start()
  const current = started.record
  assert.ok(current.process)
  const reply = await f.call({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: current.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true })
  assert.ok(reply.ok && "state" in reply.result && reply.result.state === "shutdown_accepted")
  await until(async () => await fileExists(join(f.root, "handler-completed")) ? true : undefined)
  assert.equal(await readFile(join(f.root, "handler-completed"), "utf8"), current.generation)
  const { scope } = await fixtureRuntime(), launch = f.registrations().find(value => value.pid === current.process!.pid)!
  assert.equal(launch.exit, null)
  assert.equal(launch.close, false)
  let entered = false, completed = false, signalPreparations = 0
  f.beforeCleanup(async () => { assert.notEqual(await f.observe(current.process!.pid), null); entered = true })
  const complete = async () => {
    assert.equal(entered, true)
    if (completed) return
    completed = true
    await writeFile(join(f.root, "release-completion"), "released during cleanup", { mode: 0o600 })
    await until(async () => scope.snapshot().launches.find(value => value.ref.launchId === launch.ref.launchId)?.close === true ? true : undefined)
  }
  const receiver = await workerReceiver(), prepare = receiver.prepareExit.bind(receiver), readProcess = f.adapter.readProcess.bind(f.adapter)
  t.mock.method(receiver, "prepareExit", async (ref: import("./fixtures/run-scope.js").LaunchRef) => { signalPreparations++; await complete(); await prepare(ref) })
  t.mock.method(f.adapter, "readProcess", async (pid: number) => { if (entered && pid === current.process!.pid) await complete(); return readProcess(pid) })
  await f.cleanup()
  assert.equal(completed, true)
  assert.equal(signalPreparations, 0)
  const final = scope.snapshot().launches.find(value => value.ref.launchId === launch.ref.launchId)!
  assert.deepEqual(final.exit, { code: 0, signal: null })
  assert.equal(final.close, true)
  assert.equal(await f.observe(current.process.pid), null)
  assert.deepEqual(await f.adapter.readGroup(current.process.pid), [])
})

for (const mismatch of ["generation", "identity"] as const) test(`accepted owner cleanup refuses changed Handler ${mismatch}`, { timeout: 20000 }, async t => {
  const f = await controlFixture(t, { pauseAt: "handler-completed" }), started = await f.start(), current = started.record
  assert.ok(current.process)
  const path = join(f.paths.runtimeRoot, "handler.json")
  const reply = await f.call({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: current.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true })
  assert.ok(reply.ok && "state" in reply.result && reply.result.state === "shutdown_accepted")
  await until(async () => await fileExists(join(f.root, "handler-completed")) ? true : undefined)
  const original = await readFile(path), receiver = await workerReceiver()
  let preparations = 0
  t.mock.method(receiver, "prepareExit", async () => { preparations++; throw new Error("changed acceptance attempted signal preparation") })
  try {
    const record = JSON.parse(original.toString())
    if (mismatch === "generation") record.generation = randomUUID()
    else record.process.parentPid++
    await writeFile(path, JSON.stringify(record), { mode: 0o600 })
    await assert.rejects(f.shutdownOwnedHandler({ generation: current.generation, process: current.process }), { code: "ERR_ASSERTION" })
    assert.equal(preparations, 0)
  } finally {
    await writeFile(path, original, { mode: 0o600 })
    await writeFile(join(f.root, "release-completion"), "released after strict refusal", { mode: 0o600 })
  }
  await f.cleanup()
  assert.equal(await f.observe(current.process.pid), null)
  assert.deepEqual(await f.adapter.readGroup(current.process.pid), [])
})

async function assertSocketsAbsent(f: Awaited<ReturnType<typeof controlFixture>>): Promise<void> {
  for (const name of ["handler.sock", "attachment.sock", "bridge.sock", "acp.sock"]) {
    await until(async () => await lstat(join(f.paths.runtimeRoot, name)).then(() => false, error => { if (error.code !== "ENOENT") throw error; return true }) ? true : undefined)
  }
}

async function assertSignalExit(f: Awaited<ReturnType<typeof controlFixture>>, code: number, timeoutMs = 5000): Promise<void> {
  const child = await until(async () => f.registrations().find(value => value.pid === f.owned[0]!.pid && value.close) ?? undefined, timeoutMs)
  assert.deepEqual(child.exit, { code, signal: null })
  await until(async () => await f.observe(f.owned[0]!.pid) === null ? true : undefined)
}

test("signal during catalog initialization drains constructed services without creating agents", { timeout: 20000 }, async t => {
  const f = await controlFixture(t, { terminationFixture: { initializeHold: true } }), started = assert.rejects(f.start())
  await until(async () => await readFile(join(f.root, "termination-events"), "utf8").then(v => v.includes("catalog-initialize") ? true : undefined, () => undefined))
  await f.signal(f.owned[0]!, "SIGTERM")
  await started
  await assertSignalExit(f, 70)
  await assertSocketsAbsent(f)
  const events = await readFile(join(f.root, "termination-events"), "utf8")
  assert.match(events, /catalog-drain/)
  assert.match(events, /catalog-close/)
  assert.doesNotMatch(events, /agents-created/)
})

for (const drain of [undefined, "fail", "hold"] as const) test(`ready signal termination handles catalog drain ${drain ?? "success"}`, { timeout: 25000 }, async t => {
  const f = await controlFixture(t, { terminationFixture: drain ? { drain } : {} })
  await f.start()
  await until(async () => await readFile(join(f.root, "termination-events"), "utf8").then(v => v.includes("tasks-ready") ? true : undefined, () => undefined))
  const before = Date.now()
  await f.signal(f.owned[0]!, "SIGTERM")
  await assertSignalExit(f, drain ? 70 : 0, 18000)
  const elapsed = Date.now() - before
  if (drain === "hold") { assert.ok(elapsed >= 14500); assert.ok(elapsed < 18000) }
  if (drain !== "hold") await assertSocketsAbsent(f)
  const events = await readFile(join(f.root, "termination-events"), "utf8")
  assert.match(events, /catalog-drain/)
  if (drain !== "hold") { assert.match(events, /catalog-close/); assert.match(events, /agents-close/); assert.match(events, /tasks-close/) }
})

for (const taskClose of ["sync", "reject", "hold"] as const) test(`independent daemon closure survives task ${taskClose}`, { timeout: 25000 }, async t => {
  const f = await controlFixture(t, { terminationFixture: { taskClose, endpointCloseReject: true, catalogCloseHold: taskClose !== "hold" } })
  await f.start()
  await until(async () => await readFile(join(f.root, "termination-events"), "utf8").then(v => v.includes("tasks-ready") ? true : undefined, () => undefined))
  const socket = createConnection(f.paths.handlerSocketPath)
  socket.on("error", () => undefined)
  t.after(() => socket.destroy())
  await once(socket, "connect")
  let disconnected = false
  socket.once("close", () => { disconnected = true })
  await f.signal(f.owned[0]!, "SIGTERM")
  await until(async () => disconnected ? true : undefined)
  await until(async () => await readFile(join(f.root, "termination-events"), "utf8").then(v => v.includes("endpoint:attachment.sock") ? true : undefined))
  await assertSocketsAbsent(f)
  assert.notEqual(await f.observe(f.owned[0]!.pid), null)
  const events = await readFile(join(f.root, "termination-events"), "utf8")
  for (const value of ["tasks-close", "catalog-close", "agents-close", "endpoint:handler.sock", "endpoint:bridge.sock", "endpoint:acp.sock"]) assert.ok(events.includes(value), value)
  if (taskClose !== "hold") await writeFile(join(f.root, "release-close"), "release")
  await assertSignalExit(f, 70, 18000)
})

for (const lateTask of ["resolve", "reject"] as const) test(`late task ${lateTask} after explicit daemon closure is observed`, { timeout: 20000 }, async t => {
  const f = await controlFixture(t, { terminationFixture: { lateTask, taskClose: "reject" } })
  const started = await f.start()
  await until(async () => await readFile(join(f.root, "termination-events"), "utf8").then(v => v.includes("tasks-created") ? true : undefined, () => undefined))
  const reply = await f.call({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: started.record.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true })
  assert.equal(reply.ok, true)
  await assertSocketsAbsent(f)
  await writeFile(join(f.root, "release-task"), "release")
  await until(async () => await readFile(join(f.root, "termination-events"), "utf8").then(v => v.includes(lateTask === "resolve" ? "tasks-close" : "task-initialize-rejected") ? true : undefined))
  await assertSignalExit(f, 0)
})

test("signal joins accepted shutdown without treating draining as interrupted startup", { timeout: 20000 }, async t => {
  const f = await controlFixture(t, { terminationFixture: { taskClose: "hold" } })
  const started = await f.start()
  await until(async () => await readFile(join(f.root, "termination-events"), "utf8").then(v => v.includes("tasks-ready") ? true : undefined, () => undefined))
  const reply = await f.call({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: started.record.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true })
  assert.equal(reply.ok, true)
  await until(async () => await readFile(join(f.root, "termination-events"), "utf8").then(v => v.includes("tasks-close") ? true : undefined))
  await f.signal(f.owned[0]!, "SIGTERM")
  await writeFile(join(f.root, "release-task-close"), "release")
  await assertSignalExit(f, 0)
  await assertSocketsAbsent(f)
})