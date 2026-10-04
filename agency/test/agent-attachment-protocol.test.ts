import assert from "node:assert/strict"
import test from "node:test"
import { agentId } from "./agent-support.js"
import { createNdjsonDecoder, parseAttachmentRequest, parseAttachmentFrame, parseSubmissionReceipt } from "../src/agent/attachment-protocol.js"

const load = async () => ({ createNdjsonDecoder, parseAttachmentRequest, parseAttachmentFrame, parseSubmissionReceipt })
const target = { agentId: agentId(1), handlerGeneration: agentId(2), providerGeneration: agentId(3) }
const request = { protocol: "agency-attachment/1", target, requestId: agentId(4), op: "attach" }

test("NDJSON decodes fragmented UTF-8 and bounds individual frames in a coalesced read", async () => {
  const { createNdjsonDecoder } = await load(), received: unknown[] = []
  const decoder = createNdjsonDecoder((value: unknown) => received.push(value), (error: Error) => { throw error })
  const unicode = Buffer.from('{"text":"α"}\n')
  for (const byte of unicode) decoder.feed(Buffer.from([byte]))
  const lines = Array.from({ length: 60 }, () => JSON.stringify({ text: "x".repeat(50000) }) + "\n")
  decoder.feed(Buffer.from(lines.join(""))); decoder.end()
  assert.equal(received.length, 61)
  assert.deepEqual(received[0], { text: "α" })
})

for (const scenario of ["UTF-8", "incomplete", "empty", "invalid JSON", "oversized", "oversized terminated"]) test(`NDJSON rejects ${scenario} once and does not resume decoding`, async () => {
  const { createNdjsonDecoder } = await load(), faults: any[] = [], received: unknown[] = []
  const decoder = createNdjsonDecoder((value: unknown) => received.push(value), (error: unknown) => faults.push(error))
  const bytes = scenario === "UTF-8" ? Buffer.from([255, 10]) : scenario === "incomplete" ? Buffer.from('{"text":') : scenario === "empty" ? Buffer.from("\n") : scenario === "invalid JSON" ? Buffer.from("x\n") : Buffer.from(" ".repeat(2097153) + (scenario === "oversized terminated" ? "\n" : ""))
  decoder.feed(bytes); decoder.end(); decoder.feed(Buffer.from('{}\n')); decoder.end()
  assert.equal(faults.length, 1)
  assert.equal(faults[0].code, "INVALID_PROTOCOL")
  assert.deepEqual(received, [])
})

test("attachment requests preserve exact tuples and prohibit lifecycle and authority operations", async () => {
  const { parseAttachmentRequest } = await load()
  assert.deepEqual(parseAttachmentRequest(request), request)
  for (const op of ["start", "stop", "restore", "terminal", "permission", "set-mode"]) assert.throws(() => parseAttachmentRequest({ ...request, op }), { code: "INVALID_PROTOCOL" })
  for (const value of [{ ...request, environment: { SECRET: "not forwarded" } }, { ...request, target: { ...target, providerGeneration: "bad" } }, { ...request, requestId: "bad" }, { ...request, op: "submit", submissionId: agentId(5), text: "\ud800" }]) assert.throws(() => parseAttachmentRequest(value), { code: "INVALID_PROTOCOL" })
  const submit = { ...request, op: "submit", submissionId: agentId(5), text: "x".repeat(262144) }
  assert.deepEqual(parseAttachmentRequest(submit), submit)
  assert.throws(() => parseAttachmentRequest({ ...submit, text: "x".repeat(262145) }), { code: "INPUT_TOO_LARGE" })
})

test("attachment frames validate event fields, byte counts, bounds, and sanitized failures", async () => {
  const { parseAttachmentFrame } = await load()
  const frame = { protocol: "agency-attachment/1", target, type: "event", firstSeq: 1, historyTruncated: false, event: { kind: "submitted", seq: 1, encodedBytes: 120, submissionId: agentId(5), text: "α\"\n" } }
  assert.deepEqual(parseAttachmentFrame(frame), frame)
  for (const event of [{ ...frame.event, seq: 0 }, { ...frame.event, encodedBytes: -1 }, { ...frame.event, encodedBytes: 1.5 }, { ...frame.event, private: "value" }]) assert.throws(() => parseAttachmentFrame({ ...frame, event }), { code: "INVALID_PROTOCOL" })
  assert.throws(() => parseAttachmentFrame({ ...frame, firstSeq: 3 }), { code: "INVALID_PROTOCOL" })
  assert.throws(() => parseAttachmentFrame({ ...frame, target: { ...target, extra: "value" } }), { code: "INVALID_PROTOCOL" })
  const fault = { protocol: "agency-attachment/1", target, type: "fault", error: { code: "NOT_READY", message: "not ready" } }
  assert.deepEqual(parseAttachmentFrame(fault), fault)
  assert.throws(() => parseAttachmentFrame({ ...fault, error: { code: "NOT_READY", message: "private provider text" } }), { code: "INVALID_PROTOCOL" })
})

test("attachment enum fields reject coercible arrays", async () => {
  const { parseAttachmentFrame, parseSubmissionReceipt } = await load()
  const event = { kind: "turn", seq: 1, encodedBytes: 120, submissionId: agentId(5), state: "completed", stopReason: "cancelled", failure: null }
  const base = { protocol: "agency-attachment/1", target, type: "event", firstSeq: 1, historyTruncated: false }
  assert.throws(() => parseAttachmentFrame({ ...base, event: { ...event, stopReason: ["cancelled"] } }), { code: "INVALID_PROTOCOL" })
  assert.throws(() => parseAttachmentFrame({ ...base, event: { kind: "lifecycle", seq: 1, encodedBytes: 120, phase: ["ready"] } }), { code: "INVALID_PROTOCOL" })
  assert.throws(() => parseSubmissionReceipt({ submissionId: agentId(5), digest: "a".repeat(64), state: ["running"], stopReason: null, failure: null, acceptedSeq: 1, completedSeq: null }), { code: "INVALID_PROTOCOL" })
})

test("faults before target parsing use a null target without inventing a generation", async () => {
  const { parseAttachmentFrame } = await load()
  const frame = { protocol: "agency-attachment/1", target: null, type: "fault", error: { code: "USAGE", message: "usage" } }
  assert.deepEqual(parseAttachmentFrame(frame), frame)
  assert.throws(() => parseAttachmentFrame({ ...frame, target: "unknown" }), { code: "INVALID_PROTOCOL" })
})

test("NDJSON reports complete raw wire bytes including escaping and whitespace", () => {
  const received: unknown[][] = []
  const decoder = createNdjsonDecoder((...args: unknown[]) => { received.push(args) }, error => { throw error })
  decoder.feed(Buffer.from(' {"text":"α"} \n'))
  decoder.end()
  assert.deepEqual(received, [[{ text: "α" }, 16]])
})