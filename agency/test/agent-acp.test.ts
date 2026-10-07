import assert from "node:assert/strict"
import test from "node:test"
import { PassThrough, Writable } from "node:stream"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { privateRoot } from "./control-support.js"
import { createAcpConnection } from "../src/agent/acp.js"
import * as sessionEvents from "../src/agent/session-events.js"
import type { PromptResult } from "../src/agent/types.js"
import { splitLaunchSpec } from "../src/agent/types.js"
import { sampleAgent, sampleContract, sampleSpec, sampleProductionContract, sampleProductionSpec, scriptedAcp as baseScriptedAcp } from "./agent-support.js"

const scriptedAcp: typeof baseScriptedAcp = (t, scenario, settings = {}) => {
  const peer = baseScriptedAcp(t, scenario, settings)
  const model = settings.productionContract ? "gpt-5.6-sol" : "model-a"
  peer.replaceOptions([
    { id: "model", type: "select", currentValue: "initial-model", options: [{ value: "initial-model" }, { value: model }, { value: "model-b" }] },
    { id: settings.productionContract ? "reasoning_effort" : "reasoning", type: "select", currentValue: "low", options: [{ value: "low" }, { value: "high" }] },
    { id: "mode", type: "select", currentValue: "plan", options: [{ value: "plan" }, { value: "review" }, { value: "read-only" }] },
  ])
  return peer
}

const editorLimits = { inputBytes: 262144, outputBytes: 786432, encodedTextBytes: 917504, allowEmptyAnswer: true }
const updateFrame = (update: unknown) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update } })

for (const [text, expected] of [["α".repeat(3000), "α".repeat(2048)], ["a".repeat(4095) + "🙂", "a".repeat(4095)]]) test("legacy answer projection preserves UTF-8 boundaries: " + Buffer.byteLength(text!), async t => {
  const seen: sessionEvents.AcpObservation[] = []
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), prompt(request, send) {
    send(updateFrame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }))
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const result = await peer.connection.prompt("question", new AbortController().signal)
  assert.equal(result.text, expected)
  assert.equal(result.text.isWellFormed(), true)
  assert.equal(seen.at(-1)!.update.content && (seen.at(-1)!.update.content as { text: string }).text, text)
})

test("display titles truncate at UTF-8 boundaries without changing wire text", () => {
  assert.deepEqual(sessionEvents.displayTitle("α".repeat(600)), { title: "α".repeat(512), titleTruncated: true, titleOriginalBytes: 1200 })
  assert.deepEqual(sessionEvents.displayTitle("title"), { title: "title", titleTruncated: false, titleOriginalBytes: 5 })
})

test("tool content preserves bounded diff and terminal results without enabling RPCs", async t => {
  const seen: sessionEvents.AcpObservation[] = [], update = { sessionUpdate: "tool_call_update", toolCallId: "tool", content: [
    { type: "diff", path: "/a", oldText: null, newText: "new" },
    { type: "terminal", terminalId: "terminal-1" },
    { type: "content", content: { type: "text", text: "x".repeat(32768) } },
  ] }
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), prompt(request, send) {
    send(updateFrame(update)); send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  await peer.connection.prompt("question", new AbortController().signal, editorLimits)
  assert.deepEqual(seen.at(-1)!.update, update)
})

for (const [name, title] of [["missing", undefined], ["null", null]] as const) {
  for (const kind of ["new", "load"] as const) test(`ACP ${kind} preserves a tool call with a ${name} title and keeps the session usable`, async t => {
    const seen: sessionEvents.AcpObservation[] = []
    const update = { sessionUpdate: "tool_call", toolCallId: "subagent-completed-fixture", kind: "other", status: "completed",
      rawInput: { agentThreadId: "child-session", agentPath: "/root/plan_reviewer", activityKind: "completed" },
      _meta: { codex: { subagent: { threadId: "child-session", path: "/root/plan_reviewer", activity: "completed" } } },
      ...(title === undefined ? {} : { title }),
    }
    const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), response(request, reply) {
      if (request.method === "session/load") peer.send(updateFrame(update))
      return reply
    }, prompt(request, send) {
      send(updateFrame(update))
      send(updateFrame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } }))
      send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
    } })
    await peer.connection.initialize(sampleAgent(), sampleContract(), kind === "load" ? { kind, sessionId: "fixture-session", params: {} } : { kind, params: {} }, new AbortController().signal)
    assert.deepEqual(await peer.connection.prompt("first", new AbortController().signal), { stopReason: "end_turn", text: "answer" })
    assert.deepEqual(await peer.connection.prompt("second", new AbortController().signal), { stopReason: "end_turn", text: "answer" })
    const tools = seen.filter(event => event.update.sessionUpdate === "tool_call")
    assert.equal(tools.length, kind === "load" ? 3 : 2)
    for (const event of tools) assert.deepEqual(event.update, update)
    assert.equal(tools[0]!.replay, kind === "load")
  })
}

for (const [name, title] of [["missing", undefined], ["null", null]] as const) {
  test(`native tool call validation preserves provider input with a ${name} title`, () => {
    const update = Object.freeze({ sessionUpdate: "tool_call", toolCallId: "tool-1", status: "completed", ...(title === undefined ? {} : { title }) })
    assert.strictEqual(sessionEvents.validateNativeUpdate(update), update)
    assert.equal(Object.hasOwn(update, "title"), title !== undefined)
  })
}

