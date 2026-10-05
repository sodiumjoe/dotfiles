import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readdir, rename, rmdir, unlink, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { createRetentionCoordinator, authorizeRetirement, authorizedRetirementView, verifyRetirementAbsence } from "../src/retention/coordinator.js"
import { createRetentionStore, type RetentionFileSystem } from "../src/retention/store.js"
import { FAILED_START_TTL_MS } from "../src/retention/policy.js"
import { createCatalogStore } from "../src/catalog/store.js"
import { createCatalogService } from "../src/catalog/service.js"
import { CatalogError, failure, type ProviderProfile } from "../src/catalog/types.js"
import { createAgentStore } from "../src/agent/store.js"
import { createAgentService } from "../src/agent/service.js"
import { agentFailure, AgentError, type AgentCommand } from "../src/agent/types.js"
import { MutationQueue, type HandlerMutations } from "../src/handler/mutations.js"
import { readShutdownInventory, writeShutdownReceipt } from "../src/handler/receipt.js"
import { writeLaunchRecord } from "../src/platform/private-state.js"
import type { ManagedLaunchRecord, PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"
import { launch, privateRoot, until } from "./control-support.js"
import type { HandlerStatus } from "../src/control/protocol.js"
import { sampleAgent, sampleCommand, sampleSession } from "./agent-support.js"

async function fixture(t: Parameters<typeof privateRoot>[0], filesystem?: RetentionFileSystem) {
  const root = await privateRoot(t), hostId = "a".repeat(64), generation = randomUUID(), queue = new MutationQueue()
  await mkdir(join(root, "launches"), { mode: 0o700 })
  let now = 1000000, tick: (() => void) | undefined, fail = false, invocations = 0
  const adapter: PlatformAdapter = { platform: "linux", bootId: async () => "boot", readProcess: async () => null, readGroup: async () => [], signalGroup: async () => { throw new Error("retention must not signal") } }
  const retention = createRetentionStore(root, hostId, generation, filesystem), catalogStore = createCatalogStore(root, undefined, retention.view), agentStore = createAgentStore(root, undefined, retention.view)
  const mutations: HandlerMutations = { queue, accepted: [], root, retirement: retention.view }
  const paths = { persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "handler.sock"), hostKey: hostId }
  const profile: ProviderProfile = { id: "codex-acp", enabled: true, executable: "/fixture/native", adapterPackageJson: "/fixture/adapter.json", sdkPackageJson: null, configurationFiles: [] }
  let coordinator: ReturnType<typeof createRetentionCoordinator>
  const catalog = createCatalogService({ paths, generation, queue, store: catalogStore, retirement: retention.view, isReady: () => true, shutdownPending: () => false, readProfiles: async () => [profile], observeConfig: async () => ({ providerId: "codex-acp", scope: "declared-config-v1", fingerprint: "b".repeat(64), adapterVersion: "1", sdkVersion: null }), clock: { now: () => now, every: (_ms, callback) => { tick = callback; return () => { tick = undefined } } }, onTerminal: () => coordinator?.request(), probes: {
    retentionPins: () => ({ paths: [] }), forgetRemoved() {}, recover: async () => undefined, verifyDischarged: async () => undefined,
    async run(request) {
      invocations++
      await queue.run(async () => {
        await catalogStore.writeProbeMeta(request.meta)
        await mkdir(join(root, "catalog/probe-launches"), { recursive: true, mode: 0o700 })
        await mkdir(request.meta.workPath, { recursive: true, mode: 0o700 })
        await writeFile(join(request.meta.workPath, "result.json"), "{}", { mode: 0o600 })
        await writeLaunchRecord(join(root, "catalog/probe-launches", request.meta.attemptId + ".json"), record(request.meta.attemptId, request.meta.handlerGeneration, request.meta.commandId))
      })
      return { request, record: record(request.meta.attemptId, request.meta.handlerGeneration, request.meta.commandId), result: fail ? null : { models: [], providerVersion: null, providerVersionSource: "unknown" }, error: fail ? failure(new CatalogError("PROBE_FAILED")) : null }
    },
  } })
  const state: HandlerStatus = { hostId, handlerGeneration: generation, phase: "ready", reconciliation: { classified: 0, total: 0, uncertain: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] }
  const agents = createAgentService({ context: { paths, adapter, mutations, state, shutdownPending: () => false }, catalog, contracts: [], store: agentStore, retirement: retention.view })
  coordinator = createRetentionCoordinator({ root, hostId, generation, queue, adapter, store: retention, catalogStore, agentStore, mutations, catalog, agents, now: () => now })
  await catalog.initialize()
  t.after(() => { agents.close(); catalog.close() })
  const record = (attempt: string, handler: string, owner: string): ManagedLaunchRecord => ({ version: 2, owner: { kind: "catalog-probe", providerId: "codex-acp", commandId: owner }, handlerGeneration: handler, launchAttemptId: attempt, launchBootId: "boot", launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null })
  return { root, hostId, generation, queue, adapter, retention, catalogStore, agentStore, catalog, agents, mutations, coordinator, setTime(value: number) { now = value }, setFailure(value: boolean) { fail = value }, advance() { now += 600001; tick?.() }, invocations: () => invocations }
}

