import assert from "node:assert/strict"
import test from "node:test"
import { PassThrough, Writable } from "node:stream"
import { createAcpConnection } from "../src/agent/acp.js"
import type { PromptResult } from "../src/agent/types.js"
import { sampleContract, sampleSpec, sampleQualifiedContract, sampleQualifiedSpec, scriptedAcp } from "./agent-support.js"

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
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  const result: PromptResult = await peer.connection.prompt("challenge", new AbortController().signal)
  assert.deepEqual(result, { stopReason: "end_turn", text: "answer" })
  assert.deepEqual(peer.sent.at(-1), { jsonrpc: "2.0", id: 6, method: "session/prompt", params: { sessionId: "fixture-session", prompt: [{ type: "text", text: "challenge" }] } })
})

test("ACP rejects connection reuse before a delayed first-turn chunk can cross turns", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } })
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  assert.deepEqual(await peer.connection.prompt("first", new AbortController().signal), { stopReason: "end_turn", text: "answer" })
  await assert.rejects(peer.connection.prompt("second", new AbortController().signal), { code: "INVALID_AGENT_STATE" })
  assert.deepEqual(peer.sent.filter(request => request.method === "session/prompt").map(request => request.id), [6])
  peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "delayed-first-turn" } } } })
  assert.equal((await peer.connection.fault).code, "INVALID_PROTOCOL")
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
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  assert.deepEqual(await peer.connection.prompt("challenge", new AbortController().signal), { stopReason: "end_turn", text: "answer" })
})

for (const layer of ["session params", "config update", "current mode", "option", "group", "choice"] as const) test(`ACP bounds documented metadata on ${layer}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send(metadataNotification(layer, { value: "x".repeat(16384) })) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

test("ACP rejects end_turn without an answer chunk", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) { send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } }) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
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
] as const) test(`ACP rejects malformed informational update: ${name}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update } })
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

for (const content of [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "answer", extra: true }, { type: "text" }]) test(`ACP rejects non-exact answer content: ${JSON.stringify(content)}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content } } }) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

test("ACP rejects an answer chunk for another session", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } }) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

test("ACP faults on an unsolicited answer chunk", async t => {
  const peer = scriptedAcp(t)
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } })
  assert.equal((await peer.connection.fault).code, "INVALID_PROTOCOL")
})

for (const tail of [
  { jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } } } },
  { jsonrpc: "2.0", id: 6, result: { stopReason: "end_turn" } },
] as const) test(`ACP rejects activity after the prompt result: ${JSON.stringify(tail)}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } })
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
    send(tail)
  } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

test("ACP rejects an unknown prompt result ID", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send({ jsonrpc: "2.0", id: 999, result: { stopReason: "end_turn" } }) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

for (const result of [
  {}, { stopReason: null }, { stopReason: "end_turn", extra: true }, { stopReason: "end_turn", usage: { totalTokens: -1, inputTokens: 1, outputTokens: 1 } },
] as const) test(`ACP rejects malformed prompt result ${JSON.stringify(result)}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) { send({ jsonrpc: "2.0", id: request.id, result }) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

for (const stopReason of ["max_tokens", "max_turn_requests", "refusal", "cancelled"]) test(`ACP rejects prompt stop reason ${stopReason}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) { send({ jsonrpc: "2.0", id: request.id, result: { stopReason } }) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

test("ACP rejects EOF during a prompt", async t => {
  const peer = scriptedAcp(t, "exact", { prompt() { peer.readable.end() } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "STARTUP_FAILED" })
})

test("ACP abort rejects the active prompt and clears its listener", async t => {
  const peer = scriptedAcp(t, "exact", { prompt() {} }), controller = new AbortController()
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
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
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
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

test("ACP applies the 90 second prompt deadline", async t => {
  let now = 0
  const peer = scriptedAcp(t, "exact", { prompt() {}, now: () => now })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let settled = false
  const pending = peer.connection.prompt("challenge", new AbortController().signal)
  void pending.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  now = 89999; t.mock.timers.tick(89999)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  now = 90000; t.mock.timers.tick(1)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
})

test("ACP rejects an answer larger than 4096 bytes", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(4097) } } } }) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

