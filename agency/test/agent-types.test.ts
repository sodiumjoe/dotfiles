import assert from "node:assert/strict"
import test from "node:test"
import { agentFailure, parseAgentCommand, parseAgentRecord, parseLaunchSpec, parseSession, parseAgentFailure, startCommand } from "../src/agent/types.js"
import { launchEnvironmentDigest } from "../src/agent/environment.js"
import { agentId, sampleAgent, sampleCommand, sampleSession, sampleSpec } from "./agent-support.js"

test("version-two agent definition and launch keep ambient cwd without checkout identity", () => {
  const record = sampleAgent()
  assert.equal(record.version, 2)
  assert.equal(record.definition.cwd, "/workspace/a")
  assert.equal(record.definition.agentId, agentId(1))
  assert.equal(record.launch.launchAttemptId, agentId(5))
  assert.equal(JSON.stringify(record).includes("checkoutId"), false)
  assert.equal(JSON.stringify(record).includes("leaseId"), false)
  assert.deepEqual(parseAgentRecord(record), record)
})

test("durable start command stores an environment digest without values", () => {
  const environment = { SECRET_TOKEN: "not-for-state", EMPTY: "", PATH: "/usr/bin" }
  const request = { commandId: agentId(6), handlerGeneration: agentId(2), cwd: "/workspace/a", selection: sampleSpec().selection, environment }
  const command = startCommand(request, { agentId: agentId(1), handlerGeneration: agentId(2), providerGeneration: agentId(3) }, "a".repeat(64))
  assert.equal(command.version, 2)
  assert.ok("environmentDigest" in command.input)
  assert.equal(command.input.environmentDigest, launchEnvironmentDigest(environment))
  assert.equal(JSON.stringify(command).includes("SECRET_TOKEN"), false)
  assert.equal(JSON.stringify(command).includes("not-for-state"), false)
})

test("launch evidence is strict, immutable by copying, and bound to ambient cwd", () => {
  const input = sampleSpec(), parsed = parseLaunchSpec(input)
  assert.equal(parsed.selection.modelId, "model-a")
  assert.equal(parsed.cwd, "/workspace/a")
  input.selection.modelId = "replacement"
  assert.equal(parsed.selection.modelId, "model-a")
  for (const change of [
    { version: 1 }, { extra: true }, { agentId: "../outside" }, { hostId: "wrong" }, { handlerGeneration: agentId(99) },
    { configuration: { ...sampleSpec().configuration, fingerprint: "d".repeat(64) } },
    { configuration: { ...sampleSpec().configuration, extra: true } },
    { limits: { ...sampleSpec().limits, startupMs: 30001 } },
    { cwd: "relative" },
    { selection: { ...sampleSpec().selection, modelId: "absent" } },
    { selection: { ...sampleSpec().selection, reasoning: { kind: "none" } } },
    { selection: { ...sampleSpec().selection, mode: null } },
  ]) assert.throws(() => parseLaunchSpec({ ...sampleSpec(), ...change }), { code: "INVALID_AGENT_STATE" })
})

test("ready records require exact complete session evidence", () => {
  const record = sampleAgent()
  assert.deepEqual(parseAgentRecord(record), record)
  assert.throws(() => parseAgentRecord({ ...record, phase: "ready" }))
  const ready = { ...record, phase: "ready", session: sampleSession() }
  assert.equal(parseAgentRecord(ready).phase, "ready")
  for (const change of [{ modelId: "alias" }, { mode: "plan" }, { permissionProfile: "unrestricted" }, { reasoning: { kind: "none" } }, { sessionGeneration: "pid-1" }, { extra: true }]) {
    assert.throws(() => parseAgentRecord({ ...ready, session: { ...sampleSession(), ...change } }), { code: "INVALID_AGENT_STATE" })
  }
  assert.throws(() => parseAgentRecord({ ...record, phase: "failed", failure: null }))
})

test("session permission evidence accepts only the two closed authorities", () => {
  for (const permissionEvidence of ["fixture-contract-v1", "agency-deny-all-v1"]) assert.equal(parseSession({ ...sampleSession(), permissionEvidence }).permissionEvidence, permissionEvidence)
  for (const permissionEvidence of ["", "unrestricted", "agency-deny-all-v2", "agency-deny-all-v1 ", "FIXTURE-CONTRACT-V1", null, 1, {}]) assert.throws(() => parseSession({ ...sampleSession(), permissionEvidence }), { code: "INVALID_AGENT_STATE" })
})

test("authentication failure has a closed persistable error code", () => {
  assert.deepEqual(parseAgentFailure({ code: "AUTH_REQUIRED", message: "auth required" }), { code: "AUTH_REQUIRED", message: "auth required" })
})

test("commands bind operation, identity, result, and original generation", () => {
  const input = sampleCommand()
  assert.deepEqual(parseAgentCommand(input), input)
  for (const change of [{ commandId: agentId(55) }, { op: "stop" }, { state: "completed" }, { target: { ...input.target, handlerGeneration: agentId(55) } }, { input: { ...input.input, cwd: "relative" } }, { extra: true }]) {
    assert.throws(() => parseAgentCommand({ ...input, ...change }), { code: "INVALID_AGENT_STATE" })
  }
  const completed = { ...input, state: "completed", result: { outcome: "started", target: input.target, session: sampleSession(), failure: null } }
  assert.equal(parseAgentCommand(completed).result?.outcome, "started")
  assert.throws(() => parseAgentCommand({ ...completed, result: { ...completed.result, target: null } }))
  assert.throws(() => parseAgentCommand({ ...completed, result: { ...completed.result, session: null } }))
  assert.throws(() => parseAgentCommand({ ...completed, state: "interrupted" }))
  assert.equal(agentFailure(new Error("secret-token")).message.includes("secret-token"), false)
})