test("ACP preserves supplied tool titles and sparse tool call updates", async t => {
  const seen: sessionEvents.AcpObservation[] = [], updates = [
    { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read package", kind: "read" },
    { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" },
    { sessionUpdate: "tool_call", toolCallId: "tool-2", title: "" },
    { sessionUpdate: "tool_call_update", toolCallId: "tool-2", title: null },
  ]
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), prompt(request, send) {
    for (const update of updates) send(updateFrame(update))
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal((await peer.connection.prompt("question", new AbortController().signal)).stopReason, "end_turn")
  assert.deepEqual(seen.map(event => event.update), updates)
})

for (const kind of ["tool_call", "tool_call_update"]) {
  for (const title of [42, false, {}]) test(`ACP rejects malformed ${kind} title: ${JSON.stringify(title)}`, async t => {
    const peer = scriptedAcp(t, "exact", { prompt(_request, send) {
      send(updateFrame({ sessionUpdate: kind, toolCallId: "tool-1", title }))
    } })
    await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
    await assert.rejects(peer.connection.prompt("question", new AbortController().signal), { code: "INVALID_PROTOCOL" })
  })
}

test("load replay publishes validated user, assistant, and display updates without prompting", async t => {
  const seen: sessionEvents.AcpObservation[] = []
  const updates = [
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "prior question" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "prior answer" } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" } },
    { sessionUpdate: "tool_call", toolCallId: "read", title: "Read", kind: "read" },
    { sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed" },
    { sessionUpdate: "plan", entries: [{ content: "Answer", status: "completed", priority: "low" }] },
    { sessionUpdate: "usage_update", used: 10, size: 100 },
    { sessionUpdate: "session_info_update", title: "History" },
  ]
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), response(request, reply) {
    if (request.method === "session/load") for (const update of updates) peer.send(updateFrame(update))
    return reply
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "load", sessionId: "fixture-session", params: {} }, new AbortController().signal)
  assert.deepEqual(seen.filter(event => event.replay).map(event => event.update), updates)
  assert.equal(peer.sent.some(request => request.method === "session/prompt"), false)
})

test("editor retains tool text above the former 64 KiB update ceiling", async t => {
  const seen: sessionEvents.AcpObservation[] = []
  const update = { sessionUpdate: "tool_call_update", toolCallId: "large-read", content: [{ type: "content", content: { type: "text", text: "x".repeat(131072) } }] }
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), prompt(request, send) {
    send(updateFrame(update)); send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.deepEqual(await peer.connection.prompt("read", new AbortController().signal, editorLimits), { stopReason: "end_turn", text: "" })
  assert.deepEqual(seen.at(-1)?.update, update)
})

test("completion racing cancel clears grace and contains observer exceptions", async t => {
  const peer = scriptedAcp(t, "exact", { onUpdate() { throw new Error("observer failed") }, prompt(request, send) {
    send(updateFrame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }))
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const result = peer.connection.prompt("first", new AbortController().signal, editorLimits)
  await peer.connection.cancelPrompt()
  assert.deepEqual(await result, { stopReason: "end_turn", text: "done" })
  await new Promise<void>(resolve => setImmediate(resolve))
  t.mock.timers.tick(5000)
  assert.deepEqual(await peer.connection.prompt("second", new AbortController().signal, editorLimits), { stopReason: "end_turn", text: "done" })
  assert.equal(peer.sent.filter(request => request.method === "session/cancel").length, 0)
})

test("real fixture provider accepts cancellation and a subsequent turn", async t => {
  const root = await privateRoot(t)
  const child = spawn(process.execPath, [new URL("./fixtures/agent-provider.js", import.meta.url).pathname], { env: { ...process.env, FIXTURE_ROOT: root, FIXTURE_SCENARIO: "cancel" }, stdio: ["pipe", "pipe", "pipe"] })
  const exited = once(child, "exit")
  const peer = createAcpConnection({ readable: child.stdout, writable: child.stdin, limits: sampleSpec().limits })
  try {
    await peer.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
    const turn = peer.prompt("cancel", new AbortController().signal, editorLimits)
    await peer.cancelPrompt()
    assert.deepEqual(await turn, { stopReason: "cancelled", text: "" })
    assert.deepEqual(await peer.prompt("second", new AbortController().signal, editorLimits), { stopReason: "end_turn", text: "answer:second" })
  } finally {
    peer.close(); child.kill("SIGTERM"); await exited
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
  }
})

test("invalid display updates and configuration drift are never observed", async t => {
  const seen: sessionEvents.AcpObservation[] = []
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event) })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  seen.length = 0
  peer.send(updateFrame({ sessionUpdate: "usage_update", used: -1, size: 10 }))
  assert.equal((await Promise.race([peer.connection.fault, new Promise<undefined>(resolve => setTimeout(resolve, 100))]))?.code, "INVALID_PROTOCOL")
  assert.deepEqual(seen, [])
})

test("editor accepts maximum raw prompt and answer plus full fallback title in one burst", async t => {
  const input = "x".repeat(262144), answer = "y".repeat(786432), seen: sessionEvents.AcpObservation[] = []
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), prompt(request, send) {
    send(updateFrame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } }))
    send(updateFrame({ sessionUpdate: "session_info_update", title: input }))
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.deepEqual(await peer.connection.prompt(input, new AbortController().signal, editorLimits), { stopReason: "end_turn", text: answer })
  assert.equal(seen.at(-1)!.update.title, input)
})

test("native load replays complete editor messages without charging the answer turn budget", async t => {
  const texts = ["x".repeat(262144), "y".repeat(786432)], seen: sessionEvents.AcpObservation[] = []
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), response(request, reply) {
    if (request.method === "session/load") {
      for (const [i, text] of texts.entries()) peer.send(updateFrame({ sessionUpdate: i ? "agent_message_chunk" : "user_message_chunk", content: { type: "text", text } }))
      peer.send(updateFrame({ sessionUpdate: "session_info_update", title: texts[0] }))
    }
    return reply
  } })
  assert.equal((await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "load", sessionId: "fixture-session", params: {} }, new AbortController().signal)).sessionId, "fixture-session")
  assert.equal(seen.filter(event => event.replay).length, 3)
})

