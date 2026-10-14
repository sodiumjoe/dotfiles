import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import { createHandlerBridge } from "../src/bridge/server.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { requestBridgeRead } from "../src/bridge/paging.js"
import { registerRuntimeEndpoint } from "../src/hosts/runtime.js"
import { dispatchAgentRequest } from "../src/agent/dispatch.js"
import { AGENT_PROTOCOL, parseAgentReply, parseAgentRequest, validateAgentReply } from "../src/agent/protocol.js"
import { EDITOR_TURN_LIMITS } from "../src/agent/session-events.js"
import type { AgentService, CreateSessionInput } from "../src/agent/service.js"
import { destinationEnvironment } from "../src/agent/environment.js"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { CommandView } from "../src/agent/types.js"

const begin = (service: AgentService, input: CreateSessionInput) => (service as AgentService & { beginSession(input: CreateSessionInput): Promise<CommandView> }).beginSession(input)
const native = (f: Awaited<ReturnType<typeof agentServiceFixture>>): CreateSessionInput => ({ commandId: randomUUID(), cwd: f.workspace, backendId: "codex-acp", environment: f.input.environment, nativeParams: { mcpServers: [] } })

async function fixture(t: TestContext) {
  const f = await agentServiceFixture(t, { prompt: "hang" })
  const identity = { hostId: f.context.paths.hostKey, handlerGeneration: f.service.handlerGeneration }
  const bridge = await createHandlerBridge({ root: f.root, identity, sourceRevision: "a".repeat(40) })
  let ready = true, captures = 0
  registerRuntimeEndpoint(bridge, request => dispatchAgentRequest({ agents: f.service, generation: identity.handlerGeneration, ready: () => ready, ...{ environment: () => { captures++; return { ...f.input.environment, OWNER_ONLY: "fixture" } } } }, request))
  const peer = await connectHandlerBridge({ root: f.root, ...identity })
  t.after(async () => { peer.close(); await bridge.close() })
  const request = (operation: object) => parseAgentRequest({ protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: identity.handlerGeneration, ...operation })
  const call = async (operation: object, channel = "runtime-read") => { const input = request(operation); const reply = parseAgentReply(await peer.request(channel, input)); validateAgentReply(reply, input); return reply }
  return { ...f, identity, peer, call, request, captures: () => captures, unavailable() { ready = false } }
}

test("native admission returns pending while provider initialization is held", async t => {
  const f = await agentServiceFixture(t, { pause: "ready" }), input = native(f)
  const admitted = await begin(f.service, input)
  assert.equal(admitted.command.commandId, input.commandId)
  assert.equal(admitted.command.state, "pending")
  await f.entered
  assert.equal(f.spawns(), 1)
  f.release()
  const completed = await until(async () => { const receipt = await f.service.commandReceipt(input.commandId, f.service.handlerGeneration); return receipt?.command.state === "completed" ? receipt : undefined })
  assert.equal(completed.command.result?.outcome, "started")
})

test("native admission rejects identical and changed MCP reuse with one provider", async t => {
  const f = await agentServiceFixture(t), input = native(f)
  input.nativeParams = { mcpServers: [{ name: "tools", command: "one", args: [], env: [] }] }
  await begin(f.service, input)
  for (const nativeParams of [input.nativeParams, { mcpServers: [{ name: "tools", command: "two", args: ["changed"], env: [{ name: "A", value: "B" }] }] }, { mcpServers: [{ name: "tools", type: "http", url: "https://example.com", headers: [] }] }]) {
    await assert.rejects(begin(f.service, { ...input, nativeParams }), { code: "COMMAND_CONFLICT" })
  }
  await until(async () => (await f.service.commandReceipt(input.commandId, f.service.handlerGeneration))?.command.state === "completed" ? true : undefined)
  assert.equal(f.spawns(), 1)
})

