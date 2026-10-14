import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { createHostRuntimeClient, RuntimeOutcomeUnknown, registerRuntimeEndpoint } from "../src/hosts/runtime.js"
import { rosterView } from "../src/hosts/views.js"
import { AgentError, agentFailure } from "../src/agent/types.js"
import { AGENT_PROTOCOL } from "../src/agent/protocol.js"
import { agentServiceFixture } from "./agent-support.js"
import { createHandlerBridge } from "../src/bridge/server.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { dispatchAgentRequest } from "../src/agent/dispatch.js"
import { until } from "./control-support.js"
import { BRIDGE_FRAME_BYTES } from "../src/bridge/protocol.js"

test("mutation transport errors retain owner/command and never inspect or retry", async () => {
  const hostId = "a".repeat(64), generation = randomUUID(), commandId = randomUUID(), calls: string[] = []
  const client = createHostRuntimeClient({ localHostId: hostId, route: async route => { calls.push(route.channel); if (route.channel === "host-identity") return { hostId, handlerGeneration: generation }; throw new Error("BRIDGE_EOF") } })
  await assert.rejects(client.human(hostId, { op: "agent_permission_decide", commandId, ref: { hostId, target: { agentId: randomUUID(), handlerGeneration: generation, providerGeneration: randomUUID() }, permissionId: randomUUID(), revision: 1 }, optionId: "allow" }), error => {
    assert.ok(error instanceof RuntimeOutcomeUnknown); assert.deepEqual(error.reference, { hostId, commandId }); return true
  })
  assert.deepEqual(calls, ["host-identity", "runtime-write"])
})

test("aggregation walks all pages and retains unavailable observations without AgentPage limits", async () => {
  const hostId = "a".repeat(64), generation = randomUUID(), calls: string[] = []
  const client = { identity: async () => ({ hostId, handlerGeneration: generation }), human: async (_host: string, operation: any) => {
    if (_host !== hostId) throw new Error("HOST_UNAVAILABLE")
    calls.push(operation.input.cursor ?? "first")
    return { state: "page" as const, revision: generation, agents: [], issues: Array.from({ length: operation.input.cursor ? 5 : 100 }, (_, i) => ({ kind: "unknown" as const, id: null, path: "/fixture/" + i, message: "issue" })), nextCursor: operation.input.cursor ? null : "next" }
  } }
  const result = await rosterView({ client, localHostId: hostId, localHostname: "local", hosts: [{ hostId: "b".repeat(64), hostname: "missing" }], cwd: "/fixed" })
  assert.equal(result.state, "roster"); assert.deepEqual(calls, ["first", "next"])
  assert.ok(result.hosts[0]?.state === "available"); assert.equal(result.hosts[0].value.issues.length, 105)
  assert.equal(result.hosts[1]?.state, "unavailable")
})

