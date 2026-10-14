import assert from "node:assert/strict"
import test from "node:test"
import { PassThrough } from "node:stream"
import { randomUUID } from "node:crypto"
import { createPagedReads, requestBridgeRead } from "../src/bridge/paging.js"
import { createBridgePeer } from "../src/bridge/codec.js"
import { BRIDGE_FRAME_BYTES, BRIDGE_PROTOCOL } from "../src/bridge/protocol.js"

test("paged reads preserve one capture and bounded frames across concurrent transfers", async t => {
  const left = new PassThrough(), right = new PassThrough(), hello = { protocol: BRIDGE_PROTOCOL as typeof BRIDGE_PROTOCOL, hostId: "a".repeat(64), handlerGeneration: randomUUID(), connectionId: randomUUID(), sourceRevision: "b".repeat(40), nodeVersion: "v24.13.0", capabilities: ["read-pages"] }
  const client = createBridgePeer({ input: left, output: right, hello }), remote = createBridgePeer({ input: right, output: left, hello })
  let captures = 0, largest = 0
  left.on("data", bytes => { largest = Math.max(largest, bytes.length) })
  const reads = createPagedReads(async () => ({ capture: ++captures, history: Array.from({ length: 40 }, () => "λ".repeat(65536)) }))
  remote.onRequest((channel, payload, _id, signal) => reads.request(channel, payload, signal))
  t.after(() => { reads.close(); client.close(); remote.close() })
  const results = await Promise.all([requestBridgeRead(client, "runtime-read", {}), requestBridgeRead(client, "runtime-read", {})]) as Array<{ capture: number; history: string[] }>
  assert.deepEqual(results.map(value => value.capture).sort(), [1, 2])
  for (const result of results) assert.deepEqual(result.history, Array.from({ length: 40 }, () => "λ".repeat(65536)))
  assert.equal(captures, 2)
  assert.ok(largest < BRIDGE_FRAME_BYTES)
})

test("paged read cursors reject mixing captures and permit exact page retry", async () => {
  const reads = createPagedReads(async () => ({ history: "x".repeat(2 * BRIDGE_FRAME_BYTES) })), signal = new AbortController().signal
  try {
    const first = await reads.request("read-open", { channel: "runtime-read", payload: {} }, signal) as { transferId: string; index: number }
    assert.deepEqual(await reads.request("read-page", { transferId: first.transferId, index: 0 }, signal), first)
    await assert.rejects(reads.request("read-page", { transferId: randomUUID(), index: 1 }, signal), /INVALID_READ_CURSOR/)
    await assert.rejects(reads.request("read-page", { transferId: first.transferId, index: 2 }, signal), /INVALID_READ_CURSOR/)
    await reads.request("read-close", { transferId: first.transferId }, signal)
    await assert.rejects(reads.request("read-page", { transferId: first.transferId, index: 1 }, signal), /INVALID_READ_CURSOR/)
    await assert.rejects(reads.request("read-open", { channel: "stop", payload: {} }, signal), /UNSUPPORTED_CAPABILITY/)
  } finally { reads.close() }
})

test("unfinished read captures remain bounded and closing one releases its slot", async () => {
  const reads = createPagedReads(async () => ({ history: "x".repeat(2 * BRIDGE_FRAME_BYTES) })), signal = new AbortController().signal
  try {
    const captures = []
    for (let index = 0; index < 4; index++) captures.push(await reads.request("read-open", { channel: "runtime-read", payload: {} }, signal) as { transferId: string })
    await assert.rejects(reads.request("read-open", { channel: "runtime-read", payload: {} }, signal), /BRIDGE_BACKPRESSURE/)
    await reads.request("read-close", { transferId: captures[0]!.transferId }, signal)
    assert.ok((await reads.request("read-open", { channel: "runtime-read", payload: {} }, signal) as { transferId: string }).transferId)
  } finally { reads.close() }
})

test("paged read receiver rejects a changed capture or invalid final digest", async t => {
  for (const change of ["capture", "digest"]) {
    const left = new PassThrough(), right = new PassThrough(), hello = { protocol: BRIDGE_PROTOCOL as typeof BRIDGE_PROTOCOL, hostId: "a".repeat(64), handlerGeneration: randomUUID(), connectionId: randomUUID(), sourceRevision: "b".repeat(40), nodeVersion: "v24.13.0", capabilities: ["read-pages"] }
    const client = createBridgePeer({ input: left, output: right, hello }), remote = createBridgePeer({ input: right, output: left, hello }), transferId = randomUUID()
    t.after(() => { client.close(); remote.close() })
    remote.onRequest(async channel => channel === "read-close" ? { closed: true } : channel === "read-open" ? { transferId, index: 0, data: Buffer.from('{"x":').toString("base64"), done: false, digest: null } : { transferId: change === "capture" ? randomUUID() : transferId, index: 1, data: Buffer.from('1}').toString("base64"), done: true, digest: "a".repeat(64) })
    await assert.rejects(requestBridgeRead(client, "runtime-read", {}), /INVALID_READ_PAGE/)
    assert.deepEqual(await client.request("read-close", { transferId }), { closed: true })
  }
})
test("task paging accepts reads, rejects writes, and cancellation bounds cleanup", async t => {
  const left = new PassThrough(), right = new PassThrough(), hello = { protocol: BRIDGE_PROTOCOL as typeof BRIDGE_PROTOCOL, hostId: "a".repeat(64), handlerGeneration: randomUUID(), connectionId: randomUUID(), sourceRevision: "b".repeat(40), nodeVersion: "v24.13.0", capabilities: ["read-pages"] }
  const client = createBridgePeer({ input: left, output: right, hello }), remote = createBridgePeer({ input: right, output: left, hello })
  const reads = createPagedReads(async () => ({ report: "retained" })), controller = new AbortController(), closing = Promise.withResolvers<void>()
  remote.onRequest(async (channel, payload, _id, signal) => { if (channel === "read-close") { closing.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return {} }; return reads.request(channel, payload, signal) })
  t.after(() => { reads.close(); client.close(); remote.close() })
  for (const channel of ["task-write", "create", "report"]) await assert.rejects(client.request("read-open", { channel, payload: {} }), /UNSUPPORTED_CAPABILITY/)
  const result = requestBridgeRead(client, "task-read", {}, { signal: controller.signal })
  await closing.promise; controller.abort()
  const bounded = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve("cleanup hung"), 100))])
  assert.deepEqual(bounded, { report: "retained" })
})