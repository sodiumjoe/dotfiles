import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { notificationsFixture } from "./bureau-notifications-support.js"
import { until, delay } from "./control-support.js"
import { createBureauService } from "../src/bureau/service.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { createInbox } from "../src/bureau/inbox.js"

async function managedFixture(t: TestContext) {
  const f = await notificationsFixture(t), snapshot = f.host.raw.snapshot
  let enabled = true, unavailable = false, snapshotCalls = 0
  const enableEvents: boolean[] = []
  f.host.raw.hostId = f.parent.hostId
  f.host.raw.setEnabled = value => { enabled = value; enableEvents.push(value) }
  f.host.raw.snapshot = async () => {
    snapshotCalls++
    if (!enabled || unavailable) throw new Error("HOST_UNAVAILABLE")
    return snapshot()
  }
  const controller = new AbortController(), waiting = f.core.wait(f.waitInput, controller.signal)
  void waiting.catch(() => undefined)
  const saved = await until(async () => await f.core.waitRecord(f.waitInput.waitId) ?? undefined)
  controller.abort(); await assert.rejects(waiting, /ABORTED/)
  return { ...f, get core() { return f.core }, saved, enableEvents, get snapshotCalls() { return snapshotCalls }, unavailable(value: boolean) { unavailable = value } }
}

test("disabled recovery retains remote waits without querying disabled adapters", async t => {
  const f = await managedFixture(t)
  await f.core.disable()
  const calls = f.snapshotCalls
  await f.restart()
  assert.equal(f.snapshotCalls, calls)
  assert.deepEqual(await f.core.waitRecord(f.waitInput.waitId), f.saved)
  assert.deepEqual(await f.core.status(), { enabled: false, ready: true, writeAvailable: true })
  await f.core.enable()
  assert.deepEqual(await f.core.waitRecord(f.waitInput.waitId), f.saved)
  assert.equal((await f.core.status()).writeAvailable, true)
  assert.equal(f.host.promptCount, 1)
})

test("reenabling with an unavailable parent retains its wait until observation resumes", async t => {
  const f = await managedFixture(t)
  await f.core.disable(); f.unavailable(true)
  await f.core.enable()
  assert.deepEqual(await f.core.waitRecord(f.waitInput.waitId), f.saved)
  assert.deepEqual(await f.core.status(), { enabled: true, ready: true, writeAvailable: true })
  f.unavailable(false); await f.core.reconcile(); await f.report()
  const result = await f.core.wait(f.waitInput)
  assert.equal(result.kind, "reports")
  assert.equal((await f.core.inbox(f.parent, f.input.runId)).deliveries.length, 1)
  assert.equal(f.host.promptCount, 1)
})

test("parent generation change still cancels a retained wait on enable", async t => {
  const f = await managedFixture(t)
  await f.core.disable(); f.host.retire(); await f.core.enable()
  assert.equal((await f.core.waitRecord(f.waitInput.waitId))!.result!.kind, "cancelled")
  assert.equal(f.host.promptCount, 1)
})

test("failed enable publication leaves managed adapters disabled", async t => {
  const f = await managedFixture(t)
  await f.core.disable()
  f.enableEvents.length = 0
  f.failAt("rename", "/bureau/settings/state.json")
  await assert.rejects(f.core.enable(), /ENOSPC/)
  assert.ok(!f.enableEvents.includes(true))
  assert.equal(await f.store.readEnabled(), false)
  assert.deepEqual(await f.core.waitRecord(f.waitInput.waitId), f.saved)
  assert.equal((await f.core.status()).writeAvailable, false)
  await assert.rejects(f.core.wait(f.waitInput), /BUREAU_UNAVAILABLE/)
  await f.core.enable()
  assert.equal(f.enableEvents.at(-1), true)
})

for (const scenario of ["journaled", "snapshot-only"]) test("invalid " + scenario + " wait blocks adapter enable", async t => {
  const f = await managedFixture(t)
  await f.core.disable(); f.enableEvents.length = 0
  const waitId = scenario === "journaled" ? f.waitInput.waitId : randomUUID()
  await mkdir(join(f.root, "bureau/waits"), { recursive: true })
  await writeFile(join(f.root, "bureau/waits", waitId + ".json"), JSON.stringify({ ...f.saved, input: { ...f.saved.input, waitId }, digest: "0".repeat(64) }))
  await assert.rejects(f.core.enable(), scenario === "journaled" ? /STATE_CHANGED/ : /INVALID_WAIT/)
  assert.ok(!f.enableEvents.includes(true))
  assert.equal(await f.store.readEnabled(), false)
  assert.equal((await f.core.status()).writeAvailable, false)
})

