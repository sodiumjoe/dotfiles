import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import { runControl, type ControlDependencies } from "../src/cli/control.js"
import { parseHostReply } from "../src/hosts/protocol.js"
import { dispatchAgentRequest } from "../src/agent/dispatch.js"
import { AGENT_PROTOCOL, parseAgentRequest } from "../src/agent/protocol.js"
import { AgentError, agentFailure } from "../src/agent/types.js"
import { agentServiceFixture } from "./agent-support.js"
import { runtimeNetwork } from "./host-runtime-support.js"
import { unavailableControlDependencies, until } from "./control-support.js"
import { registerRuntimeEndpoint } from "../src/hosts/runtime.js"

async function fixture(t: TestContext) {
  const f = await agentServiceFixture(t, { prompt: "hang" }), hostId = f.context.paths.hostKey, generation = f.service.handlerGeneration
  let output = "", traffic = 0
  const deps: ControlDependencies = { ...unavailableControlDependencies(), environment: async () => ({ paths: f.context.paths, adapter: f.context.adapter }), hostInventory: () => ({ list: async () => [], enroll: async () => { throw new Error("forbidden") } }), hostRoute: async (_env, route) => {
    traffic++
    if (route.channel === "host-identity") return { hostId, handlerGeneration: generation }
    return dispatchAgentRequest({ agents: f.service, generation, ready: () => true, environment: () => f.input.environment }, parseAgentRequest(route.payload))
  }, start: async () => { throw new Error("automatic Handler start forbidden") }, callBureau: async () => { throw new Error("task coordination forbidden") }, stdout: value => { output += value } }
  const call = async (args: string[], selector: string[] = ["--host", hostId]) => { output = ""; const code = await runControl(["session", ...args, ...selector, "--json"], deps); return { code, reply: parseHostReply(JSON.parse(output)) } }
  const startInput = { commandId: randomUUID(), handlerGeneration: generation, cwd: f.workspace, backendId: "codex-acp" }
  const ready = () => until(async () => { const r = await call(["command", startInput.commandId, "--input-json", JSON.stringify({ commandGeneration: generation })]); return r.reply.ok && r.reply.result.state === "session_command" && r.reply.result.receipt?.command.state === "completed" ? r.reply.result.receipt : undefined })
  return { ...f, deps, call, ready, startInput, hostId, generation, traffic: () => traffic }
}

for (const local of [false, true]) test(`public ${local ? "local" : "remote"} session admission and explicit observations use owner envelopes`, async t => {
  const f = await fixture(t), selected = local ? ["--local"] : ["--host", f.hostId]
  const started = await f.call(["start", "--input-json", JSON.stringify(f.startInput)], selected)
  assert.equal(started.code, 0); assert.ok(started.reply.ok && started.reply.result.state === "command")
  assert.equal(started.reply.commandId, f.startInput.commandId); assert.equal(started.reply.handlerGeneration, f.generation)
  const target = (await f.ready()).command.target!, submissionId = randomUUID(), input = { target, submissionId, text: "held" }
  const submitted = await f.call(["submit", "--input-json", JSON.stringify(input)], selected)
  assert.equal(submitted.code, 0); assert.ok(submitted.reply.ok && submitted.reply.result.state === "submission")
  await f.promptEntered
  assert.equal((await f.call(["inspect", target.agentId], selected)).code, 0)
  assert.equal((await f.call(["submission", "--input-json", JSON.stringify({ target, submissionId })], selected)).code, 75)
  for (const [change, code] of [[{ text: "changed" }, "COMMAND_CONFLICT"], [{ submissionId: randomUUID() }, "BUSY"]] as const) {
    const r = await f.call(["submit", "--input-json", JSON.stringify({ ...input, ...change })], selected)
    assert.equal(r.code, 75); assert.ok(!r.reply.ok); assert.equal(r.reply.error.code, code)
    assert.deepEqual(r.reply.error.reference, { kind: "submission", hostId: f.hostId, target, submissionId: "submissionId" in change ? change.submissionId : submissionId })
  }
  assert.equal((await f.call(["cancel", "--input-json", JSON.stringify({ target, submissionId })], selected)).code, 0)
  await until(async () => (await f.service.submission(target, submissionId))?.state === "completed" ? true : undefined)
  const completed = await f.call(["submission", "--input-json", JSON.stringify({ target, submissionId })], selected)
  assert.equal(completed.code, 0); assert.ok(completed.reply.ok && completed.reply.result.state === "submission" && completed.reply.result.receipt?.stopReason === "cancelled")
  assert.equal((await f.call(["stop", "--input-json", JSON.stringify({ ...target, commandId: randomUUID() })], selected)).code, 0)
  assert.equal(f.spawns(), 1); assert.equal(f.methodHistory.filter(v => v === "session/prompt").length, 1)
})