test("ACP rejects an oversized frame during a prompt", async t => {
  const peer = scriptedAcp(t, "exact", { prompt() { peer.readable.write(Buffer.alloc(1048577, 32)) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

test("ACP bounds prompt frames in the rolling window", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) {
    for (let i = 0; i < 257; i++) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "usage_update", used: i, size: 1000 } } })
  } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

test("ACP bounds prompt bytes in the rolling window", async t => {
  const entries = Array.from({ length: 16 }, () => ({ content: "x".repeat(3800), priority: "low", status: "pending" }))
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) {
    for (let i = 0; i < 18; i++) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "plan", entries } } })
  } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

test("ACP times out a backpressured prompt write", async t => {
  const peer = scriptedAcp(t)
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
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
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  const first = peer.connection.prompt("first", firstController.signal)
  await assert.rejects(peer.connection.prompt("second", new AbortController().signal), { code: "INVALID_AGENT_STATE" })
  firstController.abort()
  await assert.rejects(first)
})

test("ACP rejects configuration drift during a prompt", async t => {
  const peer = scriptedAcp(t, "exact", { prompt() { peer.triggerDrift() } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "SELECTION_UNSUPPORTED" })
})

for (const sessionUpdate of ["tool_call", "tool_call_update"]) test(`ACP rejects ${sessionUpdate} during a prompt`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate, toolCallId: "tool-1", title: "fixture" } } }) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

