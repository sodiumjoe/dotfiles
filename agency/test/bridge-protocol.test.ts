import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { PassThrough, Writable } from "node:stream"
import { randomUUID } from "node:crypto"
import { parseBridgeFrame, encodeBridgeFrame, BRIDGE_PROTOCOL, type BridgeHello } from "../src/bridge/protocol.js"
import { createBridgePeer, decodeBridgeFrames } from "../src/bridge/codec.js"
import { canonicalDigest } from "../src/orchestration/types.js"

const generation = "11111111-1111-4111-8111-111111111111", connectionId = "22222222-2222-4222-8222-222222222222"
const hello: BridgeHello = { protocol: BRIDGE_PROTOCOL, hostId: "a".repeat(64), handlerGeneration: generation, connectionId, sourceRevision: "b".repeat(40), nodeVersion: "v24.13.0", capabilities: ["snapshot", "submit"], outboxCursor: 0 }
const target = { hostId: hello.hostId, agentId: "33333333-3333-4333-8333-333333333333", handlerGeneration: generation, providerGeneration: "44444444-4444-4444-8444-444444444444" }
function peers(t: TestContext) {
  const left = new PassThrough(), right = new PassThrough()
  const client = createBridgePeer({ input: left, output: right, hello }), remote = createBridgePeer({ input: right, output: left, hello })
  t.after(() => { client.close(); remote.close() })
  return { client, remote, left, right }
}

