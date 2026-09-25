import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer, createConnection, type Socket } from "node:net"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { Duplex } from "node:stream"
import { parseRequest, parseReply, validateReplyForRequest, exitCode, type ControlRequest, type ControlReply } from "../src/control/protocol.js"
import { exchange, receiveFrame, serveControl, sendReply } from "../src/control/wire.js"
import { privateRoot } from "./control-support.js"

const request = (): ControlRequest => ({ protocol: "agency-control/1", requestId: randomUUID(), handlerGeneration: randomUUID(), op: "status" })
const response = (r: ControlRequest): ControlReply => ({ protocol: r.protocol, requestId: r.requestId, handlerGeneration: r.handlerGeneration, ok: true, result: { hostId: "a".repeat(64), handlerGeneration: r.handlerGeneration, phase: "ready", reconciliation: { classified: 1, total: 1, quarantined: 1 }, launches: [{ launchAttemptId: "historical", agentId: "agent-a", checkoutId: "checkout-a", phase: "quarantined", reason: "ambiguous" }], capabilities: ["status", "doctor", "shutdown"] } })

test("reply write failure remains handled through callback-before-error closure", async () => {
  const socket = new Duplex({ read() {}, write(_bytes, _encoding, callback) { callback(new Error("synthetic EPIPE")) } })
  await sendReply(socket as Socket, response(request()))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(socket.closed)
  assert.equal(socket.listenerCount("error"), 0)
  assert.equal(socket.listenerCount("close"), 0)
})

test("client failure during asynchronous dispatch does not escape the server", async () => {
  const socket = new Duplex({ read() {}, write(_bytes, _encoding, callback) { callback() } })
  let started: () => void = () => undefined, release: () => void = () => undefined
  const dispatched = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const serving = serveControl(socket as Socket, async r => { started(); await pending; return response(r) })
  socket.push(JSON.stringify(request()) + "\n"); socket.push(null)
  await dispatched
  socket.destroy(new Error("synthetic connection reset during cleanup"))
  await new Promise(resolve => setImmediate(resolve))
  release()
  await serving
  assert.ok(socket.closed)
  assert.equal(socket.listenerCount("error"), 0)
  assert.equal(socket.listenerCount("close"), 0)
})