test("missing observations return unavailable and invalid forms cause no host traffic", async t => {
  const f = await fixture(t)
  for (const args of [["inspect", randomUUID()], ["command", randomUUID(), "--input-json", JSON.stringify({ commandGeneration: randomUUID() })]]) assert.equal((await f.call(args)).code, 69)
  const before = f.traffic()
  for (const [args, selected] of [
    [["start", "--input-json", JSON.stringify(f.startInput)], []],
    [["start", "--input-json", JSON.stringify(f.startInput)], ["--local", "--host", f.hostId]],
    [["start", "extra", "--input-json", JSON.stringify(f.startInput)], ["--local"]],
    [["start", "--input-json", "{"], ["--local"]],
    [["start", "--command-id", randomUUID(), "--input-json", JSON.stringify(f.startInput)], ["--local"]],
    [["start", "--input-json", JSON.stringify({ ...f.startInput, nativeParams: { mcpServers: [{}] } })], ["--local"]],
    [["inspect", randomUUID(), "--input-json", "{}"], ["--local"]],
    [["submit", "--input-json", JSON.stringify({ target: {}, submissionId: randomUUID(), text: "x" })], ["--local"]],
    [["command", randomUUID(), "--input-json", JSON.stringify({ commandGeneration: randomUUID(), extra: true })], ["--local"]],
    [["watch"], ["--local"]],
    [["inspect", randomUUID(), "--json"], ["--local"]]
  ]) assert.equal((await f.call(args!, selected!)).code, 64)
  assert.equal(f.traffic(), before)
})

test("stale generation emits original launch reference and observed current generation", async t => {
  const f = await fixture(t), input = { ...f.startInput, handlerGeneration: randomUUID() }
  const r = await f.call(["start", "--input-json", JSON.stringify(input)])
  assert.equal(r.code, 69); assert.ok(!r.reply.ok); assert.equal(r.reply.error.code, "STALE_HANDLER")
  assert.equal(r.reply.handlerGeneration, f.generation)
  assert.deepEqual(r.reply.error.reference, { kind: "command", hostId: f.hostId, handlerGeneration: input.handlerGeneration, commandId: input.commandId })
  assert.equal(f.spawns(), 0)
})

test("command and submission inspection exit codes distinguish pending, failed and absent state", async t => {
  const f = await fixture(t), commandId = f.startInput.commandId, target = { agentId: randomUUID(), handlerGeneration: f.generation, providerGeneration: randomUUID() }, submissionId = randomUUID()
  await f.service.beginSession({ commandId, cwd: f.workspace, backendId: "codex-acp", environment: f.input.environment, nativeParams: {} })
  const saved = await until(async () => { const r = await f.service.commandReceipt(commandId, f.generation); return r?.command.state === "completed" ? r : undefined })
  let result: unknown = null
  f.deps.hostRoute = async (_env, route) => {
    if (route.channel === "host-identity") return { hostId: f.hostId, handlerGeneration: f.generation }
    const request = route.payload as any
    return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: f.generation, ...(request.op === "agent_session_command" ? { commandId } : {}), ok: true, result }
  }
  for (const [receipt, code] of [[null, 69], [{ ...saved, command: { ...saved.command, state: "pending", result: null } }, 75], [saved, 0], [{ ...saved, command: { ...saved.command, state: "completed", result: { ...saved.command.result, outcome: "failed", session: null, failure: agentFailure(new AgentError("STARTUP_FAILED")) } } }, 75], [{ ...saved, command: { ...saved.command, state: "interrupted", result: { ...saved.command.result, outcome: "interrupted", session: null, failure: agentFailure(new AgentError("INCOMPLETE")) } } }, 75]] as const) {
    result = { state: "session_command", commandId, commandGeneration: f.generation, receipt }
    const observed = await f.call(["command", commandId, "--input-json", JSON.stringify({ commandGeneration: f.generation })])
    assert.equal(observed.code, code, JSON.stringify(observed.reply))
  }
  for (const [state, code] of [[null, 69], ["accepted", 75], ["running", 75], ["failed", 75], ["completed", 0]] as const) {
    result = { state: "submission", target, submissionId, receipt: state === null ? null : { submissionId, digest: "a".repeat(64), state, stopReason: state === "completed" ? "end_turn" : null, failure: state === "failed" ? agentFailure(new AgentError("STARTUP_FAILED")) : null, acceptedSeq: 1, completedSeq: state === "failed" || state === "completed" ? 2 : null } }
    assert.equal((await f.call(["submission", "--input-json", JSON.stringify({ target, submissionId })])).code, code)
  }
})

