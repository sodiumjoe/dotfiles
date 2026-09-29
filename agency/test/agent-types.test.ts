import assert from "node:assert/strict"
import test from "node:test"
import { agentFailure, parseAgentCommand, parseAgentRecord, parseLaunchSpec, parseSession, parseAgentFailure } from "../src/agent/types.js"
import { agentId, sampleAgent, sampleCommand, sampleSession, sampleSpec } from "./agent-support.js"

test("launch evidence is strict, immutable by copying, and never fabricates a resolved model", () => {
  const input = sampleSpec(), parsed = parseLaunchSpec(input)
  assert.equal(parsed.selection.modelId, "model-a")
  assert.equal(parsed.resolvedModelId, null)
  input.selection.modelId = "replacement"
  assert.equal(parsed.selection.modelId, "model-a")
  for (const change of [
    { version: 2 }, { extra: true }, { resolvedModelId: "replacement" }, { agentId: "../outside" }, { hostId: "wrong" }, { handlerGeneration: agentId(99) },
    { configuration: { ...sampleSpec().configuration, fingerprint: "d".repeat(64) } },
    { configuration: { ...sampleSpec().configuration, extra: true } },
    { limits: { ...sampleSpec().limits, startupMs: 30001 } },
    { checkout: { ...sampleSpec().checkout, ancestors: [] } },
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