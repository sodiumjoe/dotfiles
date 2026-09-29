import assert from "node:assert/strict"
import test from "node:test"
import { PassThrough, Writable } from "node:stream"
import { createAcpConnection } from "../src/agent/acp.js"
import { sampleContract, sampleSpec, sampleQualifiedContract, sampleQualifiedSpec, scriptedAcp } from "./agent-support.js"

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