test("public worker session CLI uses local Handler relay and reconnects only to inspect a lost submission", async t => {
  const provider = await agentServiceFixture(t, { hostId: "c".repeat(64), prompt: "hang" }), network = await runtimeNetwork(t)
  const laptop = await network.add("laptop", "a"), source = await network.add("source", "b"), owner = await network.add("owner", "c", provider.service.handlerGeneration)
  laptop.hosts.push(source.enrollment, owner.enrollment)
  source.bridge.register(["runtime-read", "runtime-write"], async () => null)
  await laptop.router.request({ hostId: source.enrollment.hostId, channel: "host-identity", payload: {} })
  let drop = false, writes = 0, output = ""
  owner.bridge.register(["runtime-read", "runtime-write"], async ({ payload, context }) => {
    const request = parseAgentRequest(payload)
    const reply = await dispatchAgentRequest({ agents: provider.service, generation: owner.generation, ready: () => true, environment: () => provider.input.environment }, request)
    if (request.op === "agent_session_submit") { writes++; if (drop && context.source === "peer") context.peer.close(new Error("BRIDGE_EOF")) }
    return reply
  })
  const deps: ControlDependencies = { ...unavailableControlDependencies(), environment: async () => ({ paths: { hostKey: source.enrollment.hostId, persistentRoot: source.root, runtimeRoot: source.root, handlerSocketPath: source.root + "/handler.sock" }, adapter: {} as never }), inspect: async () => ({ disposition: "live", record: { phase: "ready", generation: source.generation } } as never), hostInventory: () => ({ list: async () => source.hosts, enroll: async () => { throw new Error("forbidden") } }), start: async () => { throw new Error("forbidden") }, callBureau: async () => { throw new Error("forbidden") }, stdout: value => { output += value } }
  const call = async (argv: string[]) => { output = ""; const code = await runControl(["session", ...argv, "--host", owner.enrollment.hostId, "--json"], deps); return { code, reply: parseHostReply(JSON.parse(output)) } }
  const commandId = randomUUID(), input = { commandId, handlerGeneration: owner.generation, cwd: provider.workspace, backendId: "codex-acp" }
  assert.equal((await call(["start", "--input-json", JSON.stringify(input)])).code, 0)
  const command = await until(async () => { const r = await call(["command", commandId, "--input-json", JSON.stringify({ commandGeneration: owner.generation })]); return r.reply.ok && r.reply.result.state === "session_command" && r.reply.result.receipt?.command.state === "completed" ? r.reply.result.receipt : undefined })
  const target = command.command.target!, submissionId = randomUUID()
  drop = true
  const lost = await call(["submit", "--input-json", JSON.stringify({ target, submissionId, text: "held" })])
  assert.equal(lost.code, 75); assert.ok(!lost.reply.ok); assert.equal(lost.reply.error.code, "OUTCOME_UNKNOWN")
  assert.deepEqual(lost.reply.error.reference, { kind: "submission", hostId: owner.enrollment.hostId, target, submissionId })
  await provider.promptEntered
  const inspected = await call(["submission", "--input-json", JSON.stringify({ target, submissionId })])
  assert.equal(inspected.code, 75); assert.ok(inspected.reply.ok && inspected.reply.result.state === "submission" && inspected.reply.result.receipt?.submissionId === submissionId)
  assert.equal(writes, 1); assert.equal(provider.methodHistory.filter(v => v === "session/prompt").length, 1)
  await call(["cancel", "--input-json", JSON.stringify({ target, submissionId })])
  await call(["stop", "--input-json", JSON.stringify({ ...target, commandId: randomUUID() })])
  assert.deepEqual(network.connections, ["source", "owner", "owner"])
})