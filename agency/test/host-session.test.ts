import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import * as runtime from "../src/hosts/runtime.js"
import { AGENT_PROTOCOL, parseAgentRequest } from "../src/agent/protocol.js"
import { dispatchAgentRequest } from "../src/agent/dispatch.js"
import { AgentError, agentFailure } from "../src/agent/types.js"
import { HOST_PROTOCOL, parseHostReply } from "../src/hosts/protocol.js"
import type { RuntimeSessionRequest, RuntimeSessionResult } from "../src/agent/session-controls.js"
import { agentServiceFixture } from "./agent-support.js"
import { runtimeNetwork } from "./host-runtime-support.js"
import { until } from "./control-support.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { BRIDGE_FRAME_BYTES } from "../src/bridge/protocol.js"
import type { HostRoute } from "../src/hosts/router.js"

const clientFor = (input: Parameters<typeof runtime.createHostRuntimeClient>[0]) => runtime.createHostRuntimeClient(input) as ReturnType<typeof runtime.createHostRuntimeClient> & { session(host: string, op: RuntimeSessionRequest, signal?: AbortSignal): Promise<RuntimeSessionResult> }
async function fixture(t: TestContext, pause = false) {
  const provider = await agentServiceFixture(t, { hostId: "c".repeat(64), prompt: "hang", ...(pause ? { pause: "ready" as const } : {}) })
  const network = await runtimeNetwork(t), laptop = await network.add("laptop", "a"), source = await network.add("source", "b"), owner = await network.add("owner", "c", provider.service.handlerGeneration)
  runtime.registerRuntimeEndpoint(owner.bridge, request => dispatchAgentRequest({ agents: provider.service, generation: owner.generation, ready: () => true, environment: () => provider.input.environment }, request))
  for (const node of [laptop, source]) runtime.registerRuntimeEndpoint(node.bridge, request => dispatchAgentRequest({ agents: undefined, generation: node.generation, ready: () => true }, request))
  laptop.hosts.push(source.enrollment, owner.enrollment)
  await laptop.router.request({ hostId: source.enrollment.hostId, channel: "host-identity", payload: {} })
  const client = clientFor({ localHostId: source.enrollment.hostId, route: (route, signal) => source.router.request(route, signal) })
  const hostId = owner.enrollment.hostId, commandId = randomUUID(), start: RuntimeSessionRequest = { op: "agent_session_start", input: { commandId, handlerGeneration: owner.generation, cwd: provider.workspace, backendId: "codex-acp" } }
  const ready = () => until(async () => { const r = await client.session(hostId, { op: "agent_session_command", commandId, commandGeneration: owner.generation }); return r.state === "session_command" && r.receipt?.command.state === "completed" ? r.receipt : undefined })
  const reconnect = async () => { const peer = await connectHandlerBridge({ root: owner.root, hostId, handlerGeneration: owner.generation }); t.after(() => peer.close()); return clientFor({ localHostId: hostId, route: (route, signal) => peer.request(route.channel, route.payload, signal ? { signal } : {}) }) }
  return { ...provider, network, laptop, source, owner, client, hostId, start, commandId, ready, reconnect }
}

test("worker sessions use real runtime relay without any task endpoint", async t => {
  const f = await fixture(t)
  const accepted = await f.client.session(f.hostId, f.start); assert.equal(accepted.state, "command")
  const target = (await f.ready()).command.target!, submissionId = randomUUID()
  assert.equal((await f.client.session(f.hostId, { op: "agent_session_inspect", agentId: target.agentId })).state, "session")
  const turn = await f.client.session(f.hostId, { op: "agent_session_submit", target, submissionId, text: "held" }); assert.equal(turn.state, "submission")
  await f.promptEntered
  await f.client.session(f.hostId, { op: "agent_session_cancel", target, submissionId })
  await until(async () => (await f.service.submission(target, submissionId))?.stopReason === "cancelled" ? true : undefined)
  await f.client.session(f.hostId, { op: "agent_stop", input: { ...target, commandId: randomUUID() } })
  assert.deepEqual(f.network.connections, ["source", "owner"])
  assert.equal(f.spawns(), 1); assert.equal(f.methodHistory.filter(v => v === "session/prompt").length, 1)
})

