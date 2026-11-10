import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { PassThrough } from "node:stream"
import { createAcpConnection } from "../src/agent/acp.js"
import { AGENT_LIMITS, AgentError, agentFailure, splitLaunchSpec, parseAgentCommandV3, normalizeAgentRecord } from "../src/agent/types.js"
import { projectRestorableSettings, type JsonObject, type RequestedSettings } from "../src/agent/session-config.js"
import { parseFailureDiagnostic } from "../src/agent/failure-diagnostics.js"
import { sampleSpec, sampleContract } from "./agent-support.js"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { observeConfig } from "../src/catalog/config.js"
import { configureLaunchContract, productionLaunchContracts } from "../src/agent/contracts.js"
import { readBackendConfig } from "../src/agent/backend-config.js"
import { backendSelection } from "../src/agent/backend-selection.js"

test("production default qualifies Codex 2.6 and exposes selectable modes", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agency-codex-26-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = { id: "codex-acp" as const, enabled: true, executable: process.execPath, adapterPackageJson: fileURLToPath(new URL("../../../node-bin/node_modules/@agentclientprotocol/codex-acp/package.json", import.meta.url)), sdkPackageJson: null, configurationFiles: [] }
  await mkdir(join(root, "catalog"), { mode: 0o700 })
  await writeFile(join(root, "catalog/providers.json"), JSON.stringify({ version: 1, providers: [profile] }), { mode: 0o600 })
  const backend = (await readBackendConfig(root)).backends[0]!
  const declaration = productionLaunchContracts().find(contract => contract.id === backend.compatibilityId)!
  const evidence = await observeConfig(profile)
  const configured = await configureLaunchContract(declaration, profile, evidence)
  assert.equal(configured.adapterVersion, "2.6.0")
  assert.deepEqual((backendSelection(backend, configured).settings as JsonObject[])[0]?.values, [{ value: "read-only", name: "read-only" }, { value: "agent", name: "agent" }, { value: "agent-full-access", name: "agent-full-access" }])
  await assert.rejects(configureLaunchContract(declaration, profile, { ...evidence, adapterVersion: "2.6.1" }), { code: "ADAPTER_UNQUALIFIED" })
})

type Phase = "initialize" | "session/new" | "session/load" | "configuration"
test("Agency initializes the actual Codex 2.6 adapter with connection auth notifications", async t => {
  const { peer } = await import(fileURLToPath(new URL("../../../node-bin/test/fixtures/acp-peer.mjs", import.meta.url)))
  const p = await peer(t, { initialize: false })
  const acp = createAcpConnection({ readable: p.readable, writable: p.writable, limits: AGENT_LIMITS })
  t.after(() => acp.close())
  const spec = sampleSpec({ cwd: p.root }), record = normalizeAgentRecord({ version: 2, ...splitLaunchSpec(spec), phase: "starting", session: null, failure: null })
  record.settings = {}
  const session = await acp.initialize(record, sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  assert.equal(session.sessionId, "fixture-session")
  assert.ok(p.inbound.some((frame: { method?: string }) => frame.method === "_auth/status_update"))
  assert.equal(p.nativeRequests.some((frame: { method: string }) => frame.method === "turn/start"), false)
})

for (const contractId of ["codex-acp-1.7", "codex-acp-2.6"]) test("legacy Codex record keeps reasoning option for " + contractId, () => {
  const spec = sampleSpec(), launch = splitLaunchSpec(spec)
  const record = normalizeAgentRecord({ version: 2, ...launch, launch: { ...launch.launch, contractId }, phase: "starting", session: null, failure: null })
  assert.deepEqual(record.settings.configValues, { reasoning_effort: spec.selection.reasoning.kind === "value" ? spec.selection.reasoning.value : "high" })
})
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

function settingsFixture(t: TestContext, behavior: "normal" | "ignored" | "regressed" | "dynamic" | "legacy" | "unmapped" | "config-only" = "normal") {
  const readable = new PassThrough(), writable = new PassThrough()
  const connection = createAcpConnection({ readable, writable, limits: AGENT_LIMITS })
  t.after(() => { connection.close(); readable.destroy(); writable.destroy() })
  let model = "model-a", effort = "low", mode = "agent-full-access", legacyModel = "legacy-a", legacyMode = "normal"
  const config = (): JsonObject[] => [
    { id: "model", type: "select", category: "model", currentValue: model, options: [{ value: "model-a" }, { value: "model-b" }] },
    ...(behavior !== "dynamic" || model === "model-b" ? [{ id: "reasoning", type: "select", currentValue: effort, options: [{ value: "low" }, { value: "high" }] }] : []),
    { id: "mode", type: "select", category: "mode", currentValue: mode, options: [{ value: "agent-full-access" }, { value: "read-only" }] },
  ]
  const modes = (): JsonObject => ({ currentModeId: behavior === "legacy" ? legacyMode : behavior === "unmapped" ? "normal" : "agent-full-access", availableModes: behavior === "legacy" || behavior === "unmapped" ? [{ id: "normal" }, { id: "review" }] : [{ id: "agent-full-access" }, { id: "read-only" }] })
  const send = (id: number, result: JsonObject) => readable.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
  writable.on("data", bytes => {
    const request = JSON.parse(bytes.toString())
    if (request.method === "initialize") send(request.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
    else if (request.method === "session/load" || request.method === "session/new") send(request.id, {
      sessionId: "fixture-session", ...(behavior === "config-only" ? {} : { modes: modes(), models: { currentModelId: behavior === "legacy" ? legacyModel : "model-a[low]", availableModels: behavior === "legacy" ? [{ modelId: "legacy-a" }, { modelId: "legacy-b" }] : [{ modelId: "model-a[low]" }] } }),
      ...(behavior === "legacy" ? {} : { configOptions: config() }),
    })
    else if (request.method === "session/set_config_option") {
      if (behavior !== "ignored") {
        if (request.params.configId === "model") model = request.params.value
        if (request.params.configId === "reasoning") effort = request.params.value
        if (request.params.configId === "mode") { mode = request.params.value; if (behavior === "regressed") effort = "low" }
      }
      send(request.id, { configOptions: config() })
    } else if (request.method === "session/set_model" || request.method === "session/set_mode") {
      if (request.method === "session/set_model") legacyModel = request.params.modelId
      else legacyMode = request.params.modeId
      send(request.id, {})
    }
  })
  const start = (settings: RequestedSettings, kind: "load" | "new" = "load") => connection.initialize({ ...normalizeAgentRecord({ version: 2, ...splitLaunchSpec(sampleSpec()), phase: "starting", session: null, failure: null }), settings }, sampleContract(), kind === "load" ? { kind, sessionId: "fixture-session", params: {} } : { kind, params: {} }, new AbortController().signal)
  return { connection, start, updateMode: (currentModeId: string) => readable.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "current_mode_update", currentModeId } } }) + "\n") }
}

