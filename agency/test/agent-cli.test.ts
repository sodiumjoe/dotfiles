import assert from "node:assert/strict"
import test from "node:test"
import { runControl, type ControlDependencies } from "../src/cli/control.js"
import { AGENT_PROTOCOL, agentErrorReply, type AgentRequest, type AgentReply } from "../src/agent/protocol.js"
import { AgentError, projectStartInput, projectRestoreInput, type AgentCommand, type AgentCommandV3, type AgentErrorCode } from "../src/agent/types.js"
import { launchEnvironmentDigest } from "../src/agent/environment.js"
import { unavailableControlDependencies, until } from "./control-support.js"
import { agentId, agentServiceFixture, sampleAgent, sampleCommand, sampleSession } from "./agent-support.js"
import type { HandlerInspection } from "../src/platform/types.js"

const flags = ["--provider", "codex-acp", "--model", "model-a", "--reasoning", "high", "--mode", "review", "--permission-profile", "fixture-deny-v1", "--json"]
test("CLI import emits a verified receipt using recorded cwd without provider launch", async () => {
  const f = fixture(), commandId = agentId(77)
  f.deps.cwd = () => { throw new Error("import must use recorded cwd") }
  f.deps.callAgent = async (_env, request) => {
    f.calls.push(request)
    const input = (request as any).input
    return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, commandId: input.commandId, ok: true, result: { state: "command", durability: "verified", command: { version: 3, hostId: "a".repeat(64), commandId: input.commandId, handlerGeneration: request.handlerGeneration, op: "import", input: { backendId: input.backendId, nativeSessionId: input.nativeSessionId, cwd: input.cwd }, agentId: agentId(1), target: null, state: "completed", result: { outcome: "imported", target: null, failure: null, session: { sessionId: input.nativeSessionId, protocolVersion: 1 } } } } }
  }
  assert.equal(await runControl(["agent", "import", "--provider", "codex-acp", "--session", "saved-native", "--cwd", "/recorded", "--command-id", commandId, "--expected-handler-generation", agentId(2), "--format", "json"], f.deps), 0)
  assert.equal(f.calls[0]!.op, "agent_import")
  assert.equal(f.output().result.command.input.cwd, "/recorded")
  assert.equal(f.starts(), 0)
  f.calls.length = 0
  assert.equal(await runControl(["agent", "import", "--provider", "codex-acp", "--session", "agency:" + agentId(1), "--cwd", "/recorded"], f.deps), 64)
  assert.equal(f.calls.length, 0)
})
test("restore forwards fresh MCP JSON without retaining credentials in command input", async () => {
  const f = fixture(), servers = [{ type: "http", name: "context", url: "https://fixture", headers: [{ name: "Authorization", value: "fresh-secret" }] }]
  assert.equal(await runControl(["agent", "restore", agentId(1), "--mcp-servers-json", JSON.stringify(servers), "--json"], f.deps), 0)
  assert.deepEqual((f.calls[0] as any).input.nativeParams, { mcpServers: servers })
  assert.equal(JSON.stringify(f.output()).includes("fresh-secret"), false)
})
test("initial expected generation permits a fresh command and lost stdout recovery only inspects it", async () => {
  const f = fixture(), commandId = agentId(77), generation = f.inspection.record.generation
  assert.equal(await runControl(["agent", "start", ...flags, "--command-id", commandId, "--expected-handler-generation", generation], f.deps), 0)
  f.out.length = 0
  f.calls.length = 0
  f.inspection.record.generation = agentId(99)
  f.deps.cwd = () => { throw new Error("receipt lookup cannot read cwd") }
  assert.equal(await runControl(["agent", "command", commandId, "--handler-generation", generation, "--json"], f.deps), 0)
  assert.deepEqual(f.calls.map(r => r.op), ["agent_command"])
  assert.equal(f.calls[0]!.handlerGeneration, agentId(99))
  assert.equal(f.output().result.command.handlerGeneration, generation)
  assert.equal(f.starts(), 0)
})