test("cancel sends one notification and retains the original prompt until its response", async t => {
  let original: any
  const peer = scriptedAcp(t, "exact", { prompt(request) { original = request } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const pending = peer.connection.prompt("first", new AbortController().signal, editorLimits)
  void pending.catch(() => undefined)
  await peer.connection.cancelPrompt()
  await peer.connection.cancelPrompt()
  assert.equal(peer.sent.filter(request => request.method === "session/cancel").length, 1)
  peer.send({ jsonrpc: "2.0", id: original.id, result: { stopReason: "cancelled" } })
  assert.deepEqual(await pending, { stopReason: "cancelled", text: "" })
  const second = peer.connection.prompt("second", new AbortController().signal, editorLimits)
  peer.send(updateFrame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "usable" } }))
  peer.send({ jsonrpc: "2.0", id: original.id, result: { stopReason: "end_turn" } })
  assert.deepEqual(await second, { stopReason: "end_turn", text: "usable" })
  await peer.connection.cancelPrompt()
  assert.equal(peer.sent.filter(request => request.method === "session/cancel").length, 1)
})

for (const stopReason of ["cancelled", "max_tokens", "max_turn_requests", "refusal", "end_turn"]) test(`editor accepts empty output for ${stopReason}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) { send({ jsonrpc: "2.0", id: request.id, result: { stopReason } }) } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.deepEqual(await peer.connection.prompt("question", new AbortController().signal, editorLimits), { stopReason, text: "" })
})

test("editor rejects excessive encoded input before dispatch while remaining usable", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) { send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } }) } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  await assert.rejects(peer.connection.prompt("\u0001".repeat(152918), new AbortController().signal, editorLimits), { code: "INPUT_TOO_LARGE" })
  await assert.rejects(peer.connection.prompt("α".repeat(131073), new AbortController().signal, editorLimits), { code: "INPUT_TOO_LARGE" })
  assert.equal(peer.sent.filter(request => request.method === "session/prompt").length, 0)
  await peer.connection.prompt("\u0001".repeat(152917), new AbortController().signal, editorLimits)
  assert.equal(peer.sent.filter(request => request.method === "session/prompt").length, 1)
})

for (const [name, chunks] of [["encoded", ["\u0001".repeat(100000), "\u0001".repeat(52918)]], ["raw", ["α".repeat(200000), "α".repeat(193217)]]] as const) test(`native output exceeds the former aggregate ${name} quota without failing`, async t => {
  const seen: sessionEvents.AcpObservation[] = []
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), prompt(request, send) {
    for (const text of chunks) send(updateFrame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }))
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal((await peer.connection.prompt("question", new AbortController().signal, editorLimits)).stopReason, "end_turn")
  assert.deepEqual(seen.filter(event => event.update.sessionUpdate === "agent_message_chunk").map(event => (event.update.content as { text: string }).text), chunks)
})

test("uncooperative cancellation faults after five seconds and releases timers", async t => {
  const peer = scriptedAcp(t, "exact", { prompt() {} })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const pending = peer.connection.prompt("question", new AbortController().signal, editorLimits)
  const rejected = assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
  await peer.connection.cancelPrompt()
  t.mock.timers.tick(4999)
  await Promise.resolve()
  t.mock.timers.tick(1)
  await rejected
  assert.equal((await peer.connection.fault).code, "STARTUP_TIMEOUT")
})

for (const scenario of ["frame", "history"]) test(`load accepts the former ${scenario} bound without creating a new session`, async t => {
  const peer = scriptedAcp(t, "exact", { response(request, reply) {
    if (request.method === "session/load") {
      for (let i = 0; i < (scenario === "frame" ? 1 : 12); i++) peer.send(updateFrame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(scenario === "frame" ? 1048576 : 786432) } }))
    }
    return reply
  } })
  const loading = peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "load", sessionId: "fixture-session", params: {} }, new AbortController().signal)
  assert.equal((await loading).sessionId, "fixture-session")
  assert.equal(peer.sent.some(request => request.method === "session/new"), false)
})

test("ACP returns the bounded text answer from one successful prompt turn", async t => {
  const peer = scriptedAcp(t, "fragmented", { prompt(request, send) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_thought_chunk", messageId: "thought-1", content: { type: "text", text: "private thought" } } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "plan", entries: [{ content: "Answer", priority: "high", status: "in_progress" }] } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "config_option_update", configOptions: [
      { id: "model", type: "select", currentValue: "model-a", options: [{ value: "model-a" }] },
      { id: "reasoning", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
      { id: "mode", type: "select", currentValue: "review", options: [{ value: "plan" }, { value: "review" }] },
    ] } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "session_info_update", title: "Fixture", _meta: { codex: { threadStatus: "active" } } } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.01, currency: "USD" } } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ans" } } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wer" } } } })
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn", usage: null, _meta: { quota: { token_count: null, model_usage: [] } } } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const result: PromptResult = await peer.connection.prompt("challenge", new AbortController().signal)
  assert.deepEqual(result, { stopReason: "end_turn", text: "answer" })
  assert.deepEqual(peer.sent.at(-1), { jsonrpc: "2.0", id: 6, method: "session/prompt", params: { sessionId: "fixture-session", prompt: [{ type: "text", text: "challenge" }] } })
})

test("ACP permits sequential turns and preserves asynchronous valid updates", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } })
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.deepEqual(await peer.connection.prompt("first", new AbortController().signal), { stopReason: "end_turn", text: "answer" })
  assert.deepEqual(await peer.connection.prompt("second", new AbortController().signal), { stopReason: "end_turn", text: "answer" })
  assert.deepEqual(peer.sent.filter(request => request.method === "session/prompt").map(request => request.id), [6, 7])
  peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "delayed-first-turn" } } } })
  assert.equal(peer.connection.snapshot().configOptions.length, 3)
})

for (const kind of ["new", "load"] as const) test(`ACP ${kind} uses recorded cwd and load never replays setters`, async t => {
  const peer = scriptedAcp(t), record = sampleAgent()
  record.definition.cwd = "/recorded/workspace"
  const result = await peer.connection.initialize(record, sampleContract(), kind === "new" ? { kind, params: {} } : { kind, sessionId: "fixture-session", params: {} }, new AbortController().signal)
  assert.equal(result.sessionId, "fixture-session")
  assert.deepEqual(peer.sent[1]!.params, { ...(kind === "load" ? { sessionId: "fixture-session" } : {}), cwd: "/recorded/workspace", mcpServers: [] })
  assert.equal(peer.sent.filter(request => request.method === "session/set_config_option").length, kind === "load" ? 0 : 3)
})

for (const scenario of ["unsupported", "invalid-capability", "missing-session", "changed-id", "wrong-session", "replay"] as const) test(`ACP load validates runtime and session evidence: ${scenario}`, async t => {
  const peer = scriptedAcp(t, "exact", { response(request, reply) {
    if (request.method === "initialize") reply.result.agentCapabilities.loadSession = scenario === "unsupported" ? false : scenario === "invalid-capability" ? "true" : true
    if (request.method === "session/load") {
      if (scenario === "missing-session") return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Session not found" } }
      if (scenario === "changed-id") reply.result.sessionId = "another-session"
      if (scenario === "wrong-session" || scenario === "replay") peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: scenario === "replay" ? "fixture-session" : "another-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "prior answer" } } } })
    }
    return reply
  } })
  const pending = peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "load", sessionId: "fixture-session", params: {} }, new AbortController().signal)
  if (scenario === "replay") assert.equal((await pending).sessionId, "fixture-session")
  else await assert.rejects(pending, { code: scenario === "unsupported" ? "RESTORE_UNSUPPORTED" : scenario === "missing-session" ? "SESSION_UNAVAILABLE" : "INVALID_PROTOCOL" })
  assert.equal(peer.sent.some(request => request.method === "session/new"), false)
})

test("ACP load accepts historical user messages and mode updates before configuration replay", async t => {
  const peer = scriptedAcp(t, "exact", { response(request, reply) {
    if (request.method === "session/load") for (const update of [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } },
      { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      { sessionUpdate: "available_commands_update", availableCommands: [] },
    ]) peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update } })
    return reply
  } })
  assert.equal((await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "load", sessionId: "fixture-session", params: {} }, new AbortController().signal)).sessionId, "fixture-session")
})

for (const [code, message, expected] of [
  [-32602, "Session not found", "SESSION_UNAVAILABLE"],
  [-32602, "Invalid params", "STARTUP_FAILED"],
  [-32602, "Invalid params: cwd must refer to an accessible directory", "STARTUP_FAILED"],
  [-32602, "Session not found in the inaccessible cwd", "STARTUP_FAILED"],
  [-32603, "Session not found", "STARTUP_FAILED"],
] as const) test(`ACP load error classification requires exact missing-session evidence: ${code} ${message}`, async t => {
  const peer = scriptedAcp(t, "exact", { response(request, reply) {
    return request.method === "session/load" ? { jsonrpc: "2.0", id: request.id, error: { code, message } } : reply
  } })
  await assert.rejects(peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "load", sessionId: "fixture-session", params: {} }, new AbortController().signal), { code: expected })
  assert.equal(peer.sent.some(request => request.method === "session/new"), false)
})

type MetadataLayer = "session params" | "config update" | "current mode" | "option" | "group" | "choice"
function metadataNotification(layer: MetadataLayer, value: unknown) {
  if (layer === "session params") return { jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" } }, _meta: value } }
  if (layer === "current mode") return { jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "current_mode_update", currentModeId: "review", _meta: value } } }
  const modelChoice = { value: "model-a", ...(layer === "choice" ? { _meta: value } : {}) }
  const modelOptions = layer === "group" ? [{ group: "models", name: "Models", options: [modelChoice], _meta: value }] : [modelChoice]
  const configOptions = [
    { id: "model", type: "select", currentValue: "model-a", options: modelOptions, ...(layer === "option" ? { _meta: value } : {}) },
    { id: "reasoning", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
    { id: "mode", type: "select", currentValue: "review", options: [{ value: "plan" }, { value: "review" }] },
  ]
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "config_option_update", configOptions, ...(layer === "config update" ? { _meta: value } : {}) } } }
}

for (const layer of ["session params", "config update", "current mode", "option", "group", "choice"] as const) test(`ACP accepts bounded documented metadata on ${layer}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    send(metadataNotification(layer, { fixture: true }))
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } })
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.deepEqual(await peer.connection.prompt("challenge", new AbortController().signal), { stopReason: "end_turn", text: "answer" })
})

