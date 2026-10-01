import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import { assertRuntime } from "../src/handler/environment.js"
import { receiveStart } from "../src/handler/daemon.js"
import { readHandlerRecord, writeLaunchRecord } from "../src/platform/private-state.js"
import { controlFixture, fileExists, until, launch } from "./control-support.js"

test("runtime rejects unsupported Node and platform before production state access", () => {
  assert.throws(() => assertRuntime("23.0.0", "darwin"), /Node 24\.13\.0/)
  assert.throws(() => assertRuntime("24.13.0", "win32"), /unsupported platform/)
  assert.doesNotThrow(() => assertRuntime("24.13.0", "darwin"))
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

test("daemon reports every retained classification without adopting a survivor", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), boot = await f.adapter.bootId()
  const ambiguous = launch({ launchBootId: boot }), unattempted = launch({ launchBootId: boot, launchAttempted: false, checkoutId: "unattempted" })
  for (const record of [ambiguous, unattempted]) await writeLaunchRecord(join(f.paths.persistentRoot, "launches", `${record.launchAttemptId}.json`), record)
  const inspection = await f.start()
  assert.equal(inspection.record.phase, "ready")
  const reply = await f.call()
  assert.ok(reply.ok && "launches" in reply.result)
  assert.deepEqual(reply.result.reconciliation, { classified: 2, total: 2, uncertain: 1 })
  assert.equal(reply.result.launches.find(r => r.launchAttemptId === unattempted.launchAttemptId)?.phase, "cleanup_verified")
  assert.equal(reply.result.launches.find(r => r.launchAttemptId === ambiguous.launchAttemptId)?.phase, "quarantined")
  assert.deepEqual((await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).reconciliation, { classified: 2, total: 2, quarantined: 1 })
  assert.equal((await f.start()).record.generation, inspection.record.generation)
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

for (const [phase, mutation] of [["reconciling", "replace"], ["ready", "add"], ["ready", "replace"]] as const) test(`daemon refuses readiness when inventory changes at ${phase}/${mutation}`, { timeout: 20000 }, async t => {
  const f = await controlFixture(t, { mutateAt: phase, mutate: mutation })
  const record = launch({ launchBootId: await f.adapter.bootId(), launchAttempted: false })
  await writeLaunchRecord(join(f.paths.persistentRoot, "launches", `${record.launchAttemptId}.json`), record)
  await assert.rejects(f.start())
  const error = await until(async () => await fileExists(join(f.root, "failure")) ? readFile(join(f.root, "failure"), "utf8") : undefined)
  assert.match(error, /RETAINED_INVENTORY_CHANGED/)
  assert.notEqual((await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).phase, "ready")
})

test("malformed retained evidence appears in status while valid readiness proceeds", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), path = join(f.paths.persistentRoot, "launches", `${randomUUID()}.json`)
  await writeFile(path, "{", { mode: 0o600 })
  const started = await f.start()
  assert.equal(started.record.phase, "ready")
  const reply = await f.call()
  assert.ok(reply.ok && "issues" in reply.result)
  assert.equal(reply.result.issues?.[0]?.path, path)
  assert.equal(await readFile(path, "utf8"), "{")
})

test("shutdown requests during reconciliation have no side effects", { timeout: 20000 }, async t => {
  const f = await controlFixture(t, { pauseAt: "reconciling" })
  const started = f.start()
  await until(async () => await fileExists(join(f.root, "paused")) ? true : undefined)
  const current = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  const reply = await f.call({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: current.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true })
  assert.ok(!reply.ok)
  assert.equal(reply.error.code, "INCOMPLETE")
  await writeFile(join(f.root, "release"), "release", { mode: 0o600 })
  assert.equal((await started).record.phase, "ready")
})

test("termination during classification is deferred until the full inventory is reconciled", { timeout: 20000 }, async t => {
  const f = await controlFixture(t, { pauseAt: "reconciling" })
  const record = launch({ launchBootId: await f.adapter.bootId(), launchAttempted: false })
  const path = join(f.paths.persistentRoot, "launches", `${record.launchAttemptId}.json`)
  await writeLaunchRecord(path, record)
  const started = f.start()
  await until(async () => await fileExists(join(f.root, "paused")) ? true : undefined)
  await f.signal(f.owned[0]!, "SIGTERM")
  await f.signal(f.owned[0]!, "SIGINT")
  assert.notEqual(await f.observe(f.owned[0]!.pid), null)
  assert.equal(JSON.parse(await readFile(path, "utf8")).phase, "launch_pending")
  await writeFile(join(f.root, "release"), "release", { mode: 0o600 })
  await assert.rejects(started)
  await until(async () => await f.observe(f.owned[0]!.pid) === null ? true : undefined)
  assert.equal(JSON.parse(await readFile(path, "utf8")).phase, "cleanup_verified")
})