for (const operation of ["start", "submit", "cancel", "stop"] as const) test(`lost ${operation} reply retains original reference and reconnect only inspects`, async t => {
  const f = await fixture(t, operation === "start")
  let calls = 0
  const client = clientFor({ localHostId: f.source.enrollment.hostId, async route(route, signal) { const result = await f.source.router.request(route, signal); if (route.channel === "runtime-write") { calls++; return null }; return result } })
  let request: RuntimeSessionRequest = f.start
  let target: import("../src/agent/types.js").AgentTuple | undefined, submissionId = randomUUID()
  if (operation !== "start") {
    await f.client.session(f.hostId, f.start); target = (await f.ready()).command.target!
    request = operation === "stop" ? { op: "agent_stop", input: { ...target, commandId: randomUUID() } } : { op: operation === "submit" ? "agent_session_submit" : "agent_session_cancel", target, submissionId, ...(operation === "submit" ? { text: "held" } : {}) } as RuntimeSessionRequest
    if (operation === "cancel") { await f.client.session(f.hostId, { op: "agent_session_submit", target, submissionId, text: "held" }); await f.promptEntered }
  }
  const reference = "input" in request ? { kind: "command", hostId: f.hostId, handlerGeneration: f.owner.generation, commandId: request.input.commandId } : { kind: "submission", hostId: f.hostId, target, submissionId }
  await assert.rejects(client.session(f.hostId, request), error => { assert.equal((error as { code: string }).code, "OUTCOME_UNKNOWN"); assert.deepEqual((error as { reference: unknown }).reference, reference); return true })
  assert.equal(calls, 1)
  const next = await f.reconnect()
  if (operation === "start") {
    await f.entered
    const r = await next.session(f.hostId, { op: "agent_session_command", commandId: f.commandId, commandGeneration: f.owner.generation })
    assert.ok(r.state === "session_command" && r.receipt?.command.state === "pending")
    f.release(); await f.ready()
  } else if (operation === "stop") {
    assert.ok(request.op === "agent_stop")
    const r = await next.session(f.hostId, { op: "agent_session_command", commandId: request.input.commandId, commandGeneration: f.owner.generation }); assert.ok(r.state === "session_command" && r.receipt)
  } else {
    if (operation === "submit") await f.promptEntered
    const r = await next.session(f.hostId, { op: "agent_session_submission", target: target!, submissionId }); assert.ok(r.state === "submission" && r.receipt?.submissionId === submissionId)
    assert.equal(f.methodHistory.filter(v => v === "session/prompt").length, 1)
    if (operation === "submit") await f.client.session(f.hostId, { op: "agent_session_cancel", target: target!, submissionId })
  }
  assert.equal(f.spawns(), 1); assert.equal(calls, 1)
})

test("abort after dispatch leaves the admitted worker turn running", async t => {
  const f = await fixture(t); await f.client.session(f.hostId, f.start)
  const target = (await f.ready()).command.target!, submissionId = randomUUID(), abort = new AbortController()
  const client = clientFor({ localHostId: f.source.enrollment.hostId, async route(route, signal) { const result = await f.source.router.request(route, signal); if (route.channel === "runtime-write") { abort.abort(); throw new Error("ABORTED") }; return result } })
  await assert.rejects(client.session(f.hostId, { op: "agent_session_submit", target, submissionId, text: "held" }, abort.signal), { code: "OUTCOME_UNKNOWN" })
  await f.promptEntered
  assert.equal((await f.service.submission(target, submissionId))?.state, "running")
  assert.equal(f.methodHistory.filter(v => v === "session/prompt").length, 1)
  await f.client.session(f.hostId, { op: "agent_session_cancel", target, submissionId })
})

