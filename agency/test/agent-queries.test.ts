import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { agentServiceFixture, sampleAgent, sampleProductionContract, sampleProductionSpec, agentId } from "./agent-support.js"
import { normalizeAgentRecord } from "../src/agent/types.js"
import { inventoryPage, launchChoices, parsePageInput } from "../src/agent/queries.js"
import { until } from "./control-support.js"

test("editor queries do not advertise discovery-only providers", async t => {
  const f = await agentServiceFixture(t, { launchContracts: [sampleProductionContract()], productionCatalog: true, advertiseUnsupportedClaude: true })
  const result = await f.service.choices()
  assert.ok(result.choices.length > 0)
  assert.ok(result.unavailable.some(item => item.providerId === "claude-agent-acp"))
  for (const choice of result.choices) {
    assert.equal(choice.selection.providerId, "codex-acp")
    assert.equal(choice.selection.permissionProfile, "deny-all")
    assert.equal(choice.selection.mode, "read-only")
    assert.deepEqual(choice.selection.reasoning, { kind: "value", value: "high" })
    assert.match(choice.contractFingerprint, /^[a-f0-9]{64}$/)
  }
  result.choices[0]!.selection.permissionProfile = "unsafe"
  assert.equal((await f.service.choices()).choices[0]!.selection.permissionProfile, "deny-all")
  assert.equal(f.refreshes(), 0)
  assert.equal(f.spawns(), 0)
})

for (const kind of ["stale", "rollback", "missing"] as const) test(`editor choices reject ${kind} catalog evidence`, async t => {
  const f = await agentServiceFixture(t, { productionCatalog: true })
  await f.changeCatalog(kind)
  const result = await f.service.choices()
  assert.deepEqual(result.choices, [])
  assert.equal(f.refreshes(), 0)
})

test("stale discovery does not gate native session admission", async t => {
  const f = await agentServiceFixture(t, { productionCatalog: true })
  const choice = (await f.service.choices()).choices[0]!
  await f.changeCatalog("stale")
  const started = await f.service.start({ ...f.input, selection: choice.selection })
  await until(async () => (await f.service.command(started.command.commandId, started.command.handlerGeneration)).command.result?.outcome === "started" ? true : undefined)
  assert.equal(f.spawns(), 1)
})

test("unavailable reasoning and mode never become a different advertised selection", async t => {
  const f = await agentServiceFixture(t, { productionCatalog: true }), spec = sampleProductionSpec(), contract = sampleProductionContract()
  const base = { snapshotId: spec.catalogSnapshotId, provider: spec.catalogEvidence, configuration: spec.configuration, profile: f.profile }
  for (const capabilities of [{ reasoning: { state: "unknown" } }, { reasoning: { state: "values", values: ["low"] } }, { modes: { state: "values", values: ["write"] } }]) {
    const evidence = { ...base, provider: { ...base.provider, models: base.provider.models.map(model => ({ ...model, ...capabilities })) } } as typeof base
    assert.deepEqual(launchChoices(evidence, contract, spec.hostId, spec.handlerGeneration), [])
  }
})

test("service page revision is stable during unchanged traversal", async t => {
  const f = await agentServiceFixture(t)
  await f.service.start(f.input)
  await until(async () => (await f.service.command(f.input.commandId, f.input.handlerGeneration)).command.state === "completed" ? true : undefined)
  const page = await f.service.page({ limit: 1 })
  assert.equal((await f.service.page({ limit: 1 })).revision, page.revision)
})

const views = (count: number) => Array.from({ length: count }, (_, i) => ({ record: normalizeAgentRecord({ ...sampleAgent(), phase: "stopped" as const, definition: { ...sampleAgent().definition, agentId: agentId(1000 + i) } }), launch: null, live: false, cleanup: "not_launched" as const, unavailable: null }))

test("paged inventory traverses 4200 stable records and all issues within bounded replies", () => {
  const agents = views(4200), revision = agentId(99), issues = Array.from({ length: 4200 }, (_, i) => ({ kind: "unknown" as const, id: null, path: `/state/${i}`, message: "invalid" }))
  let cursor: string | undefined, seen: string[] = [], issueCount = 0
  do {
    const page = inventoryPage({ revision, agents, issues }, { limit: 100, ...(cursor ? { cursor } : {}) })
    assert.ok(page.agents.length + page.issues.length <= 100)
    seen.push(...page.agents.map(a => a.record.version === 3 ? a.record.definition.agentId : a.record.spec.agentId))
    issueCount += page.issues.length
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(new Set(seen).size, 4200)
  assert.equal(issueCount, 4200)
})

test("page cursors reject mutation, filter changes, malformed and excessive input", () => {
  const state = { revision: agentId(99), agents: views(3), issues: [] }
  const cursor = inventoryPage(state, { limit: 1 }).nextCursor!
  assert.throws(() => inventoryPage({ ...state, revision: agentId(98) }, { limit: 1, cursor }), { code: "RESYNC_REQUIRED" })
  assert.throws(() => inventoryPage(state, { limit: 1, cwd: "/other", cursor }), { code: "RESYNC_REQUIRED" })
  for (const bad of ["!", "a".repeat(1025), Buffer.from("{}").toString("base64url")]) assert.throws(() => inventoryPage(state, { limit: 1, cursor: bad }), { code: "INVALID_PROTOCOL" })
  for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 1, cwd: "relative" }, { limit: 1, activeOnly: "true" }, { limit: 1, extra: true }]) assert.throws(() => parsePageInput(bad), { code: "INVALID_PROTOCOL" })
})