for (const layer of ["session params", "config update", "current mode", "option", "group", "choice"] as const) test(`ACP preserves metadata above the former quota on ${layer}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    send(metadataNotification(layer, { value: "x".repeat(16384) }))
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal((await peer.connection.prompt("challenge", new AbortController().signal)).stopReason, "end_turn")
})

test("ACP accepts end_turn without text output", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) { send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } }) } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.deepEqual(await peer.connection.prompt("challenge", new AbortController().signal), { stopReason: "end_turn", text: "" })
})

for (const [name, update] of [
  ["thought extra key", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" }, extra: true }],
  ["plan entry extra key", { sessionUpdate: "plan", entries: [{ content: "Answer", priority: "high", status: "pending", extra: true }] }],
  ["configuration option extra key", { sessionUpdate: "config_option_update", configOptions: [
    { id: "model", type: "select", currentValue: "model-a", options: [{ value: "model-a" }], extra: true },
    { id: "reasoning", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
    { id: "mode", type: "select", currentValue: "review", options: [{ value: "plan" }, { value: "review" }] },
  ] }],
  ["empty session information", { sessionUpdate: "session_info_update" }],
  ["usage cost extra key", { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 0, currency: "USD", extra: true } }],
] as const) test(`ACP preserves harmless informational extensions: ${name}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update } })
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal((await peer.connection.prompt("challenge", new AbortController().signal)).stopReason, "end_turn")
})