test("concurrent native duplicate is rejected before command publication", async t => {
  const f = await agentServiceFixture(t), input = native(f), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  assert.equal(typeof (f.service as unknown as Record<string, unknown>).beginSession, "function")
  const run = f.context.mutations.queue.run.bind(f.context.mutations.queue)
  let first = true
  t.mock.method(f.context.mutations.queue, "run", async (work: () => Promise<unknown>) => { if (first) { first = false; entered.resolve(); await release.promise }; return run(work) })
  const pending = begin(f.service, input)
  await entered.promise
  try {
    assert.equal((await f.store.inventory()).commands.length, 0)
    await assert.rejects(begin(f.service, input), { code: "COMMAND_CONFLICT" })
  } finally { release.resolve() }
  await pending
  await until(async () => (await f.service.commandReceipt(input.commandId, f.service.handlerGeneration))?.command.state === "completed" ? true : undefined)
  assert.equal(f.spawns(), 1)
})

test("ordinary session bridge admits turns independently and shares attachment contention", async t => {
  const f = await fixture(t), commandId = randomUUID(), handlerGeneration = f.identity.handlerGeneration
  const start = await f.call({ op: "agent_session_start", input: { commandId, handlerGeneration, cwd: f.workspace, backendId: "codex-acp" } }, "runtime-write")
  assert.ok(start.ok && start.result.state === "command")
  assert.equal(start.result.command.state, "pending")
  const command = await until(async () => { const r = await f.call({ op: "agent_session_command", commandId, commandGeneration: handlerGeneration }); return r.ok && r.result.state === "session_command" && r.result.receipt?.command.state === "completed" ? r.result.receipt : undefined })
  const target = command.command.target!, submissionId = randomUUID(), operation = { op: "agent_session_submit", target, submissionId, text: "held" }
  const submitted = await f.call(operation, "runtime-write")
  assert.ok(submitted.ok && submitted.result.state === "submission")
  assert.equal(submitted.result.receipt?.submissionId, submissionId)
  await f.promptEntered
  assert.equal(f.methodHistory.filter(value => value === "session/prompt").length, 1)
  const reused = await f.call(operation, "runtime-write")
  assert.ok(reused.ok && reused.result.state === "submission")
  assert.equal(reused.result.receipt?.acceptedSeq, submitted.result.receipt?.acceptedSeq)
  for (const [change, code] of [[{ text: "changed" }, "COMMAND_CONFLICT"], [{ submissionId: randomUUID() }, "BUSY"]] as const) {
    const r = await f.call({ ...operation, ...change }, "runtime-write"); assert.ok(!r.ok); assert.equal(r.error.code, code)
  }
  await assert.rejects(f.service.submit(target, { submissionId: randomUUID(), text: "editor", limits: EDITOR_TURN_LIMITS }), { code: "BUSY" })
  const inspected = await f.call({ op: "agent_session_inspect", agentId: target.agentId })
  assert.ok(inspected.ok && inspected.result.state === "session" && inspected.result.agent?.live)
  for (const op of ["agent_session_cancel", "agent_stop"]) {
    const stale = { ...target, providerGeneration: randomUUID() }
    const r = await f.call(op === "agent_stop" ? { op, input: { ...stale, commandId: randomUUID() } } : { op, target: stale, submissionId }, "runtime-write")
    assert.ok(!r.ok); assert.equal(r.error.code, "STALE_PROVIDER")
  }
  const observation = await f.call({ op: "agent_session_submission", target, submissionId })
  assert.ok(observation.ok && observation.result.state === "submission"); assert.equal(observation.result.receipt?.state, "running")
  const cancel = await f.call({ op: "agent_session_cancel", target, submissionId }, "runtime-write")
  assert.ok(cancel.ok && cancel.result.state === "submission" && cancel.result.receipt)
  await until(async () => (await f.service.submission(target, submissionId))?.stopReason === "cancelled" ? true : undefined)
  const stop = await f.call({ op: "agent_stop", input: { ...target, commandId: randomUUID() } }, "runtime-write")
  assert.ok(stop.ok && stop.result.state === "command")
  assert.equal(f.captures(), 1)
  assert.equal(f.spawnOptions[0]!.env!.OWNER_ONLY, "fixture")
  assert.equal(f.methodHistory.filter(value => value === "session/prompt").length, 1)
})

