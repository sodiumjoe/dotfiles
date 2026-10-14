import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { PassThrough, Writable } from "node:stream"
import { randomUUID } from "node:crypto"
import { parseBridgeFrame, encodeBridgeFrame, BRIDGE_PROTOCOL, type BridgeHello } from "../src/bridge/protocol.js"
import { createBridgePeer, decodeBridgeFrames } from "../src/bridge/codec.js"

const generation = "11111111-1111-4111-8111-111111111111", connectionId = "22222222-2222-4222-8222-222222222222"
const hello: BridgeHello = { protocol: BRIDGE_PROTOCOL, hostId: "a".repeat(64), handlerGeneration: generation, connectionId, sourceRevision: "b".repeat(40), nodeVersion: "v24.13.0", capabilities: ["runtime-read", "runtime-write"] }
function peers(t: TestContext) {
  const left = new PassThrough(), right = new PassThrough()
  const client = createBridgePeer({ input: left, output: right, hello }), remote = createBridgePeer({ input: right, output: left, hello })
  t.after(() => { client.close(); remote.close() })
  return { client, remote, left, right }
}

test("bridge decoder preserves split UTF-8 and coalesced frames", () => {
  const frame = { protocol: BRIDGE_PROTOCOL, connectionId, type: "request" as const, requestId: randomUUID(), channel: "runtime-read", payload: { text: "λ" } }
  const frames: unknown[] = [], decoder = decodeBridgeFrames(frame => frames.push(frame))
  const bytes = encodeBridgeFrame(frame), split = bytes.indexOf(Buffer.from("λ")) + 1
  decoder.push(bytes.subarray(0, split)); assert.equal(frames.length, 0)
  decoder.push(Buffer.concat([bytes.subarray(split), bytes])); decoder.end()
  assert.deepEqual(frames, [frame, frame])
})

test("bridge decoder rejects malformed, oversized and truncated frames", () => {
  for (const bytes of [Buffer.from("{broken}\n"), Buffer.from([0xff, 10]), Buffer.alloc(1024 * 1024 + 1, 97)]) {
    const decoder = decodeBridgeFrames(() => { throw new Error("unexpected frame") })
    assert.throws(() => decoder.push(bytes), /INVALID_BRIDGE|FRAME_TOO_LARGE/)
  }
  const decoder = decodeBridgeFrames(() => {})
  decoder.push(Buffer.from('{"type":'))
  assert.throws(() => decoder.end(), /TRUNCATED_BRIDGE/)
})

test("slow bridge consumers cannot accumulate an unbounded write queue", async t => {
  const input = new PassThrough(), output = new Writable({ write(_bytes, _encoding, _callback) {} })
  const peer = createBridgePeer({ input, output, hello, writeQueueBytes: 256 })
  t.after(() => { peer.close(); input.destroy(); output.destroy() })
  const first = peer.request("runtime-read", {}); void first.catch(() => {})
  await assert.rejects(peer.request("runtime-read", { text: "x".repeat(200) }), /BRIDGE_BACKPRESSURE/)
  peer.close(); await assert.rejects(first, /BRIDGE_CLOSED|BRIDGE_BACKPRESSURE/)
})

test("retired bridge connections reject replies from another connection", async t => {
  const f = peers(t), pending = f.client.request("runtime-read", {}); void pending.catch(() => {})
  f.left.write(encodeBridgeFrame({ protocol: BRIDGE_PROTOCOL, connectionId: randomUUID(), type: "reply", requestId: randomUUID(), ok: true, payload: {} }))
  await assert.rejects(pending, /STALE_CONNECTION/)
})

test("slow inbound requests retain bounded work", async t => {
  const input = new PassThrough(), output = new PassThrough(), gate = Promise.withResolvers<void>()
  const peer = createBridgePeer({ input, output, hello, readQueueBytes: 1024 })
  t.after(() => { gate.resolve(); peer.close(); input.destroy(); output.destroy() })
  let started = 0, aborted = false
  peer.onRequest(async (_channel, _payload, _id, signal) => { started++; signal.addEventListener("abort", () => { aborted = true }); await gate.promise; return {} })
  const frame = () => ({ protocol: BRIDGE_PROTOCOL, connectionId, channel: "runtime-read", type: "request", requestId: randomUUID(), payload: { text: "x".repeat(256) } })
  input.write(encodeBridgeFrame(frame())); await new Promise(resolve => setImmediate(resolve))
  assert.equal(started, 1)
  for (let index = 0; index < 12; index++) input.write(encodeBridgeFrame(frame()))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(started, 1); assert.equal((await peer.closed).message, "BRIDGE_BACKPRESSURE"); assert.equal(aborted, true)
})

test("request detachment aborts the remote waiter without closing shared transport", async t => {
  const f = peers(t), started = Promise.withResolvers<void>(), detached = Promise.withResolvers<void>(), controller = new AbortController()
  f.remote.onRequest(async (channel, _payload, _id, signal) => {
    if (channel === "runtime-read") return { healthy: true }
    started.resolve()
    await new Promise<void>(resolve => { signal.addEventListener("abort", () => { detached.resolve(); resolve() }, { once: true }); if (signal.aborted) resolve() })
    return { detached: true }
  })
  const waiting = f.client.request("tool", { waitId: randomUUID() }, { signal: controller.signal, timeoutMs: 0 })
  await started.promise; controller.abort(new Error("TRANSPORT_DETACHED"))
  await assert.rejects(waiting, /TRANSPORT_DETACHED/)
  await detached.promise
  assert.deepEqual(await f.client.request("runtime-read", {}), { healthy: true })
})

test("bridge v2 refuses legacy protocols and frame families", () => {
  assert.equal(BRIDGE_PROTOCOL, "agency-bridge/2")
  assert.throws(() => parseBridgeFrame({ ...hello, type: "hello", protocol: "agency-bridge/1", outboxCursor: 0 }), /UNSUPPORTED_BRIDGE_PROTOCOL/)
  for (const type of ["event", "ack", "admission_prepare", "admission_result"]) assert.throws(() => parseBridgeFrame({ protocol: BRIDGE_PROTOCOL, connectionId, type }), /INVALID_BRIDGE_FRAME/)
})