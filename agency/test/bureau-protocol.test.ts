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