test("oversized records and diagnostics are explicit failures rather than empty pages", () => {
  const agents = views(1)
  agents[0]!.record.settings.configValues = { huge: "x".repeat(8 * 1024 * 1024) }
  assert.throws(() => inventoryPage({ revision: agentId(99), agents, issues: [] }, { limit: 100 }), { code: "INCOMPLETE" })
  assert.throws(() => inventoryPage({ revision: agentId(99), agents: [], issues: [{ kind: "unknown", id: null, path: "x".repeat(8 * 1024 * 1024), message: "invalid" }] }, { limit: 100 }), { code: "INCOMPLETE" })
})

test("active pages include starting before process ownership and stopping during cleanup", async t => {
  const f = await agentServiceFixture(t, { pause: "spawn", beforeOwnerPage: true, pauseCleanup: true })
  const started = await f.service.start(f.input)
  const beforeOwner = await f.beforeOwnerPage()!
  assert.equal(beforeOwner.agents.length, 1)
  assert.equal(beforeOwner.agents[0]!.live, false)
  await f.entered
  let page = await f.service.page({ limit: 100, cwd: f.workspace, activeOnly: true })
  assert.equal(page.agents.length, 1)
  assert.equal(page.agents[0]!.record.phase, "starting")
  assert.deepEqual((await f.service.page({ limit: 100, cwd: f.workspace + "/child", activeOnly: true })).agents, [])
  f.release()
  await until(async () => (await f.service.command(f.input.commandId, f.input.handlerGeneration)).command.state === "completed" ? true : undefined)
  assert.equal((await f.service.command(f.input.commandId, f.input.handlerGeneration)).command.result?.outcome, "started")
  const stopping = f.service.stop({ ...started.command.target!, commandId: randomUUID() })
  await f.cleanupEntered
  await until(async () => (await f.service.page({ limit: 100, activeOnly: true })).agents.some(a => a.record.phase === "stopping") ? true : undefined)
  page = await f.service.page({ limit: 100, activeOnly: true })
  assert.equal(page.agents[0]!.record.phase, "stopping")
  assert.equal(page.agents[0]!.live, false)
  const stopCommands = (await f.store.inventory()).commands.filter(command => command.op === "stop")
  const pins = f.service.retentionPins().paths
  assert.ok(pins.includes("agents/commands/" + stopCommands[0]!.commandId + ".json"))
  assert.ok(pins.includes("agents/records/" + started.command.target!.agentId + ".json"))
  assert.equal(pins.includes("agents/records/" + stopCommands[0]!.commandId + ".json"), false)
  f.releaseCleanup()
  await stopping
  await until(async () => (await f.service.page({ limit: 100, activeOnly: true })).agents.length === 0 ? true : undefined)
  const final = (await f.service.page({ limit: 100 })).agents[0]!
  assert.equal(final.record.phase, "stopped")
  assert.ok(final.record.session)
  f.pauseRestore("spawn")
  await f.service.restore({ commandId: randomUUID(), handlerGeneration: f.input.handlerGeneration, agentId: started.command.target!.agentId, environment: f.input.environment })
  const beforeRestoreOwner = await f.beforeOwnerPage()!
  assert.equal(beforeRestoreOwner.agents.length, 1)
  assert.equal(beforeRestoreOwner.agents[0]!.record.phase, "restoring")
  assert.equal(beforeRestoreOwner.agents[0]!.live, false)
})

test("durable mutation invalidates a service cursor without changing directory scope", async t => {
  const f = await agentServiceFixture(t)
  const first = await f.service.start(f.input), secondInput = { ...f.input, commandId: randomUUID() }
  await f.service.start(secondInput)
  await until(async () => (await f.service.command(secondInput.commandId, secondInput.handlerGeneration)).command.state === "completed" ? true : undefined)
  const page = await f.service.page({ limit: 1, cwd: f.workspace })
  assert.ok(page.nextCursor)
  await f.service.stop({ ...first.command.target!, commandId: randomUUID() })
  await assert.rejects(f.service.page({ limit: 1, cwd: f.workspace, cursor: page.nextCursor }), { code: "RESYNC_REQUIRED" })
})