test("stale identity and deterministic owner failures retain mutation references", async () => {
  const hostId = "a".repeat(64), generation = randomUUID(), target = { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() }, submissionId = randomUUID(), calls: string[] = []
  let observed = randomUUID(), code = "BUSY"
  const client = clientFor({ localHostId: hostId, async route(route) { calls.push(route.channel); if (route.channel === "host-identity") return { hostId, handlerGeneration: observed }; const request = route.payload as any; return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: observed, ok: false, error: agentFailure(new AgentError(code as any)) } } })
  const request: RuntimeSessionRequest = { op: "agent_session_submit", target, submissionId, text: "x" }, reference = { kind: "submission", hostId, target, submissionId }
  await assert.rejects(client.session(hostId, request), error => { assert.equal((error as any).code, "STALE_HANDLER"); assert.deepEqual((error as any).reference, reference); return true })
  assert.deepEqual(calls, ["host-identity"])
  observed = generation
  for (code of ["BUSY", "STALE_PROVIDER", "COMMAND_CONFLICT"]) await assert.rejects(client.session(hostId, request), error => { assert.equal((error as any).code, code); assert.deepEqual((error as any).reference, reference); return true })
  assert.equal(calls.filter(v => v === "runtime-write").length, 3)
})

for (const corrupt of ["target", "submission", "generation", "host", "command"] as const) test(`mismatched ${corrupt} response is ambiguous after one owner effect`, async t => {
  const f = await fixture(t); await f.client.session(f.hostId, f.start); const target = (await f.ready()).command.target!, submissionId = randomUUID()
  const client = clientFor({ localHostId: f.source.enrollment.hostId, async route(route, signal) { const reply = await f.source.router.request(route, signal) as any; if (route.channel === "runtime-write") {
    if (corrupt === "generation") reply.handlerGeneration = randomUUID()
    else if (corrupt === "target") reply.result.target.providerGeneration = randomUUID()
    else if (corrupt === "submission") reply.result.submissionId = randomUUID()
    else if (corrupt === "command") reply.result.command.commandId = randomUUID()
    else reply.result.command.hostId = "d".repeat(64)
  }; return reply } })
  const request: RuntimeSessionRequest = corrupt === "host" || corrupt === "command" ? { op: "agent_stop", input: { ...target, commandId: randomUUID() } } : { op: "agent_session_submit", target, submissionId, text: "held" }
  await assert.rejects(client.session(f.hostId, request), { code: "OUTCOME_UNKNOWN" })
  assert.equal(f.spawns(), 1)
  if (request.op === "agent_session_submit") { await f.promptEntered; assert.equal(f.methodHistory.filter(v => v === "session/prompt").length, 1); await f.service.cancel(target, submissionId) }
})

test("malformed and oversized operations fail before identity and maximum escaped text crosses relay", async t => {
  let traffic = 0
  const client = clientFor({ localHostId: "a".repeat(64), route: async () => { traffic++; throw new Error("forbidden") } })
  const generation = randomUUID(), start = { op: "agent_session_start", input: { commandId: randomUUID(), handlerGeneration: generation, cwd: "/workspace", backendId: "codex-acp", nativeParams: { extension: "a".repeat(BRIDGE_FRAME_BYTES) } } } as RuntimeSessionRequest
  await assert.rejects(client.session("a".repeat(64), start), { code: "INPUT_TOO_LARGE" })
  await assert.rejects(client.session("a".repeat(64), { ...start, input: { ...(start as any).input, nativeParams: { mcpServers: [{}] } } } as RuntimeSessionRequest), { code: "INVALID_PROTOCOL" })
  assert.equal(traffic, 0)
  const f = await fixture(t); await f.client.session(f.hostId, f.start); const target = (await f.ready()).command.target!
  const text = "\u0001".repeat(152917) + "a".repeat(917504 - 2 - 152917 * 6), submissionId = randomUUID()
  assert.equal(Buffer.byteLength(JSON.stringify(text)), 917504)
  const r = await f.client.session(f.hostId, { op: "agent_session_submit", target, submissionId, text }); assert.ok(r.state === "submission" && r.receipt)
  await f.promptEntered; await f.service.cancel(target, submissionId)
})