test("bridge decoder preserves split UTF-8 and coalesced frames", () => {
  const frame = { protocol: BRIDGE_PROTOCOL, connectionId, type: "request" as const, requestId: randomUUID(), channel: "snapshot", payload: { text: "λ" } }
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

test("bridge parser validates protocol, identity, event digest and sequence", () => {
  assert.deepEqual(parseBridgeFrame({ ...hello, type: "hello" }), { ...hello, type: "hello" })
  for (const value of [{ ...hello, type: "hello", protocol: "agency-bridge/2" }, { ...hello, type: "hello", hostId: "hostname" }, { ...hello, type: "hello", outboxCursor: -1 }]) assert.throws(() => parseBridgeFrame(value))
  const payload = { kind: "report", payload: { status: "completed" } }, base = { protocol: BRIDGE_PROTOCOL, connectionId, type: "event", channel: "origin", streamId: randomUUID(), runId: randomUUID(), hostId: hello.hostId, eventId: randomUUID(), seq: 1, digest: canonicalDigest(payload), payload }
  assert.equal((parseBridgeFrame(base) as any).seq, 1)
  for (const invalid of [{ ...base, seq: 0 }, { ...base, digest: "f".repeat(64) }, { ...base, hostId: "b" }]) assert.throws(() => parseBridgeFrame(invalid))
})

test("duplex admission holds destination dispatch until laptop publication completes", async t => {
  const f = peers(t), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  let dispatched = 0
  f.remote.onRequest(async (channel: string, payload: any, requestId: string) => {
    assert.equal(channel, "submit")
    await f.remote.prepareAdmission(requestId, { execution: payload.target, submissionId: payload.request.submissionId, digest: canonicalDigest({ prompt: payload.request.prompt }) })
    dispatched++; return { state: "accepted" }
  })
  const request = { submissionId: randomUUID(), prompt: [{ type: "text", text: "notification" }] }
  const result = f.client.request("submit", { target, request }, { beforeAccepted: async () => { entered.resolve(); await gate.promise } })
  await entered.promise
  assert.equal(dispatched, 0)
  gate.resolve()
  assert.deepEqual(await result, { state: "accepted" })
  assert.equal(dispatched, 1)
})

test("duplex publication failure admits no destination prompt", async t => {
  const f = peers(t); let dispatched = 0
  f.remote.onRequest(async (_channel: string, payload: any, requestId: string) => { await f.remote.prepareAdmission(requestId, { execution: payload.target, submissionId: payload.request.submissionId, digest: canonicalDigest({ prompt: payload.request.prompt }) }); dispatched++; return {} })
  await assert.rejects(f.client.request("submit", { target, request: { submissionId: randomUUID(), prompt: [] } }, { beforeAccepted: async () => { throw new Error("ENOSPC") } }), /ENOSPC/)
  assert.equal(dispatched, 0)
})

test("EOF before admission confirmation releases the pending destination callback", async t => {
  const f = peers(t), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  let dispatched = 0, released = false
  f.remote.onRequest(async (_channel: string, payload: any, requestId: string) => {
    try { await f.remote.prepareAdmission(requestId, { execution: payload.target, submissionId: payload.request.submissionId, digest: canonicalDigest({ prompt: payload.request.prompt }) }); dispatched++; return {} }
    finally { released = true }
  })
  const pending = f.client.request("submit", { target, request: { submissionId: randomUUID(), prompt: [] } }, { beforeAccepted: async () => { entered.resolve(); await gate.promise } })
  void pending.catch(() => {})
  await entered.promise; f.client.close(); gate.resolve()
  await assert.rejects(pending, /BRIDGE_CLOSED|BRIDGE_EOF/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(dispatched, 0); assert.equal(released, true)
})

test("admission confirmation is bound to its exact execution and prompt digest", async t => {
  const f = peers(t); let published = 0
  f.remote.onRequest(async (_channel: string, payload: any, requestId: string) => {
    await f.remote.prepareAdmission(requestId, { execution: { ...payload.target, providerGeneration: randomUUID() }, submissionId: payload.request.submissionId, digest: "f".repeat(64) }); return {}
  })
  await assert.rejects(f.client.request("submit", { target, request: { submissionId: randomUUID(), prompt: [] } }, { beforeAccepted: async () => { published++ } }), /INVALID_ADMISSION/)
  assert.equal(published, 0)
})

test("slow bridge consumers cannot accumulate an unbounded write queue", async t => {
  const input = new PassThrough(), output = new Writable({ write(_bytes, _encoding, _callback) {} })
  const peer = createBridgePeer({ input, output, hello, writeQueueBytes: 256 })
  t.after(() => { peer.close(); input.destroy(); output.destroy() })
  const first = peer.request("snapshot", {}); void first.catch(() => {})
  await assert.rejects(peer.request("snapshot", { text: "x".repeat(200) }), /BRIDGE_BACKPRESSURE/)
  peer.close(); await assert.rejects(first, /BRIDGE_CLOSED|BRIDGE_BACKPRESSURE/)
})

test("retired bridge connections reject replies from another connection", async t => {
  const f = peers(t), pending = f.client.request("snapshot", {}); void pending.catch(() => {})
  f.left.write(encodeBridgeFrame({ protocol: BRIDGE_PROTOCOL, connectionId: randomUUID(), type: "reply", requestId: randomUUID(), ok: true, payload: {} }))
  await assert.rejects(pending, /STALE_CONNECTION/)
})

test("admission timeout releases the destination without dispatch", async t => {
  const left = new PassThrough(), right = new PassThrough(), remote = createBridgePeer({ input: right, output: left, hello, admissionTimeoutMs: 10 }), client = createBridgePeer({ input: left, output: right, hello })
  t.after(() => { remote.close(); client.close() })
  let dispatched = 0
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  remote.onRequest(async (_channel, payload, requestId) => { const p = payload as any; await remote.prepareAdmission(requestId, { execution: p.target, submissionId: p.request.submissionId, digest: canonicalDigest({ prompt: p.request.prompt }) }); dispatched++; return {} })
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive))
  const pending = client.request("submit", { target, request: { submissionId: randomUUID(), prompt: [] } }, { beforeAccepted: async () => { entered.resolve(); await gate.promise } })
  await entered.promise
  await assert.rejects(pending, /BRIDGE_EOF|ADMISSION_TIMEOUT/); gate.resolve()
  assert.equal(dispatched, 0)
})

test("accepted reply cannot bypass the awaited publication callback", async t => {
  const f = peers(t)
  f.remote.onRequest(async () => ({ state: "accepted" }))
  let published = false
  await assert.rejects(f.client.request("submit", { target, request: { submissionId: randomUUID(), prompt: [] } }, { beforeAccepted: async () => { published = true } }), /INVALID_ADMISSION/)
  assert.equal(published, false)
})

test("a contiguous acknowledgment cursor may advance past an older acknowledged event", () => {
  const frame = { protocol: BRIDGE_PROTOCOL, connectionId, type: "ack", channel: "origin", streamId: randomUUID(), runId: randomUUID(), hostId: hello.hostId, eventId: randomUUID(), seq: 1, digest: "a".repeat(64), cursor: 2 }
  assert.deepEqual(parseBridgeFrame(frame), frame)
})

for (const kind of ["request", "event"] as const) test(`slow inbound ${kind} consumers retain bounded work`, async t => {
  const input = new PassThrough(), output = new PassThrough(), gate = Promise.withResolvers<void>()
  const peer = createBridgePeer({ input, output, hello, readQueueBytes: 1024 })
  t.after(() => { gate.resolve(); peer.close(); input.destroy(); output.destroy() })
  let started = 0, aborted = false
  peer.onRequest(async (_channel, _payload, _id, signal) => { started++; signal.addEventListener("abort", () => { aborted = true }); await gate.promise; return {} })
  peer.subscribe(async () => { started++; await gate.promise })
  const base = { protocol: BRIDGE_PROTOCOL, connectionId, channel: "origin" }
  const payload = { text: "x".repeat(256) }
  const frame = () => kind === "request"
    ? { ...base, type: kind, requestId: randomUUID(), payload }
    : { ...base, type: kind, hostId: hello.hostId, runId: randomUUID(), streamId: randomUUID(), eventId: randomUUID(), seq: 1, digest: canonicalDigest(payload), payload }
  input.write(encodeBridgeFrame(frame()))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(started, 1)
  for (let index = 0; index < 12; index++) input.write(encodeBridgeFrame(frame()))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(started, 1)
  assert.equal((await peer.closed).message, "BRIDGE_BACKPRESSURE")
  if (kind === "request") assert.equal(aborted, true)
})