test("initial generation mismatch fails before dispatch", async () => {
  const f = fixture()
  assert.equal(await runControl(["agent", "start", ...flags, "--command-id", agentId(77), "--expected-handler-generation", agentId(99)], f.deps), 69)
  assert.equal(f.output().error.code, "STALE_HANDLER")
  assert.equal(f.calls.length, 0)
  assert.equal(f.starts(), 0)
})

test("initial restore requires the observed Handler without reading caller cwd", async () => {
  const f = fixture()
  f.deps.cwd = () => { throw new Error("restore cannot read caller cwd") }
  assert.equal(await runControl(["agent", "restore", agentId(1), "--command-id", agentId(77), "--expected-handler-generation", agentId(2), "--json"], f.deps), 0)
  assert.deepEqual(f.calls.map(r => r.op), ["agent_restore"])
  assert.equal(f.starts(), 0)
})

test("page resynchronization remains an explicit error envelope", async () => {
  const f = fixture()
  f.deps.callAgent = async (_env, request) => agentErrorReply(request, new AgentError("RESYNC_REQUIRED"))
  assert.equal(await runControl(["agent", "page", "--limit", "100", "--json"], f.deps), 75)
  assert.equal(f.output().error.code, "RESYNC_REQUIRED")
  assert.equal(f.starts(), 0)
})

for (const extra of [["--expected-handler-generation", agentId(2)], ["--command-id", agentId(77), "--expected-handler-generation", agentId(2), "--handler-generation", agentId(2)]]) test(`invalid initial preconditions reject ${extra.join(" ")}`, async () => {
  const f = fixture()
  assert.equal(await runControl(["agent", "start", ...flags, ...extra], f.deps), 64)
  assert.equal(f.calls.length, 0)
})
function fixture() {
  const out: string[] = [], err: string[] = [], calls: AgentRequest[] = [], command = sampleCommand()
  let retained: AgentCommand | AgentCommandV3 = { ...command, state: "completed", result: { outcome: "started", target: command.target, session: sampleSession(), failure: null } }, now = 0, starts = 0
  const inspection: HandlerInspection = { disposition: "live", record: { version: 1, hostId: command.hostId, generation: command.handlerGeneration, launchBootId: "boot-a", launchAttemptId: agentId(50), launchAttempted: true, phase: "ready", process: { bootId: "boot-a", pid: 100, birth: `1:agy-handler:${agentId(50)}`, parentPid: 1, processGroupId: 100, sessionId: 100, uid: 1, gid: 1 }, socketPath: "/fixture/socket", writer: "handler", reconciliation: { classified: 0, total: 0, quarantined: 0 }, reason: null } }
  const unsupported = async (): Promise<never> => { throw new Error("unexpected store mutation") }
  const reply = (r: AgentRequest): AgentReply => {
    if (r.op === "agent_list") return { protocol: AGENT_PROTOCOL, requestId: r.requestId, handlerGeneration: r.handlerGeneration, ok: true, result: { state: "agents", agents: [], issues: [] } }
    if (r.op === "agent_current") return { protocol: AGENT_PROTOCOL, requestId: r.requestId, handlerGeneration: r.handlerGeneration, ok: true, result: { state: "current", cwd: r.cwd, agents: [] } }
    if (r.op === "agent_start") retained = { ...retained, commandId: r.input.commandId, handlerGeneration: r.input.handlerGeneration, input: projectStartInput(r.input) }
    if (r.op === "agent_restore") retained = { ...retained, op: "restore", commandId: r.input.commandId, handlerGeneration: r.input.handlerGeneration, input: projectRestoreInput(r.input), result: { outcome: "restored", target: retained.target, session: sampleSession(), failure: null } }
    return { protocol: AGENT_PROTOCOL, requestId: r.requestId, handlerGeneration: r.handlerGeneration, commandId: retained.commandId, ok: true, result: { state: "command", command: retained, durability: "verified" } }
  }
  const deps: ControlDependencies = { ...unavailableControlDependencies(), environment: async () => ({ paths: { hostKey: command.hostId, persistentRoot: "/fixture", runtimeRoot: "/fixture", handlerSocketPath: "/fixture/socket" }, adapter: { platform: "darwin", bootId: async () => "boot-a", readProcess: unsupported, readGroup: unsupported, signalGroup: unsupported } }), start: async () => { starts++; return inspection }, inspect: async () => inspection, cwd: () => "/checkout", now: () => now, sleep: async ms => { now += ms }, stdout: value => out.push(value), stderr: value => err.push(value), callAgent: async (_env, r) => { calls.push(r); return reply(r) }, agentStore: () => ({ readCommand: async id => id === retained.commandId ? structuredClone(retained) : null, readAgent: unsupported, inventory: unsupported, writeAgent: unsupported, writeCommand: unsupported, verifyDurability: unsupported, forgetRemoved() {}, terminalTimes: async () => null }) }
  return { deps, out, err, calls, command, inspection, reply, starts: () => starts, output: () => JSON.parse(out.join("")), retain(value: AgentCommand | AgentCommandV3) { retained = value } }
}