test("twenty successful and twenty failed automatic batches leave only the current cache", async t => {
  const f = await fixture(t)
  const sentinels = ["agents/provider-state", "qualification", "provider-home"]
  for (const name of sentinels) { await mkdir(join(f.root, name), { recursive: true, mode: 0o700 }); await writeFile(join(f.root, name, "keep"), "retained", { mode: 0o600 }) }
  await f.catalogStore.inventory()
  f.catalog.startScheduling()
  for (let index = 0; index < 40; index++) {
    f.setFailure(index >= 20)
    if (index) f.advance()
    await until(async () => f.invocations() === index + 1 && (await f.catalog.list()).discovery.state === "idle" ? true : undefined)
    await f.queue.run(() => f.coordinator.sweepLocked())
    assert.deepEqual(f.coordinator.diagnostics(), [])
    const inventory = await f.catalogStore.inventory()
    assert.deepEqual(inventory.issues, [])
    assert.equal(inventory.commands.length, 0); assert.equal(inventory.automatic.length, 0); assert.equal(inventory.snapshots.length, 1)
    assert.equal(inventory.metadata.length, 0); assert.equal(inventory.launches.length, 0)
    assert.deepEqual(await readdir(join(f.root, "catalog/work")), [])
    if (index >= 20) assert.equal((await f.catalog.list()).providers[1]!.error!.code, "PROBE_FAILED")
  }
  for (const name of sentinels) assert.deepEqual(await readdir(join(f.root, name)), ["keep"])
})

test("manual results survive automatic sweeps and lost replies do not redispatch", async t => {
  const f = await fixture(t), commandId = randomUUID()
  await f.catalog.refresh(commandId, f.generation)
  const first = await until(async () => { const reply = await f.catalog.refresh(commandId, f.generation); return reply.command.state !== "pending" ? reply : undefined })
  const count = f.invocations()
  assert.deepEqual(await f.catalog.refresh(commandId, f.generation), first); assert.equal(f.invocations(), count)
  f.catalog.startScheduling(); f.advance()
  await until(async () => f.invocations() > count && (await f.catalog.list()).discovery.state === "idle" ? true : undefined)
  await f.queue.run(() => f.coordinator.sweepLocked())
  assert.deepEqual(f.coordinator.diagnostics(), [])
  assert.deepEqual(await f.catalog.refresh(commandId, f.generation), first)
  const inventory = await f.catalogStore.inventory()
  assert.equal(inventory.commands.length, 1); assert.equal(inventory.snapshots.length, 2); assert.equal(inventory.launches.length, 0)
})

async function failedAgent(f: Awaited<ReturnType<typeof fixture>>, session = false, current = false) {
  const initial = sampleAgent(), command = sampleCommand()
  if (current) { initial.launch.handlerGeneration = f.generation; initial.launch.catalogEvidence.verifiedHandlerGeneration = f.generation; command.handlerGeneration = f.generation; command.input.handlerGeneration = f.generation; command.target!.handlerGeneration = f.generation }
  await f.agentStore.writeAgent(initial, null); await f.agentStore.writeCommand(command, null)
  const next = session ? { ...initial, phase: "ready" as const, session: sampleSession() } : initial
  if (session) await f.agentStore.writeAgent(next, initial)
  const terminal = { ...next, phase: "failed" as const, failure: agentFailure(new AgentError("STARTUP_FAILED")) }
  await f.agentStore.writeAgent(terminal, next)
  const completed: AgentCommand = { ...command, state: "completed", result: { outcome: "failed", target: command.target, session: terminal.session, failure: terminal.failure } }
  await f.agentStore.writeCommand(completed, command)
  const launch: ManagedLaunchRecord = { version: 2, owner: { kind: "agent", agentId: initial.definition.agentId, providerGeneration: initial.launch.providerGeneration }, handlerGeneration: initial.launch.handlerGeneration, launchAttemptId: initial.launch.launchAttemptId, launchBootId: "boot", launchAttempted: false, phase: "cleanup_verified", provider: null, reason: null }
  await writeLaunchRecord(join(f.root, "launches", launch.launchAttemptId + ".json"), launch); f.mutations.accepted.push({ path: join(f.root, "launches", launch.launchAttemptId + ".json"), record: launch })
  for (const path of ["agents/records/" + initial.definition.agentId, "agents/commands/" + command.commandId]) await utimes(join(f.root, path + ".json"), 1000, 1000)
  return { initial, command, launch }
}

