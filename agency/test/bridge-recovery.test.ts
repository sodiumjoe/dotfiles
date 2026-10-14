import assert from "node:assert/strict"
import test from "node:test"
import { createRemoteHost } from "../src/bureau/remote-host.js"
import { connectHost } from "../src/bridge/task-ssh.js"
import { bridgeFixture } from "./bridge-support.js"
import { until } from "./control-support.js"

function timers() {
  let now = 100
  const entries: Array<{ delay: number; cancelled: boolean; task(): void }> = []
  return { entries, now: () => now, schedule(delay: number, task: () => void) { const entry = { delay, cancelled: false, task }; entries.push(entry); return () => { entry.cancelled = true } }, fire() { const entry = entries.find(value => !value.cancelled); if (!entry) throw new Error("missing retry"); entry.cancelled = true; now += entry.delay; entry.task(); return entry.delay }, active: () => entries.filter(value => !value.cancelled) }
}

test("managed bridges remain disabled until enabled and reconnect without provider replay", async t => {
  const f = bridgeFixture(t), clock = timers()
  const host = createRemoteHost({ enrollment: f.enrollment, managed: true, connect: () => connectHost(f.enrollment, f.spawn), now: clock.now, random: () => 0.5, schedule: clock.schedule })
  t.after(() => host.close())
  await assert.rejects(host.snapshot(), /HOST_UNAVAILABLE/)
  assert.equal(f.calls.length, 0)
  host.setEnabled(true)
  await until(async () => host.observation().ready ? true : undefined)
  const observed = host.observation()
  assert.equal(observed.observedAt, 100)
  f.processes[0]!.kill()
  await until(async () => clock.active().length === 1 ? true : undefined)
  assert.equal(host.observation().ready, false)
  assert.deepEqual(host.observation().snapshot, observed.snapshot)
  assert.equal(host.observation().observedAt, 100)
  await assert.rejects(host.snapshot(), /HOST_UNAVAILABLE/)
  assert.equal(f.calls.length, 1)
  assert.equal(clock.fire(), 1000)
  await until(async () => host.observation().ready ? true : undefined)
  assert.equal(f.calls.length, 2)
  assert.equal(f.startCount, 0)
  host.setEnabled(false)
  await until(async () => !host.observation().connected ? true : undefined)
  assert.equal(clock.active().length, 0)
  assert.deepEqual(host.observation().snapshot!.agents, observed.snapshot!.agents)
})

test("reconnect backoff is capped and resets after a validated snapshot", async t => {
  const f = bridgeFixture(t), clock = timers()
  let online = false, attempts = 0
  const host = createRemoteHost({ enrollment: f.enrollment, managed: true, now: clock.now, random: () => 0.5, schedule: clock.schedule, async connect() { attempts++; if (!online) throw new Error("BRIDGE_EOF"); return connectHost(f.enrollment, f.spawn) } })
  t.after(() => host.close())
  host.setEnabled(true)
  const delays: number[] = []
  for (let i = 0; i < 8; i++) { await until(async () => clock.active().length ? true : undefined); delays.push(clock.fire()) }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  await until(async () => clock.active().length ? true : undefined)
  online = true; clock.fire()
  await until(async () => host.observation().ready ? true : undefined)
  assert.equal(attempts, 10)
  f.processes.at(-1)!.kill()
  await until(async () => clock.active().length ? true : undefined)
  assert.equal(clock.active()[0]!.delay, 1000)
})

test("disable invalidates a late successful connection before it can become dispatch ready", async t => {
  const f = bridgeFixture(t), clock = timers(), gate = Promise.withResolvers<Awaited<ReturnType<typeof connectHost>>>()
  let attempts = 0
  const host = createRemoteHost({ enrollment: f.enrollment, managed: true, now: clock.now, schedule: clock.schedule, connect() { attempts++; return gate.promise } })
  t.after(() => host.close())
  host.setEnabled(true)
  await until(async () => attempts === 1 ? true : undefined)
  host.setEnabled(false)
  const connection = await connectHost(f.enrollment, f.spawn)
  gate.resolve(connection)
  await connection.closed
  assert.equal(host.observation().enabled, false)
  assert.equal(host.observation().ready, false)
  assert.equal(clock.active().length, 0)
  assert.equal(f.startCount, 0)
})

