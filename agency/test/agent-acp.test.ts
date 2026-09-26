import assert from "node:assert/strict"
import test from "node:test"
import { PassThrough, Writable } from "node:stream"
import { createAcpConnection } from "../src/agent/acp.js"
import { sampleContract, sampleSpec, scriptedAcp } from "./agent-support.js"

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