test("choices and filtered page use existing Handler without sampling caller environment", async () => {
  for (const [argv, state] of [[["agent", "choices", "--json"], "choices"], [["agent", "page", "--limit", "100", "--cwd", "/checkout", "--active", "--json"], "page"]] as const) {
    const f = fixture()
    f.deps.cwd = () => { throw new Error("query must not sample cwd") }
    f.deps.callAgent = async (_env, request) => {
      f.calls.push(request)
      if (request.op === "agent_choices") return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, ok: true, result: { state: "choices", choices: [], unavailable: [] } }
      assert.equal(request.op, "agent_page")
      if (request.op !== "agent_page") throw new Error("wrong query")
      assert.deepEqual(request.input, { limit: 100, cwd: "/checkout", activeOnly: true })
      return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, ok: true, result: { state: "page", revision: agentId(87), agents: [], issues: [], nextCursor: null } }
    }
    assert.equal(await runControl(argv, f.deps), 0)
    assert.equal(f.output().result.state, state)
    assert.equal(f.starts(), 0)
  }
})

test("command inspection reports pending and interrupted receipts without resubmission", async () => {
  for (const interrupted of [false, true]) {
    const f = fixture(), command = sampleCommand()
    f.retain(interrupted ? { ...command, state: "interrupted", result: { outcome: "interrupted", target: command.target, failure: { code: "INCOMPLETE", message: "incomplete" }, session: null } } : command)
    assert.equal(await runControl(["agent", "command", command.commandId, "--handler-generation", command.handlerGeneration, "--json"], f.deps), 75)
    assert.deepEqual(f.calls.map(r => r.op), ["agent_command"])
    assert.equal(f.output().result.command.state, interrupted ? "interrupted" : "pending")
    assert.equal(f.starts(), 0)
  }
})

test("absent Handler and absent command receipts remain explicit lookup failures", async () => {
  const f = fixture()
  f.deps.inspect = async () => null
  assert.equal(await runControl(["agent", "command", agentId(77), "--handler-generation", agentId(2), "--json"], f.deps), 69)
  assert.equal(f.output().error.code, "UNAVAILABLE")
  assert.equal(f.starts(), 0)
  const g = fixture()
  g.deps.callAgent = async (_env, request) => { g.calls.push(request); return agentErrorReply(request, new AgentError("UNAVAILABLE")) }
  assert.equal(await runControl(["agent", "command", agentId(77), "--handler-generation", agentId(2), "--json"], g.deps), 69)
  assert.deepEqual(g.calls.map(r => r.op), ["agent_command"])
})

for (const operation of ["start", "restore"]) test(`replay-only ${operation} with an absent receipt never dispatches`, async () => {
  const f = fixture()
  const argv = operation === "start" ? ["agent", "start", ...flags] : ["agent", "restore", agentId(1), "--json"]
  assert.equal(await runControl([...argv, "--command-id", agentId(77), "--handler-generation", agentId(2)], f.deps), 69)
  assert.equal(f.output().error.code, "UNAVAILABLE")
  assert.equal(f.calls.length, 0)
  assert.equal(f.starts(), 0)
})