for (const content of [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "answer", extra: true }, { type: "text" }]) test(`ACP validates structured answer content: ${JSON.stringify(content)}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    send(updateFrame({ sessionUpdate: "agent_message_chunk", content }))
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const pending = peer.connection.prompt("challenge", new AbortController().signal)
  if (content.type === "text" && !("text" in content)) await assert.rejects(pending, { code: "INVALID_PROTOCOL" })
  else assert.equal((await pending).stopReason, "end_turn")
})

test("ACP rejects an answer chunk for another session", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } }) } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

test("ACP preserves valid updates outside a prompt", async t => {
  const seen: sessionEvents.AcpObservation[] = []
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event) })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  peer.send(updateFrame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "asynchronous" } }))
  assert.equal((seen.at(-1)!.update.content as { text: string }).text, "asynchronous")
})

test("duplicate terminal responses fault the transport after settling the valid result", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    const result = { jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } }
    send(result); send(result)
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal((await peer.connection.prompt("challenge", new AbortController().signal)).stopReason, "end_turn")
  assert.equal((await peer.connection.fault).code, "INVALID_PROTOCOL")
})

test("ACP rejects an unknown prompt result ID", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send({ jsonrpc: "2.0", id: 999, result: { stopReason: "end_turn" } }) } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

for (const result of [
  {}, { stopReason: null }, { stopReason: "end_turn", usage: { totalTokens: -1, inputTokens: 1, outputTokens: 1 } },
] as const) test(`ACP rejects malformed prompt result ${JSON.stringify(result)}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) { send({ jsonrpc: "2.0", id: request.id, result }) } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

for (const stopReason of ["max_tokens", "max_turn_requests", "refusal", "cancelled"]) test(`ACP accepts prompt stop reason ${stopReason}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) { send({ jsonrpc: "2.0", id: request.id, result: { stopReason } }) } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.deepEqual(await peer.connection.prompt("challenge", new AbortController().signal), { stopReason, text: "" })
})

test("ACP rejects EOF during a prompt", async t => {
  const peer = scriptedAcp(t, "exact", { prompt() { peer.readable.end() } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "STARTUP_FAILED" })
})

test("ACP abort rejects the active prompt and clears its listener", async t => {
  const peer = scriptedAcp(t, "exact", { prompt() {} }), controller = new AbortController()
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal)
  let additions = 0, removals = 0
  t.mock.method(controller.signal, "addEventListener", ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => { if (type === "abort") additions++; add(type, listener, options) }) as typeof controller.signal.addEventListener)
  t.mock.method(controller.signal, "removeEventListener", ((type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => { if (type === "abort") removals++; remove(type, listener, options) }) as typeof controller.signal.removeEventListener)
  const pending = peer.connection.prompt("challenge", controller.signal)
  controller.abort()
  await assert.rejects(pending, { code: "STARTUP_FAILED" })
  assert.equal(additions, 1)
  assert.equal(removals, 1)
})

test("closing an active prompt clears its request, write timer, and abort listener", async t => {
  const peer = scriptedAcp(t), controller = new AbortController()
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, active = new Set<NodeJS.Timeout>()
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms?: number) => {
    const timer = originalSet(() => { active.delete(timer); callback() }, ms)
    active.add(timer); return timer
  }) as typeof setTimeout)
  t.mock.method(globalThis, "clearTimeout", (timer: Parameters<typeof clearTimeout>[0]) => { active.delete(timer as NodeJS.Timeout); originalClear(timer) })
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal)
  let additions = 0, removals = 0
  t.mock.method(controller.signal, "addEventListener", ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => { if (type === "abort") additions++; add(type, listener, options) }) as typeof controller.signal.addEventListener)
  t.mock.method(controller.signal, "removeEventListener", ((type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => { if (type === "abort") removals++; remove(type, listener, options) }) as typeof controller.signal.removeEventListener)
  const originalWrite = peer.writable._write.bind(peer.writable)
  peer.writable._write = (_chunk, _encoding, _callback) => undefined
  t.after(() => { peer.writable._write = originalWrite; for (const timer of active) originalClear(timer) })
  const pending = peer.connection.prompt("challenge", controller.signal)
  peer.connection.close()
  await assert.rejects(pending, { code: "STARTUP_FAILED" })
  assert.equal(active.size, 0)
  assert.equal(additions, 1)
  assert.equal(removals, 1)
})

for (const field of ["kind", "status", "optionKind", "priority", "planStatus"] as const) for (const shape of ["array", "object"] as const) test(`ACP rejects ${shape} substitution for ${field}`, async t => {
  const valid = { kind: "read", status: "pending", optionKind: "allow_once", priority: "high", planStatus: "pending" }[field]
  const value = shape === "array" ? [valid] : { value: valid }
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    if (field === "priority" || field === "planStatus") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "plan", entries: [{ content: "Answer", priority: field === "priority" ? value : "high", status: field === "planStatus" ? value : "pending" }] } } })
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } })
      send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
    } else send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: { sessionId: "fixture-session", toolCall: { toolCallId: "tool", kind: field === "kind" ? value : "read", status: field === "status" ? value : "pending" }, options: [{ optionId: "once", name: "Once", kind: field === "optionKind" ? value : "allow_once" }] } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
  assert.deepEqual(peer.permissionReplies, [])
})

test("legacy answer projection truncates without terminating native output", async t => {
  const seen: sessionEvents.AcpObservation[] = []
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), prompt(request, send) {
    send(updateFrame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(4097) } }))
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal((await peer.connection.prompt("challenge", new AbortController().signal)).text.length, 4096)
  assert.equal((seen.at(-1)!.update.content as { text: string }).text.length, 4097)
})

test("ACP forwards a large tool result without materializing its payload", async t => {
  const seen: sessionEvents.AcpObservation[] = [], output = "opaque-result:" + "λ".repeat(1048577)
  const update = { sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed", rawOutput: { stdout: output }, content: [{ type: "content", content: { type: "text", text: output } }] }
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), prompt(request, send) {
    send(updateFrame(update)); send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const parse = t.mock.method(JSON, "parse")
  await peer.connection.prompt("challenge", new AbortController().signal)
  assert.ok(parse.mock.calls.every(call => !String(call.arguments[0]).includes("opaque-result:")))
  parse.mock.restore()
  assert.deepEqual(seen.at(-1)!.update, update)
})

test("native updates exceed former rolling frame and byte quotas", async t => {
  const seen: sessionEvents.AcpObservation[] = []
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), prompt(request, send) {
    for (let i = 0; i < 300; i++) send(updateFrame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(32768) } }))
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal((await peer.connection.prompt("challenge", new AbortController().signal)).stopReason, "end_turn")
  assert.equal(seen.length, 300)
})

test("ACP times out a backpressured prompt write", async t => {
  const peer = scriptedAcp(t)
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const original = peer.writable._write.bind(peer.writable)
  peer.writable._write = (_chunk, _encoding, _callback) => undefined
  t.after(() => { peer.writable._write = original })
  const pending = peer.connection.prompt("challenge", new AbortController().signal)
  t.mock.timers.tick(5000)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
})

test("ACP permits only one active prompt", async t => {
  const peer = scriptedAcp(t, "exact", { prompt() {} }), firstController = new AbortController()
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const first = peer.connection.prompt("first", firstController.signal)
  await assert.rejects(peer.connection.prompt("second", new AbortController().signal), { code: "NOT_READY" })
  firstController.abort()
  await assert.rejects(first)
})

test("ordinary configuration updates remain authoritative during a turn", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    peer.triggerDrift()
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal((await peer.connection.prompt("challenge", new AbortController().signal)).stopReason, "end_turn")
})

test("ACP accepts bounded provider tool notifications while retaining only answer text", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    for (const update of [
      { sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read package", kind: "read", status: "in_progress", rawInput: { path: "agency/package.json" } },
      { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "file data" } }] },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
    ]) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update } })
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.deepEqual(await peer.connection.prompt("read package", new AbortController().signal), { stopReason: "end_turn", text: "answer" })
  assert.deepEqual(peer.permissionReplies, [])
})

for (const method of ["fs/read_text_file", "fs/write_text_file", "terminal/create", "terminal/output", "terminal/release", "terminal/wait_for_exit", "terminal/kill", "fixture/unknown"]) test(`unsupported client RPC ${method} does not kill the provider`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    send({ jsonrpc: "2.0", id: "client-1", method, params: { sessionId: "fixture-session" } })
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal((await peer.connection.prompt("challenge", new AbortController().signal)).stopReason, "end_turn")
  assert.deepEqual(peer.permissionReplies, [{ jsonrpc: "2.0", id: "client-1", error: { code: -32601, message: "Client RPC is not supported" } }])
})

const permission = (overrides: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId: "fixture-session", toolCall: { toolCallId: "tool-1", title: "fixture" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], ...overrides } })
for (const [name, request] of [
  ["wrong session", permission({ sessionId: "other-session" })],
  ["missing tool identity", permission({ toolCall: { title: "fixture" } })],
  ["duplicate options", permission({ options: [{ optionId: "same", name: "One", kind: "allow_once" }, { optionId: "same", name: "Two", kind: "reject_once" }] })],
  ["too many options", permission({ options: Array.from({ length: 33 }, (_, index) => ({ optionId: `option-${index}`, name: "Choice", kind: "reject_once" })) })],
  ["invalid option kind", permission({ options: [{ optionId: "allow", name: "Allow", kind: "selected" }] })],
] as const) test(`ACP rejects malformed permission request: ${name}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send(request) } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
  assert.deepEqual(peer.permissionReplies, [])
})