for (const [name, offset, session, current, removed] of [
  ["one millisecond before", -1, false, false, false], ["exact seven days", 0, false, false, true], ["future time", -FAILED_START_TTL_MS - 1, false, false, false], ["current receipt", 1, false, true, false], ["session-bearing failure", 1, true, false, false],
] as const) test("sessionless age policy: " + name, async t => {
  const f = await fixture(t); await failedAgent(f, session, current); f.setTime(1000000 + FAILED_START_TTL_MS + offset)
  await f.coordinator.initialize()
  assert.deepEqual(f.coordinator.diagnostics(), [])
  const inventory = await f.agentStore.inventory()
  assert.deepEqual(inventory.issues, []); assert.equal(inventory.agents.length, removed ? 0 : 1); assert.equal(inventory.commands.length, removed ? 0 : 1)
})

test("unreadable ages and runtime publication pins retain expired failures", async t => {
  const f = await fixture(t), { initial, command } = await failedAgent(f)
  f.setTime(1000000 + FAILED_START_TTL_MS)
  const terminalTimes = f.agentStore.terminalTimes
  f.agentStore.terminalTimes = async () => null
  await f.coordinator.initialize(); assert.ok(await f.agentStore.readAgent(initial.definition.agentId))
  f.agentStore.terminalTimes = terminalTimes
  f.agents.retentionPins = () => ({ paths: ["agents/commands/" + command.commandId + ".json"] })
  await f.coordinator.initialize(); assert.ok(await f.agentStore.readAgent(initial.definition.agentId))
})

for (const op of ["stop", "restore"] as const) test("global missing-target assessment retains interrupted " + op + " evidence", async t => {
  const f = await fixture(t), sample = sampleCommand(), target = sample.target!
  const pending: AgentCommand = { ...sample, op, input: op === "stop" ? { ...target, commandId: sample.commandId } : { agentId: target.agentId, handlerGeneration: sample.handlerGeneration, commandId: sample.commandId, environmentDigest: "c".repeat(64) } }
  await f.agentStore.writeCommand(pending, null)
  const interrupted: AgentCommand = { ...pending, state: "interrupted", result: { outcome: "interrupted", target, session: null, failure: agentFailure(new AgentError("INCOMPLETE")) } }
  await f.agentStore.writeCommand(interrupted, pending)
  await f.agents.initialize()
  assert.ok((await f.agents.list()).issues.some(issue => issue.id === sample.commandId && issue.message === "command target missing"))
  await f.coordinator.initialize()
  assert.deepEqual(await f.agentStore.readCommand(sample.commandId), interrupted)
  assert.ok((await f.agents.list()).issues.some(issue => issue.id === sample.commandId && issue.message === "command target missing"))
})

test("unknown same-boot process evidence is retained without signaling", async t => {
  const f = await fixture(t), { launch } = await failedAgent(f)
  f.setTime(1000000 + FAILED_START_TTL_MS)
  const identity: ProcessIdentity = { bootId: "boot", birth: `100:agy-provider:${launch.launchAttemptId}`, pid: 12345, parentPid: 10, processGroupId: 12345, sessionId: 12345, uid: process.getuid!(), gid: process.getgid!() }
  const witnessed = { ...launch, launchAttempted: true, provider: { kind: "process-group" as const, group: { leader: identity, observed: [identity] } } }
  await writeLaunchRecord(join(f.root, "launches", launch.launchAttemptId + ".json"), witnessed)
  f.adapter.readProcess = async () => { throw new Error("unknown observation") }
  await f.coordinator.initialize()
  assert.equal((await f.agentStore.inventory()).agents.length, 1)
  f.adapter.readProcess = async () => null
  f.adapter.readGroup = async () => [identity]
  await assert.rejects(verifyRetirementAbsence(f.adapter, [{ path: "launches/" + launch.launchAttemptId + ".json", record: witnessed }], []))
  f.adapter.bootId = async () => "replacement-boot"
  await verifyRetirementAbsence(f.adapter, [{ path: "launches/" + launch.launchAttemptId + ".json", record: witnessed }], [])
})