for (const method of ["fs/read_text_file", "fs/write_text_file", "terminal/create", "terminal/output", "terminal/release", "terminal/wait_for_exit", "terminal/kill", "fixture/unknown"]) test(`ACP rejects forbidden client request ${method}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send({ jsonrpc: "2.0", id: "client-1", method, params: { sessionId: "fixture-session" } }) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
  assert.deepEqual(peer.permissionReplies, [])
})

const permission = (overrides: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId: "fixture-session", toolCall: { toolCallId: "tool-1", title: "fixture" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], ...overrides } })
for (const [name, request] of [
  ["extra request key", { ...permission(), extra: true }],
  ["extra params key", permission({ extra: true })],
  ["wrong session", permission({ sessionId: "other-session" })],
  ["missing tool identity", permission({ toolCall: { title: "fixture" } })],
  ["duplicate options", permission({ options: [{ optionId: "same", name: "One", kind: "allow_once" }, { optionId: "same", name: "Two", kind: "reject_once" }] })],
  ["too many options", permission({ options: Array.from({ length: 33 }, (_, index) => ({ optionId: `option-${index}`, name: "Choice", kind: "reject_once" })) })],
  ["invalid option kind", permission({ options: [{ optionId: "allow", name: "Allow", kind: "selected" }] })],
] as const) test(`ACP rejects malformed permission request: ${name}`, async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send(request) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "INVALID_PROTOCOL" })
  assert.deepEqual(peer.permissionReplies, [])
})

test("ACP cancels a valid permission request before failing the prompt", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send(permission()) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "PERMISSION_UNSUPPORTED" })
  assert.deepEqual(peer.permissionReplies, [{ jsonrpc: "2.0", id: "permission-1", result: { outcome: { outcome: "cancelled" } } }])
})

for (const kind of ["allow_once", "allow_always", "reject_once", "reject_always"] as const) test(`ACP cancels permission option kind ${kind}`, async t => {
  const request = permission({ options: [{ optionId: kind, name: "Choice", kind }] })
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send(request) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "PERMISSION_UNSUPPORTED" })
  assert.equal(peer.permissionReplies.length, 1)
})

test("ACP cancels the pinned adapter permission shape before failing the prompt", async t => {
  const request = permission({
    toolCall: { toolCallId: "tool-1", kind: "execute", status: "pending", title: "Run command", rawInput: { command: ["pwd"] }, locations: [{ path: "/checkout" }] },
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once", _meta: { permission: { version: 1, description: "one turn" } } },
      { optionId: "allow_always", name: "Always", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      { optionId: "reject_always", name: "Never", kind: "reject_always" },
    ],
    _meta: { permission: { version: 1, title: "Run command?" } },
  })
  const peer = scriptedAcp(t, "exact", { prompt(_request, send) { send(request) } })
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  await assert.rejects(peer.connection.prompt("challenge", new AbortController().signal), { code: "PERMISSION_UNSUPPORTED" })
  assert.deepEqual(peer.permissionReplies, [{ jsonrpc: "2.0", id: "permission-1", result: { outcome: { outcome: "cancelled" } } }])
})

test("production evidence follows the qualified contract without widening ACP", async t => {
  const peer = scriptedAcp(t, "exact", { qualified: true })
  const session = await peer.connection.initialize(sampleQualifiedSpec(), sampleQualifiedContract(), new AbortController().signal)
  assert.equal(session.permissionProfile, "deny-all")
  assert.equal(session.permissionEvidence, "agency-deny-all-v1")
  assert.deepEqual(peer.sent.map(value => value.method), ["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/set_config_option"])
  assert.deepEqual(peer.sent.slice(2).map(value => value.params), [
    { sessionId: "fixture-session", configId: "model", value: "gpt-5.6-sol" },
    { sessionId: "fixture-session", configId: "reasoning_effort", value: "high" },
    { sessionId: "fixture-session", configId: "mode", value: "read-only" },
  ])
})

test("qualified permission callback is cancelled before startup fails", async t => {
  const peer = scriptedAcp(t, "permission", { qualified: true })
  await assert.rejects(peer.connection.initialize(sampleQualifiedSpec(), sampleQualifiedContract(), new AbortController().signal), { code: "PERMISSION_UNSUPPORTED" })
  assert.deepEqual(peer.permissionReplies, [{ jsonrpc: "2.0", id: "request-1", result: { outcome: { outcome: "cancelled" } } }])
  assert.deepEqual(peer.sent.map(value => value.method), ["initialize", "session/new", "session/set_config_option"])
})

test("the remaining overall budget only tightens qualified RPC deadlines", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const peer = scriptedAcp(t, "hang", { qualified: true })
  peer.connection.close()
  const connection = createAcpConnection({ readable: peer.readable, writable: peer.writable, limits: sampleSpec().limits, deadline: 2000, now: () => Date.now() })
  t.after(() => connection.close())
  let settled = false
  const pending = connection.initialize(sampleQualifiedSpec(), sampleQualifiedContract(), new AbortController().signal)
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
  const peer = scriptedAcp(t, "exact", { qualified: true, hold: 2 })
  const pending = peer.connection.initialize(sampleQualifiedSpec(), sampleQualifiedContract(), new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  now += 15000
  peer.send({ jsonrpc: "2.0", id: 2, result: { sessionId: "fixture-session", configOptions: [
    { id: "model", type: "select", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol" }] },
    { id: "reasoning_effort", type: "select", currentValue: "high", options: [{ value: "high" }] },
    { id: "mode", type: "select", currentValue: "read-only", options: [{ value: "read-only" }] },
  ] } })
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
  assert.equal(peer.sent.length, 2)
})

for (const [boundary, changed] of [[3, "model"], [4, "reasoning_effort"], [4, "model"], [5, "mode"], [5, "model"], [5, "reasoning_effort"]] as const) test(`ACP rejects substituted selected prefix at ${boundary}: ${changed}`, async t => {
  const peer = scriptedAcp(t, "exact", { qualified: true, response(request, reply) {
    if (request.id === boundary) reply.result.configOptions = reply.result.configOptions.map((option: any) => option.id === changed ? { ...option, currentValue: "substitute" } : option)
    return reply
  } })
  await assert.rejects(peer.connection.initialize(sampleQualifiedSpec(), sampleQualifiedContract(), new AbortController().signal), { code: "SELECTION_UNSUPPORTED" })
  assert.equal(peer.sent.length, boundary)
})

for (const boundary of [3, 4, 5]) test(`unsolicited options cannot repair a substituted response at ${boundary}`, async t => {
  let correct: unknown
  const peer = scriptedAcp(t, "exact", { qualified: true, response(request, reply) {
    if (request.id === boundary) {
      correct = structuredClone(reply.result.configOptions)
      reply.result.configOptions = reply.result.configOptions.map((option: any) => option.id === "model" ? { ...option, currentValue: "substitute" } : option)
    }
    return reply
  } })
  peer.writable.on("data", (bytes: Buffer) => {
    if (JSON.parse(bytes.toString()).id === boundary) peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "config_option_update", configOptions: correct } } })
  })
  await assert.rejects(peer.connection.initialize(sampleQualifiedSpec(), sampleQualifiedContract(), new AbortController().signal), { code: "SELECTION_UNSUPPORTED" })
  assert.equal(peer.sent.length, boundary)
})

for (const boundary of [2, 3, 4, 5]) for (const defect of ["missing-array", "missing-id", "duplicate-id", "duplicate-value", "malformed-group", "missing-group-id"] as const) test(`ACP validates option structure at ${boundary}: ${defect}`, async t => {
  const peer = scriptedAcp(t, "exact", { qualified: true, response(request, reply) {
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
  await assert.rejects(peer.connection.initialize(sampleQualifiedSpec(), sampleQualifiedContract(), new AbortController().signal))
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
  await assert.rejects(peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal), (error: any) => defect === "exact" ? error.code === "AUTH_REQUIRED" : ["INVALID_PROTOCOL", "STARTUP_FAILED"].includes(error.code))
  assert.equal(peer.sent.length, boundary)
})

for (const [boundary, deadline] of [[1, 15000], [2, 15000], [3, 5000], [4, 5000], [5, 5000]] as const) test(`qualified ACP phase ${boundary} observes its own deadline`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const peer = scriptedAcp(t, "exact", { qualified: true, hold: boundary })
  let settled = false
  const pending = peer.connection.initialize(sampleQualifiedSpec(), sampleQualifiedContract(), new AbortController().signal)
  void pending.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(peer.sent.length, boundary)
  t.mock.timers.tick(deadline - 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
})

for (const protocolVersion of [undefined, null, "1", 0, 2]) test(`qualified ACP rejects unsupported protocol version ${protocolVersion}`, async t => {
  const peer = scriptedAcp(t, "exact", { qualified: true, response(request, reply) { if (request.method === "initialize") reply.result.protocolVersion = protocolVersion; return reply } })
  await assert.rejects(peer.connection.initialize(sampleQualifiedSpec(), sampleQualifiedContract(), new AbortController().signal), { code: "INVALID_PROTOCOL" })
  assert.equal(peer.sent.length, 1)
})

for (const boundary of [2, 3, 4, 5]) test(`qualified ACP rejects a missing required option at response ${boundary}`, async t => {
  const peer = scriptedAcp(t, "exact", { qualified: true, response(request, reply) { if (request.id === boundary) reply.result.configOptions = reply.result.configOptions.filter((option: any) => option.id !== "model"); return reply } })
  await assert.rejects(peer.connection.initialize(sampleQualifiedSpec(), sampleQualifiedContract(), new AbortController().signal), { code: "SELECTION_UNSUPPORTED" })
  assert.equal(peer.sent.length, boundary)
})

for (const message of [undefined, null, "", false]) test(`malformed authentication error text is protocol failure: ${message}`, async t => {
  const peer = scriptedAcp(t, "exact", { response(request, reply) { return request.id === 2 ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message } } : reply } })
  await assert.rejects(peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal), { code: "INVALID_PROTOCOL" })
})

for (const scenario of ["exact", "fragmented", "grouped"]) test(`ACP confirms exact selections using bounded v1 setup: ${scenario}`, async t => {
  const peer = scriptedAcp(t, scenario), spec = sampleSpec()
  const session = await peer.connection.initialize(spec, sampleContract(), new AbortController().signal)
  assert.equal(session.sessionId, "fixture-session")
  assert.equal(session.modelId, "model-a")
  assert.deepEqual(session.reasoning, { kind: "value", value: "high" })
  assert.equal(session.mode, "review")
  assert.equal(session.permissionEvidence, "fixture-contract-v1")
  assert.deepEqual(peer.sent.map(request => request.method), ["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/set_config_option"])
  assert.deepEqual(peer.sent[0]!.params, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  assert.deepEqual(peer.sent[1]!.params, { cwd: "/checkout", mcpServers: [] })
  assert.deepEqual(peer.sent.slice(2).map(request => [request.params.configId, request.params.value]), [["model", "model-a"], ["reasoning", "high"], ["mode", "review"]])
})

for (const scenario of ["alias", "clamp", "version", "missing", "duplicate-option", "empty-ack", "error", "auth", "utf8", "oversized", "empty-eof", "incomplete-eof", "wrong-id", "duplicate-id", "wrong-session", "filesystem", "terminal"]) test(`ACP fails closed without prompt or authentication: ${scenario}`, async t => {
  const peer = scriptedAcp(t, scenario)
  await assert.rejects(peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal))
  assert.equal(peer.sent.some(request => ["session/prompt", "authenticate", "logout"].includes(request.method)), false)
  assert.equal(JSON.stringify(await peer.connection.fault).includes("sensitive remote diagnostic"), false)
})

test("permission callbacks receive cancelled, never selected authority", async t => {
  const peer = scriptedAcp(t, "permission")
  await assert.rejects(peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal))
  assert.deepEqual(peer.permissionReplies, [{ jsonrpc: "2.0", id: "request-1", result: { outcome: { outcome: "cancelled" } } }])
  assert.equal((await peer.connection.fault).code, "PERMISSION_UNSUPPORTED")
})

test("abort rejects pending requests and removes listeners", async t => {
  const peer = scriptedAcp(t, "hang"), controller = new AbortController()
  const pending = peer.connection.initialize(sampleSpec(), sampleContract(), controller.signal)
  controller.abort()
  await assert.rejects(pending)
  peer.connection.close()
  assert.equal(peer.readable.listenerCount("data"), 0)
})

test("RPC timeout faults setup without a remote response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const peer = scriptedAcp(t, "hang"), pending = peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  t.mock.timers.tick(5001)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
})

test("post-ready configuration drift faults the same session", async t => {
  const peer = scriptedAcp(t)
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  peer.triggerDrift()
  assert.equal((await peer.connection.fault).code, "SELECTION_UNSUPPORTED")
})

test("post-ready notifications cannot exceed rolling frame budget", async t => {
  const peer = scriptedAcp(t)
  await peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  for (let i = 0; i < 257; i++) peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } })
  assert.equal((await peer.connection.fault).code, "INVALID_PROTOCOL")
})

test("stdout startup traffic is cumulatively bounded even when frames are small", async t => {
  const peer = scriptedAcp(t, "hang"), pending = peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  for (let i = 0; i < 9; i++) peer.send({ jsonrpc: "2.0", method: "fixture/progress", params: { value: "x".repeat(1000000) } })
  await assert.rejects(pending)
  assert.equal((await peer.connection.fault).code, "INVALID_PROTOCOL")
})

test("backpressured output cannot exceed the write queue limit", async t => {
  const writable = new Writable({ write() {} }), readable = new PassThrough()
  writable.write(Buffer.alloc(1048576))
  const connection = createAcpConnection({ writable, readable, limits: sampleSpec().limits })
  t.after(() => { connection.close(); readable.destroy(); writable.destroy() })
  await assert.rejects(connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal))
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
  const pending = connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  connection.close()
  await assert.rejects(pending)
  assert.equal(active.size, 0)
})

test("a permission callback before final acknowledgement cannot briefly publish readiness", async t => {
  const peer = scriptedAcp(t, "late-permission"), original = peer.writable._write.bind(peer.writable)
  let release = () => {}, settled = false
  peer.writable._write = (chunk: Buffer, encoding, callback) => original(chunk, encoding, error => {
    if (JSON.parse(chunk.toString()).method) callback(error)
    else release = () => callback(error)
  })
  t.after(() => release())
  const startup = peer.connection.initialize(sampleSpec(), sampleContract(), new AbortController().signal)
  void startup.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  release()
  await assert.rejects(startup, { code: "PERMISSION_UNSUPPORTED" })
})