test("restore snapshots caller environment without accessing caller cwd", async () => {
  const f = fixture()
  f.deps.cwd = () => { throw new Error("restore must use recorded cwd") }
  f.deps.callAgent = async (_env, request) => {
    f.calls.push(request)
    assert.equal(request.op, "agent_restore")
    const input = (request as any).input
    assert.equal(Object.hasOwn(input, "cwd"), false)
    assert.deepEqual(input.environment, { ...process.env })
    return agentErrorReply(request, new AgentError("INCOMPLETE"))
  }
  assert.equal(await runControl(["agent", "restore", agentId(1), "--json"], f.deps), 75)
  assert.equal(f.calls.length, 1)
})

test("a lost restore receipt polls the original command without sending environment again", async () => {
  const f = fixture()
  f.deps.cwd = () => { throw new Error("restore must use recorded cwd") }
  f.deps.callAgent = async (_env, request) => { f.calls.push(request); const reply = f.reply(request); if (request.op === "agent_restore") throw new AgentError("UNAVAILABLE"); return reply }
  assert.equal(await runControl(["agent", "restore", agentId(1), "--json"], f.deps), 0)
  assert.deepEqual(f.calls.map(call => call.op), ["agent_restore", "agent_command"])
  assert.equal(f.output().result.command.result.outcome, "restored")
})

test("a pinned restore uses only its retained receipt across Handler replacement", async () => {
  const f = fixture(), input = { commandId: f.command.commandId, handlerGeneration: f.command.handlerGeneration, agentId: agentId(1), environment: {} }
  f.retain({ ...f.command, op: "restore", input: projectRestoreInput(input), state: "completed", result: { outcome: "restored", target: f.command.target, session: sampleSession(), failure: null } })
  f.inspection.record.generation = agentId(99)
  f.deps.cwd = () => { throw new Error("restore retry must not read cwd") }
  assert.equal(await runControl(["agent", "restore", agentId(1), "--command-id", input.commandId, "--handler-generation", input.handlerGeneration, "--json"], f.deps), 0)
  assert.equal(f.starts(), 0)
  assert.equal(f.calls[0]?.op, "agent_command")
})

for (const flags of [["--cwd", "/caller"], ["--candidate-restore-contract", "fixture-v1"], ["--provider-generation", agentId(3)], ["--model", "alias"]]) test(`restore rejects alternate scope or authority: ${flags[0]}`, async () => {
  const f = fixture()
  assert.equal(await runControl(["agent", "restore", agentId(1), ...flags], f.deps), 64)
  assert.equal(f.calls.length, 0)
})

test("new agent start emits one envelope and explicit effective selections", async () => {
  const f = fixture()
  assert.equal(await runControl(["agent", "start", ...flags], f.deps), 0)
  assert.equal(f.out.length, 1); assert.equal(f.output().protocol, AGENT_PROTOCOL)
  assert.equal(f.output().result.command.result.session.mode, "review")
  assert.equal(f.starts(), 1)
})

test("client sends its complete ambient environment only on initial start", async () => {
  const previous = process.env.AGENCY_TEST_SECRET
  process.env.AGENCY_TEST_SECRET = "not-for-state"
  try {
    const f = fixture()
    assert.equal(await runControl(["agent", "start", ...flags], f.deps), 0)
    assert.equal(f.calls[0]?.op, "agent_start")
    if (f.calls[0]?.op !== "agent_start") throw new Error("start was not sent")
    assert.equal(f.calls[0].input.environment.AGENCY_TEST_SECRET, "not-for-state")
    assert.equal(f.calls.slice(1).every(call => call.op === "agent_command"), true)
    assert.equal(JSON.stringify(f.output()).includes("not-for-state"), false)
  } finally {
    if (previous === undefined) delete process.env.AGENCY_TEST_SECRET
    else process.env.AGENCY_TEST_SECRET = previous
  }
})

test("list does not require a start-sized ambient environment", async () => {
  const previous = process.env.AGENCY_TEST_OVERSIZED
  process.env.AGENCY_TEST_OVERSIZED = "x".repeat(256 * 1024)
  try {
    const f = fixture()
    assert.equal(await runControl(["agent", "list", "--json"], f.deps), 0)
    assert.equal(f.output().result.state, "agents")
  } finally {
    if (previous === undefined) delete process.env.AGENCY_TEST_OVERSIZED
    else process.env.AGENCY_TEST_OVERSIZED = previous
  }
})

