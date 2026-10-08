import { createOrchestrationService } from "../src/orchestration/service.js"
import { createJournalPool } from "../src/orchestration/journal.js"
import { createLineageStore } from "../src/orchestration/lineage.js"
import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"
import type { AgentRecordV3, CommandView } from "../src/agent/types.js"
import type { CreateSessionInput } from "../src/agent/service.js"
import type { JsonObject } from "../src/agent/session-config.js"

type Hooks = { agentId: string; mcpServerNames?: string[]; prepare(record: AgentRecordV3, params: JsonObject): Promise<JsonObject>; ready?(record: AgentRecordV3): void; revoke?(): void }
const launch = (f: Awaited<ReturnType<typeof agentServiceFixture>>, hooks: Hooks) =>
  (f.service as unknown as { launchSession(request: CreateSessionInput, kind: "start", hooks: Hooks): Promise<CommandView> }).launchSession({ commandId: f.input.commandId, cwd: f.input.cwd, backendId: "codex-acp", selection: { modelId: "model-a" }, environment: f.input.environment, nativeParams: {} }, "start", hooks)

test("reserved agent execution is prepared durably before provider creation", async t => {
  const f = await agentServiceFixture(t), agentId = randomUUID(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const request = launch(f, { agentId, async prepare(record, params) { assert.equal(record.definition.agentId, agentId); assert.ok(record.launch?.providerGeneration); assert.equal(f.spawns(), 0); entered.resolve(); await gate.promise; return params } })
  await entered.promise
  assert.equal(f.spawns(), 0)
  gate.resolve()
  const accepted = await request
  assert.equal(accepted.command.target?.agentId, agentId)
  const terminal = await until(async () => { const receipt = await f.service.command(f.input.commandId, f.input.handlerGeneration); return receipt.command.state !== "pending" ? receipt : undefined })
  assert.equal(terminal.command.result?.outcome, "started")
  assert.equal(f.spawns(), 1)
})

test("failed orchestration preparation dispatches no provider and leaves ordinary starts available", async t => {
  const f = await agentServiceFixture(t)
  await assert.rejects(launch(f, { agentId: randomUUID(), async prepare() { throw new Error("ENOSPC preparation") } }), /ENOSPC/)
  assert.equal(f.spawns(), 0)
  await f.service.createSession({ commandId: randomUUID(), cwd: f.input.cwd, backendId: "codex-acp", environment: f.input.environment, nativeParams: {} })
  assert.equal(f.spawns(), 1)
})

test("prepared session inputs reach ACP while generated credentials stay out of durable commands", async t => {
  const f = await agentServiceFixture(t), agentId = randomUUID(), token = "transient-test-token"
  await launch(f, { agentId, mcpServerNames: ["agency"], async prepare(_record, params) { return { ...params, mcpServers: [{ name: "agency", command: "fixture-helper", args: [], env: [{ name: "AGENCY_TOKEN", value: token }] }] } } })
  await until(async () => (await f.service.command(f.input.commandId, f.input.handlerGeneration)).command.state !== "pending" ? true : undefined)
  const command = await f.store.readCommand(f.input.commandId)
  assert.ok(!JSON.stringify(command).includes(token))
  assert.deepEqual((await f.service.sessionRecord(agentId))!.record.inputRequirements.mcpServerNames, ["agency"])
})

test("local host binds launch lineage to the reserved execution before creation", async t => {
  const f = await agentServiceFixture(t), hostId = f.context.paths.hostKey, journals = createJournalPool(f.root, undefined, Date.now, "origin"), lineage = createLineageStore(f.root)
  let execution: unknown = null
  const host = createOrchestrationService({ root: f.root, hostId, agents: f.service, journals, lineage, tools: { definition(target) { execution = target; return { name: "agency", command: "fixture-helper", args: [], env: [] } }, activate() {}, revoke() {} }, relay: async () => { throw new Error("offline") } })
  const parent = { hostId, agentId: randomUUID() }, runId = randomUUID(), assignmentId = randomUUID(), attemptId = randomUUID(), child = { hostId, agentId: randomUUID() }
  const command = { commandId: randomUUID(), runId, ref: { runId, assignmentId, attemptId }, agent: child, handlerGeneration: f.service.handlerGeneration, bindingEpoch: randomUUID(), spec: { parent, description: "Inspect local state", hostId, cwd: f.workspace, backendId: "codex-acp" as const, modelId: "model-a", overrides: {}, git: null }, lineage: { runId, parent, assignmentId }, git: null, retryMode: "new" as const, savedSettings: null }
  const receipt = await host.launch(command, { environment: f.input.environment, nativeParams: {} })
  assert.equal(receipt.state, "started")
  assert.deepEqual(receipt.execution, execution)
  assert.deepEqual(await lineage.read(child), command.lineage)
  const entries = await journals.forRun(runId).read(0, 256)
  assert.equal(entries.entries[0]!.kind, "origin-launch")
  assert.ok(!JSON.stringify(entries).includes('"environment":'))
  assert.equal(f.spawns(), 1)
  assert.deepEqual(await host.inspectCommand(command.commandId, command.handlerGeneration), receipt)
  await assert.rejects(host.launch({ ...command, spec: { ...command.spec, description: "Changed assignment" } }, { environment: f.input.environment, nativeParams: {} }), /COMMAND_CONFLICT/)
  await assert.rejects(host.launch({ ...command, ref: { ...command.ref, attemptId: randomUUID() } }, { environment: f.input.environment, nativeParams: {} }), /COMMAND_CONFLICT/)
  assert.equal(f.spawns(), 1)
})

test("preparation failure revokes a generated tool binding even before its journal is published", async t => {
  const f = await agentServiceFixture(t), journals = createJournalPool(f.root, undefined, Date.now, "origin"), lineage = createLineageStore(f.root), hostId = f.context.paths.hostKey
  const original = journals.forRun, expected = new Set<string>(), revoked = new Set<string>()
  journals.forRun = runId => ({ ...original(runId), async append() { throw new Error("ENOSPC origin preparation") } })
  const host = createOrchestrationService({ root: f.root, hostId, agents: f.service, journals, lineage, tools: { definition(target) { expected.add(target.providerGeneration); return { name: "agency", command: "helper", args: [], env: [] } }, activate() {}, revoke(target) { revoked.add(target.providerGeneration) } }, relay: async () => { throw new Error("offline") } })
  await assert.rejects(host.launchRoot({ commandId: randomUUID(), runId: randomUUID(), agent: { hostId, agentId: randomUUID() }, handlerGeneration: f.service.handlerGeneration, bindingEpoch: randomUUID(), cwd: f.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {} }, { environment: f.input.environment, nativeParams: {} }), /ENOSPC/)
  assert.equal(f.spawns(), 0)
  assert.equal(expected.size, 1)
  assert.deepEqual(revoked, expected)
})

test("explicit local restore preserves immutable lineage and rotates execution bindings", async t => {
  const f = await agentServiceFixture(t), hostId = f.context.paths.hostKey, journals = createJournalPool(f.root, undefined, Date.now, "origin"), lineage = createLineageStore(f.root), activations: string[] = [], revocations: string[] = []
  const host = createOrchestrationService({ root: f.root, hostId, agents: f.service, journals, lineage, tools: { definition() { return { name: "agency", command: "fixture-helper", args: [], env: [] } }, activate(target) { activations.push(target.providerGeneration) }, revoke(target) { revocations.push(target.providerGeneration) } }, relay: async () => { throw new Error("offline") } })
  const parent = { hostId, agentId: randomUUID() }, runId = randomUUID(), assignmentId = randomUUID(), attemptId = randomUUID(), child = { hostId, agentId: randomUUID() }
  const command = { commandId: randomUUID(), runId, ref: { runId, assignmentId, attemptId }, agent: child, handlerGeneration: f.service.handlerGeneration, bindingEpoch: randomUUID(), spec: { parent, description: "Inspect local state", hostId, cwd: f.workspace, backendId: "codex-acp" as const, modelId: "model-a", overrides: {}, git: null }, lineage: { runId, parent, assignmentId }, git: null, retryMode: "new" as const, savedSettings: null }
  const first = await host.launch(command, { environment: f.input.environment, nativeParams: {} })
  const stopId = randomUUID()
  await f.service.stop({ agentId: child.agentId, handlerGeneration: first.execution!.handlerGeneration, providerGeneration: first.execution!.providerGeneration, commandId: stopId })
  await until(async () => (await f.service.command(stopId, command.handlerGeneration)).command.state !== "pending" ? true : undefined)
  const backendPath = join(f.root, "catalog/backends.json"), backend = JSON.parse(await readFile(backendPath, "utf8"))
  backend.backends[0].initial = { configValues: { reasoning: "low" } }
  await writeFile(backendPath, JSON.stringify(backend), { mode: 0o600 })
  const restored = await host.launch({ ...command, commandId: randomUUID(), ref: { ...command.ref, attemptId: randomUUID() }, retryMode: "restore", savedSettings: first.effective }, { environment: f.input.environment, nativeParams: {} })
  assert.equal(restored.state, "started")
  assert.deepEqual(restored.effective, first.effective)
  assert.notEqual(restored.execution!.providerGeneration, first.execution!.providerGeneration)
  assert.deepEqual(await lineage.read(child), command.lineage)
  assert.ok(revocations.includes(first.execution!.providerGeneration))
  assert.deepEqual(activations, [first.execution!.providerGeneration, restored.execution!.providerGeneration])
})

test("failed launch publication revokes its binding and inspection cannot dispatch it", async t => {
  for (const failure of ["command", "agent"] as const) {
    const f = await agentServiceFixture(t), agentId = randomUUID()
    let revoked = false
    if (failure === "command") f.failInitialCommand(true)
    else f.failInitialAgent(true)
    await assert.rejects(launch(f, { agentId, async prepare(_record, params) { return params }, revoke() { revoked = true } }), /incomplete/i)
    assert.equal(revoked, true)
    f.failInitialCommand(false); f.failInitialAgent(false)
    const receipt = await (f.service as unknown as { commandReceipt(commandId: string, generation: string): Promise<CommandView | null> }).commandReceipt(f.input.commandId, f.input.handlerGeneration)
    assert.equal(receipt?.command.state, "pending")
    assert.equal(f.spawns(), 0)
  }
})

async function localFixture(t: test.TestContext) {
  const f = await agentServiceFixture(t), hostId = f.context.paths.hostKey, journals = createJournalPool(f.root, undefined, Date.now, "origin"), lineage = createLineageStore(f.root)
  const tools = { definition() { return { name: "agency", command: "fixture-helper", args: [], env: [] } }, activate() {}, revoke() {} }
  const makeHost = () => createOrchestrationService({ root: f.root, hostId, agents: f.service, journals, lineage, tools, relay: async () => { throw new Error("offline") } })
  const rootCommand = { commandId: randomUUID(), runId: randomUUID(), agent: { hostId, agentId: randomUUID() }, handlerGeneration: f.service.handlerGeneration, bindingEpoch: randomUUID(), cwd: f.workspace, backendId: "codex-acp" as const, modelId: "model-a", overrides: {} }
  return { ...f, hostId, journals, lineage, makeHost, rootCommand, invocation: { environment: f.input.environment, nativeParams: {} } }
}

test("origin receipt loss after spawn is inspectable without another provider dispatch", async t => {
  const f = await localFixture(t), original = f.journals.forRun
  let fail = true
  f.journals.forRun = runId => ({ ...original(runId), async append(eventId, kind, payload) { if (kind === "origin-receipt" && fail) throw new Error("receipt lost"); return original(runId).append(eventId, kind, payload) } })
  await assert.rejects(f.makeHost().launchRoot(f.rootCommand, f.invocation), /receipt lost/)
  assert.equal(f.spawns(), 1)
  fail = false
  const recovered = f.makeHost(), receipt = await recovered.inspectCommand(f.rootCommand.commandId, f.rootCommand.handlerGeneration)
  assert.equal(receipt?.state, "started")
  assert.deepEqual(await recovered.launchRoot(f.rootCommand, f.invocation), receipt)
  assert.equal(f.spawns(), 1)
})

test("origin preparation without Agent command remains uncertain across origin recovery", async t => {
  const f = await localFixture(t)
  f.failInitialCommand(true)
  await assert.rejects(f.makeHost().launchRoot(f.rootCommand, f.invocation), /incomplete/i)
  f.failInitialCommand(false)
  const recovered = f.makeHost(), receipt = await recovered.inspectCommand(f.rootCommand.commandId, f.rootCommand.handlerGeneration)
  assert.equal(receipt?.state, "uncertain")
  assert.deepEqual(await recovered.launchRoot(f.rootCommand, f.invocation), receipt)
  assert.equal(f.spawns(), 0)
})

test("fresh launches resolve the current configured effort defaults", async t => {
  const f = await localFixture(t), path = join(f.root, "catalog/backends.json")
  const backend = JSON.parse(await readFile(path, "utf8"))
  backend.backends[0].initial = { configValues: { reasoning: "low" } }
  await writeFile(path, JSON.stringify(backend), { mode: 0o600 })
  const host = f.makeHost(), first = await host.launchRoot(f.rootCommand, f.invocation)
  assert.equal(first.effective?.configValues?.reasoning, "low")
  const stopId = randomUUID()
  await f.service.stop({ agentId: first.execution!.agentId, handlerGeneration: first.execution!.handlerGeneration, providerGeneration: first.execution!.providerGeneration, commandId: stopId })
  await until(async () => (await f.service.command(stopId, f.rootCommand.handlerGeneration)).command.state !== "pending" ? true : undefined)
  backend.backends[0].initial = { configValues: { reasoning: "high" } }
  await writeFile(path, JSON.stringify(backend), { mode: 0o600 })
  const replacement = await host.launchRoot({ ...f.rootCommand, commandId: randomUUID(), runId: randomUUID(), agent: { hostId: f.hostId, agentId: randomUUID() } }, f.invocation)
  assert.equal(replacement.effective?.configValues?.reasoning, "high")
})

test("external Agency tool name conflict fails before any origin preparation", async t => {
  const f = await localFixture(t)
  await assert.rejects(f.makeHost().launchRoot(f.rootCommand, { ...f.invocation, nativeParams: { mcpServers: [{ name: "agency", command: "external", args: [], env: [] }] } }), /SESSION_INPUT_REQUIRED/)
  assert.equal(f.spawns(), 0)
  assert.deepEqual(await f.journals.list(), [])
})

test("report retention and generation retirement share Handler mutation ordering", async t => {
  const f = await localFixture(t), root = f.rootCommand, assignmentId = randomUUID(), attemptId = randomUUID()
  const command = { ...root, ref: { runId: root.runId, assignmentId, attemptId }, spec: { parent: { hostId: f.hostId, agentId: randomUUID() }, description: "Report", hostId: f.hostId, cwd: f.workspace, backendId: "codex-acp" as const, modelId: "model-a", overrides: {}, git: null }, lineage: { runId: root.runId, parent: { hostId: f.hostId, agentId: randomUUID() }, assignmentId }, git: null, retryMode: "new" as const, savedSettings: null }
  const host = f.makeHost(), receipt = await host.launch(command, f.invocation), original = f.journals.forRun
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.journals.forRun = runId => ({ ...original(runId), async append(eventId, kind, payload) { if (kind === "report-retained") { entered.resolve(); await release.promise }; return original(runId).append(eventId, kind, payload) } })
  const reporting = host.report({ ...command.ref, commandId: randomUUID(), execution: receipt.execution!, report: { status: "completed", summary: "Done", issues: [], validation: [], git: null } })
  await entered.promise
  const stopId = randomUUID(), stopping = f.service.stop({ agentId: receipt.execution!.agentId, handlerGeneration: receipt.execution!.handlerGeneration, providerGeneration: receipt.execution!.providerGeneration, commandId: stopId })
  try {
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(await f.store.readCommand(stopId), null)
  } finally { release.resolve(); await reporting; await stopping }
})

test("launch timeout revokes preparation before and after its asynchronous completion", async t => {
  const f = await agentServiceFixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.contract.deadlines.commandMs = 250
  let revocations = 0
  const launching = launch(f, { agentId: randomUUID(), async prepare(_record, params) { entered.resolve(); await release.promise; return params }, revoke() { revocations++ } })
  void launching.catch(() => undefined)
  await entered.promise
  try { await assert.rejects(launching, { code: "STARTUP_TIMEOUT" }); assert.ok(revocations > 0) }
  finally { release.resolve(); await f.context.mutations.queue.run(async () => undefined) }
  assert.ok(revocations > 1)
  assert.equal(f.spawns(), 0)
})

test("origin snapshots fence unacknowledged reports and launch records await recipient storage", async t => {
  const f = await agentServiceFixture(t), hostId = f.context.paths.hostKey, journals = createJournalPool(f.root, undefined, Date.now, "origin"), runId = randomUUID()
  const host = createOrchestrationService({ root: f.root, hostId, agents: f.service, journals, lineage: createLineageStore(f.root), tools: { definition() { return { name: "agency", command: "fixture-helper", args: [], env: [] } }, activate() {}, revoke() {} }, relay: async () => { throw new Error("offline") } })
  await host.launchRoot({ commandId: randomUUID(), runId, agent: { hostId, agentId: randomUUID() }, handlerGeneration: f.service.handlerGeneration, bindingEpoch: randomUUID(), cwd: f.workspace, backendId: "codex-acp", modelId: "model-a", overrides: {} }, { environment: f.input.environment, nativeParams: {} })
  const journal = journals.forRun(runId), events = (await journal.retainedRead(0, 256)).entries
  assert.equal(await journal.watermark("bureau"), 0)
  const event = await journal.append(randomUUID(), "report-retained", { runId, assignmentId: randomUUID(), attemptId: randomUUID(), commandId: randomUUID(), execution: { hostId, agentId: randomUUID(), handlerGeneration: f.service.handlerGeneration, providerGeneration: randomUUID() }, report: { status: "completed", summary: "result", issues: [], validation: [], git: null } })
  const snapshot = await host.snapshot()
  assert.deepEqual(snapshot.replayFences, [{ runId, streamId: runId, throughSeq: event.seq, checkpoint: 0 }])
  assert.equal(events.length, 2)
})