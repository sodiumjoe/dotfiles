import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { EDITOR_TURN_LIMITS, type TurnResult } from "../src/agent/session-events.js"
import { agentId } from "./agent-support.js"
import { createConversation } from "../src/agent/conversation.js"
import { AgentError } from "../src/agent/types.js"
import { createTurnCoordinator } from "../src/agent/turns.js"

const target = { agentId: agentId(1), handlerGeneration: agentId(2), providerGeneration: agentId(3) }

test("submission receipt survives detach and history eviction without another dispatch", async () => {
  const conversation = createConversation(target, { events: 1 }), answer = Promise.withResolvers<TurnResult>()
  let calls = 0
  const turns = createTurnCoordinator({ target, conversation, validate: async () => {}, invoke: async () => { calls++; return answer.promise }, cancel: async () => {} })
  const request = { submissionId: randomUUID(), text: "one request", limits: EDITOR_TURN_LIMITS }
  const observed = conversation.observe(() => {})
  await turns.submit(request)
  observed.close()
  await turns.submit(request)
  assert.equal(calls, 1)
  await assert.rejects(turns.submit({ ...request, text: "changed" }), { code: "COMMAND_CONFLICT" })
  const done = turns.settled(request.submissionId)
  answer.resolve({ stopReason: "end_turn", text: "done" })
  assert.deepEqual(await done, { stopReason: "end_turn", text: "done" })
  assert.equal(turns.inspect(request.submissionId)!.state, "completed")
  assert.match(turns.inspect(request.submissionId)!.digest, /^[a-f0-9]{64}$/)
  assert.equal(Object.hasOwn(turns.inspect(request.submissionId)!, "text"), false)
  await turns.submit(request)
  assert.equal(calls, 1)
  turns.close(null)
  assert.equal(turns.inspect(request.submissionId), null)
  conversation.close()
})

test("simultaneous different submissions accept exactly one and reject busy before acceptance", async () => {
  const conversation = createConversation(target), answer = Promise.withResolvers<TurnResult>()
  let calls = 0
  const turns = createTurnCoordinator({ target, conversation, validate: async () => {}, invoke: async () => { calls++; return answer.promise }, cancel: async () => {} })
  const first = { submissionId: randomUUID(), text: "one", limits: EDITOR_TURN_LIMITS }, second = { ...first, submissionId: randomUUID() }
  const results = await Promise.allSettled([turns.submit(first), turns.submit(second)])
  assert.equal(results[0].status, "fulfilled")
  assert.equal(results[1].status, "rejected")
  assert.equal(turns.inspect(second.submissionId), null)
  assert.equal(calls, 1)
  const settled = turns.settled(first.submissionId)
  answer.resolve({ stopReason: "refusal", text: "" }); await settled
  turns.close(null); conversation.close()
})

test("old cancellation cannot affect a later active submission and duplicate cancel is idempotent", async () => {
  const conversation = createConversation(target), answers = [Promise.withResolvers<TurnResult>(), Promise.withResolvers<TurnResult>()]
  let calls = 0, cancels = 0
  const turns = createTurnCoordinator({ target, conversation, validate: async () => {}, invoke: async () => answers[calls++]!.promise, cancel: async () => { cancels++ } })
  const first = { submissionId: randomUUID(), text: "one", limits: EDITOR_TURN_LIMITS }, second = { ...first, submissionId: randomUUID(), text: "two" }
  await turns.submit(first)
  await turns.cancel(first.submissionId); await turns.cancel(first.submissionId)
  assert.equal(cancels, 1)
  const settled = turns.settled(first.submissionId)
  answers[0]!.resolve({ stopReason: "cancelled", text: "" }); await settled
  await turns.submit(second)
  await turns.cancel(first.submissionId)
  assert.equal(cancels, 1)
  const next = turns.settled(second.submissionId)
  answers[1]!.resolve({ stopReason: "end_turn", text: "two" }); await next
  turns.close(null); conversation.close()
})

test("accepted invocation failure is terminal and retries cannot dispatch again", async () => {
  const conversation = createConversation(target)
  let calls = 0
  const turns = createTurnCoordinator({ target, conversation, validate: async () => {}, invoke: async () => { calls++; throw new Error("private provider diagnostic") }, cancel: async () => {} })
  const request = { submissionId: randomUUID(), text: "one", limits: EDITOR_TURN_LIMITS }
  await turns.submit(request)
  await assert.rejects(turns.settled(request.submissionId), { code: "STARTUP_FAILED" })
  assert.equal(turns.inspect(request.submissionId)!.state, "failed")
  assert.equal(JSON.stringify(turns.inspect(request.submissionId)).includes("private"), false)
  await turns.submit(request)
  assert.equal(calls, 1)
  turns.close(null); conversation.close()
})

