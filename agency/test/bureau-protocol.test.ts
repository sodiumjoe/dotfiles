import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { BUREAU_PROTOCOL, parseBureauRequest } from "../src/bureau/protocol.js"

test("Bureau requests bind an exact Handler and reject unknown operations and fields", () => {
  const request = { protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: randomUUID(), op: "bureau_status" }
  assert.deepEqual(parseBureauRequest(request), request)
  for (const raw of [{ ...request, parent: {} }, { ...request, op: "destroy" }, { ...request, handlerGeneration: "current" }]) assert.throws(() => parseBureauRequest(raw))
})

test("Bureau mutation IDs are UUIDs independent of transport request IDs", () => {
  const request = { protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: randomUUID(), op: "run_cancel", commandId: randomUUID(), runId: randomUUID() }
  assert.deepEqual(parseBureauRequest(request), request)
  assert.throws(() => parseBureauRequest({ ...request, commandId: undefined }))
  assert.throws(() => parseBureauRequest({ ...request, commandId: "1" }))
})

test("human recovery requests carry exact report sources or the original stop command", () => {
  const base = { protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: randomUUID(), commandId: randomUUID(), runId: randomUUID() }
  const source = { eventId: randomUUID(), seq: 1, digest: "a".repeat(64) }
  const ack = { ...base, op: "report_acknowledge", sources: [source] }
  assert.deepEqual(parseBureauRequest(ack), ack)
  assert.throws(() => parseBureauRequest({ ...ack, sources: [{ ...source, digest: "wrong" }] }))
  assert.throws(() => parseBureauRequest({ ...ack, sender: {} }))
  const stop = { ...base, op: "stop_recover" }
  assert.deepEqual(parseBureauRequest(stop), stop)
  assert.throws(() => parseBureauRequest({ ...stop, target: {} }))
})