test("binding storage errors remain fatal instead of deferring existing waits", async t => {
  const f = await managedFixture(t)
  await f.core.disable()
  f.host.raw.snapshot = async () => { throw new Error("CORRUPT_ORIGIN") }
  await assert.rejects(f.core.enable(), /CORRUPT_ORIGIN/)
  assert.equal((await f.core.status()).writeAvailable, false)
  await assert.rejects(f.core.wait(f.waitInput), /BUREAU_UNAVAILABLE/)
})

test("disabled recovery and scheduling never inspect retained prompt deliveries", async t => {
  const f = await notificationsFixture(t)
  await f.report()
  const inbox = createInbox({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), failed(error) { throw error } })
  const entry = (await f.store.listInbox())[0]!, target = (await f.host.raw.snapshot()).agents.find(agent => agent.agent.agentId === f.parent.agentId)!.execution!
  await inbox.claim(f.parent, [entry.eventId], target, f.input.runId, f.input.bindingEpoch, "prompt")
  await f.core.disable(); await f.core.close()
  const snapshot = f.host.raw.snapshot
  let calls = 0
  f.host.raw.snapshot = async () => { calls++; return snapshot() }
  const core = createBureauService({ store: f.store, journals: createJournalPool(f.root, f.filesystem, f.clock.now), origins: f.origins, hosts: [f.host.raw], notifications: true })
  f.beforeCleanup(() => core.close())
  await core.initialize()
  await assert.rejects(core.schedule(f.parent), /BUREAU_DISABLED/)
  await delay(30)
  assert.equal(calls, 0)
  assert.equal((await core.inbox(f.parent, f.input.runId)).deliveries[0]!.state, "claimed")
  assert.equal(f.host.promptCount, 1)
})

test("queued reconnect reconciliation respects failed enable storage suspension", async t => {
  const f = await notificationsFixture(t), controller = new AbortController(), waiting = f.core.wait(f.waitInput, controller.signal)
  void waiting.catch(() => undefined)
  const saved = await until(async () => await f.core.waitRecord(f.waitInput.waitId) ?? undefined)
  controller.abort(); await assert.rejects(waiting, /ABORTED/)
  await f.core.disable()
  const report = { ...f.child.attempt.ref, commandId: randomUUID(), execution: f.child.attempt.execution!, report: f.input.report }
  await f.origins.forRun(f.input.runId).append(report.commandId, "report-retained", report)
  const writeWait = f.store.writeWait, snapshot = f.host.raw.snapshot, reconciled = Promise.withResolvers<{ error: unknown }>()
  let failed = false, queued = false
  f.store.writeWait = async (value, previous) => {
    if (value.result && !failed) { failed = true; throw new Error("ENOSPC wait snapshot") }
    return writeWait(value, previous)
  }
  f.host.raw.snapshot = async () => {
    if (!queued) { queued = true; void f.core.reconcile().then(() => reconciled.resolve({ error: null }), error => reconciled.resolve({ error })) }
    return snapshot()
  }
  await assert.rejects(f.core.enable(), /ENOSPC/)
  assert.match(String((await reconciled.promise).error), /BUREAU_UNAVAILABLE/)
  assert.deepEqual(await f.core.waitRecord(f.waitInput.waitId), saved)
  assert.ok((await f.store.listDeliveries()).every(delivery => delivery.state !== "delivered"))
  assert.equal((await f.core.status()).writeAvailable, false)
  assert.equal(f.host.promptCount, 1)
  await f.core.enable()
  const result = await f.core.wait(f.waitInput)
  assert.equal(result.kind, "reports")
  const deliveries = (await f.core.inbox(f.parent, f.input.runId)).deliveries
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]!.state, "delivered")
  assert.equal((await f.core.status()).writeAvailable, true)
  assert.equal(f.host.promptCount, 1)
})

for (const code of ["HOST_IDENTITY_CHANGED", "UNSUPPORTED_RUNTIME"]) test("enable preserves " + code + " before retry backoff", async t => {
  const f = await managedFixture(t)
  await f.core.disable()
  let calls = 0
  f.host.raw.snapshot = async () => { calls++; throw new Error(calls === 1 ? code : "HOST_UNAVAILABLE") }
  await assert.rejects(f.core.enable(), new RegExp(code))
  assert.equal(calls, 1)
  assert.equal((await f.core.status()).writeAvailable, false)
  assert.deepEqual(await f.core.waitRecord(f.waitInput.waitId), f.saved)
  assert.equal(f.host.promptCount, 1)
})