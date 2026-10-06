import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { normalizeAgentRecord, parseAgentRecordV3, parseAgentCommandV3, tupleOfRecord } from "../src/agent/types.js"
import { crossCheckAgents } from "../src/agent/recovery.js"
import type { LaunchContext } from "../src/handler/launch-transitions.js"
import { AGENT_PROTOCOL, parseAgentReply, validateAgentReply } from "../src/agent/protocol.js"
import { launchEnvironmentDigest } from "../src/agent/environment.js"
import { sampleAgent, agentServiceFixture } from "./agent-support.js"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createAgentStore } from "../src/agent/store.js"
import { privateRoot } from "./control-support.js"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"

test("legacy normalization preserves explicit historical choices without rewriting input", () => {
  const old = sampleAgent(), original = structuredClone(old), record = normalizeAgentRecord(old)
  assert.equal(record.version, 3)
  assert.equal(record.definition.backendId, "codex-acp")
  assert.equal(record.definition.origin, "new")
  assert.deepEqual(record.settings, { modelId: old.definition.selection.modelId, modeId: old.definition.selection.mode, configValues: { reasoning: "high" } })
  assert.deepEqual(record.configurationState, { verification: { kind: "verified" }, nonRestorableOptionIds: [] })
  assert.deepEqual(old, original)
})

test("import has native identity but no process ownership", () => {
  const record = normalizeAgentRecord(sampleAgent())
  const imported = { ...record, definition: { ...record.definition, origin: "import" }, phase: "stopped", launch: null, session: { sessionId: "saved-native", protocolVersion: 1 } }
  assert.equal(tupleOfRecord(parseAgentRecordV3(imported)), null)
  for (const patch of [{ phase: "ready" }, { session: null }, { definition: { ...imported.definition, origin: "new" } }]) assert.throws(() => parseAgentRecordV3({ ...imported, ...patch }))
})

test("pending configuration and independent non-restorable IDs survive strict parsing", () => {
  const record = normalizeAgentRecord(sampleAgent()), commandId = randomUUID()
  const configurationState = { verification: { kind: "pending", commandId }, nonRestorableOptionIds: ["transient-setting"] }
  assert.deepEqual(parseAgentRecordV3({ ...record, configurationState }).configurationState, configurationState)
  assert.deepEqual(parseAgentRecordV3({ ...record, configurationState: { ...configurationState, verification: { kind: "verified" } } }).configurationState.nonRestorableOptionIds, ["transient-setting"])
  for (const patch of [
    { configurationState: { ...configurationState, verification: { kind: "pending" } } },
    { configurationState: { ...configurationState, nonRestorableOptionIds: ["same", "same"] } },
    { inputRequirements: { mcpServerNames: ["same", "same"] } },
    { settings: { credential: "secret" } },
    { version: 4 },
    { launch: { ...record.launch, backendFingerprint: "invalid" } },
    { unexpected: true },
  ]) assert.throws(() => parseAgentRecordV3({ ...record, ...patch }))
})

test("inventory normalizes legacy evidence without rewriting durable bytes", async t => {
  const root = await privateRoot(t), old = sampleAgent(), dir = join(root, "agents/records")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, old.definition.agentId + ".json"), bytes = JSON.stringify(old)
  await writeFile(path, bytes, { mode: 0o600 })
  const store = createAgentStore(root), inventory = await store.inventory()
  assert.equal(inventory.agents[0]?.version, 3)
  assert.deepEqual(await store.readAgent(old.definition.agentId), normalizeAgentRecord(old))
  assert.equal(await readFile(path, "utf8"), bytes)
})

test("V3 import publication does not require a fictional launch", async t => {
  const root = await privateRoot(t), store = createAgentStore(root), base = normalizeAgentRecord(sampleAgent())
  const record = parseAgentRecordV3({ ...base, definition: { ...base.definition, origin: "import" }, launch: null, phase: "stopped", session: { sessionId: "saved-native", protocolVersion: 1 } })
  await store.writeAgent(record as never, null)
  assert.deepEqual(await store.readAgent(record.definition.agentId), record)
  assert.deepEqual((await store.inventory()).issues, [])
})

test("import recovery checks native creation evidence without demanding launch ownership", () => {
  const base = normalizeAgentRecord(sampleAgent())
  const record = parseAgentRecordV3({ ...base, definition: { ...base.definition, origin: "import" }, launch: null, phase: "stopped", session: { sessionId: "saved-native", protocolVersion: 1 } })
  const command = parseAgentCommandV3({ version: 3, hostId: record.definition.hostId, commandId: record.definition.createdCommandId, handlerGeneration: randomUUID(), op: "import", input: { backendId: "codex-acp", nativeSessionId: "saved-native", cwd: record.definition.cwd }, agentId: record.definition.agentId, target: null, state: "completed", result: { outcome: "imported", target: null, failure: null, session: record.session } })
  const context = { paths: { persistentRoot: "/fixture", hostKey: record.definition.hostId }, mutations: { accepted: [], issues: [] } } as unknown as LaunchContext
  const result = crossCheckAgents(context, { agents: [record], commands: [command], legacyAgents: [], issues: [] })
  assert.deepEqual([...result.unavailable], [])
  assert.deepEqual(result.issues, [])
  const mismatch = { ...command, input: { ...command.input, nativeSessionId: "another" } }
  assert.equal(crossCheckAgents(context, { agents: [record], commands: [mismatch], legacyAgents: [], issues: [] }).unavailable.size, 1)
})