test("partial work unlink stays diagnostic, retries, and does not corrupt unrelated inventories", async t => {
  let fail = true
  const f = await fixture(t, { open, rename, rmdir, async unlink(path) { if (fail && String(path).endsWith("result.json")) throw new Error("injected unlink failure"); await unlink(path) } })
  f.catalog.startScheduling()
  await until(async () => (await f.catalog.list()).discovery.state === "idle" ? true : undefined)
  await f.coordinator.initialize()
  assert.ok(await f.retention.pending()); assert.ok(f.coordinator.diagnostics().length)
  assert.deepEqual((await f.catalogStore.inventory()).issues, []); assert.deepEqual((await f.agentStore.inventory()).issues, [])
  assert.equal((await f.catalog.list()).discovery.state, "idle")
  fail = false; await f.coordinator.initialize()
  assert.equal(await f.retention.pending(), null); assert.deepEqual(f.coordinator.diagnostics(), [])
})

test("surviving references cancel intent deletion and shutdown requires exact absence", async t => {
  const f = await fixture(t), snapshot = { version: 1 as const, hostId: f.hostId, handlerGeneration: f.generation, snapshotId: randomUUID(), createdAt: 100, providers: [] }
  await f.catalogStore.writeSnapshot(snapshot)
  const intent = await f.retention.prepare({ paths: ["catalog/snapshots/" + snapshot.snapshotId + ".json"], launches: [], handlers: [] })
  await f.catalogStore.publishCurrent(snapshot)
  await assert.rejects(authorizeRetirement({ ...f, adapter: f.adapter }, intent))
  const guarded = authorizedRetirementView(f.retention, value => authorizeRetirement(f, value))
  await assert.rejects(guarded.validate())
  assert.equal(guarded.hides("catalog/snapshots/" + snapshot.snapshotId + ".json"), false)
  assert.ok(await f.retention.pending())
  const identity: ProcessIdentity = { bootId: "boot", birth: `100:agy-handler:${randomUUID()}`, pid: 12345, parentPid: 10, processGroupId: 12345, sessionId: 12345, uid: process.getuid!(), gid: process.getgid!() }
  await writeShutdownReceipt(f.root, { version: 1, commandId: randomUUID(), hostId: f.hostId, handlerGeneration: randomUUID(), handlerIdentity: identity, stopAgents: true, state: "accepted" })
  assert.equal((await readShutdownInventory(f.root)).receipts.length, 1)
  await chmod(join(f.root, "shutdown"), 0o755)
  assert.ok((await readShutdownInventory(f.root)).issues.length)
})

test("unrelated legacy launches do not invalidate catalog retirement authorization", async t => {
  const f = await fixture(t), snapshotId = randomUUID(), old = launch({ phase: "quarantined", reason: "legacy ownership unresolved" })
  await f.catalogStore.writeSnapshot({ version: 1, hostId: f.hostId, handlerGeneration: f.generation, snapshotId, createdAt: 100, providers: [] })
  await writeLaunchRecord(join(f.root, "launches", old.launchAttemptId + ".json"), old)
  const intent = await f.retention.prepare({ paths: ["catalog/snapshots/" + snapshotId + ".json"], launches: [], handlers: [] })
  await authorizeRetirement(f, intent)
  await f.retention.resume({ authorize: value => authorizeRetirement(f, value), removed: () => undefined })
  assert.ok(await f.agentStore.inventory())
  assert.equal(await f.retention.pending(), null)
})

test("retired shutdown receipts require absence of the exact Handler and its group", async t => {
  const f = await fixture(t), commandId = randomUUID()
  const identity: ProcessIdentity = { bootId: "boot", birth: `100:agy-handler:${randomUUID()}`, pid: 12345, parentPid: 10, processGroupId: 12345, sessionId: 12345, uid: process.getuid!(), gid: process.getgid!() }
  await writeShutdownReceipt(f.root, { version: 1, commandId, hostId: f.hostId, handlerGeneration: randomUUID(), handlerIdentity: identity, stopAgents: true, state: "accepted" })
  f.adapter.readProcess = async () => identity
  await f.coordinator.initialize(); assert.equal((await readShutdownInventory(f.root)).receipts.length, 1)
  f.adapter.readProcess = async () => null; f.adapter.readGroup = async () => [{ ...identity, birth: `101:agy-handler:${randomUUID()}` }]
  await f.coordinator.initialize(); assert.equal((await readShutdownInventory(f.root)).receipts.length, 1)
  f.adapter.readGroup = async () => []
  await f.coordinator.initialize(); assert.equal((await readShutdownInventory(f.root)).receipts.length, 0)
  assert.deepEqual(f.coordinator.diagnostics(), [])
})

test("malformed catalog evidence cannot strand unrelated lifecycle retirement", async t => {
  const f = await fixture(t), { initial } = await failedAgent(f)
  f.setTime(1000000 + FAILED_START_TTL_MS)
  const directory = join(f.root, "catalog/commands")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, randomUUID() + ".json"), "{}", { mode: 0o600 })
  await f.coordinator.initialize()
  assert.equal(await f.retention.pending(), null)
  assert.equal(await f.agentStore.readAgent(initial.definition.agentId), null)
})