test("logically retired cached agents are absent from list and page queries", async t => {
  const hidden = new Set<string>(), retirement = { validate: async () => undefined, hides: (path: string) => hidden.has(path) }
  const f = await agentServiceFixture(t, { retirement })
  const started = await f.service.start(f.input)
  await until(async () => (await f.service.command(f.input.commandId, f.input.handlerGeneration)).command.state === "completed" ? true : undefined)
  await f.service.stop({ ...started.command.target!, commandId: randomUUID() })
  await until(async () => (await f.service.list()).agents[0]?.record.phase === "stopped" ? true : undefined)
  const inventory = await f.store.inventory()
  for (const record of inventory.agents) hidden.add("agents/records/" + record.definition.agentId + ".json")
  for (const command of inventory.commands) hidden.add("agents/commands/" + command.commandId + ".json")
  try {
    assert.deepEqual((await f.service.list()).agents, [])
    assert.deepEqual((await f.service.page({ limit: 100 })).agents, [])
  } finally { hidden.clear() }
})

test("memory roster bypasses failing and queued retained verification while actions revalidate", async t => {
  const f = await agentServiceFixture(t)
  const started = await f.service.start(f.input)
  await until(async () => (await f.service.command(f.input.commandId, f.input.handlerGeneration)).command.state === "completed" ? true : undefined)
  const service = f.service as typeof f.service & { roster: typeof f.service.page }
  const original = f.store.inventory.bind(f.store)
  const failure = t.mock.method(f.store, "inventory", async () => { throw new Error("retained verification unavailable") })
  try {
    const page = await service.roster({ limit: 100 })
    assert.equal(page.agents.length, 1)
    assert.equal(page.agents[0]!.live, true)
    assert.equal((await service.roster({ limit: 100 })).revision, page.revision)
    page.agents[0]!.record.phase = "failed"
    assert.equal((await service.roster({ limit: 100 })).agents[0]!.record.phase, "ready")
    await assert.rejects(f.service.page({ limit: 100 }), /retained verification unavailable/)
    await assert.rejects(f.service.sessionSnapshot(started.command.target!), /retained verification unavailable/)
  } finally { failure.mock.restore() }
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), seen = new Promise<void>(resolve => { entered = resolve })
  const blocked = t.mock.method(f.store, "inventory", async () => { entered(); await gate; return original() })
  const verifying = f.service.page({ limit: 100 })
  await seen
  try {
    const page = await Promise.race([service.roster({ limit: 100 }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("roster waited for verification queue")), 500).unref())])
    assert.equal(page.agents.length, 1)
  } finally { release(); await verifying; blocked.mock.restore() }
  f.service.close()
  await assert.rejects(service.roster({ limit: 100 }), { code: "NOT_READY" })
})

test("memory roster tracks transitions, retirement and cursor scope", async t => {
  const hidden = new Set<string>(), retirement = { validate: async () => undefined, hides: (path: string) => hidden.has(path) }
  const f = await agentServiceFixture(t, { pause: "spawn", pauseCleanup: true, retirement })
  const service = f.service as typeof f.service & { roster: typeof f.service.page }
  const first = await f.service.start(f.input)
  await f.entered
  const starting = await service.roster({ limit: 100 })
  assert.equal(starting.agents[0]!.record.phase, "starting")
  assert.deepEqual((await service.roster({ limit: 100, cwd: f.workspace + "/other" })).agents, [])
  f.release()
  const second = { ...f.input, commandId: randomUUID() }
  await f.service.start(second)
  await until(async () => (await f.service.command(second.commandId, second.handlerGeneration)).command.state === "completed" ? true : undefined)
  const page = await service.roster({ limit: 1 })
  assert.ok(page.nextCursor)
  assert.equal((await service.roster({ limit: 1, cursor: page.nextCursor })).agents.length, 1)
  await assert.rejects(service.roster({ limit: 1, cursor: page.nextCursor, cwd: f.workspace + "/other" }), { code: "RESYNC_REQUIRED" })
  const stop = f.service.stop({ ...first.command.target!, commandId: randomUUID() })
  await f.cleanupEntered
  const stopping = await service.roster({ limit: 100 })
  assert.equal(stopping.agents.find(a => a.record.version === 3 && a.record.definition.agentId === first.command.target!.agentId)!.record.phase, "stopping")
  await assert.rejects(service.roster({ limit: 1, cursor: page.nextCursor }), { code: "RESYNC_REQUIRED" })
  f.releaseCleanup(); await stop
  await until(async () => (await service.roster({ limit: 100 })).agents.length === 1 ? true : undefined)
  const live = (await service.roster({ limit: 100 })).agents[0]!
  hidden.add("agents/records/" + (live.record.version === 3 ? live.record.definition.agentId : "" ) + ".json")
  assert.deepEqual((await service.roster({ limit: 100 })).agents, [])
  hidden.clear()
})