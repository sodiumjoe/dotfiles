import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test, { type TestContext } from "node:test"
import { createConversation, type Conversation } from "../src/agent/conversation.js"
import { createTurnCoordinator } from "../src/agent/turns.js"
import { LEGACY_TURN_LIMITS } from "../src/agent/session-events.js"
import { ProviderRequestError } from "../src/agent/types.js"
import type { JsonObject } from "../src/agent/session-config.js"

function fixture(t: TestContext, history: { events?: number } = {}) {
  const target = { agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: randomUUID() }
  const source = createConversation(target, history), calls: JsonObject[] = [], pending: ReturnType<typeof Promise.withResolvers<JsonObject>>[] = []
  const started = Promise.withResolvers<void>()
  let observers = 0, cancellations = 0
  const conversation: Conversation = { ...source, observe(listener) {
    const observation = source.observe(listener)
    let closed = false
    observers++
    return { snapshot: observation.snapshot, close() { if (closed) return; closed = true; observers--; observation.close() } }
  } }
  const turns = createTurnCoordinator({ target, conversation, validate: async () => {}, invokeAcp: async params => {
    calls.push(structuredClone(params))
    const completion = Promise.withResolvers<JsonObject>()
    pending.push(completion); started.resolve()
    return completion.promise
  }, cancel: async () => { cancellations++ } })
  t.after(() => { turns.close(null); source.close() })
  const emit = (value: string, replay = false) => source.append({ kind: "update", replay, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } })
  return { turns, conversation, calls, pending, emit, started: started.promise, observers: () => observers, cancellations: () => cancellations,
    text: (submissionId: string = randomUUID(), text = "hello", outputBytes = 5) => turns.submit({ submissionId, text, limits: { ...LEGACY_TURN_LIMITS, outputBytes } }),
    native: (submissionId: string = randomUUID(), text = "hello") => turns.submitAcp({ submissionId, prompt: [{ type: "text", text }] }),
  }
}

test("text submissions project bounded Unicode from native ACP execution", async t => {
  const f = fixture(t), receipt = await f.text(), projected = f.turns.settled(receipt.submissionId)
  await f.started
  assert.deepEqual(f.calls, [{ prompt: [{ type: "text", text: "hello" }] }])
  f.emit("a🙂é")
  f.pending[0]!.resolve({ stopReason: "end_turn", fixture: { preserved: true } })
  assert.deepEqual(await projected, { stopReason: "end_turn", text: "a🙂" })
  assert.deepEqual(await f.turns.settledAcp(receipt.submissionId), { stopReason: "end_turn", fixture: { preserved: true } })
  assert.equal(f.observers(), 0)
})

test("projection handles independent well-formed chunks and ignores replay and other content", async t => {
  const f = fixture(t), receipt = await f.text(undefined, "hello", 4), projected = f.turns.settled(receipt.submissionId)
  await f.started
  f.emit("old answer", true)
  for (const sessionUpdate of ["agent_thought_chunk", "user_message_chunk"]) f.conversation.append({ kind: "update", replay: false, update: { sessionUpdate, content: { type: "text", text: "excluded" } } })
  f.conversation.append({ kind: "update", replay: false, update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "eA==", mimeType: "image/png" } } })
  f.emit("é"); f.emit("🙂"); f.emit("é")
  f.pending[0]!.resolve({ stopReason: "max_tokens" })
  assert.deepEqual(await projected, { stopReason: "max_tokens", text: "éé" })
})

test("completed text inspection applies the same UTF-8 byte cap", async t => {
  const f = fixture(t), receipt = await f.text(), projected = f.turns.settled(receipt.submissionId)
  await f.started; f.emit("a🙂é"); f.pending[0]!.resolve({ stopReason: "end_turn" }); await projected
  assert.deepEqual(await f.turns.settled(receipt.submissionId), { stopReason: "end_turn", text: "a🙂" })
})