test("invalid input and failed readiness validation leave no accepted receipt", async () => {
  const conversation = createConversation(target)
  const turns = createTurnCoordinator({ target, conversation, validate: async () => { throw new Error("not ready") }, invoke: async () => { throw new Error("must not invoke") }, cancel: async () => {} })
  const request = { submissionId: randomUUID(), text: "x".repeat(262145), limits: EDITOR_TURN_LIMITS }
  await assert.rejects(turns.submit(request), { code: "INPUT_TOO_LARGE" })
  await assert.rejects(turns.submit({ ...request, text: "valid" }))
  assert.equal(turns.inspect(request.submissionId), null)
  assert.equal(conversation.observe(() => {}).snapshot.events.length, 0)
  turns.close(null); conversation.close()
})

test("closing a coordinator frees receipts and rejects its waiter without cancelling the provider", async () => {
  const conversation = createConversation(target), answer = Promise.withResolvers<TurnResult>()
  let cancels = 0
  const turns = createTurnCoordinator({ target, conversation, validate: async () => {}, invoke: async () => answer.promise, cancel: async () => { cancels++ } })
  const request = { submissionId: randomUUID(), text: "one", limits: EDITOR_TURN_LIMITS }
  await turns.submit(request)
  const settled = turns.settled(request.submissionId)
  turns.close({ code: "STARTUP_FAILED", message: "startup failed" })
  await assert.rejects(settled, { code: "STARTUP_FAILED" })
  assert.equal(turns.inspect(request.submissionId), null)
  answer.resolve({ stopReason: "end_turn", text: "late" })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(cancels, 0)
  assert.equal(conversation.observe(() => {}).snapshot.events.length, 2)
  conversation.close()
})

test("late settlement uses retained answer events but never reconstructs evicted text", async () => {
  const conversation = createConversation(target, { events: 8 }), answer = Promise.withResolvers<TurnResult>()
  const turns = createTurnCoordinator({ target, conversation, validate: async () => {}, invoke: async () => answer.promise, cancel: async () => {} })
  const request = { submissionId: randomUUID(), text: "one", limits: EDITOR_TURN_LIMITS }
  await turns.submit(request)
  conversation.append({ kind: "update", replay: false, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } })
  const settled = turns.settled(request.submissionId)
  answer.resolve({ stopReason: "end_turn", text: "answer" }); await settled
  assert.deepEqual(await turns.settled(request.submissionId), { stopReason: "end_turn", text: "answer" })
  for (let i = 0; i < 10; i++) conversation.append({ kind: "update", replay: false, update: { sessionUpdate: "usage_update", used: i, size: 100 } })
  await assert.rejects(turns.settled(request.submissionId), { code: "INCOMPLETE" })
  assert.equal(turns.inspect(request.submissionId)!.state, "completed")
  turns.close(null); conversation.close()
})

test("accepted admission runs once and cannot be stolen by busy or duplicate requests", async () => {
  const conversation = createConversation(target), answer = Promise.withResolvers<TurnResult>(), origins: string[] = []
  const admission = { onAccepted: (request: { originConnectionId?: string }) => { origins.push(request.originConnectionId!) } }
  const turns = createTurnCoordinator({ ...admission, target, conversation, validate: async () => {}, invokeAcp: async () => { await answer.promise; return { stopReason: "end_turn" } }, cancel: async () => {} })
  const request = { submissionId: randomUUID(), prompt: [{ type: "text", text: "one" }], originConnectionId: "a" }
  await turns.submitAcp(request)
  await turns.submitAcp({ ...request, originConnectionId: "b" })
  await assert.rejects(turns.submitAcp({ ...request, submissionId: randomUUID(), originConnectionId: "b" }), { code: "BUSY" })
  assert.deepEqual(origins, ["a"])
  const settled = turns.settledAcp(request.submissionId)
  answer.resolve({ stopReason: "end_turn", text: "" }); await settled
  turns.close(null); conversation.close()
})

test("stale accepted origin creates no receipt or submitted event", async () => {
  const conversation = createConversation(target)
  const admission = { onAccepted: () => { throw new AgentError("STALE_ATTACHMENT") } }
  const turns = createTurnCoordinator({ ...admission, target, conversation, validate: async () => {}, invokeAcp: async () => { throw new Error("must not invoke") }, cancel: async () => {} })
  const request = { submissionId: randomUUID(), prompt: [{ type: "text", text: "one" }] }
  await assert.rejects(turns.submitAcp(request), { code: "STALE_ATTACHMENT" })
  assert.equal(turns.inspect(request.submissionId), null)
  const observation = conversation.observe(() => {})
  assert.equal(observation.snapshot.events.length, 0); observation.close()
  turns.close(null); conversation.close()
})