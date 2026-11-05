import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { PassThrough } from "node:stream"
import { createAcpConnection } from "../src/agent/acp.js"
import { AGENT_LIMITS, normalizeAgentRecord, splitLaunchSpec } from "../src/agent/types.js"
import type { JsonObject } from "../src/agent/session-config.js"
import type { AcpObservation } from "../src/agent/session-events.js"
import { sampleContract, sampleSpec } from "./agent-support.js"

const option = (value: boolean): JsonObject => ({ id: "fixture", type: "boolean", currentValue: value })
const text = (value: string): JsonObject => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } })
const frame = (update: JsonObject, sessionId = "fixture-session"): JsonObject => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })
function fixture(t: TestContext, deadline = performance.now() + 5000) {
  const readable = new PassThrough(), writable = new PassThrough(), events: AcpObservation[] = []
  const connection = createAcpConnection({ readable, writable, limits: AGENT_LIMITS, deadline, onUpdate: event => events.push(event) })
  t.after(() => { connection.close(); readable.destroy(); writable.destroy() })
  const requested = Promise.withResolvers<number>()
  void requested.promise.catch(() => undefined)
  const send = (value: JsonObject) => readable.write(JSON.stringify(value) + "\n")
  writable.on("data", bytes => {
    const request = JSON.parse(bytes.toString())
    if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
    if (request.method === "session/new") requested.resolve(request.id)
  })
  const record = { ...normalizeAgentRecord({ version: 2, ...splitLaunchSpec(sampleSpec()), phase: "starting", session: null, failure: null }), settings: { configValues: {} } }
  const start = () => {
    const promise = connection.initialize(record, sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
    void promise.catch(error => requested.reject(error))
    return promise
  }
  return { connection, events, requested: requested.promise, start, send,
    async release(result: JsonObject = { sessionId: "fixture-session", configOptions: [] }) { send({ jsonrpc: "2.0", id: await requested.promise, result }) },
  }
}

test("early updates wait for identity and override the response baseline in order", async t => {
  const f = fixture(t), started = f.start(); await f.requested
  f.send(frame(text("first")))
  f.send(frame({ sessionUpdate: "config_option_update", configOptions: [option(true)] }))
  f.send(frame({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "fixture", description: "fixture command" }] }))
  f.send({ ...frame(text("last")), _meta: { trace: "fixture" }, params: { ...frame(text("last")).params as JsonObject, _meta: { fixture: true } } })
  assert.equal(f.events.length, 0)
  assert.deepEqual(f.connection.snapshot().configOptions, [])
  await f.release({ sessionId: "fixture-session", configOptions: [option(false)] })
  const session = await started
  assert.equal(session.sessionId, "fixture-session")
  assert.deepEqual(f.events.map(event => event.update.sessionUpdate), ["agent_message_chunk", "config_option_update", "available_commands_update", "agent_message_chunk"])
  assert.ok(f.events.every(event => !event.replay))
  assert.deepEqual(f.events[3]!.params, { _meta: { fixture: true } })
  assert.deepEqual(f.events[3]!.meta, { trace: "fixture" })
  assert.deepEqual(f.connection.snapshot().configOptions, [option(true)])
  assert.deepEqual(f.connection.snapshot().availableCommands, [{ name: "fixture", description: "fixture command" }])
  f.send(frame(text("live")))
  assert.equal(f.events.length, 5)
})

test("all early identities must match the response before any publication", async t => {
  const f = fixture(t), started = f.start(); await f.requested
  f.send(frame(text("first"))); f.send(frame(text("last")))
  await f.release({ sessionId: "other-session", configOptions: [] })
  await assert.rejects(started, { code: "INVALID_PROTOCOL" })
  assert.equal(f.events.length, 0)
})

for (const [name, invalid] of [
  ["mixed native IDs", frame(text("wrong"), "other-session")],
  ["empty native ID", frame(text("wrong"), "")],
  ["malformed update", frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: false } })],
  ["early permission RPC", { ...frame({}), id: "permission", method: "session/request_permission", params: { sessionId: "fixture-session", options: [], toolCall: {} } }],
 ] satisfies Array<[string, JsonObject]>) {
  test("early updates reject " + name, async t => {
    const f = fixture(t), started = f.start(); await f.requested
    f.send(frame(text("queued"))); f.send(invalid)
    await assert.rejects(started, { code: "INVALID_PROTOCOL" })
    assert.equal(f.events.length, 0)
  })
}

test("updates before an initialized new request are rejected", async t => {
  const f = fixture(t)
  f.send(frame(text("unsolicited")))
  assert.equal((await f.connection.fault).code, "INVALID_PROTOCOL")
  await assert.rejects(f.start(), { code: "INVALID_PROTOCOL" })
  assert.equal(f.events.length, 0)
})

test("queued malformed configuration rejects the original new waiter", { timeout: 1000 }, async t => {
  const f = fixture(t), started = f.start(); await f.requested
  f.send(frame({ sessionUpdate: "config_option_update", configOptions: [{}] }))
  await f.release()
  await assert.rejects(started, { code: "INVALID_PROTOCOL" })
  assert.equal(f.events.length, 0)
})

for (const kind of ["error", "close", "timeout"] as const) {
  test("unpublished updates are discarded on " + kind, async t => {
    if (kind === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] })
    const f = fixture(t), started = f.start(); await f.requested
    f.send(frame(text("private queued text")))
    if (kind === "error") f.send({ jsonrpc: "2.0", id: await f.requested, error: { code: -32000, message: "startup failed" } })
    if (kind === "close") f.connection.close()
    if (kind === "timeout") t.mock.timers.tick(5001)
    await assert.rejects(started, { code: kind === "timeout" ? "STARTUP_TIMEOUT" : "STARTUP_FAILED" })
    assert.equal(f.events.length, 0)
  })
}

for (const count of [128, 129]) {
  test("early update count " + count + " is " + (count === 128 ? "accepted" : "rejected"), async t => {
    const f = fixture(t), started = f.start(); await f.requested
    for (let index = 0; index < count; index++) f.send(frame(text(String(index))))
    assert.equal(f.events.length, 0)
    if (count === 128) { await f.release(); await started; assert.equal(f.events.length, count) }
    else await assert.rejects(started, { code: "INVALID_PROTOCOL" })
  })
}

function sized(bytes: number): JsonObject {
  const base = frame(text("")), overhead = Buffer.byteLength(JSON.stringify(base)) + 1
  return frame(text("x".repeat(bytes - overhead)))
}
for (const [name, payloads, accepted] of [
  ["one MiB frame", [sized(1048576)], true],
  ["oversized frame", [sized(1048577)], false],
  ["eight MiB queue", Array.from({ length: 8 }, () => sized(1048576)), true],
  ["oversized queue", [...Array.from({ length: 8 }, () => sized(1048576)), frame(text("overflow"))], false],
] as const) {
  test("early buffer " + name, async t => {
    const f = fixture(t), started = f.start(); await f.requested
    for (const payload of payloads) f.send(payload)
    assert.equal(f.events.length, 0)
    if (accepted) { await f.release(); await started; assert.equal(f.events.length, payloads.length) }
    else await assert.rejects(started, { code: "INVALID_PROTOCOL" })
  })
}

test("confirmed session updates retain their unbounded transport behavior", async t => {
  const f = fixture(t), started = f.start(); await f.requested; await f.release(); await started
  f.send(sized(1048577))
  assert.equal(f.events.length, 1)
  f.send(frame(text("next")))
  assert.equal(f.events.length, 2)
})