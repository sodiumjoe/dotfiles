import assert from "node:assert/strict"
import { encodeWireJson, parseWireJson } from "../src/acp/wire-json.js"
import test from "node:test"
import { readFileSync } from "node:fs"
import { validateNativeUpdate, validateSessionUpdate } from "../src/agent/session-events.js"
import { agentId } from "./agent-support.js"
import { createConversation } from "../src/agent/conversation.js"

const target = { agentId: agentId(1), handlerGeneration: agentId(2), providerGeneration: agentId(3) }

for (const replay of [false, true]) test(`nullable optional updates retain title and valid content with replay=${replay}`, () => {
  const updates: unknown[] = JSON.parse(readFileSync(new URL("../../../tests/fixtures/agency-nullable-updates.json", import.meta.url), "utf8"))
  const conversation = createConversation(target)
  for (const raw of updates) {
    const update = validateSessionUpdate(raw)
    conversation.append({ kind: "update", replay, update })
    assert.equal(conversation.observe(() => {}).snapshot.metadata.title?.title, "retained title")
  }
  const snapshot = conversation.observe(() => {}).snapshot
  assert.equal(snapshot.events.length, 5)
  assert.deepEqual(snapshot.events[4], { kind: "update", replay, update: updates[4], seq: 5,
    encodedBytes: Buffer.byteLength(JSON.stringify({ kind: "update", replay, update: updates[4], seq: 5 })) })
  conversation.close()
})

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

test("usage cost extensions remain in history without overflowing compact metadata", () => {
  const conversation = createConversation(target), seen: unknown[] = []
  const update = validateNativeUpdate({ sessionUpdate: "usage_update", used: 9, size: 100, cost: { amount: 1.25, currency: "USD", _meta: { detail: "x".repeat(70000) } } })
  conversation.observe(notification => seen.push(notification))
  conversation.append({ kind: "update", replay: false, update })
  const snapshot = conversation.observe(() => {}).snapshot
  assert.deepEqual(snapshot.metadata.usage, { used: 9, size: 100, cost: { amount: 1.25, currency: "USD" } })
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.metadata)) <= 65536)
  assert.equal(snapshot.events.length, 1)
  assert.equal(seen.length, 1)
  assert.deepEqual(snapshot.events[0]?.kind === "update" && snapshot.events[0].update, update)
  conversation.close()
})

test("compact usage currency is bounded without rejecting the native update", () => {
  const conversation = createConversation(target)
  const update = validateNativeUpdate({ sessionUpdate: "usage_update", used: 9, size: 100, cost: { amount: 1.25, currency: "x".repeat(70000) } })
  conversation.append({ kind: "update", replay: false, update })
  const snapshot = conversation.observe(() => {}).snapshot
  assert.deepEqual(snapshot.metadata.usage, { used: 9, size: 100, cost: { amount: 1.25, currency: "x".repeat(1024) } })
  assert.deepEqual(snapshot.events[0]?.kind === "update" && snapshot.events[0].update, update)
  conversation.close()
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

test("first request supplies a stable title until the provider supplies one", () => {
  const conversation = createConversation(target, { events: 1 })
  conversation.append({ kind: "submitted", submissionId: agentId(4), text: "  Fix\n the picker layout\t after restarting  " })
  assert.equal(conversation.observe(() => {}).snapshot.metadata.title?.title, "Fix the picker layout after restarting")
  conversation.append({ kind: "submitted", submissionId: agentId(5), text: "A different follow-up" })
  assert.equal(conversation.observe(() => {}).snapshot.metadata.title?.title, "Fix the picker layout after restarting")
  conversation.append({ kind: "update", replay: false, update: { sessionUpdate: "session_info_update", title: "Repair agent picker" } })
  assert.equal(conversation.observe(() => {}).snapshot.metadata.title?.title, "Repair agent picker")
  conversation.append({ kind: "update", replay: false, update: { sessionUpdate: "session_info_update", title: " " } })
  assert.equal(conversation.observe(() => {}).snapshot.metadata.title?.title, "Repair agent picker")
  conversation.close()
})

test("restored user history supplies a title without submitting another request", () => {
  const conversation = createConversation(target)
  conversation.append({ kind: "update", replay: true, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Investigate session persistence" } } })
  assert.equal(conversation.observe(() => {}).snapshot.metadata.title?.title, "Investigate session persistence")
  conversation.close()
})

test("inventory display normalizes provider titles and reports turn activity without copying history", () => {
  const conversation = createConversation(target)
  assert.deepEqual(conversation.display(), { title: null, activity: "idle" })
  conversation.append({ kind: "submitted", submissionId: agentId(4), text: "Fix the picker" })
  assert.deepEqual(conversation.display(), { title: "Fix the picker", activity: "working" })
  conversation.append({ kind: "update", replay: false, update: { sessionUpdate: "session_info_update", title: "Picker\n\t repair\u0000" } })
  assert.equal(conversation.display().title, "Picker repair")
  conversation.append({ kind: "turn", submissionId: agentId(4), state: "completed", stopReason: "end_turn", failure: null })
  assert.deepEqual(conversation.display(), { title: "Picker repair", activity: "idle" })
  const display = conversation.display(); display.title = "changed"
  assert.equal(conversation.display().title, "Picker repair")
  conversation.close()
})

test("conversation retention and fanout preserve unread opaque payloads", t => {
  const update = parseWireJson('{"sessionUpdate":"tool_call_update","toolCallId":"tool","rawOutput":{"text":"opaque-retained:' + "x".repeat(2 * 1024 * 1024) + '"},"content":[{"type":"content","content":{"type":"text","text":"opaque-retained:content"}}]}')
  const conversation = createConversation(target), forwarded: string[] = []
  conversation.observe(value => { if (value.kind === "event") forwarded.push(encodeWireJson(value.event)) })
  conversation.observe(value => { if (value.kind === "event") forwarded.push(encodeWireJson(value.event)) })
  const parse = t.mock.method(JSON, "parse")
  conversation.append({ kind: "update", replay: false, update: update as any })
  const snapshot = conversation.observe(() => {}).snapshot
  assert.equal(forwarded.length, 2)
  assert.equal(forwarded[0], forwarded[1])
  assert.strictEqual(snapshot.events[0]!.kind === "update" && snapshot.events[0]!.update, update)
  assert.ok(parse.mock.calls.every(call => !String(call.arguments[0]).includes("opaque-retained:")))
  conversation.close()
})

test("a wire event exceeding retained history still reaches live subscribers", () => {
  const conversation = createConversation(target, { bytes: 1024 }), seen: any[] = []
  conversation.observe(value => { if (value.kind === "event") seen.push(value.event) })
  const update = parseWireJson('{"sessionUpdate":"tool_call_update","toolCallId":"tool","rawOutput":"' + "x".repeat(1048577) + '"}')
  conversation.append({ kind: "update", replay: false, update: update as any })
  const snapshot = conversation.observe(() => {}).snapshot
  assert.equal(seen.length, 1)
  assert.equal(encodeWireJson(seen[0].update), encodeWireJson(update))
  assert.equal(snapshot.events.length, 0)
  assert.equal(snapshot.historyTruncated, true)
  conversation.close()
})