for (const kind of ["new", "load"] as const) test("canonical mode and model override stale legacy settings during " + kind, async t => {
  const f = settingsFixture(t)
  const session = await f.start({ modelId: "retired[low]", modeId: "agent-full-access", configValues: { model: "model-a", reasoning: "high", mode: "read-only" } }, kind)
  assert.deepEqual(projectRestorableSettings(session.configuration).configValues, { model: "model-a", reasoning: "high", mode: "read-only" })
  assert.equal(session.configuration.modes?.currentModeId, "read-only")
  assert.equal(session.sessionId, "fixture-session")
})

test("loaded settings discover dependent options after restoring the model", async t => {
  const f = settingsFixture(t, "dynamic")
  const session = await f.start({ configValues: { model: "model-b", reasoning: "high", mode: "read-only" } })
  assert.deepEqual(projectRestorableSettings(session.configuration).configValues, { model: "model-b", reasoning: "high", mode: "read-only" })
})

for (const behavior of ["ignored", "regressed"] as const) test("loaded settings reject " + behavior + " acknowledgments", async t => {
  const f = settingsFixture(t, behavior)
  await assert.rejects(f.start({ configValues: { model: "model-a", reasoning: "high", mode: "read-only" } }), { code: "SELECTION_UNSUPPORTED" })
})

test("legacy-only load reapplies saved model and mode", async t => {
  const f = settingsFixture(t, "legacy")
  const session = await f.start({ modelId: "legacy-b", modeId: "review" })
  assert.deepEqual(projectRestorableSettings(session.configuration), { modelId: "legacy-b", modeId: "review" })
})

test("canonical mode does not invent an unadvertised legacy mapping", async t => {
  const f = settingsFixture(t, "unmapped")
  const session = await f.start({ configValues: { model: "model-a", reasoning: "high", mode: "read-only" } })
  assert.equal(session.configuration.modes?.currentModeId, "normal")
  assert.equal(projectRestorableSettings(session.configuration).configValues?.mode, "read-only")
})

test("canonical mode follows an acknowledged equivalent legacy mode setter", async t => {
  const f = settingsFixture(t)
  await f.start({ configValues: { model: "model-a", reasoning: "high", mode: "agent-full-access" } }, "new")
  await f.connection.request("session/set_mode", { sessionId: "fixture-session", modeId: "read-only" })
  assert.equal(projectRestorableSettings(f.connection.snapshot()).configValues?.mode, "read-only")
  assert.equal(f.connection.snapshot().modes?.currentModeId, "read-only")
})

test("canonical mode follows an equivalent native mode update", async t => {
  const f = settingsFixture(t)
  await f.start({ configValues: { model: "model-a", reasoning: "high", mode: "agent-full-access" } }, "new")
  f.updateMode("read-only")
  assert.equal(projectRestorableSettings(f.connection.snapshot()).configValues?.mode, "read-only")
  assert.equal(f.connection.snapshot().modes?.currentModeId, "read-only")
})

test("canonical mode survives removal of the legacy settings surface", async t => {
  const f = settingsFixture(t, "config-only")
  const session = await f.start({ modelId: "retired[low]", modeId: "agent-full-access", configValues: { model: "model-a", reasoning: "high", mode: "read-only" } })
  assert.deepEqual(projectRestorableSettings(session.configuration).configValues, { model: "model-a", reasoning: "high", mode: "read-only" })
})