test("real owner large permission snapshots use paging and compete with editor/local answers once", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), started = await f.service.start(f.input)
  const ready = await until(async () => { const result = await f.service.command(started.command.commandId, started.command.handlerGeneration); return result.command.state === "completed" ? result : undefined })
  const target = ready.command.target!, turn = f.service.prompt({ ...target, text: "permission" }); void turn.catch(() => undefined); await f.promptEntered
  for (let i = 0; i < 3; i++) f.requestPermission(target.agentId, "host-permission-" + i, { sessionId: "fixture-session", toolCall: { toolCallId: "tool-" + i, title: "Large" }, options: [{ optionId: "allow", name: "é".repeat(200000), kind: "allow_once" }] })
  const hostId = f.context.paths.hostKey, generation = f.service.handlerGeneration
  const bridge = await createHandlerBridge({ root: f.root, identity: { hostId, handlerGeneration: generation }, sourceRevision: "a".repeat(40) })
  registerRuntimeEndpoint(bridge, request => dispatchAgentRequest({ agents: f.service, generation, ready: () => true }, request))
  bridge.register(["host-identity"], async () => ({ hostId, handlerGeneration: generation }))
  const peer = await connectHandlerBridge({ root: f.root, hostId, handlerGeneration: generation }); t.after(async () => { peer.close(); await bridge.close() })
  const client = createHostRuntimeClient({ localHostId: hostId, route: route => peer.request(route.channel, route.payload) })
  const result = await until(async () => { const value = await client.human(hostId, { op: "agent_permissions" }); return value.state === "permissions" && value.snapshot.pending.length === 3 ? value : undefined })
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > BRIDGE_FRAME_BYTES)
  assert.equal(result.state, "permissions"); const ref = result.snapshot.pending[0]!.ref
  const frames: any[] = []; await f.service.attachPermissions(target, { connectionId: "editor", send: value => frames.push(value) })
  const offered = frames.find(value => value.method === "session/request_permission")
  await Promise.all([client.human(hostId, { op: "agent_permission_decide", commandId: randomUUID(), ref, optionId: "allow" }), f.service.permissionRouting.decide(randomUUID(), ref, "allow"), f.service.permissionDecision("editor", offered.id, { outcome: { outcome: "selected", optionId: "allow" } })])
  assert.equal(f.permissionReplies(target.agentId).length, 1)
  await assert.rejects(peer.request("read-open", { channel: "runtime-write", payload: {} }), /UNSUPPORTED_CAPABILITY/)
  f.completePrompt(target.agentId, "done"); await turn
})
test("legal roster pages exceed the frame and aggregation preserves more than 100 agents and equal UUIDs across owners", async t => {
  const f = await agentServiceFixture(t), started = await f.service.start(f.input)
  await until(async () => (await f.service.command(started.command.commandId, started.command.handlerGeneration)).command.state === "completed" ? true : undefined)
  const row = (await f.service.roster({ limit: 100 })).agents[0]!, hostId = f.context.paths.hostKey, generation = f.service.handlerGeneration, other = "b".repeat(64), revision = randomUUID()
  const rows = Array.from({ length: 105 }, () => {
    const value = structuredClone(row)
    assert.ok(value.record.version === 3 && value.launch?.version === 2 && value.launch.owner.kind === "agent")
    const agentId = randomUUID(); value.record.definition.agentId = agentId; value.launch.owner.agentId = agentId
    value.record.settings.configValues = Object.fromEntries(Array.from({ length: 5 }, (_, index) => ["large" + index, "x".repeat(4096)]))
    return value
  })
  const { inventoryPage } = await import("../src/agent/queries.js")
  const bridge = await createHandlerBridge({ root: f.root, identity: { hostId, handlerGeneration: generation }, sourceRevision: "a".repeat(40) })
  bridge.register(["runtime-read", "host-identity"], async ({ channel, payload }) => channel === "host-identity" ? { hostId, handlerGeneration: generation } : { protocol: AGENT_PROTOCOL, requestId: (payload as any).requestId, handlerGeneration: generation, ok: true, result: inventoryPage({ revision, agents: rows, issues: [] }, (payload as any).input) })
  const peer = await connectHandlerBridge({ root: f.root, hostId, handlerGeneration: generation }); t.after(async () => { peer.close(); await bridge.close() })
  const client = createHostRuntimeClient({ localHostId: hostId, route: route => peer.request(route.channel, route.payload) })
  const page = await client.human(hostId, { op: "agent_roster", input: { limit: 100 } })
  assert.ok(page.state === "page" && page.agents.length === 100 && Buffer.byteLength(JSON.stringify(page)) > BRIDGE_FRAME_BYTES)
  const all = await rosterView({ client, localHostId: hostId, localHostname: "local", hosts: [] })
  assert.ok(all.hosts[0]?.state === "available"); assert.equal(all.hosts[0].value.agents.length, 105)
  const remoteRows = structuredClone(rows)
  for (const value of remoteRows) if (value.record.version === 3) value.record.definition.hostId = other
  const both = createHostRuntimeClient({ localHostId: hostId, route: route => route.hostId === hostId ? peer.request(route.channel, route.payload) : Promise.resolve(route.channel === "host-identity" ? { hostId: other, handlerGeneration: generation } : { protocol: AGENT_PROTOCOL, requestId: (route.payload as any).requestId, handlerGeneration: generation, ok: true, result: inventoryPage({ revision, agents: remoteRows, issues: [] }, (route.payload as any).input) }) })
  const aggregate = await rosterView({ client: both, localHostId: hostId, localHostname: "local", hosts: [{ hostId: other, hostname: "worker" }] })
  assert.equal(aggregate.hosts.length, 2)
  assert.ok(aggregate.hosts.every(host => host.state === "available" && host.value.agents.length === 105))
  const { parseHostReply, HOST_PROTOCOL } = await import("../src/hosts/protocol.js")
  assert.ok(parseHostReply({ protocol: HOST_PROTOCOL, requestId: randomUUID(), hostId: null, handlerGeneration: null, ok: true, result: aggregate }).ok)
  assert.equal(f.spawns(), 1)
})

test("roster aggregation discards all partial rows when an owner changes revision", async () => {
  const hostId = "a".repeat(64), generation = randomUUID()
  let pages = 0
  const client = { identity: async () => ({ hostId, handlerGeneration: generation }), human: async () => ({ state: "page" as const, revision: pages++ ? randomUUID() : generation, agents: [], issues: [{ kind: "unknown" as const, id: null, path: "/fixture", message: "issue" }], nextCursor: "next" }) }
  const result = await rosterView({ client, localHostId: hostId, localHostname: "local", hosts: [] })
  assert.deepEqual(result.hosts, [{ hostId, hostname: "local", state: "unavailable", code: "RESYNC_REQUIRED" }])
})
test("stale decisions fail before dispatch and valid owner errors preserve their meaning", async () => {
  const hostId = "a".repeat(64), generation = randomUUID(), calls: string[] = []
  const operation = { op: "agent_permission_decide" as const, commandId: randomUUID(), ref: { hostId, target: { agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: randomUUID() }, permissionId: randomUUID(), revision: 1 }, optionId: "allow" }
  const client = createHostRuntimeClient({ localHostId: hostId, route: async route => { calls.push(route.channel); if (route.channel === "host-identity") return { hostId, handlerGeneration: generation }; const request = route.payload as any; return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: generation, ok: false, error: agentFailure(new AgentError("STALE_PROVIDER")) } } })
  await assert.rejects(client.human(hostId, operation), { code: "STALE_HANDLER" }); assert.deepEqual(calls, ["host-identity"])
  operation.ref.target.handlerGeneration = generation
  await assert.rejects(client.human(hostId, operation), { code: "STALE_PROVIDER" })
  assert.equal(calls.filter(channel => channel === "runtime-write").length, 1)
})