test("a failed fresh snapshot blocks dispatch while preserving cached observation", async t => {
  const f = bridgeFixture(t), clock = timers()
  const host = createRemoteHost({ enrollment: f.enrollment, managed: true, now: clock.now, schedule: clock.schedule, connect: () => connectHost(f.enrollment, f.spawn) })
  t.after(() => host.close()); host.setEnabled(true)
  await until(async () => host.observation().ready ? true : undefined)
  const observed = host.observation()
  f.retire()
  await assert.rejects(host.snapshot(), /STALE_HANDLER/)
  assert.equal(host.observation().ready, false)
  assert.deepEqual(host.observation().snapshot, observed.snapshot)
  assert.equal(host.observation().observedAt, observed.observedAt)
  assert.equal(f.startCount, 0)
})

test("origin replay does not transfer or acknowledge another Bureau's run", async t => {
  const { randomUUID } = await import("node:crypto"), { canonicalDigest } = await import("../src/orchestration/types.js"), { createRemoteOrigins } = await import("../src/bureau/origins.js"), { privateRoot } = await import("./control-support.js")
  const root = await privateRoot(t), f = bridgeFixture(t), connection = await connectHost(f.enrollment, f.spawn), runId = randomUUID()
  const payload = { commandId: randomUUID(), runId, agent: { hostId: f.enrollment.hostId, agentId: randomUUID() }, execution: { hostId: f.enrollment.hostId, agentId: randomUUID(), handlerGeneration: connection.hello.handlerGeneration, providerGeneration: randomUUID() }, launchAttemptId: randomUUID(), lineage: null, attempt: null, bindingEpoch: randomUUID(), invocationDigest: "a".repeat(64), toolsDigest: "b".repeat(64), settings: {} }
  payload.execution.agentId = payload.agent.agentId
  const kind = "origin-launch", entry = { seq: 1, eventId: payload.commandId, kind, payload, digest: canonicalDigest({ kind, payload }) }
  let transfers = 0, acknowledgments = 0
  f.processes[0]!.peer.onRequest(async channel => {
    if (channel === "snapshot") return { ...connection.snapshot, replayFences: [{ runId, streamId: runId, throughSeq: 1, checkpoint: 0 }] }
    if (channel === "origin-read") { transfers++; return { entries: [entry], checkpoint: 0, lastSeq: 1, nextCursor: 1 } }
    if (channel === "origin-ack") { acknowledgments++; return { acknowledged: true } }
    throw new Error("unexpected request")
  })
  const host = createRemoteHost({ enrollment: f.enrollment, origins: createRemoteOrigins(root, f.enrollment.hostId), ownsRun: async () => false, connect: async () => connection })
  t.after(() => host.close())
  assert.deepEqual((await host.snapshot()).replayFences, [])
  assert.equal(transfers, 0)
  assert.equal(acknowledgments, 0)
})

test("managed side effects wait for a validated initial snapshot", async t => {
  const { randomUUID } = await import("node:crypto")
  const f = bridgeFixture(t), connection = await connectHost(f.enrollment, f.spawn), gate = Promise.withResolvers<void>()
  let dispatches = 0, entered = false
  f.processes[0]!.peer.onRequest(async channel => { if (channel === "snapshot") { entered = true; await gate.promise; return connection.snapshot }; dispatches++; throw new Error("TEST_DISPATCH") })
  const host = createRemoteHost({ enrollment: f.enrollment, managed: true, connect: async () => ({ ...connection, request: async (channel, payload, options) => channel === "stop" ? (dispatches++, Promise.reject(new Error("TEST_DISPATCH"))) : connection.request(channel, payload, options) }) })
  t.after(async () => { gate.resolve(); await host.close() }); host.setEnabled(true)
  await until(async () => entered ? true : undefined)
  const target = { hostId: f.enrollment.hostId, agentId: randomUUID(), handlerGeneration: connection.hello.handlerGeneration, providerGeneration: randomUUID() }
  const pending = host.stop(randomUUID(), target)
  const result = assert.rejects(pending, /TEST_DISPATCH/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(dispatches, 0)
  gate.resolve(); await result
})

test("hostname replacement rejects the changed host without replacing cached identity", async t => {
  const f = bridgeFixture(t), clock = timers()
  let replaced = false
  const host = createRemoteHost({ enrollment: f.enrollment, managed: true, schedule: clock.schedule, random: () => 0.5, async connect() { if (replaced) f.setHost(f.second.hostId); return connectHost(replaced ? f.second : f.enrollment, f.spawn) } })
  t.after(() => host.close()); host.setEnabled(true)
  await until(async () => host.observation().ready ? true : undefined)
  const cached = host.observation().snapshot
  replaced = true; f.processes[0]!.kill()
  await until(async () => clock.active().length ? true : undefined); clock.fire()
  await until(async () => host.observation().error === "HOST_IDENTITY_CHANGED" ? true : undefined)
  assert.deepEqual(host.observation().snapshot, cached)
  assert.equal(host.observation().ready, false)
  assert.equal(f.startCount, 0)
})