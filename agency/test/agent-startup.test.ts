import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { PassThrough } from "node:stream"
import { createAcpConnection } from "../src/agent/acp.js"
import { AGENT_LIMITS, AgentError, agentFailure, splitLaunchSpec, parseAgentCommandV3 } from "../src/agent/types.js"
import { parseFailureDiagnostic } from "../src/agent/failure-diagnostics.js"
import { sampleSpec, sampleContract } from "./agent-support.js"

type Phase = "initialize" | "session/new" | "session/load" | "configuration"
type Startup = { phase: Phase; elapsedMs: number; replayUpdates: number }
function fixture(t: TestContext, stage: Phase | "ready", replay = 0) {
  const readable = new PassThrough(), writable = new PassThrough()
  const connection = createAcpConnection({ readable, writable, limits: AGENT_LIMITS, deadline: performance.now() + 100 })
  t.after(() => { connection.close(); readable.destroy(); writable.destroy() })
  const send = (frame: unknown) => readable.write(JSON.stringify({ jsonrpc: "2.0", ...frame as object }) + "\n")
  writable.on("data", bytes => {
    const request = JSON.parse(bytes.toString())
    if (request.method === "initialize" && stage !== "initialize") send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
    else if (request.method === "session/load") {
      for (let index = 0; index < replay; index++) send({ method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "private fixture history" } } } })
      if (stage === "ready") send({ id: request.id, result: { configOptions: [] } })
    } else if (request.method === "session/new" && stage === "configuration") send({ id: request.id, result: { sessionId: "fixture-session", configOptions: [
      { id: "model", type: "select", currentValue: "model-a", options: [{ value: "model-a" }] },
      { id: "reasoning", type: "select", currentValue: "low", options: [{ value: "low" }, { value: "high" }] },
      { id: "mode", type: "select", currentValue: "plan", options: [{ value: "plan" }, { value: "review" }] },
    ] } })
  })
  return { connection, send }
}

for (const [phase, replay] of [["initialize", 0], ["session/new", 0], ["configuration", 0], ["session/load", 0], ["session/load", 2]] as const) {
  test("startup timeout identifies " + phase + " with " + replay + " replay updates", { timeout: 2000 }, async t => {
    const { connection } = fixture(t, phase, replay)
    const loading = phase === "session/load"
    const started = connection.initialize({ version: 2, ...splitLaunchSpec(sampleSpec()), phase: "starting", session: null, failure: null }, sampleContract(), loading ? { kind: "load", sessionId: "fixture-session", params: {} } : { kind: "new", params: {} }, new AbortController().signal)
    const rejected = started.catch(error => error)
    const failure = await connection.fault
    assert.equal((await rejected).code, "STARTUP_TIMEOUT")
    assert.equal(failure.code, "STARTUP_TIMEOUT")
    assert.equal(failure.diagnostic?.boundary, "acp_transport")
    const startup = (failure.diagnostic as unknown as { startup?: Startup })?.startup
    assert.equal(startup?.phase, phase)
    assert.equal(startup?.replayUpdates, replay)
    assert.ok(Number.isSafeInteger(startup!.elapsedMs) && startup!.elapsedMs >= 0)
    assert.equal(JSON.stringify(failure).includes("private fixture history"), false)
    assert.deepEqual(parseFailureDiagnostic(failure.diagnostic), failure.diagnostic)
  })
}

test("startup diagnostics preserve old receipts and reject malformed progress", () => {
  const legacy = { boundary: "acp_transport", causeCode: "STARTUP_TIMEOUT" }
  assert.deepEqual(parseFailureDiagnostic(legacy), legacy)
  const valid = { ...legacy, startup: { phase: "session/load", elapsedMs: 100, replayUpdates: 2 } }
  assert.deepEqual(parseFailureDiagnostic(valid), valid)
  const failure = agentFailure(new AgentError("STARTUP_TIMEOUT", parseFailureDiagnostic(valid)))
  const spec = sampleSpec(), target = { agentId: spec.agentId, handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration }
  const command = { version: 3, hostId: spec.hostId, commandId: spec.commandId, handlerGeneration: spec.handlerGeneration, agentId: spec.agentId, op: "restore", input: { agentId: spec.agentId, environmentDigest: "c".repeat(64), mcpServerNames: [] }, target, state: "completed", result: { outcome: "failed", target, failure, session: null } }
  assert.deepEqual(parseAgentCommandV3(command).result?.failure, failure)
  for (const startup of [
    { phase: "unknown", elapsedMs: 100, replayUpdates: 2 },
    { phase: ["session/load"], elapsedMs: 100, replayUpdates: 2 },
    { phase: "session/load", elapsedMs: -1, replayUpdates: 2 },
    { phase: "session/load", elapsedMs: 0.5, replayUpdates: 2 },
    { phase: "session/load", elapsedMs: 100, replayUpdates: -1 },
    { phase: "session/load", elapsedMs: 100, replayUpdates: Number.MAX_SAFE_INTEGER + 1 },
    { phase: "session/load", elapsedMs: 100, replayUpdates: 2, text: "private fixture history" },
  ]) assert.throws(() => parseFailureDiagnostic({ ...legacy, startup }))
  assert.throws(() => parseFailureDiagnostic({ ...valid, boundary: "provider_initialize" }))
})

test("successful load clears startup timers and later RPC timeout carries no startup progress", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { connection, send } = fixture(t, "ready", 2)
  await connection.initialize({ version: 2, ...splitLaunchSpec(sampleSpec()), phase: "starting", session: null, failure: null }, sampleContract(), { kind: "load", sessionId: "fixture-session", params: {} }, new AbortController().signal)
  t.mock.timers.tick(30001)
  send({ method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late live output" } } } })
  const request = connection.request("session/set_config_option", { sessionId: "fixture-session", configId: "mode", value: "review" }).catch(error => error)
  t.mock.timers.tick(5001)
  assert.equal((await request).code, "STARTUP_TIMEOUT")
  const failure = await connection.fault
  assert.equal((failure.diagnostic as unknown as { startup?: Startup })?.startup, undefined)
})