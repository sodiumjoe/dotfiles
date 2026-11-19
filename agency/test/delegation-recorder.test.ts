import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createConversation } from "../src/agent/conversation.js"
import { createOutboxStore } from "../src/delegation/outbox.js"
import { recordTurns } from "../src/delegation/recorder.js"
import { until } from "./control-support.js"

const child = "00000000-0000-4000-8000-000000000001", submission = "00000000-0000-4000-8000-000000000003"
const target = { agentId: child, handlerGeneration: "00000000-0000-4000-8000-000000000004", providerGeneration: "00000000-0000-4000-8000-000000000005" }
const chunk = (text: string) => ({ kind: "update" as const, replay: false, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } as never })
const tool = () => ({ kind: "update" as const, replay: false, update: { sessionUpdate: "tool_call", toolCallId: "t", title: "Run", status: "pending" } as never })
async function setup(t: { after(fn: () => Promise<void>): void }, limits: { events?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agency-recorder-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outbox = createOutboxStore(root), conversation = createConversation(target, limits)
  await outbox.create({ childId: child, parent: { hostId: "a".repeat(64), agentId: "00000000-0000-4000-8000-000000000002" }, depth: 1, ref: "master" })
  let changes = 0
  return { outbox, conversation, changes: () => changes, record: (running: string | null = null) => recordTurns({ childId: child, conversation, outbox, running: () => running, changed: () => { changes++ } }) }
}

test("a finished turn becomes one answer, with a blank line wherever a tool call fell between messages", async t => {
  const { outbox, conversation, changes, record } = await setup(t)
  const recorder = record()
  conversation.append({ kind: "submitted", submissionId: submission, text: "task" })
  conversation.append(chunk("Let me check.")); conversation.append(tool()); conversation.append(chunk("Found it")); conversation.append(chunk(" in foo.ts."))
  conversation.append({ kind: "turn", submissionId: submission, state: "completed", stopReason: "end_turn", failure: null })
  const value = await until(async () => { const current = await outbox.read(child); return current?.entries.length ? current : undefined })
  assert.deepEqual(value.entries.map(entry => [entry.state, entry.stopReason, entry.text]), [["answer", "end_turn", "Let me check.\n\nFound it in foo.ts."]])
  assert.equal(value.open, null)
  await until(async () => changes() >= 1 ? true : undefined)
  recorder.close()
})

test("a failed turn is recorded with its failure, and a closed conversation records the open turn as interrupted", async t => {
  const { outbox, conversation, record } = await setup(t)
  const recorder = record()
  conversation.append({ kind: "submitted", submissionId: submission, text: "task" })
  conversation.append({ kind: "turn", submissionId: submission, state: "failed", stopReason: null, failure: { code: "INTERNAL", message: "boom" } })
  await until(async () => (await outbox.read(child))?.entries.length === 1 ? true : undefined)
  const second = "00000000-0000-4000-8000-000000000006"
  conversation.append({ kind: "submitted", submissionId: second, text: "more" })
  await until(async () => (await outbox.read(child))?.open === second ? true : undefined)
  conversation.close()
  const value = await until(async () => { const current = await outbox.read(child); return current?.entries.length === 2 ? current : undefined })
  assert.deepEqual(value.entries.map(entry => [entry.state, entry.failure, entry.text]), [["failed", "INTERNAL", "(no text)"], ["interrupted", null, "(no text)"]])
  recorder.close()
})

test("an open turn left by a crash is recorded as interrupted when a recorder attaches, but not if that turn is still running", async t => {
  const { outbox, record } = await setup(t)
  await outbox.update(child, current => { current.open = submission })
  record(submission).close()
  await outbox.flushed()
  assert.equal((await outbox.read(child))!.entries.length, 0)
  record(null).close()
  const value = await until(async () => { const current = await outbox.read(child); return current?.entries.length ? current : undefined })
  assert.deepEqual(value.entries.map(entry => [entry.submissionId, entry.state]), [[submission, "interrupted"]])
})

test("a change callback that throws neither loses the entry nor escapes as an unhandled rejection", async t => {
  const { outbox, conversation } = await setup(t)
  const rejections: unknown[] = [], onRejection = (reason: unknown) => { rejections.push(reason) }
  process.on("unhandledRejection", onRejection)
  t.after(() => { process.off("unhandledRejection", onRejection) })
  const recorder = recordTurns({ childId: child, conversation, outbox, running: () => null, changed: () => { throw new Error("changed failed") } })
  conversation.append({ kind: "submitted", submissionId: submission, text: "task" })
  conversation.append(chunk("ok"))
  conversation.append({ kind: "turn", submissionId: submission, state: "completed", stopReason: "end_turn", failure: null })
  const value = await until(async () => { const current = await outbox.read(child); return current?.entries.length ? current : undefined })
  assert.deepEqual(value.entries.map(entry => [entry.state, entry.text]), [["answer", "ok"]])
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(rejections, [])
  recorder.close()
})

test("a turn longer than the conversation buffer keeps all its text", async t => {
  const { outbox, conversation, record } = await setup(t, { events: 4 })
  const recorder = record()
  conversation.append({ kind: "submitted", submissionId: submission, text: "task" })
  for (let n = 0; n < 10; n++) conversation.append(chunk("p" + n))
  conversation.append({ kind: "turn", submissionId: submission, state: "completed", stopReason: "end_turn", failure: null })
  const value = await until(async () => { const current = await outbox.read(child); return current?.entries.length ? current : undefined })
  assert.deepEqual(value.entries.map(entry => entry.text), ["p0p1p2p3p4p5p6p7p8p9"])
  recorder.close()
})