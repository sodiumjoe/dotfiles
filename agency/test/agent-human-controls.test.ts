import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { createConnection, createServer } from "node:net"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import { dispatchRuntimeHuman, isRuntimeHumanRequest, type RuntimeHumanRequest } from "../src/agent/human-controls.js"
import { AGENT_PROTOCOL, agentErrorReply, exchangeAgent } from "../src/agent/protocol.js"
import { serveProtocols } from "../src/control/wire.js"
import { createPermissionArbiter } from "../src/agent/permission-arbiter.js"
import type { AgentService } from "../src/agent/service.js"

async function wire(t: TestContext, root: string, service: AgentService) {
  const path = join(root, randomUUID() + ".sock")
  const server = createServer({ allowHalfOpen: true }, socket => {
    void serveProtocols(socket, async () => { throw new Error("wrong protocol") }, async () => { throw new Error("wrong protocol") }, 5000, async request => {
      try {
        assert.ok(isRuntimeHumanRequest(request))
        return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: service.handlerGeneration, ok: true,
          result: await dispatchRuntimeHuman(service, request) }
      } catch (error) { return agentErrorReply(request, error) }
    }).catch(() => socket.destroy())
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  return (operation: RuntimeHumanRequest) => exchangeAgent(createConnection(path), {
    protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: service.handlerGeneration, ...operation
  })
}

async function permission(t: TestContext, longLabel = false) {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const command = await f.service.start(f.input)
  const ready = await until(async () => {
    const view = await f.service.command(command.command.commandId, command.command.handlerGeneration)
    return view.command.state === "completed" ? view : undefined
  }, 40000)
  const target = ready.command.target!
  const turn = f.service.prompt({ ...target, text: "permission" })
  void turn.catch(() => undefined)
  await f.promptEntered
  const params = longLabel ? JSON.parse(await readFile(new URL("../../test/fixtures/codex-long-permission.json", import.meta.url), "utf8")) : undefined
  if (params) params.options[2].name = "é".repeat(65537)
  f.requestPermission(target.agentId, "local-permission", params)
  const call = await wire(t, f.root, f.service)
  const offer = await until(async () => {
    const reply = await call({ op: "agent_permissions" })
    assert.ok(reply.ok && reply.result.state === "permissions")
    return reply.result.snapshot.pending[0]
  })
  const finish = async () => { f.completePrompt(target.agentId, "done"); await turn }
  return { ...f, call, target, offer, turn, finish }
}

for (const longLabel of [false, true]) test("local owner answers " + (longLabel ? "long-label" : "ordinary") + " permission once and retains inspectable receipt", async t => {
  const f = await permission(t, longLabel), commandId = randomUUID(), optionId = longLabel ? "allow_once" : "allow"
  if (longLabel) assert.equal(f.offer.options[2]!.name, "é".repeat(65537))
  const answer = await f.call({ op: "agent_permission_decide", commandId, ref: f.offer.ref, optionId })
  assert.ok(answer.ok && answer.result.state === "permission")
  assert.equal(answer.result.receipt?.state, "applied")
  assert.deepEqual(f.permissionReplies(f.target.agentId), [{ jsonrpc: "2.0", id: "local-permission", result: { outcome: { outcome: "selected", optionId } } }])
  for (let i = 0; i < 2; i++) {
    const inspected = await f.call({ op: "agent_permission_inspect", commandId })
    assert.ok(inspected.ok && inspected.result.state === "permission")
    assert.deepEqual(inspected.result.receipt, answer.result.receipt)
  }
  const absent = await f.call({ op: "agent_permission_inspect", commandId: randomUUID() })
  assert.ok(absent.ok && absent.result.state === "permission")
  assert.equal(absent.result.receipt, null)
  await f.finish()
  assert.equal((await f.service.current(f.workspace)).agents[0]!.record.phase, "ready")
})

test("local and editor permission answers share one arbiter", async t => {
  const f = await permission(t), frames: any[] = []
  await f.service.attachPermissions(f.target, { connectionId: "editor", send: frame => frames.push(frame) })
  const offer = frames.find(frame => frame.method === "session/request_permission")
  assert.ok(offer)
  const [local] = await Promise.all([
    f.call({ op: "agent_permission_decide", commandId: randomUUID(), ref: f.offer.ref, optionId: "allow" }),
    f.service.permissionDecision("editor", offer.id, { outcome: { outcome: "selected", optionId: "deny" } })
  ])
  assert.ok(local.ok && local.result.state === "permission")
  assert.ok(["applied", "withdrawn"].includes(local.result.receipt!.state))
  assert.equal(f.permissionReplies(f.target.agentId).length, 1)
  assert.equal((await f.service.permissions.snapshot()).pending.length, 0)
  await f.finish()
})

test("stale provider and foreign host views cannot answer the current permission", async t => {
  const f = await permission(t)
  for (const ref of [
    { ...f.offer.ref, hostId: "b".repeat(64) },
    { ...f.offer.ref, target: { ...f.target, providerGeneration: randomUUID() } }
  ]) {
    const reply = await f.call({ op: "agent_permission_decide", commandId: randomUUID(), ref, optionId: "allow" })
    assert.ok(reply.ok && reply.result.state === "permission")
    assert.equal(reply.result.receipt?.state, "stale")
  }
  assert.equal(f.permissionReplies(f.target.agentId).length, 0)
  assert.equal((await f.service.permissions.snapshot()).pending.length, 1)
  await f.call({ op: "agent_permission_decide", commandId: randomUUID(), ref: f.offer.ref, optionId: "allow" })
  await f.finish()
})

test("invalid option and conflicting command identity preserve owner errors over the wire", async t => {
  const f = await permission(t), commandId = randomUUID()
  const invalid = await f.call({ op: "agent_permission_decide", commandId, ref: f.offer.ref, optionId: "missing" })
  assert.ok(!invalid.ok)
  assert.equal(invalid.error.code, "USAGE")
  assert.equal(f.permissionReplies(f.target.agentId).length, 0)
  await f.call({ op: "agent_permission_decide", commandId, ref: f.offer.ref, optionId: "allow" })
  const conflict = await f.call({ op: "agent_permission_decide", commandId, ref: f.offer.ref, optionId: "deny" })
  assert.ok(!conflict.ok)
  assert.equal(conflict.error.code, "COMMAND_CONFLICT")
  assert.equal(f.permissionReplies(f.target.agentId).length, 1)
  await f.finish()
})

test("stopping the owner withdraws a pending permission", async t => {
  const f = await permission(t)
  await f.service.stop({ ...f.target, commandId: randomUUID() })
  const reply = await f.call({ op: "agent_permission_decide", commandId: randomUUID(), ref: f.offer.ref, optionId: "allow" })
  assert.ok(reply.ok && reply.result.state === "permission")
  assert.equal(reply.result.receipt?.state, "stale")
  assert.equal(f.permissionReplies(f.target.agentId).length, 0)
  await f.turn.catch(() => undefined)
})

test("closed owner permissions is explicit on the agent protocol", async t => {
  const f = await agentServiceFixture(t)
  const routing = createPermissionArbiter({ hostId: f.context.paths.hostKey, handlerGeneration: f.service.handlerGeneration })
  routing.close()
  const call = await wire(t, f.root, { ...f.service, permissions: routing })
  const reply = await call({ op: "agent_permissions" })
  assert.ok(!reply.ok)
  assert.equal(reply.error.code, "UNAVAILABLE")
})

test("local roster preserves active filtering, pagination and not-yet-live starts", async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await agentServiceFixture(t, { observe: async () => { entered.resolve(); await release.promise } })
  const command = await f.service.start(f.input)
  await entered.promise
  try {
  const page = await dispatchRuntimeHuman(f.service, { op: "agent_roster", input: { limit: 1, cwd: f.workspace } })
  assert.equal(page.state, "page")
  assert.ok(page.state === "page")
  assert.equal(page.agents.length, 1)
  assert.equal(page.agents[0]!.record.phase, "starting")
  assert.equal(page.agents[0]!.live, false)
  const empty = await dispatchRuntimeHuman(f.service, { op: "agent_roster", input: { limit: 1, cwd: "/other" } })
  assert.ok(empty.state === "page")
  assert.equal(empty.agents.length, 0)
  await assert.rejects(dispatchRuntimeHuman(f.service, { op: "agent_roster", input: { limit: 1, activeOnly: false } }), { code: "INVALID_PROTOCOL" })
  } finally { release.resolve() }
  await until(async () => (await f.service.command(command.command.commandId, command.command.handlerGeneration)).command.state === "completed" ? true : undefined)
})

test("local roster pages do not duplicate active sessions", async t => {
  const f = await agentServiceFixture(t)
  for (let i = 0; i < 2; i++) {
    const started = await f.service.start({ ...f.input, commandId: randomUUID() })
    await until(async () => (await f.service.command(started.command.commandId, started.command.handlerGeneration)).command.state === "completed" ? true : undefined)
  }
  const first = await dispatchRuntimeHuman(f.service, { op: "agent_roster", input: { limit: 1 } })
  assert.ok(first.state === "page")
  assert.equal(first.agents.length, 1)
  assert.ok(first.nextCursor)
  const second = await dispatchRuntimeHuman(f.service, { op: "agent_roster", input: { limit: 1, cursor: first.nextCursor } })
  assert.ok(second.state === "page")
  assert.equal(second.agents.length, 1)
  assert.equal(second.nextCursor, null)
  const ids = [...first.agents, ...second.agents].map(view => view.record.version === 3 ? view.record.definition.agentId : null)
  assert.equal(new Set(ids).size, 2)
})