for (const kind of ["allow_once", "allow_always", "reject_once", "reject_always"] as const) test(`permission option ${kind} is routed without an automatic decision`, async t => {
  const requests: any[] = [], request = permission({ options: [{ optionId: kind, name: "Choice", kind }] })
  let prompt: any
  const peer = scriptedAcp(t, "exact", { onRequest: message => requests.push(message), prompt(message, send) { prompt = message; send(request) } })
  await peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const pending = peer.connection.prompt("challenge", new AbortController().signal)
  assert.deepEqual(requests, [request])
  assert.deepEqual(peer.permissionReplies, [])
  peer.connection.respond("permission-1", { outcome: { outcome: "selected", optionId: kind } })
  peer.send({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } })
  assert.equal((await pending).stopReason, "end_turn")
  assert.deepEqual(peer.permissionReplies, [{ jsonrpc: "2.0", id: "permission-1", result: { outcome: { outcome: "selected", optionId: kind } } }])
})

test("production evidence follows the production contract without widening ACP", async t => {
  const peer = scriptedAcp(t, "exact", { productionContract: true })
  const session = await peer.connection.initialize({ ...sampleAgent(), ...splitLaunchSpec(sampleProductionSpec()) }, sampleProductionContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal(session.protocolVersion, 1)
  assert.deepEqual(peer.sent.map(value => value.method), ["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/set_config_option"])
  assert.deepEqual(peer.sent.slice(2).map(value => value.params), [
    { sessionId: "fixture-session", configId: "model", value: "gpt-5.6-sol" },
    { sessionId: "fixture-session", configId: "reasoning_effort", value: "high" },
    { sessionId: "fixture-session", configId: "mode", value: "read-only" },
  ])
})

test("the remaining overall budget only tightens production RPC deadlines", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const peer = scriptedAcp(t, "hang", { productionContract: true })
  peer.connection.close()
  const connection = createAcpConnection({ readable: peer.readable, writable: peer.writable, limits: sampleSpec().limits, deadline: 2000, now: () => Date.now() })
  t.after(() => connection.close())
  let settled = false
  const pending = connection.initialize({ ...sampleAgent(), ...splitLaunchSpec(sampleProductionSpec()) }, sampleProductionContract(), { kind: "new", params: {} }, new AbortController().signal)
  void pending.then(() => { settled = true }, () => { settled = true })
  t.mock.timers.tick(1999)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
  peer.send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })
  assert.equal(peer.sent.length, 1)
})

