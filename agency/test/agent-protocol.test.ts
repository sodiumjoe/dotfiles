import assert from "node:assert/strict"
import test from "node:test"
import { createConnection, createServer } from "node:net"
import { join } from "node:path"
import { readdir } from "node:fs/promises"
import { AGENT_PROTOCOL, agentErrorReply, exchangeAgent, parseAgentReply, parseAgentRequest, validateAgentReply, type AgentReply, type AgentRequest } from "../src/agent/protocol.js"
import { AgentError } from "../src/agent/types.js"
import { CheckoutResolutionError } from "../src/checkout/identity.js"
import { parseRequest, parseReply } from "../src/control/protocol.js"
import { serveProtocols } from "../src/control/wire.js"
import { privateRoot, controlFixture } from "./control-support.js"
import { agentId, sampleCommand } from "./agent-support.js"

const request = (): AgentRequest => ({ protocol: AGENT_PROTOCOL, requestId: agentId(10), handlerGeneration: agentId(2), op: "agent_start", input: sampleCommand().input as import("../src/agent/types.js").StartInput })
const response = (r: AgentRequest): AgentReply => ({ protocol: AGENT_PROTOCOL, requestId: r.requestId, handlerGeneration: r.handlerGeneration, commandId: agentId(6), ok: true, result: { state: "command", command: sampleCommand(), durability: "verified" } })

test("agent framing preserves strict independent envelopes and command identity", () => {
  const r = request(), reply = response(r)
  assert.deepEqual(parseAgentRequest(r), r); assert.deepEqual(parseAgentReply(reply), reply)
  assert.throws(() => parseRequest(r)); assert.throws(() => parseReply(reply))
  for (const value of [{ ...r, extra: true }, { ...r, protocol: "agency-agent/2" }, { ...r, input: { ...(r as AgentRequest & { op: "agent_start" }).input, handlerGeneration: agentId(100) } }, { ...r, handlerGeneration: null }]) assert.throws(() => parseAgentRequest(value), { code: "INVALID_PROTOCOL" })
  for (const value of [{ ...reply, extra: true }, { ...reply, commandId: agentId(55) }, { ...reply, result: { state: "command", command: sampleCommand(), durability: "claimed" } }]) assert.throws(() => parseAgentReply(value), { code: "INVALID_PROTOCOL" })
  assert.throws(() => validateAgentReply({ ...reply, requestId: agentId(100) }, r), { code: "INVALID_PROTOCOL" })
  assert.throws(() => validateAgentReply({ ...reply, handlerGeneration: agentId(100) }, r), { code: "STALE_HANDLER" })
  assert.throws(() => validateAgentReply(reply, { protocol: AGENT_PROTOCOL, requestId: r.requestId, handlerGeneration: r.handlerGeneration, op: "agent_list" }), { code: "INVALID_PROTOCOL" })
})

test("historical command generation is independent of the serving Handler", () => {
  const old = sampleCommand(), r: AgentRequest = { protocol: AGENT_PROTOCOL, requestId: agentId(10), handlerGeneration: agentId(99), op: "agent_command", commandId: old.commandId, commandGeneration: old.handlerGeneration }
  const reply = parseAgentReply(response(r))
  assert.doesNotThrow(() => validateAgentReply(reply, r))
  assert.throws(() => validateAgentReply(reply, { ...r, commandGeneration: agentId(55) }), { code: "INVALID_PROTOCOL" })
})

