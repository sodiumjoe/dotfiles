import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { createPermissionBroker } from "../src/acp/permissions.js"
import type { JsonObject } from "../src/agent/session-config.js"
import type { AgentTuple } from "../src/agent/types.js"
import { acpFixture } from "./acp-support.js"
import { until } from "./control-support.js"

const target = (): AgentTuple => ({ agentId: randomUUID(), handlerGeneration: randomUUID(), providerGeneration: randomUUID() })
const params: JsonObject = { sessionId: "native-session", toolCall: { toolCallId: "same-tool", title: "Edit", kind: "edit" }, options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }] }
const selected = (optionId: string): JsonObject => ({ outcome: { outcome: "selected", optionId } })
function fixture() {
  const responses: Array<{ target: AgentTuple; id: string | number; result: JsonObject }> = []
  const broker = createPermissionBroker({ respond: (target, id, result) => responses.push({ target, id, result }) })
  const a: JsonObject[] = [], b: JsonObject[] = [], t = target()
  const client = (connectionId: string, frames: JsonObject[]) => ({ connectionId, send: (frame: JsonObject) => frames.push(frame) })
  broker.attach(t, client("a", a)); broker.attach(t, client("b", b))
  return { broker, responses, a, b, t, client }
}

test("the first offered decision wins synchronously and withdraws the other frontend", async () => {
  const f = fixture()
  f.broker.open(f.t, 1, params)
  assert.equal(f.a[0]!.method, "session/request_permission")
  assert.equal((f.a[0]!.params as JsonObject).sessionId, "agency:" + f.t.agentId)
  const decisions = await Promise.all([f.broker.decision("a", f.a[0]!.id as string, selected("allow-once")), f.broker.decision("b", f.b[0]!.id as string, selected("reject-once"))])
  assert.deepEqual(decisions, [true, false])
  assert.deepEqual(f.responses, [{ target: f.t, id: 1, result: selected("allow-once") }])
  assert.equal(f.b.at(-1)!.method, "agency/permission_withdrawn")
  assert.equal((f.b.at(-1)!.params as JsonObject).requestId, f.b[0]!.id)
  assert.equal(await f.broker.decision("a", f.a[0]!.id as string, selected("reject-once")), false)
})

test("abandonment and unoffered decisions cannot reject or approve the provider request", async () => {
  const f = fixture()
  f.broker.open(f.t, 1, params)
  assert.equal(await f.broker.decision("a", f.a[0]!.id as string, { outcome: { outcome: "cancelled" } }), false)
  assert.equal(await f.broker.decision("b", f.b[0]!.id as string, selected("not-offered")), false)
  assert.equal(f.responses.length, 0)
  const reoffer = f.b.filter(frame => frame.method === "session/request_permission").at(-1)!
  assert.notEqual(reoffer.id, f.b[0]!.id)
  assert.equal(await f.broker.decision("b", reoffer.id as string, selected("reject-once")), true)
  assert.deepEqual(f.responses[0]!.result, selected("reject-once"))
})

test("pending permission survives every client detaching and is offered to a later attachment", async () => {
  const f = fixture()
  f.broker.open(f.t, 1, params)
  const old = f.a[0]!.id as string
  f.broker.detach("a"); f.broker.detach("b")
  assert.equal(f.responses.length, 0)
  const c: JsonObject[] = []
  f.broker.attach(f.t, f.client("c", c))
  assert.equal(await f.broker.decision("a", old, selected("allow-once")), false)
  assert.equal(await f.broker.decision("c", c[0]!.id as string, selected("allow-once")), true)
  assert.equal(f.responses.length, 1)
})

test("the same tool and provider request IDs in distinct sessions remain independent", async () => {
  const f = fixture(), second = target()
  f.broker.attach(second, f.client("a", f.a))
  f.broker.open(f.t, 1, params); f.broker.open(second, 1, params)
  assert.notEqual(f.a[0]!.id, f.a[1]!.id)
  await f.broker.decision("a", f.a[0]!.id as string, selected("allow-once"))
  await f.broker.decision("a", f.a[1]!.id as string, selected("reject-once"))
  assert.deepEqual(f.responses.map(response => response.target), [f.t, second])
})