test("a session response after its deadline cannot win before the timer callback runs", async t => {
  let now = performance.now()
  t.mock.method(performance, "now", () => now)
  const peer = scriptedAcp(t, "exact", { productionContract: true, hold: 2 })
  const pending = peer.connection.initialize({ ...sampleAgent(), ...splitLaunchSpec(sampleProductionSpec()) }, sampleProductionContract(), { kind: "new", params: {} }, new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  now += 30001
  peer.send({ jsonrpc: "2.0", id: 2, result: { sessionId: "fixture-session", configOptions: [
    { id: "model", type: "select", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol" }] },
    { id: "reasoning_effort", type: "select", currentValue: "high", options: [{ value: "high" }] },
    { id: "mode", type: "select", currentValue: "read-only", options: [{ value: "read-only" }] },
  ] } })
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
  assert.equal(peer.sent.length, 2)
})

for (const [boundary, changed] of [[3, "model"], [4, "reasoning_effort"], [4, "model"], [5, "mode"], [5, "model"], [5, "reasoning_effort"]] as const) test(`ACP rejects substituted selected prefix at ${boundary}: ${changed}`, async t => {
  const peer = scriptedAcp(t, "exact", { productionContract: true, response(request, reply) {
    if (request.id === boundary) reply.result.configOptions = reply.result.configOptions.map((option: any) => option.id === changed ? { ...option, currentValue: option.id === "model" ? "initial-model" : option.id === "mode" ? "plan" : "low" } : option)
    return reply
  } })
  await assert.rejects(peer.connection.initialize({ ...sampleAgent(), ...splitLaunchSpec(sampleProductionSpec()) }, sampleProductionContract(), { kind: "new", params: {} }, new AbortController().signal), { code: "SELECTION_UNSUPPORTED" })
  assert.equal(peer.sent.length, boundary)
})

for (const boundary of [3, 4, 5]) test(`unsolicited options cannot repair a substituted response at ${boundary}`, async t => {
  let correct: unknown
  const peer = scriptedAcp(t, "exact", { productionContract: true, response(request, reply) {
    if (request.id === boundary) {
      correct = structuredClone(reply.result.configOptions)
      reply.result.configOptions = reply.result.configOptions.map((option: any) => option.id === "model" ? { ...option, currentValue: "initial-model" } : option)
    }
    return reply
  } })
  peer.writable.on("data", (bytes: Buffer) => {
    if (JSON.parse(bytes.toString()).id === boundary) peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "config_option_update", configOptions: correct } } })
  })
  await assert.rejects(peer.connection.initialize({ ...sampleAgent(), ...splitLaunchSpec(sampleProductionSpec()) }, sampleProductionContract(), { kind: "new", params: {} }, new AbortController().signal), { code: "SELECTION_UNSUPPORTED" })
  assert.equal(peer.sent.length, boundary)
})

for (const boundary of [2, 3, 4, 5]) for (const defect of ["missing-array", "missing-id", "duplicate-id", "duplicate-value", "malformed-group", "missing-group-id"] as const) test(`ACP validates option structure at ${boundary}: ${defect}`, async t => {
  const peer = scriptedAcp(t, "exact", { productionContract: true, response(request, reply) {
    if (request.id !== boundary) return reply
    const values = reply.result.configOptions
    if (defect === "missing-array") delete reply.result.configOptions
    if (defect === "missing-id") delete values[0].id
    if (defect === "duplicate-id") values.push(values[0])
    if (defect === "duplicate-value") values[0].options.push(values[0].options[0])
    if (defect === "malformed-group") values[0].options = [{ group: "x", options: {} }]
    if (defect === "missing-group-id") values[0].options = [{ options: values[0].options }]
    return reply
  } })
  await assert.rejects(peer.connection.initialize({ ...sampleAgent(), ...splitLaunchSpec(sampleProductionSpec()) }, sampleProductionContract(), { kind: "new", params: {} }, new AbortController().signal))
  assert.equal(peer.sent.length, boundary)
})

for (const defect of ["exact", "initialize", "option", "data", "extra", "missing-code", "missing-message", "alternate", "case", "fraction", "string-code", "result", "unsolicited", "string-id", "server-request", "notification", "oversized"] as const) test(`authentication evidence is specific to the pending session/new response: ${defect}`, async t => {
  const boundary = defect === "initialize" ? 1 : defect === "option" ? 3 : 2
  const peer = scriptedAcp(t, "exact", { response(request, reply) {
    if (request.id !== boundary) return reply
    const error: any = { code: -32000, message: "Authentication required" }
    if (defect === "data") error.data = null
    if (defect === "extra") error.extra = true
    if (defect === "missing-code") delete error.code
    if (defect === "missing-message") delete error.message
    if (defect === "alternate") error.message = "Authentication required."
    if (defect === "case") error.message = "authentication required"
    if (defect === "fraction") error.code = -32000.5
    if (defect === "string-code") error.code = "-32000"
    if (defect === "oversized") error.message = "x".repeat(1048577)
    const response: any = { jsonrpc: "2.0", id: request.id, error }
    if (defect === "result") response.result = {}
    if (defect === "unsolicited") response.id = 999
    if (defect === "string-id") response.id = String(request.id)
    if (defect === "server-request" || defect === "notification") response.method = "authenticate"
    if (defect === "notification") delete response.id
    return response
  } })
  await assert.rejects(peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal), (error: any) => ["exact", "data", "extra"].includes(defect) ? error.code === "AUTH_REQUIRED" : ["INVALID_PROTOCOL", "STARTUP_FAILED", "ACP_FRAME_LIMIT"].includes(error.code))
  assert.equal(peer.sent.length, boundary)
})