for (const args of [["agent", "start"], ["agent", "start", ...flags.filter((_, i) => i !== 8 && i !== 9)], ["agent", "start", ...flags, "--model", "b"], ["agent", "start", ...flags, "--reasoning", ""], ["agent", "list", "--mode", "review"], ["agent", "stop", agentId(1)]]) test(`invalid agent arguments fail before environment access: ${args.join(" ")}`, async () => {
  const f = fixture(); f.deps.environment = async () => { throw new Error("unexpected environment access") }
  assert.equal(await runControl(args, f.deps), 64); assert.equal(f.output().protocol, AGENT_PROTOCOL); assert.equal(f.out.length, 1)
})

for (const [code, exit] of [["USAGE", 64], ["SELECTION_UNSUPPORTED", 64], ["INVALID_PROTOCOL", 65], ["ADAPTER_UNQUALIFIED", 69], ["STALE_PROVIDER", 69], ["STALE_HANDLER", 69], ["UNAVAILABLE", 69], ["INTERNAL", 70], ["CLEANUP_UNVERIFIED", 75], ["INCOMPLETE", 75]] as const) test(`agent error ${code} has exit ${exit}`, async () => {
  const f = fixture()
  f.deps.callAgent = async (_env, r) => agentErrorReply(r, new AgentError(code))
  assert.equal(await runControl(["agent", "list", "--json"], f.deps), exit)
  assert.equal(f.output().error.code, code)
})

test("pinned start lookup never starts a daemon or reads ambient cwd", async () => {
  const f = fixture()
  f.deps.inspect = async () => null; f.deps.cwd = () => { throw new Error("checkout removed") }
  assert.equal(await runControl(["agent", "start", ...flags, "--command-id", f.command.commandId, "--handler-generation", f.command.handlerGeneration], f.deps), 75)
  assert.equal(f.output().result.durability, "unverified"); assert.equal(f.starts(), 0); assert.equal(f.calls.length, 0)
})

test("replacement Handler receives only a historical lookup with distinct outer generation", async () => {
  const f = fixture(); f.inspection.record.generation = agentId(99); f.deps.cwd = () => { throw new Error("cwd must not be read") }
  assert.equal(await runControl(["agent", "start", ...flags, "--command-id", f.command.commandId, "--handler-generation", f.command.handlerGeneration], f.deps), 0)
  assert.equal(f.starts(), 0); assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.op, "agent_command"); assert.equal(f.calls[0]!.handlerGeneration, agentId(99))
  assert.equal((f.calls[0] as AgentRequest & { op: "agent_command" }).commandGeneration, agentId(2))
  assert.equal(f.output().result.command.handlerGeneration, agentId(2))
})

test("pending start polling is limited to 45 seconds and never generates another command ID", async () => {
  const f = fixture(); f.retain(sampleCommand())
  f.deps.callAgent = async (_env, r, timeout) => { f.calls.push(r); await f.deps.sleep(timeout!); return f.reply(r) }
  assert.equal(await runControl(["agent", "start", ...flags], f.deps), 75)
  assert.equal(f.deps.now(), 45000); assert.equal(f.out.length, 1)
  assert.equal(f.calls.filter(r => r.op === "agent_start").length, 1)
  assert.equal(f.output().result.command.state, "pending")
})

test("a lost start response is reconciled using the original command identity", async () => {
  const f = fixture()
  f.deps.callAgent = async (_env, r) => { f.calls.push(r); const reply = f.reply(r); if (r.op === "agent_start") throw new AgentError("UNAVAILABLE"); return reply }
  assert.equal(await runControl(["agent", "start", ...flags], f.deps), 0)
  assert.deepEqual(f.calls.map(r => r.op), ["agent_start", "agent_command"])
})

test("current forwards only its normalized cwd and returns an agent list", async () => {
  const f = fixture(); f.deps.cwd = () => "/checkout/nested/.."
  assert.equal(await runControl(["agent", "current", "--json"], f.deps), 0)
  assert.equal((f.calls[0] as AgentRequest & { op: "agent_current" }).cwd, "/checkout")
  assert.deepEqual(f.output().result.agents, [])
})