test("invalidating a generation makes delayed decisions ineffective even when native IDs are reused", async () => {
  const f = fixture()
  f.broker.open(f.t, 1, params)
  const old = f.a[0]!.id as string
  f.broker.invalidate(f.t)
  assert.equal(f.a.at(-1)!.method, "agency/permission_withdrawn")
  const replacement = { ...f.t, providerGeneration: randomUUID() }
  f.broker.attach(replacement, f.client("a", f.a)); f.broker.open(replacement, 1, params)
  assert.equal(await f.broker.decision("a", old, selected("allow-once")), false)
  const current = f.a.at(-1)!
  assert.equal(await f.broker.decision("a", current.id as string, selected("reject-once")), true)
  assert.deepEqual(f.responses[0]!.target, replacement)
})

test("real provider receives exactly one racing shared decision", async t => {
  const f = await acpFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", { protocolVersion: 1 }); await b.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] })
  const ar = await a.next("session/request_permission"), br = await b.next("session/request_permission")
  a.respond(ar.id, selected("allow-once")); b.respond(br.id, selected("reject-once"))
  assert.equal((await pending).stopReason, "end_turn")
  const withdrawn = await b.next("agency/permission_withdrawn")
  assert.equal(withdrawn.requestId, br.id)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 1)
})

test("real permission remains pending after all frontend connections close", async t => {
  const f = await acpFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] }).catch(() => null)
  await a.next("session/request_permission"); a.close(); await pending
  const b = await f.connect()
  await b.request("initialize", { protocolVersion: 1 })
  await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  const request = await b.next("session/request_permission")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 0)
  b.drain("agency/session_state")
  b.respond(request.id, selected("allow-once"))
  await b.nextState("idle")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 1)
})

test("a frontend decision from another connection and malformed decisions cannot settle a request", async () => {
  const f = fixture()
  f.broker.open(f.t, "native-request", params)
  assert.equal(await f.broker.decision("b", f.a[0]!.id as string, selected("allow-once")), false)
  assert.equal(await f.broker.decision("a", f.a[0]!.id as string, { outcome: { outcome: "selected", optionId: null } }), false)
  assert.equal(f.responses.length, 0)
  const reoffer = f.a.at(-1)!
  assert.equal(await f.broker.decision("a", reoffer.id as string, selected("allow-once")), true)
  assert.equal(f.responses[0]!.id, "native-request")
})

test("an attachment is offered each request once and detaching one target preserves another", async () => {
  const f = fixture(), second = target()
  f.broker.attach(second, f.client("a", f.a))
  f.broker.open(f.t, 1, params); f.broker.open(second, 1, params)
  f.broker.attach(f.t, f.client("a", f.a))
  assert.equal(f.a.length, 2)
  f.broker.detach("a", f.t)
  assert.equal(await f.broker.decision("a", f.a[0]!.id as string, selected("allow-once")), false)
  assert.equal(await f.broker.decision("a", f.a[1]!.id as string, selected("reject-once")), true)
})

test("one broken client writer does not prevent another attachment deciding", async () => {
  const f = fixture()
  f.broker.attach(f.t, { connectionId: "broken", send() { throw new Error("connection failed") } })
  f.broker.open(f.t, 1, params)
  assert.equal(await f.broker.decision("b", f.b[0]!.id as string, selected("allow-once")), true)
  assert.equal(f.responses.length, 1)
})

test("explicit cancel withdraws permission and a delayed decision cannot decide the next request", async t => {
  const f = await acpFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const prompt = () => a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] })
  const first = prompt(), old = await a.next("session/request_permission")
  await a.request("session/cancel", { sessionId: s.sessionId! })
  assert.equal((await first).stopReason, "cancelled")
  assert.equal((await a.next("agency/permission_withdrawn")).requestId, old.id)
  a.respond(old.id, selected("allow-once"))
  const next = prompt(), current = await a.next("session/request_permission")
  assert.notEqual(current.id, old.id)
  a.respond(old.id, selected("reject-once"))
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 0)
  a.respond(current.id, selected("allow-once"))
  assert.equal((await next).stopReason, "end_turn")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 1)
})

