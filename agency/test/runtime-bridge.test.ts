import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { createHandlerBridge } from "../src/bridge/server.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { registerRuntimeEndpoint } from "../src/hosts/runtime.js"
import { dispatchAgentRequest } from "../src/agent/dispatch.js"
import { AGENT_PROTOCOL, parseAgentReply, validateAgentReply, type AgentRequest } from "../src/agent/protocol.js"
import { agentServiceFixture } from "./agent-support.js"

async function fixture(t: Parameters<typeof agentServiceFixture>[0]) {
  const f = await agentServiceFixture(t)
  const identity = { hostId: f.context.paths.hostKey, handlerGeneration: f.service.handlerGeneration }
  const bridge = await createHandlerBridge({ root: f.root, identity, sourceRevision: "a".repeat(40) })
  let ready = true
  registerRuntimeEndpoint(bridge, request => dispatchAgentRequest({ agents: f.service, generation: identity.handlerGeneration, ready: () => ready }, request))
  const peer = await connectHandlerBridge({ root: f.root, ...identity })
  t.after(async () => { peer.close(); await bridge.close() })
  const request = (op: "agent_roster" | "agent_permissions" = "agent_roster"): AgentRequest => ({ protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: identity.handlerGeneration, ...(op === "agent_roster" ? { op, input: { limit: 100 } } : { op }) })
  return { ...f, identity, bridge, peer, request, unavailable() { ready = false } }
}

test("runtime bridge exposes ordinary controls without legacy composition", async t => {
  const f = await fixture(t), request = f.request()
  const first = parseAgentReply(await f.peer.request("runtime-read", request))
  validateAgentReply(first, request)
  assert.ok(first.ok && first.result.state === "page")
  assert.equal((await f.peer.ready).capabilities.includes("snapshot"), false)
  const next = parseAgentReply(await f.peer.request("runtime-read", f.request()))
  assert.ok(next.ok && next.result.state === "page")
  await assert.rejects(f.peer.request("snapshot", {}), /UNSUPPORTED_CAPABILITY/)
  assert.equal(f.spawns(), 0)
})

test("runtime bridge rejects cross-channel operations and malformed requests before effects", async t => {
  const f = await fixture(t), request = f.request()
  const wrong = parseAgentReply(await f.peer.request("runtime-write", request))
  assert.ok(!wrong.ok && wrong.error.code === "INVALID_PROTOCOL")
  const ref = { hostId: f.identity.hostId, target: { agentId: randomUUID(), handlerGeneration: f.identity.handlerGeneration, providerGeneration: randomUUID() }, permissionId: randomUUID(), revision: 1 }
  const mutation = { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: f.identity.handlerGeneration, op: "agent_permission_decide", commandId: randomUUID(), ref, optionId: "allow" }
  const reply = parseAgentReply(await f.peer.request("runtime-read", mutation))
  assert.ok(!reply.ok && reply.error.code === "INVALID_PROTOCOL")
  const malformed = parseAgentReply(await f.peer.request("runtime-read", { ...request, input: { limit: 0 } }))
  assert.ok(!malformed.ok && malformed.error.code === "INVALID_PROTOCOL")
  assert.equal((await f.service.permissions.snapshot()).receipts.length, 0)
  const absent = parseAgentReply(await f.peer.request("runtime-read", null))
  assert.ok(!absent.ok && absent.error.code === "INVALID_PROTOCOL")
  assert.equal(f.spawns(), 0)
})

test("runtime bridge checks generation and current readiness on each operation", async t => {
  const f = await fixture(t)
  const stale = parseAgentReply(await f.peer.request("runtime-read", { ...f.request(), handlerGeneration: randomUUID() }))
  assert.ok(!stale.ok && stale.error.code === "STALE_HANDLER")
  f.unavailable()
  const notReady = parseAgentReply(await f.peer.request("runtime-read", f.request()))
  assert.ok(!notReady.ok && notReady.error.code === "NOT_READY")
})

test("core registration removal does not remove another endpoint or replace duplicate channels", async t => {
  const f = await fixture(t)
  const remove = f.bridge.register(["fixture"], async () => ({ value: 1 }))
  assert.throws(() => f.bridge.register(["other", "fixture"], async () => ({ value: 2 })), /BRIDGE_CHANNEL_EXISTS/)
  assert.deepEqual(await f.peer.request("fixture", {}), { value: 1 })
  await assert.rejects(f.peer.request("other", {}), /UNSUPPORTED_CAPABILITY/)
  remove(); remove()
  assert.ok(parseAgentReply(await f.peer.request("runtime-read", f.request())).ok)
})