test("host session envelopes preserve command identity, old generation and discriminated errors", () => {
  const hostId = "a".repeat(64), generation = randomUUID(), commandId = randomUUID(), target = { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() }
  const base = { protocol: HOST_PROTOCOL, requestId: randomUUID(), hostId, handlerGeneration: generation }
  const r = { ...base, commandId, ok: true, result: { state: "session_command", commandId, commandGeneration: randomUUID(), receipt: null } }
  assert.deepEqual(parseHostReply(r), r)
  for (const reference of [{ kind: "command", hostId, handlerGeneration: randomUUID(), commandId }, { kind: "submission", hostId, target, submissionId: randomUUID() }]) {
    const error = { ...base, ok: false, error: { code: "OUTCOME_UNKNOWN", message: "inspect", reference } }
    assert.deepEqual(parseHostReply(error), error)
    assert.throws(() => parseHostReply({ ...error, error: { ...error.error, reference: { ...reference, hostId: "b".repeat(64) } } }))
  }
})

test("current connection can inspect an old command after restart without restoring live submissions", async t => {
  const f = await fixture(t); await f.client.session(f.hostId, f.start)
  const target = (await f.ready()).command.target!, submissionId = randomUUID()
  const absent = await f.client.session(f.hostId, { op: "agent_session_submission", target, submissionId })
  assert.ok(absent.state === "submission" && absent.receipt === null)
  const replacement = await f.restart(), node = await f.network.add("restarted", "c", replacement.handlerGeneration)
  runtime.registerRuntimeEndpoint(node.bridge, request => dispatchAgentRequest({ agents: replacement, generation: replacement.handlerGeneration, ready: () => true, environment: () => f.input.environment }, request))
  const peer = await connectHandlerBridge({ root: node.root, hostId: f.hostId, handlerGeneration: replacement.handlerGeneration }); t.after(() => peer.close())
  const client = clientFor({ localHostId: f.hostId, route: route => peer.request(route.channel, route.payload) })
  const command = await client.session(f.hostId, { op: "agent_session_command", commandId: f.commandId, commandGeneration: target.handlerGeneration })
  assert.ok(command.state === "session_command" && command.receipt?.command.handlerGeneration === target.handlerGeneration)
  const session = await client.session(f.hostId, { op: "agent_session_inspect", agentId: target.agentId })
  assert.ok(session.state === "session" && session.agent?.live === false)
  await assert.rejects(client.session(f.hostId, { op: "agent_session_submission", target, submissionId }), { code: "STALE_HANDLER" })
  assert.equal(f.spawns(), 1)
})

test("equal agent UUIDs remain scoped to each selected host", async t => {
  const f = await fixture(t); await f.client.session(f.hostId, f.start); const target = (await f.ready()).command.target!, original = await f.service.sessionRecord(target.agentId)
  assert.ok(original)
  const otherId = "d".repeat(64), other = structuredClone(original); other.record.definition.hostId = otherId
  const client = clientFor({ localHostId: f.hostId, async route(route) {
    if (route.channel === "host-identity") return { hostId: route.hostId, handlerGeneration: f.owner.generation }
    const request = route.payload as any
    return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: f.owner.generation, ok: true, result: { state: "session", agentId: target.agentId, agent: route.hostId === otherId ? other : original } }
  } })
  for (const host of [f.hostId, otherId]) { const r = await client.session(host, { op: "agent_session_inspect", agentId: target.agentId }); assert.ok(r.state === "session" && r.agent?.record.definition.hostId === host) }
})