test("a stale permission after restore cannot approve a replacement generation", async t => {
  const f = await acpFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] }).catch(() => null)
  const old = await a.next("session/request_permission")
  await f.stopSession(String(s.sessionId)); await pending
  await f.restoreSession(String(s.sessionId)); await a.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  const currentPrompt = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] }), current = await a.next("session/request_permission")
  a.respond(old.id, selected("allow-once"))
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 0)
  a.respond(current.id, selected("reject-once"))
  assert.equal((await currentPrompt).stopReason, "end_turn")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 1)
})

test("provider failure withdraws permission without deciding it or affecting another backend", async t => {
  const f = await acpFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const other = await a.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, backendId: "claude-agent-acp" } } })
  let settled = false
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] }).catch(() => null).finally(() => { settled = true })
  const request = await a.next("session/request_permission")
  await writeFile(join(f.root, "fail-permission"), "fail", { mode: 0o600 })
  await until(async () => settled ? true : undefined)
  await pending
  assert.equal((await a.next("agency/permission_withdrawn")).requestId, request.id)
  a.respond(request.id, selected("allow-once"))
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 0)
  assert.equal((await a.request("session/prompt", { sessionId: other.sessionId!, prompt: [{ type: "text", text: "still live" }] })).stopReason, "end_turn")
})

test("explicit session detach abandons permissions without cancelling the accepted turn", async t => {
  const f = await acpFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", { protocolVersion: 1 }); await b.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] })
  const old = await a.next("session/request_permission")
  await a.request("agency/detach", { sessionId: s.sessionId! })
  a.respond(old.id, selected("reject-once"))
  await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  const current = await b.next("session/request_permission")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 0)
  b.respond(current.id, selected("allow-once"))
  assert.equal((await pending).stopReason, "end_turn")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/cancel").length, 0)
  await assert.rejects(a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "detached" }] }), { code: "STALE_ATTACHMENT" })
})

test("two native request ID collisions on one frontend reach only their matching providers", async t => {
  const f = await acpFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const codex = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const claude = await a.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, backendId: "claude-agent-acp" } } })
  const prompts = [codex, claude].map(s => a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] }))
  const requests = [await a.next("session/request_permission"), await a.next("session/request_permission")]
  assert.notEqual(requests[0]!.id, requests[1]!.id)
  for (const request of requests) a.respond(request.id, selected(request.params.sessionId === codex.sessionId ? "allow-once" : "reject-once"))
  assert.deepEqual((await Promise.all(prompts)).map(result => result.stopReason), ["end_turn", "end_turn"])
  for (const [backend, choice] of [["codex-acp", "allow-once"], ["claude-agent-acp", "reject-once"]] as const) {
    const decisions = (await f.requests(backend)).filter(frame => frame.result?.outcome)
    assert.equal(decisions.length, 1)
    assert.equal((decisions[0]!.result!.outcome as JsonObject).optionId, choice)
    assert.equal(decisions[0]!.id, 1)
  }
})

test("frontend abandonment and invalid selections preserve a real permission for another valid decision", async t => {
  const f = await acpFixture(t), a = await f.connect(), b = await f.connect()
  await a.request("initialize", { protocolVersion: 1 }); await b.request("initialize", { protocolVersion: 1 })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "permission" }] })
  const ar = await a.next("session/request_permission"), br = await b.next("session/request_permission")
  a.respond(ar.id, { outcome: { outcome: "cancelled" } }); b.respond(br.id, selected("not-offered"))
  const offered = await b.next("session/request_permission")
  assert.notEqual(offered.id, br.id)
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 0)
  b.respond(offered.id, selected("allow-once"))
  assert.equal((await pending).stopReason, "end_turn")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 1)
})