test("session reads return null and generation/readiness gates precede environment capture", async t => {
  const f = await fixture(t), generation = f.identity.handlerGeneration
  for (const operation of [{ op: "agent_session_inspect", agentId: randomUUID() }, { op: "agent_session_command", commandId: randomUUID(), commandGeneration: randomUUID() }]) {
    const r = await f.call(operation); assert.ok(r.ok); assert.ok(r.result.state === "session" ? r.result.agent === null : r.result.state === "session_command" && r.result.receipt === null)
  }
  const start = { op: "agent_session_start", input: { commandId: randomUUID(), handlerGeneration: generation, cwd: f.workspace, backendId: "codex-acp" } }
  const stale = parseAgentReply(await f.peer.request("runtime-write", { ...f.request(start), handlerGeneration: randomUUID(), input: { ...start.input, handlerGeneration: randomUUID() } }))
  assert.ok(!stale.ok)
  f.unavailable()
  const unavailable = await f.call(start, "runtime-write"); assert.ok(!unavailable.ok); assert.equal(unavailable.error.code, "NOT_READY")
  assert.equal(f.captures(), 0); assert.equal(f.spawns(), 0)
})

test("session mutations cannot execute over direct or paged reads", async t => {
  const f = await fixture(t), target = { agentId: randomUUID(), handlerGeneration: f.identity.handlerGeneration, providerGeneration: randomUUID() }
  const mutations = [
    { op: "agent_session_start", input: { commandId: randomUUID(), handlerGeneration: target.handlerGeneration, cwd: f.workspace, backendId: "codex-acp" } },
    { op: "agent_session_submit", target, submissionId: randomUUID(), text: "hello" },
    { op: "agent_session_cancel", target, submissionId: randomUUID() },
    { op: "agent_stop", input: { ...target, commandId: randomUUID() } }
  ]
  for (const operation of mutations) {
    const request = f.request(operation)
    for (const raw of [await f.peer.request("runtime-read", request), await requestBridgeRead(f.peer, "runtime-read", request)]) {
      const reply = parseAgentReply(raw); assert.ok(!reply.ok); assert.equal(reply.error.code, "INVALID_PROTOCOL")
    }
  }
  for (const operation of [{ op: "agent_session_inspect", agentId: target.agentId }, { op: "agent_session_command", commandId: randomUUID(), commandGeneration: target.handlerGeneration }, { op: "agent_session_submission", target, submissionId: randomUUID() }]) {
    const r = await f.call(operation, "runtime-write"); assert.ok(!r.ok); assert.equal(r.error.code, "INVALID_PROTOCOL")
  }
  assert.equal(f.spawns(), 0); assert.equal(f.captures(), 0)
})

test("native owner environment is filtered and backend defaults preserve explicit values", async t => {
  const f = await agentServiceFixture(t), input = native(f)
  await writeFile(join(f.root, "catalog", "backends.json"), JSON.stringify({ version: 1, defaultBackendId: "codex-acp", backends: [{ id: "codex-acp", args: [], environmentDefaults: { FALLBACK: "default", EXPLICIT: "default" }, initial: {}, compatibilityId: f.contract.id }] }), { mode: 0o600 })
  input.environment = destinationEnvironment({ ...f.input.environment, AGENCY_SECRET: "omit", NVIM: "omit", EXPLICIT: "owner" })
  await begin(f.service, input)
  await until(async () => (await f.service.commandReceipt(input.commandId, f.service.handlerGeneration))?.command.state === "completed" ? true : undefined)
  const environment = f.spawnOptions[0]!.env!
  assert.equal(environment.AGENCY_SECRET, undefined); assert.equal(input.environment.NVIM, undefined); assert.ok(environment.NVIM?.startsWith(f.root + "/editor-"))
  assert.equal(environment.EXPLICIT, "owner"); assert.equal(environment.FALLBACK, "default")
})

test("command inspection observes incomplete receipts without repairing publication", async t => {
  const f = await agentServiceFixture(t), input = native(f)
  f.failReceipt(true)
  await begin(f.service, input)
  await until(async () => f.receiptFailures() > 0 ? true : undefined)
  const before = f.receiptFailures()
  for (let n = 0; n < 2; n++) {
    const r = await dispatchAgentRequest({ agents: f.service, generation: f.service.handlerGeneration, ready: () => true }, parseAgentRequest({ protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: f.service.handlerGeneration, op: "agent_session_command", commandId: input.commandId, commandGeneration: f.service.handlerGeneration }))
    assert.ok(r.ok && r.result.state === "session_command")
  }
  assert.equal(f.receiptFailures(), before)
  f.failReceipt(false)
})