test("mismatched response identities never become successful output", async () => {
  for (const field of ["requestId", "handlerGeneration"] as const) {
    const f = fixture(); f.deps.callAgent = async (_env, r) => ({ ...f.reply(r), [field]: agentId(99) })
    assert.equal(await runControl(["agent", "list", "--json"], f.deps), field === "requestId" ? 65 : 69)
  }
})

test("unsupported agent transport reports bounded upgrade guidance without restart", async () => {
  const f = fixture(); f.deps.callAgent = async () => { throw new AgentError("UNAVAILABLE") }
  assert.equal(await runControl(["agent", "list", "--json"], f.deps), 69)
  assert.match(f.err.join(""), /explicit Handler restart after upgrade/)
  assert.equal(f.starts(), 1)
})

test("stop dispatch pins the exact provider tuple without lazy startup or cwd access", async () => {
  const f = fixture(); f.deps.cwd = () => { throw new Error("unexpected cwd") }
  f.deps.callAgent = async (_env, request) => {
    f.calls.push(request); assert.equal(request.op, "agent_stop")
    if (request.op !== "agent_stop") throw new Error()
    const target = { agentId: request.input.agentId, handlerGeneration: request.input.handlerGeneration, providerGeneration: request.input.providerGeneration }
    return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, commandId: request.input.commandId, ok: true, result: { state: "command", durability: "verified", command: { ...f.command, op: "stop", commandId: request.input.commandId, input: request.input, target, state: "completed", result: { outcome: "stopped", target, failure: null, session: null } } } }
  }
  assert.equal(await runControl(["agent", "stop", agentId(1), "--handler-generation", agentId(2), "--provider-generation", agentId(3), "--json"], f.deps), 0)
  assert.equal(f.starts(), 0); assert.equal(f.calls.length, 1)
})

test("agent prompt sends one pinned turn without a response deadline", async () => {
  const f = fixture(), target = sampleAgent().launch, calls: AgentRequest[] = [], timeouts: number[] = []
  f.deps.start = async () => { throw new Error("prompt must not start a Handler") }
  f.deps.cwd = () => { throw new Error("prompt must not read cwd") }
  f.deps.callAgent = async (_environment, request, timeoutMs) => {
    calls.push(request); timeouts.push(timeoutMs!)
    if (request.op !== "agent_prompt") throw new Error("unexpected request")
    return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, ok: true, result: { state: "prompt", target: { agentId: request.input.agentId, handlerGeneration: request.input.handlerGeneration, providerGeneration: request.input.providerGeneration }, stopReason: "end_turn", text: "answer" } }
  }
  assert.equal(await runControl(["agent", "prompt", agentId(1), "--text", "--literal\nline two", "--handler-generation", target.handlerGeneration, "--provider-generation", target.providerGeneration, "--json"], f.deps), 0)
  assert.deepEqual(calls.map(call => call.op), ["agent_prompt"])
  assert.deepEqual(timeouts, [0])
  assert.equal(f.starts(), 0)
  assert.deepEqual(f.output().result, { state: "prompt", target: { agentId: agentId(1), handlerGeneration: target.handlerGeneration, providerGeneration: target.providerGeneration }, stopReason: "end_turn", text: "answer" })
})

test("agent prompt does not retry an ambiguous transport failure", async () => {
  const f = fixture(), target = sampleAgent().launch
  f.deps.callAgent = async (_environment, request) => { f.calls.push(request); throw new AgentError("INCOMPLETE") }
  assert.equal(await runControl(["agent", "prompt", agentId(1), "--text", "challenge", "--handler-generation", target.handlerGeneration, "--provider-generation", target.providerGeneration, "--json"], f.deps), 75)
  assert.deepEqual(f.calls.map(call => call.op), ["agent_prompt"])
  assert.equal(f.output().error.code, "INCOMPLETE")
  assert.equal(f.starts(), 0)
})

