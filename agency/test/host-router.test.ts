import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { createHostRouter } from "../src/hosts/router.js"
import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { runtimeNetwork } from "./host-runtime-support.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { connectBridge } from "../src/bridge/ssh.js"
import { BRIDGE_FRAME_BYTES } from "../src/bridge/protocol.js"
import { until } from "./control-support.js"

async function network(t: Parameters<typeof runtimeNetwork>[0]) {
  const f = await runtimeNetwork(t), laptop = await f.add("laptop", "a"), source = await f.add("source", "b"), worker = await f.add("worker", "c")
  let reads = 0, writes = 0
  for (const node of [laptop, source, worker]) node.bridge.register(["runtime-read", "runtime-write"], async ({ channel, payload, context }) => {
    if (channel === "runtime-read") { reads++; return typeof payload === "object" && payload !== null && "fixtureLarge" in payload ? { large: "λ".repeat(BRIDGE_FRAME_BYTES) } : payload }
    writes++
    if (payload === "drop" && context.source === "peer") context.peer.close(new Error("BRIDGE_EOF"))
    return { applied: true }
  })
  laptop.hosts.push(source.enrollment, worker.enrollment)
  return { ...f, laptop, source, worker, reads: () => reads, writes: () => writes }
}

test("neutral transport validates hello without task traffic and permits a concurrent control-only helper", async t => {
  const f = await network(t), first = await f.laptop.connect(f.source.enrollment), second = await f.laptop.connect(f.source.enrollment)
  t.after(() => { first.close(); second.close() })
  assert.equal(first.hello.hostId, f.source.enrollment.hostId)
  assert.deepEqual(f.registrations, [true, false])
  assert.equal(f.requests.includes("snapshot"), false)
  assert.equal(f.requests.includes("coordinate"), false)
  assert.equal(f.requests.includes("replay"), false)
  assert.deepEqual(await second.request("runtime-read", { live: true }), { live: true })
  assert.deepEqual(await second.request("runtime-write", {}), { applied: true })
  second.close()
  assert.deepEqual(await first.request("runtime-read", { first: true }), { first: true })
  assert.equal(f.writes(), 1)
})

test("source relays one large read through the laptop and worker with paging at every hop", async t => {
  const f = await network(t)
  await f.laptop.router.request({ hostId: f.source.enrollment.hostId, channel: "runtime-read", payload: {} })
  const local = await connectHandlerBridge({ root: f.source.root, hostId: f.source.enrollment.hostId, handlerGeneration: f.source.generation })
  t.after(() => local.close())
  const before = f.reads(), result = { large: "λ".repeat(BRIDGE_FRAME_BYTES) }
  const received = await local.request("host-route-read", { hostId: f.worker.enrollment.hostId, channel: "runtime-read", payload: { fixtureLarge: true } })
  assert.deepEqual(received, result)
  assert.equal(f.reads(), before + 1)
  assert.deepEqual(f.connections, ["source", "worker"])
})

test("unknown relay destinations terminate without looping and relay disconnect releases its slot", async t => {
  const f = await network(t)
  await assert.rejects(f.source.router.request({ hostId: "d".repeat(64), channel: "runtime-read", payload: {} }), /HOST_UNAVAILABLE/)
  const first = await f.laptop.connect(f.source.enrollment)
  first.close(); await first.closed
  const next = await until(async () => { const value = await f.laptop.connect(f.source.enrollment); if (f.registrations.at(-1)) return value; value.close(); return undefined })
  t.after(() => next.close())
  next.peer.onRequest(async () => { throw new Error("HOST_UNAVAILABLE") })
  await assert.rejects(f.source.router.request({ hostId: "d".repeat(64), channel: "runtime-read", payload: {} }), /HOST_UNAVAILABLE/)
})

test("a dropped mutation is dispatched once and an explicit read reconnects without replay", async t => {
  const f = await network(t)
  await assert.rejects(f.laptop.router.request({ hostId: f.worker.enrollment.hostId, channel: "runtime-write", payload: "drop" }))
  assert.equal(f.writes(), 1)
  const observation = { commandId: randomUUID() }
  assert.deepEqual(await f.laptop.router.request({ hostId: f.worker.enrollment.hostId, channel: "runtime-read", payload: observation }), observation)
})

test("changed host identity and a restarted owner are rejected before controls", async t => {
  const f = await network(t)
  await assert.rejects(connectBridge({ ...f.worker.enrollment, hostId: "d".repeat(64) }, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read"], processFactory: f.processFactory }), /HOST_IDENTITY_CHANGED/)
  await assert.rejects(connectHandlerBridge({ root: f.worker.root, hostId: f.worker.enrollment.hostId, handlerGeneration: randomUUID() }), /STALE_HANDLER/)
  assert.equal(f.reads(), 0)
  assert.equal(f.writes(), 0)
})

test("bridge version mismatch refuses mutation without a fallback helper", async t => {
  const enrollment = { inventoryId: randomUUID(), hostId: "b".repeat(64), hostname: "legacy", agyPath: "/opt/agy", loginShell: "/bin/sh" }
  let attempts = 0, mutations = 0
  const router = createHostRouter({ hostId: "a".repeat(64), inventory: { list: async () => [enrollment] }, local: async () => { mutations++; return {} }, connect: host => connectBridge(host, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-write"], processFactory: (_file, argv) => {
    attempts++; assert.ok(argv.at(-1)!.includes("internal-runtime-bridge"))
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    stdin.on("data", () => { mutations++ })
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill() { stdin.end(); stdout.end(); return true } })
    queueMicrotask(() => stdout.write(JSON.stringify({ type: "hello", protocol: "agency-bridge/1", connectionId: randomUUID(), hostId: host.hostId, handlerGeneration: randomUUID(), sourceRevision: "a".repeat(40), nodeVersion: "v24.13.0", capabilities: ["runtime-write"], outboxCursor: 0 }) + "\n"))
    return child
  } }) })
  t.after(() => router.close())
  await assert.rejects(router.request({ hostId: enrollment.hostId, channel: "runtime-write", payload: {} }), /UNSUPPORTED_BRIDGE_PROTOCOL/)
  assert.equal(attempts, 1); assert.equal(mutations, 0)
})