test("waiting projection survives history eviction while later inspection reports incomplete", async t => {
  const f = fixture(t, { events: 2 }), receipt = await f.text(), projected = f.turns.settled(receipt.submissionId)
  await f.started
  f.emit("a"); f.emit("b"); f.emit("c"); f.pending[0]!.resolve({ stopReason: "end_turn" })
  assert.deepEqual(await projected, { stopReason: "end_turn", text: "abc" })
  await assert.rejects(f.turns.settled(receipt.submissionId), { code: "INCOMPLETE" })
})

for (const first of ["text", "native"] as const) test(first + " submissions reject overlapping text projection", async t => {
  const f = fixture(t)
  await f[first](); await f.started
  await assert.rejects(f.text(), { code: "BUSY" })
  if (first === "text") await assert.rejects(f.native(), { code: "BUSY" })
  assert.equal(f.calls.length, 1)
})

test("native overlap preserves both results and grouped cancellation", async t => {
  const f = fixture(t), a = await f.native(), b = await f.native(undefined, "second")
  assert.equal(f.calls.length, 2)
  await f.turns.cancel(a.submissionId); await f.turns.cancel(b.submissionId)
  assert.equal(f.cancellations(), 1)
  f.pending[0]!.resolve({ stopReason: "cancelled", first: true }); f.pending[1]!.resolve({ stopReason: "cancelled", second: true })
  assert.deepEqual(await f.turns.settledAcp(a.submissionId), { stopReason: "cancelled", first: true })
  assert.deepEqual(await f.turns.settledAcp(b.submissionId), { stopReason: "cancelled", second: true })
  assert.equal(f.observers(), 0)
})

test("duplicate text and native IDs reuse one invocation but reject changed content", async t => {
  const f = fixture(t), receipt = await f.text()
  await f.started
  assert.equal((await f.native(receipt.submissionId)).acceptedSeq, receipt.acceptedSeq)
  await assert.rejects(f.native(receipt.submissionId, "different"), { code: "COMMAND_CONFLICT" })
  assert.equal(f.calls.length, 1)
})

test("text input validation rejects empty and oversized Unicode before invoking ACP", async t => {
  const f = fixture(t)
  await assert.rejects(f.text(undefined, ""), { code: "INVALID_AGENT_STATE" })
  await assert.rejects(f.text(undefined, "🙂".repeat(1025)), { code: "INPUT_TOO_LARGE" })
  assert.equal(f.calls.length, 0)
})

test("native provider errors survive both result views and release text observation", async t => {
  const f = fixture(t), receipt = await f.text(), projected = f.turns.settled(receipt.submissionId)
  const textFailure = assert.rejects(projected, { code: "STARTUP_FAILED" })
  await f.started
  const error = new ProviderRequestError({ code: -32042, message: "Provider busy", data: { retry: true } })
  f.pending[0]!.reject(error)
  await textFailure
  await assert.rejects(f.turns.settledAcp(receipt.submissionId), value => value === error)
  assert.equal(f.observers(), 0)
  const next = await f.native(undefined, "next")
  f.pending[1]!.resolve({ stopReason: "end_turn" })
  assert.deepEqual(await f.turns.settledAcp(next.submissionId), { stopReason: "end_turn" })
})

test("closing a pending text turn settles both views and releases its observer immediately", async t => {
  const f = fixture(t), receipt = await f.text()
  const a = assert.rejects(f.turns.settled(receipt.submissionId), { code: "STARTUP_FAILED" })
  const b = assert.rejects(f.turns.settledAcp(receipt.submissionId), { code: "STARTUP_FAILED" })
  await f.started; f.turns.close(null)
  await Promise.all([a, b])
  assert.equal(f.observers(), 0)
  f.emit("late"); f.pending[0]!.resolve({ stopReason: "end_turn" })
  assert.equal(f.turns.inspect(receipt.submissionId), null)
})