for (const stage of ["receipt", "record"] as const) test("import recovery closes the " + stage + " write gap without inventing process ownership", async t => {
  const f = await agentServiceFixture(t), agentId = randomUUID(), commandId = randomUUID(), session = { sessionId: "saved-native", protocolVersion: 1 }
  const command = parseAgentCommandV3({ version: 3, hostId: f.context.paths.hostKey, commandId, handlerGeneration: f.context.state.handlerGeneration, op: "import", input: { backendId: "codex-acp", nativeSessionId: "saved-native", cwd: f.workspace }, agentId, target: null, state: "pending", result: null })
  await f.store.writeCommand(command, null)
  if (stage === "record") await f.store.writeAgent(parseAgentRecordV3({ version: 3, definition: { hostId: f.context.paths.hostKey, agentId, createdCommandId: commandId, backendId: "codex-acp", cwd: f.workspace, origin: "import" }, launch: null, phase: "stopped", session, inputRequirements: { mcpServerNames: [] }, settings: {}, configurationState: { verification: { kind: "unknown" }, nonRestorableOptionIds: [] }, failure: null }), null)
  await f.restart()
  const inventory = await f.store.inventory()
  assert.equal(inventory.agents.length, 1)
  assert.equal(inventory.agents[0]!.definition.agentId, agentId)
  assert.equal(inventory.agents[0]!.launch, null)
  assert.deepEqual((await f.store.readCommand(commandId))!.result, { outcome: "imported", target: null, failure: null, session })
  assert.equal(f.spawns(), 0)
  assert.equal(f.context.mutations.accepted.length, 0)
})

test("dangling configure intent requires native verification even before marker publication", () => {
  const base = normalizeAgentRecord(sampleAgent()), target = tupleOfRecord(base)!
  const command = parseAgentCommandV3({ version: 3, hostId: base.definition.hostId, commandId: randomUUID(), handlerGeneration: target.handlerGeneration, op: "configure", input: { target, method: "session/set_model", optionIds: ["model"], prior: base.settings, desired: { ...base.settings, modelId: "model-b" }, priorNonRestorableOptionIds: ["secret-option"] }, agentId: target.agentId, target, state: "pending", result: null })
  const context = { paths: { persistentRoot: "/fixture", hostKey: base.definition.hostId }, mutations: { accepted: [], issues: [] } } as unknown as LaunchContext
  const result = crossCheckAgents(context, { agents: [base], commands: [command], legacyAgents: [], issues: [] })
  assert.deepEqual(result.configurationPending.get(target.agentId), [command.commandId])
  assert.equal(base.configurationState.verification.kind, "verified")
})

test("control roster accepts an imported stopped record without a live tuple", () => {
  const base = normalizeAgentRecord(sampleAgent())
  const record = parseAgentRecordV3({ ...base, definition: { ...base.definition, origin: "import" }, launch: null, phase: "stopped", session: { sessionId: "saved-native", protocolVersion: 1 } })
  const view = { record, launch: null, live: false, cleanup: "not_launched", unavailable: null }
  const reply = { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: randomUUID(), ok: true, result: { state: "agents", agents: [view], issues: [] } }
  assert.deepEqual(parseAgentReply(reply), reply)
  assert.throws(() => parseAgentReply({ ...reply, protocol: "agency-agent/2" }))
  assert.throws(() => parseAgentReply({ ...reply, result: { ...reply.result, agents: [{ ...view, live: true }] } }))
})

test("control reply validates V3 native selection against the CLI request", () => {
  const old = sampleAgent(), record = normalizeAgentRecord(old), commandId = record.definition.createdCommandId
  const request = { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: old.launch.handlerGeneration, op: "agent_start" as const, input: { commandId, handlerGeneration: old.launch.handlerGeneration, cwd: old.definition.cwd, selection: old.definition.selection, environment: {} } }
  const command = parseAgentCommandV3({ version: 3, hostId: record.definition.hostId, commandId, handlerGeneration: request.handlerGeneration, agentId: record.definition.agentId, op: "start", input: { cwd: record.definition.cwd, backendId: "codex-acp", selection: record.settings, environmentDigest: launchEnvironmentDigest({}), mcpServerNames: [] }, target: tupleOfRecord(record), state: "pending", result: null })
  const reply = parseAgentReply({ protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, commandId, ok: true, result: { state: "command", command, durability: "verified" } })
  assert.doesNotThrow(() => validateAgentReply(reply, request))
  assert.throws(() => validateAgentReply(reply, { ...request, input: { ...request.input, environment: { SECRET: "changed" } } }), { code: "INVALID_PROTOCOL" })
})

test("normalized expected state cannot overwrite an intervening raw publication", async t => {
  const root = await privateRoot(t), store = createAgentStore(root), original = normalizeAgentRecord(sampleAgent())
  await store.writeAgent(original, null)
  const path = join(root, "agents/records", original.definition.agentId + ".json"), intervening = { ...original, settings: { modelId: "concurrent" } }
  const lstat = fs.promises.lstat
  let checks = 0
  t.mock.method(fs.promises, "lstat", async (...args: Parameters<typeof lstat>) => {
    if (String(args[0]) === join(root, "agents/records") && ++checks === 2) await writeFile(path, JSON.stringify(intervening), { mode: 0o600 })
    return lstat(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(store.writeAgent({ ...original, settings: { modelId: "stale-overwrite" } }, original), { code: "COMMAND_CONFLICT" })
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).settings, { modelId: "concurrent" })
})