test("one half-closed socket dispatches agent traffic without changing legacy framing", async t => {
  const root = await privateRoot(t), path = join(root, "socket")
  let calls = 0
  const server = createServer({ allowHalfOpen: true }, socket => { void serveProtocols(socket, async () => { throw new Error("wrong protocol") }, async () => { throw new Error("wrong protocol") }, 5000, async r => { calls++; return response(r) }) })
  await new Promise<void>(resolve => server.listen(path, resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  assert.deepEqual(await exchangeAgent(createConnection(path), request()), response(request()))
  assert.equal(calls, 1)
})

for (const [name, bytes, code] of [["empty", "", "UNAVAILABLE"], ["incomplete", "{}", "INVALID_PROTOCOL"], ["duplicate", "{}\n{}\n", "INVALID_PROTOCOL"], ["invalid UTF-8", Buffer.from([255, 10]), "INVALID_PROTOCOL"], ["oversized", Buffer.alloc(8 * 1024 * 1024 + 2), "INVALID_PROTOCOL"]] as const) test(`agent exchange rejects ${name} response`, async t => {
  const root = await privateRoot(t), path = join(root, "socket")
  const server = createServer({ allowHalfOpen: true }, socket => { socket.on("error", () => undefined); socket.resume(); socket.on("end", () => socket.end(bytes)) })
  await new Promise<void>(resolve => server.listen(path, resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  await assert.rejects(exchangeAgent(createConnection(path), request()), { code })
})

test("agent errors preserve retry identity and discard private diagnostics", () => {
  const r = request(), reply = agentErrorReply(r, new Error("private-provider-diagnostic"))
  assert.equal(reply.commandId, agentId(6)); assert.equal(reply.ok, false)
  assert.equal(JSON.stringify(reply).includes("private-provider-diagnostic"), false)
  assert.doesNotThrow(() => parseAgentReply(agentErrorReply(r, new AgentError("ADAPTER_UNQUALIFIED"))))
})

test("current outside a Git checkout is unavailable rather than an internal error", () => {
  const reply = agentErrorReply({ protocol: AGENT_PROTOCOL, requestId: agentId(10), handlerGeneration: agentId(2), op: "agent_current", cwd: "/outside" }, new CheckoutResolutionError("NOT_CHECKOUT", "private diagnostic"))
  assert.ok(!reply.ok && reply.error.code === "ADMISSION_UNAVAILABLE")
  assert.equal(JSON.stringify(reply).includes("private diagnostic"), false)
})

test("oversized agent history returns explicit incomplete instead of truncation", async t => {
  const root = await privateRoot(t), path = join(root, "socket")
  const server = createServer({ allowHalfOpen: true }, socket => { void serveProtocols(socket, async () => { throw new Error() }, async () => { throw new Error() }, 5000, async request => ({ protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, ok: true, result: { state: "agents", agents: [], unavailable: { code: "INCOMPLETE", message: "x".repeat(9 * 1024 * 1024) } } })) })
  await new Promise<void>(resolve => server.listen(path, resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const reply = await exchangeAgent(createConnection(path), { protocol: AGENT_PROTOCOL, requestId: agentId(10), handlerGeneration: agentId(2), op: "agent_list" })
  assert.ok(!reply.ok && reply.error.code === "INCOMPLETE")
})

test("production Handler exposes agent inspection but cannot select fixture launch contracts", async t => {
  const f = await controlFixture(t), handler = await f.start(), initial = sampleCommand().input as import("../src/agent/types.js").StartInput
  const reply = await exchangeAgent(createConnection(f.paths.handlerSocketPath), { protocol: AGENT_PROTOCOL, requestId: agentId(10), handlerGeneration: handler.record.generation, op: "agent_start", input: { ...initial, handlerGeneration: handler.record.generation } })
  assert.ok(!reply.ok && reply.error.code === "ADAPTER_UNQUALIFIED")
  const list = await exchangeAgent(createConnection(f.paths.handlerSocketPath), { protocol: AGENT_PROTOCOL, requestId: agentId(11), handlerGeneration: handler.record.generation, op: "agent_list" })
  assert.ok(list.ok && list.result.state === "agents" && list.result.agents.length === 0)
  assert.deepEqual(await readdir(join(f.paths.persistentRoot, "launches")), [])
  assert.ok((await f.call()).ok)
})