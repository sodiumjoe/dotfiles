import assert from "node:assert/strict"
import test from "node:test"
import { agentId } from "./agent-support.js"
import { createConversation } from "../src/agent/conversation.js"

const target = { agentId: agentId(1), handlerGeneration: agentId(2), providerGeneration: agentId(3) }

test("conversation observation captures a value snapshot and the following sequence atomically", async () => {
  const conversation = createConversation(target)
  conversation.append({ kind: "submitted", submissionId: agentId(4), text: "α\"\n" })
  const seen: any[] = []
  const observed = conversation.observe((event: unknown) => seen.push(event))
  const initial = observed.snapshot.events[0]!
  if (initial.kind !== "submitted") throw new Error("wrong event")
  initial.text = "changed"
  observed.snapshot.target.agentId = agentId(9)
  conversation.append({ kind: "turn", submissionId: agentId(4), state: "running", stopReason: null, failure: null })
  const latest = conversation.observe(() => {}).snapshot
  const retained = latest.events[0]!
  if (retained.kind !== "submitted") throw new Error("wrong event")
  assert.equal(retained.text, "α\"\n")
  assert.deepEqual(latest.target, target)
  assert.equal(observed.snapshot.lastSeq, 1)
  assert.equal(seen[0].event.seq, 2)
  const { encodedBytes, ...raw } = latest.events[0]!
  assert.equal(encodedBytes, Buffer.byteLength(JSON.stringify(raw)))
  assert.ok(Buffer.byteLength(JSON.stringify(latest.events[0])) > encodedBytes)
  observed.close()
  conversation.append({ kind: "update", replay: true, update: { sessionUpdate: "usage_update", used: 2, size: 100 } })
  assert.equal(seen.length, 1)
  conversation.close()
})

for (const bound of ["bytes", "events"]) test(`conversation evicts the oldest prefix at its ${bound} bound without resetting sequence`, async () => {
  const conversation = createConversation(target, { bytes: bound === "bytes" ? 600 : 100000, events: bound === "events" ? 2 : 100 })
  const boundaries: number[] = []
  conversation.observe((value: any) => { if (value.kind === "event") boundaries.push(value.firstSeq) })
  for (let i = 0; i < 10; i++) conversation.append({ kind: "submitted", submissionId: agentId(i + 10), text: "x".repeat(100) })
  const snapshot = conversation.observe(() => {}).snapshot
  assert.equal(snapshot.lastSeq, 10)
  assert.equal(snapshot.events.length, 2)
  assert.equal(snapshot.firstSeq, 9)
  assert.equal(snapshot.historyTruncated, true)
  assert.ok(boundaries.every((value, i) => !i || value >= boundaries[i - 1]!))
  conversation.close()
})

test("conversation contains observer mutation and exceptions and releases listeners on close", async () => {
  const conversation = createConversation(target), seen: any[] = []
  conversation.observe((event: any) => { if (event.kind === "event") event.event.text = "corrupt"; throw new Error("observer failed") })
  conversation.observe((event: unknown) => seen.push(event))
  conversation.append({ kind: "submitted", submissionId: agentId(4), text: "original" })
  assert.equal(seen[0].event.text, "original")
  conversation.close()
  assert.equal(seen.at(-1).kind, "closed")
  assert.throws(() => conversation.append({ kind: "submitted", submissionId: agentId(4), text: "late" }), { code: "NOT_READY" })
})

test("compact metadata survives display eviction with bounded title and plan", async () => {
  const conversation = createConversation(target, { events: 1 })
  conversation.append({ kind: "update", replay: true, update: { sessionUpdate: "session_info_update", title: "α".repeat(1000) } })
  conversation.append({ kind: "update", replay: true, update: { sessionUpdate: "plan", entries: Array.from({ length: 32 }, () => ({ content: "x".repeat(2000), priority: "low", status: "pending" })) } })
  conversation.append({ kind: "update", replay: false, update: { sessionUpdate: "usage_update", used: 9, size: 100 } })
  const snapshot = conversation.observe(() => {}).snapshot
  assert.deepEqual(snapshot.metadata.title, { title: "α".repeat(512), titleTruncated: true, titleOriginalBytes: 2000 })
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.metadata)) <= 65536)
  assert.equal(snapshot.metadata.planTruncated, true)
  assert.deepEqual(snapshot.metadata.usage, { used: 9, size: 100 })
  assert.equal(snapshot.events.length, 1)
  conversation.close()
})