for (const args of [
  ["agent", "prompt", agentId(1), "--handler-generation", agentId(2), "--provider-generation", agentId(3)],
  ["agent", "prompt", agentId(1), "--text", "", "--handler-generation", agentId(2), "--provider-generation", agentId(3)],
  ["agent", "prompt", agentId(1), "--text", "challenge", "--handler-generation", agentId(2)],
  ["agent", "prompt", agentId(1), "--text", "challenge", "--provider-generation", agentId(3)],
  ["agent", "prompt", agentId(1), "--text", "challenge", "--handler-generation", agentId(2), "--provider-generation", agentId(3), "--command-id", agentId(6)],
  ["agent", "prompt", agentId(1), "--text", "challenge", "--handler-generation", agentId(2), "--provider-generation", agentId(3), "--model", "model-a"],
] as const) test(`agent prompt rejects incomplete or extra authority: ${args.join(" ")}`, async () => {
  const f = fixture()
  assert.equal(await runControl(args, f.deps), 64)
  assert.deepEqual(f.calls, [])
})

test("a pinned lookup cannot create an unknown command or change retained selections", async () => {
  const f = fixture()
  assert.equal(await runControl(["agent", "start", ...flags, "--command-id", agentId(91), "--handler-generation", agentId(2)], f.deps), 69)
  assert.equal(f.starts(), 0); assert.equal(f.calls.length, 0)
  const other = fixture(), changed = flags.map(value => value === "model-a" ? "model-b" : value)
  assert.equal(await runControl(["agent", "start", ...changed, "--command-id", agentId(6), "--handler-generation", agentId(2)], other.deps), 75)
  assert.equal(other.output().error.code, "COMMAND_CONFLICT"); assert.equal(other.calls.length, 0)
})

test("a pinned V3 start compares the selection digest", async () => {
  const f = fixture(), base = f.command
  f.retain({ version: 3, hostId: base.hostId, commandId: base.commandId,
    handlerGeneration: base.handlerGeneration, op: "start", agentId: base.target!.agentId,
    target: base.target, state: "completed", input: { cwd: "/checkout", backendId: "codex-acp",
      selectionDigest: "81614afeb0b86dc3bdc46121f448a4abef09b633a6bd2d2ceb5cdb87572169f4",
      environmentDigest: launchEnvironmentDigest({}), mcpServerNames: [] },
    result: { outcome: "started", target: base.target, session: { sessionId: "fixture-session", protocolVersion: 1 }, failure: null } })
  assert.equal(await runControl(["agent", "start", ...flags, "--command-id", base.commandId,
    "--handler-generation", base.handlerGeneration], f.deps), 0)
  assert.deepEqual(f.calls.map(call => call.op), ["agent_command"])
})

test("offline visible receipt after failed fsync remains unverified until the owner repairs it", async t => {
  const lifecycle = await agentServiceFixture(t), f = fixture()
  lifecycle.failReceipt(true); await lifecycle.service.start(lifecycle.input)
  await until(async () => (await lifecycle.store.readCommand(lifecycle.input.commandId))!.state === "completed" ? true : undefined)
  f.deps.environment = async () => ({ paths: lifecycle.context.paths, adapter: lifecycle.context.adapter }); f.deps.inspect = async () => null; f.deps.agentStore = () => lifecycle.store
  const args = ["agent", "start", ...flags, "--command-id", lifecycle.input.commandId, "--handler-generation", lifecycle.input.handlerGeneration]
  assert.equal(await runControl(args, f.deps), 75); assert.equal(f.output().result.durability, "unverified")
  lifecycle.failReceipt(false)
  f.out.length = 0; f.inspection.record.generation = lifecycle.input.handlerGeneration; f.deps.inspect = async () => f.inspection
  f.deps.callAgent = async (_env, r) => { assert.equal(r.op, "agent_command"); if (r.op !== "agent_command") throw new Error(); return { protocol: AGENT_PROTOCOL, requestId: r.requestId, handlerGeneration: r.handlerGeneration, commandId: r.commandId, ok: true, result: await lifecycle.service.command(r.commandId, r.commandGeneration) } }
  assert.equal(await runControl(args, f.deps), 0); assert.equal(lifecycle.spawns(), 1); assert.equal(f.starts(), 0)
})