for (const [boundary, deadline] of [[1, 30000], [2, 30000], [3, 5000], [4, 5000], [5, 5000]] as const) test(`production ACP phase ${boundary} observes its own deadline`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const peer = scriptedAcp(t, "exact", { productionContract: true, hold: boundary })
  let settled = false
  const pending = peer.connection.initialize({ ...sampleAgent(), ...splitLaunchSpec(sampleProductionSpec()) }, sampleProductionContract(), { kind: "new", params: {} }, new AbortController().signal)
  void pending.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(peer.sent.length, boundary)
  t.mock.timers.tick(deadline - 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
})

for (const protocolVersion of [undefined, null, "1", 0, 2]) test(`production ACP rejects unsupported protocol version ${protocolVersion}`, async t => {
  const peer = scriptedAcp(t, "exact", { productionContract: true, response(request, reply) { if (request.method === "initialize") reply.result.protocolVersion = protocolVersion; return reply } })
  await assert.rejects(peer.connection.initialize({ ...sampleAgent(), ...splitLaunchSpec(sampleProductionSpec()) }, sampleProductionContract(), { kind: "new", params: {} }, new AbortController().signal), { code: "INVALID_PROTOCOL" })
  assert.equal(peer.sent.length, 1)
})

for (const boundary of [2, 3, 4, 5]) test(`production ACP rejects a missing required option at response ${boundary}`, async t => {
  const peer = scriptedAcp(t, "exact", { productionContract: true, response(request, reply) { if (request.id === boundary) reply.result.configOptions = reply.result.configOptions.filter((option: any) => option.id !== "model"); return reply } })
  await assert.rejects(peer.connection.initialize({ ...sampleAgent(), ...splitLaunchSpec(sampleProductionSpec()) }, sampleProductionContract(), { kind: "new", params: {} }, new AbortController().signal), { code: "SELECTION_UNSUPPORTED" })
  assert.equal(peer.sent.length, boundary)
})

for (const message of [undefined, null, "", false]) test(`malformed authentication error text is protocol failure: ${message}`, async t => {
  const peer = scriptedAcp(t, "exact", { response(request, reply) { return request.id === 2 ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message } } : reply } })
  await assert.rejects(peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

for (const scenario of ["exact", "fragmented", "grouped"]) test(`ACP confirms exact selections using bounded v1 setup: ${scenario}`, async t => {
  const peer = scriptedAcp(t, scenario), spec = sampleSpec()
  const session = await peer.connection.initialize({ ...sampleAgent(), ...splitLaunchSpec(spec) }, sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal(session.sessionId, "fixture-session")
  assert.equal(session.configuration.configOptions.find(option => option.id === "model")!.currentValue, "model-a")
  assert.equal(session.configuration.configOptions.find(option => option.id === "reasoning")!.currentValue, "high")
  assert.equal(session.configuration.configOptions.find(option => option.id === "mode")!.currentValue, "review")
  assert.deepEqual(peer.sent.map(request => request.method), ["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/set_config_option"])
  assert.deepEqual(peer.sent[0]!.params, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  assert.deepEqual(peer.sent[1]!.params, { cwd: spec.cwd, mcpServers: [] })
  assert.deepEqual(peer.sent.slice(2).map(request => [request.params.configId, request.params.value]), [["model", "model-a"], ["reasoning", "high"], ["mode", "review"]])
})

for (const scenario of ["alias", "clamp", "version", "missing", "duplicate-option", "empty-ack", "error", "auth", "utf8", "oversized", "empty-eof", "incomplete-eof", "wrong-id", "wrong-session"]) test(`ACP fails closed without prompt or authentication: ${scenario}`, async t => {
  const peer = scriptedAcp(t, scenario)
  await assert.rejects(peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal))
  assert.equal(peer.sent.some(request => ["session/prompt", "authenticate", "logout"].includes(request.method)), false)
  assert.equal(JSON.stringify(await peer.connection.fault).includes("sensitive remote diagnostic"), false)
})

test("abort rejects pending requests and removes listeners", async t => {
  const peer = scriptedAcp(t, "hang"), controller = new AbortController()
  const pending = peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, controller.signal)
  controller.abort()
  await assert.rejects(pending)
  peer.connection.close()
  assert.equal(peer.readable.listenerCount("data"), 0)
})

test("RPC timeout faults setup without a remote response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const peer = scriptedAcp(t, "hang"), pending = peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  t.mock.timers.tick(30001)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
})

test("stdout startup traffic is cumulatively bounded even when frames are small", async t => {
  const peer = scriptedAcp(t, "hang"), pending = peer.connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  for (let i = 0; i < 9; i++) peer.send({ jsonrpc: "2.0", method: "fixture/progress", params: { value: "x".repeat(1000000) } })
  await assert.rejects(pending)
  assert.equal((await peer.connection.fault).code, "INVALID_PROTOCOL")
})

test("backpressured provider writes use a deadline without a byte quota", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const writable = new Writable({ write() {} }), readable = new PassThrough()
  writable.write(Buffer.alloc(1048576))
  const connection = createAcpConnection({ writable, readable, limits: sampleSpec().limits })
  t.after(() => { connection.close(); readable.destroy(); writable.destroy() })
  const pending = connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const rejected = assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
  assert.ok(writable.writableLength > 1048576)
  t.mock.timers.tick(5000)
  await rejected
})

test("closing a blocked write disposes its timer as well as the RPC deadline", async t => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, active = new Set<NodeJS.Timeout>()
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms?: number) => {
    const timer = originalSet(() => { active.delete(timer); callback() }, ms)
    active.add(timer); return timer
  }) as typeof setTimeout)
  t.mock.method(globalThis, "clearTimeout", (timer: Parameters<typeof clearTimeout>[0]) => { active.delete(timer as NodeJS.Timeout); originalClear(timer) })
  const readable = new PassThrough(), writable = new Writable({ write() {} })
  const connection = createAcpConnection({ readable, writable, limits: sampleSpec().limits })
  t.after(() => { for (const timer of active) originalClear(timer); readable.destroy(); writable.destroy() })
  const pending = connection.initialize(sampleAgent(), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  connection.close()
  await assert.rejects(pending)
  assert.equal(active.size, 0)
})