async function connect(t: TestContext, listener: (socket: Socket) => void): Promise<Socket> {
  const root = await privateRoot(t)
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, socket => { sockets.add(socket); socket.on("error", () => undefined); listener(socket) })
  await new Promise<void>(resolve => server.listen(join(root, "s"), resolve))
  const socket = createConnection(join(root, "s"))
  socket.on("error", () => undefined)
  t.after(async () => { socket.destroy(); for (const s of sockets) s.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return socket
}

test("strict requests reject invalid versions, identifiers, extra authority and unknown operations", () => {
  const r = request()
  assert.deepEqual(parseRequest(r), r)
  for (const value of [null, [], "x", { ...r, protocol: "other" }, { ...r, requestId: "../x" }, { ...r, role: "human" }, { ...r, op: "agent.start" }, { ...r, op: "shutdown", commandId: randomUUID(), stopAgents: "false" }]) assert.throws(() => parseRequest(value), /INVALID_PROTOCOL/)
})

test("replies preserve historical IDs but bind request, operation and both generation fields", () => {
  const r = request(), reply = response(r)
  assert.deepEqual(parseReply(reply), reply)
  validateReplyForRequest(parseReply(reply), r)
  assert.throws(() => validateReplyForRequest({ ...reply, handlerGeneration: randomUUID() }, r), /STALE_HANDLER/)
  assert.throws(() => validateReplyForRequest({ ...reply, requestId: randomUUID() }, r), /INVALID_PROTOCOL/)
  assert.throws(() => validateReplyForRequest({ ...reply, ok: true, result: { state: "shutdown_accepted", commandId: randomUUID(), handlerGeneration: r.handlerGeneration } }, r), /INVALID_PROTOCOL/)
  const raw = JSON.parse(JSON.stringify(reply))
  raw.result.handlerGeneration = randomUUID()
  assert.throws(() => validateReplyForRequest(parseReply(raw), r), /STALE_HANDLER/)
  for (const change of [{ phase: "active" }, { reconciliation: { classified: 3, total: 1, quarantined: 0 } }, { hostId: "bad" }, { capabilities: ["status", "shell"] }]) assert.throws(() => parseReply({ ...raw, result: { ...raw.result, ...change } }), /INVALID_PROTOCOL/)
  assert.deepEqual(["USAGE", "INVALID_PROTOCOL", "STALE_HANDLER", "UNAVAILABLE", "INTERNAL", "INCOMPLETE", "ACTIVE_AGENTS", "COMMAND_CONFLICT"].map(code => exitCode(code as Parameters<typeof exitCode>[0])), [64, 65, 69, 69, 70, 75, 75, 75])
})

test("one-shot exchange accepts fragmented UTF-8 and removes listeners", async t => {
  const r = request(), reply = response(r)
  if (reply.ok && "launches" in reply.result) reply.result.launches[0]!.reason = "évidence"
  const bytes = Buffer.from(JSON.stringify(reply) + "\n")
  const offset = bytes.indexOf(Buffer.from("é")) + 1
  const socket = await connect(t, s => { s.resume(); s.on("end", () => { s.write(bytes.subarray(0, offset)); setImmediate(() => s.end(bytes.subarray(offset))) }) })
  const original = new Map(["data", "end", "close"].map(event => [event, socket.listeners(event)]))
  assert.deepEqual(await exchange(socket, r, 500), reply)
  for (const event of ["data", "end", "close"]) assert.ok(socket.listeners(event).every(listener => original.get(event)!.includes(listener)))
})

for (const [name, bytes] of [["duplicate", Buffer.from("{}\n{}\n")], ["missing LF", Buffer.from("{}")], ["invalid UTF-8", Buffer.from([0xc3, 0x28, 10])], ["non-JSON", Buffer.from("invalid\n")], ["oversized", Buffer.alloc(8 * 1024 * 1024 + 2, 32)]] as const) test(`framing rejects ${name}`, async t => {
  const socket = await connect(t, s => s.end(bytes))
  await assert.rejects(receiveFrame(socket, 500), /INVALID_PROTOCOL/)
  assert.equal(socket.listenerCount("data"), 0)
})

test("timeouts and closed sockets settle without retained data listeners", async t => {
  const socket = await connect(t, () => undefined)
  await assert.rejects(receiveFrame(socket, 20), /INCOMPLETE/)
  assert.equal(socket.listenerCount("data"), 0)
  socket.destroy()
  await assert.rejects(receiveFrame(socket, 20), /UNAVAILABLE/)
})

test("server rejects a second request in another chunk without dispatching either", async t => {
  let calls = 0
  const socket = await connect(t, s => { void serveControl(s, async r => { calls++; return response(r) }, 500) })
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()))
  socket.write(JSON.stringify(request()) + "\n")
  await new Promise(resolve => setTimeout(resolve, 10))
  socket.end(JSON.stringify(request()) + "\n")
  await closed
  assert.equal(calls, 0)
})

test("server and client exchange one validated request and bound oversized responses", async t => {
  const r = request()
  const socket = await connect(t, s => { void serveControl(s, async incoming => response(incoming), 500) })
  assert.deepEqual(await exchange(socket, r, 500), response(r))
  const large = await connect(t, s => { void serveControl(s, async incoming => {
    const reply = response(incoming)
    if (reply.ok && "launches" in reply.result) reply.result.launches[0]!.reason = "x".repeat(8 * 1024 * 1024)
    return reply
  }, 500) })
  const reply = await exchange(large, r, 1000)
  assert.equal(reply.ok, false)
  if (!reply.ok) assert.equal(reply.error.code, "INCOMPLETE")
})