import assert from "node:assert/strict"
import test from "node:test"
import { constants } from "node:fs"
import { chmod, link, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createAgentStore } from "../src/agent/store.js"
import { commitLaunchTransition, restoreUninvokedLaunch, type LaunchContext } from "../src/handler/launch-transitions.js"
import { MutationQueue } from "../src/handler/mutations.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import type { LaunchRecord } from "../src/platform/types.js"
import type { CatalogFileSystem } from "../src/catalog/store.js"
import { agentFailure, AgentError, type AgentCommand } from "../src/agent/types.js"
import { agentId, sampleAgent, sampleCommand, sampleSession } from "./agent-support.js"
import { privateRoot } from "./control-support.js"

const filesystem = { open, rename, rm, mkdir }

test("missing agent storage is read-only and valid updates cannot mutate specification or session", async t => {
  const root = await privateRoot(t), store = createAgentStore(root), initial = sampleAgent()
  assert.deepEqual(await store.inventory(), { agents: [], legacyAgents: [], commands: [], issues: [] })
  assert.equal(await store.readAgent(initial.definition.agentId), null)
  assert.deepEqual(await readdir(root), [])
  await store.writeAgent(initial, null)
  await store.writeAgent(initial, null)
  await assert.rejects(store.writeAgent({ ...initial, launch: { ...initial.launch, contractId: "different" } }, initial))
  const ready = { ...initial, phase: "ready" as const, session: sampleSession() }
  await store.writeAgent(ready, initial)
  await assert.rejects(store.writeAgent(initial, ready))
  await assert.rejects(store.writeAgent({ ...ready, session: { ...ready.session, sessionId: "different" } }, ready))
  const stopping = { ...ready, phase: "stopping" as const }, stopped = { ...stopping, phase: "stopped" as const }
  await store.writeAgent(stopping, ready); await store.writeAgent(stopped, stopping)
  await assert.rejects(store.writeAgent(ready, stopped))
  assert.deepEqual(await store.readAgent(initial.definition.agentId), stopped)
})

test("stopped restore requires verified cleanup and preserves the stable session while rotating generations", async t => {
  const root = await privateRoot(t), store = createAgentStore(root), initial = sampleAgent()
  await store.writeAgent(initial, null)
  const ready = { ...initial, phase: "ready" as const, session: sampleSession() }
  const stopping = { ...ready, phase: "stopping" as const }, stopped = { ...ready, phase: "stopped" as const }
  await store.writeAgent(ready, initial); await store.writeAgent(stopping, ready); await store.writeAgent(stopped, stopping)
  const restoring = { ...stopped, phase: "restoring" as const, launch: { ...stopped.launch, commandId: agentId(40), launchAttemptId: agentId(41), providerGeneration: agentId(42) } }
  await assert.rejects(store.writeAgent(restoring, stopped))
  const path = join(root, "launches", stopped.launch.launchAttemptId + ".json")
  await mkdir(join(root, "launches"), { mode: 0o700 })
  const launch = { version: 2 as const, owner: { kind: "agent" as const, agentId: stopped.definition.agentId, providerGeneration: stopped.launch.providerGeneration }, handlerGeneration: stopped.launch.handlerGeneration, launchAttemptId: stopped.launch.launchAttemptId, launchBootId: "boot-a", launchAttempted: false, phase: "launch_pending" as const, provider: null, reason: null }
  await writeLaunchRecord(path, launch)
  await assert.rejects(store.writeAgent(restoring, stopped), { code: "COMMAND_CONFLICT" })
  await writeLaunchRecord(path, { ...launch, phase: "cleanup_verified" })
  await assert.rejects(store.writeAgent({ ...restoring, session: { ...restoring.session, sessionId: "another" } }, stopped), { code: "COMMAND_CONFLICT" })
  await store.writeAgent(restoring, stopped)
  const restored = { ...restoring, phase: "ready" as const, session: { ...restoring.session, sessionGeneration: agentId(43) } }
  await store.writeAgent(restored, restoring)
  assert.deepEqual((await store.readAgent(initial.definition.agentId))!.definition, initial.definition)
  assert.equal((await store.readAgent(initial.definition.agentId))!.session!.sessionId, "fixture-session")
})

test("legacy agent evidence is listed without rewriting its version-one bytes", async t => {
  const root = await privateRoot(t), directory = join(root, "agents/records"), agentIdValue = agentId(91)
  await mkdir(join(root, "agents"), { mode: 0o700 })
  await mkdir(directory, { mode: 0o700 })
  const legacy = { version: 1, spec: { agentId: agentIdValue, handlerGeneration: agentId(92), providerGeneration: agentId(93), launchAttemptId: agentId(94), checkout: { root: { path: "/legacy/checkout" } } }, phase: "stopped", session: null, failure: null }
  const path = join(directory, agentIdValue + ".json"), bytes = JSON.stringify(legacy)
  await writeFile(path, bytes, { mode: 0o600 })
  const store = createAgentStore(root), inventory = await store.inventory()
  assert.equal(inventory.issues.length, 0)
  assert.deepEqual(inventory.agents, [])
  assert.equal(inventory.legacyAgents[0]?.spec.agentId, agentIdValue)
  assert.equal(await store.readAgent(agentIdValue), null)
  assert.equal(await readFile(path, "utf8"), bytes)
})

test("command intent and completed result are immutable across exact retries", async t => {
  const store = createAgentStore(await privateRoot(t)), initial = sampleCommand()
  await store.writeCommand(initial, null)
  await assert.rejects(store.writeCommand({ ...initial, input: { ...initial.input, commandId: agentId(55) } }, initial))
  const completed: AgentCommand = { ...initial, state: "completed", result: { outcome: "started", target: initial.target, session: sampleSession(), failure: null } }
  await store.writeCommand(completed, initial); await store.writeCommand(completed, initial)
  await assert.rejects(store.writeCommand(initial, completed))
  await assert.rejects(store.writeCommand({ ...completed, result: { ...completed.result!, outcome: "failed", failure: agentFailure(new AgentError("STARTUP_FAILED")) } }, completed))
  assert.deepEqual(await store.readCommand(initial.commandId), completed)
})

test("agent inventory retains healthy records beside malformed entries and clears repaired issues", async t => {
  const root = await privateRoot(t), store = createAgentStore(root), healthy = sampleAgent()
  const damaged = { ...sampleAgent(), definition: { ...sampleAgent().definition, agentId: agentId(61) }, launch: { ...sampleAgent().launch, providerGeneration: agentId(62), launchAttemptId: agentId(63), commandId: agentId(64) } }
  await store.writeAgent(healthy, null); await store.writeAgent(damaged, null)
  const damagedPath = join(root, "agents/records", damaged.definition.agentId + ".json"), unknownPath = join(root, "agents/records/unknown.json")
  const bytes = await readFile(damagedPath)
  await writeFile(damagedPath, "{}", { mode: 0o600 }); await writeFile(unknownPath, "{}", { mode: 0o600 })
  const inventory = await store.inventory()
  assert.deepEqual(inventory.agents, [healthy])
  assert.deepEqual(inventory.issues.map(issue => issue.path), [damagedPath, unknownPath])
  assert.deepEqual(inventory.issues.map(issue => issue.kind), ["agent", "unknown"])
  await store.writeCommand(sampleCommand(), null)
  await writeFile(damagedPath, bytes)
  await rm(unknownPath)
  assert.deepEqual((await store.inventory()).issues, [])
  assert.deepEqual((await store.inventory()).agents, [healthy, damaged])
})

for (const kind of ["mode", "hardlink", "symlink", "utf8", "oversized", "wrong-name", "unknown", "deleted", "replaced"] as const) {
  test(`unsafe or changed agent evidence is local to its path: ${kind}`, async t => {
    const root = await privateRoot(t), store = createAgentStore(root), value = sampleAgent(), directory = join(root, "agents/records"), path = join(directory, value.definition.agentId + ".json")
    await store.writeAgent(value, null)
    const bytes = await readFile(path)
    if (kind === "mode") await chmod(path, 0o644)
    if (kind === "hardlink") await link(path, join(root, "link"))
    if (kind === "symlink") { await rename(path, join(root, "original")); await symlink(join(root, "original"), path) }
    if (kind === "utf8") await writeFile(path, Buffer.from([255]))
    if (kind === "oversized") await writeFile(path, Buffer.alloc(1048577))
    if (kind === "wrong-name") await rename(path, join(directory, agentId(90) + ".json"))
    if (kind === "unknown") await writeFile(join(directory, "unknown"), "retained", { mode: 0o600 })
    if (kind === "deleted") await rm(path)
    if (kind === "replaced") { await rename(path, join(root, "original")); await writeFile(path, bytes, { mode: 0o600 }) }
    assert.equal((await store.inventory()).issues.length > 0, kind !== "replaced")
    await store.writeCommand(sampleCommand(), null)
    if (kind === "unknown") assert.equal(await readFile(join(directory, "unknown"), "utf8"), "retained")
  })
}

test("private atomic remnants are ignored but unsafe directories are not empty inventories", async t => {
  const root = await privateRoot(t), store = createAgentStore(root), value = sampleAgent()
  await store.writeAgent(value, null)
  const remnant = join(root, "agents/records", `.${agentId(77)}.json.${agentId(78)}.tmp`)
  await writeFile(remnant, "partial", { mode: 0o600 })
  assert.deepEqual((await store.inventory()).issues, [])
  assert.equal(await readFile(remnant, "utf8"), "partial")
  await assert.rejects(store.readAgent("../outside"))
  const other = await privateRoot(t), outside = join(other, "outside")
  await mkdir(outside, { mode: 0o700 }); await symlink(outside, join(other, "agents"))
  assert.ok((await createAgentStore(other).inventory()).issues.length)
})

test("private provider-state coexists with record and command evidence without entering inventory", async t => {
  const root = await privateRoot(t), store = createAgentStore(root), agent = sampleAgent(), command = sampleCommand()
  await store.writeAgent(agent, null); await store.writeCommand(command, null)
  const state = join(root, "agents/provider-state")
  await mkdir(state, { mode: 0o700 })
  assert.deepEqual(await store.inventory(), { agents: [agent], legacyAgents: [], commands: [command], issues: [] })
  await mkdir(join(state, agent.launch.launchAttemptId), { mode: 0o700 })
  await writeFile(join(state, agent.launch.launchAttemptId, "provider-data"), "live", { mode: 0o600 })
  assert.deepEqual(await store.inventory(), { agents: [agent], legacyAgents: [], commands: [command], issues: [] })
  assert.deepEqual(await store.readAgent(agent.definition.agentId), agent)
  assert.deepEqual(await store.readCommand(command.commandId), command)
})

test("historical provider-state entries are ignored regardless of shape", async t => {
  for (const kind of ["symlink", "wrong-mode", "non-directory"] as const) {
    const root = await privateRoot(t), store = createAgentStore(root), agent = sampleAgent()
    await store.writeAgent(agent, null)
    const state = join(root, "agents/provider-state")
    if (kind === "symlink") await symlink(root, state)
    if (kind === "wrong-mode") { await mkdir(state, { mode: 0o700 }); await chmod(state, 0o750) }
    if (kind === "non-directory") await writeFile(state, "historical", { mode: 0o600 })
    assert.deepEqual((await store.inventory()).issues, [])
    await store.writeCommand(sampleCommand(), null)
    assert.deepEqual((await store.inventory()).issues, [])
  }
})

test("unknown agent storage entry reports an issue without blocking an independent command", async t => {
  const root = await privateRoot(t), store = createAgentStore(root), agent = sampleAgent()
  await store.writeAgent(agent, null)
  await mkdir(join(root, "agents/other"), { mode: 0o700 })
  assert.ok((await store.inventory()).issues.length)
  await store.writeCommand(sampleCommand(), null)
  await rm(join(root, "agents/other"), { recursive: true })
  assert.deepEqual((await store.inventory()).issues, [])
})

for (const failure of ["file-sync", "rename", "directory-sync", "readback"] as const) {
  test(`publication ${failure} failure retains evidence and exact retry repeats durability`, async t => {
    const root = await privateRoot(t), value = sampleCommand(), path = join(root, "agents/commands", value.commandId + ".json")
    let enabled = true, renamed = false
    const syncs: string[] = []
    const io: CatalogFileSystem = { ...filesystem,
      async open(path, flags, mode) {
        const handle = await open(path, flags, mode), original = handle.sync.bind(handle)
        handle.sync = async () => {
          syncs.push(path)
          if (enabled && (failure === "file-sync" && (flags & constants.O_WRONLY) !== 0 || failure === "directory-sync" && renamed && path === join(root, "agents/commands"))) throw new Error("injected sync")
          await original()
        }
        return handle
      },
      async rename(from, to) {
        if (enabled && failure === "rename") throw new Error("injected rename")
        await rename(from, to); renamed = true
        if (enabled && failure === "readback") await writeFile(to, "{}", { mode: 0o600 })
      },
    }
    const store = createAgentStore(root, io)
    await assert.rejects(store.writeCommand(value, null))
    if (failure === "readback") { assert.equal(await readFile(path, "utf8"), "{}"); assert.ok((await store.inventory()).issues.length); return }
    if (failure === "directory-sync") assert.deepEqual(await store.readCommand(value.commandId), value)
    enabled = false; syncs.length = 0
    await store.writeCommand(value, null)
    assert.deepEqual(await store.readCommand(value.commandId), value)
    assert.ok(syncs.includes(root)); assert.ok(syncs.includes(join(root, "agents"))); assert.ok(syncs.includes(join(root, "agents/commands")))
    assert.ok(syncs.some(path => path.endsWith(".tmp")))
  })
}

test("completed receipt visibility is not proof that its directory fsync succeeded", async t => {
  const root = await privateRoot(t)
  let fail = false
  const store = createAgentStore(root, { ...filesystem, async open(path: string, flags: number, mode?: number) {
    const handle = await open(path, flags, mode)
    if (fail && path === join(root, "agents/commands")) handle.sync = async () => { throw new Error("receipt directory sync") }
    return handle
  } })
  const pending = sampleCommand()
  await store.writeCommand(pending, null)
  const completed: AgentCommand = { ...pending, state: "completed", result: { outcome: "started", target: pending.target, session: sampleSession(), failure: null } }
  fail = true
  await assert.rejects(store.writeCommand(completed, pending), /receipt directory sync/)
  assert.deepEqual(await store.readCommand(pending.commandId), completed)
  fail = false
  await store.writeCommand(completed, pending)
  assert.deepEqual(await store.readCommand(pending.commandId), completed)
})

async function transitionContext(t: test.TestContext) {
  const root = await privateRoot(t), agent = sampleAgent(), path = join(root, "launches", `${agent.launch.launchAttemptId}.json`)
  await mkdir(join(root, "launches"), { mode: 0o700 })
  const record: LaunchRecord = { version: 2, owner: { kind: "agent", agentId: agent.definition.agentId, providerGeneration: agent.launch.providerGeneration }, handlerGeneration: agent.launch.handlerGeneration, launchAttemptId: agent.launch.launchAttemptId, launchBootId: "boot-a", launchAttempted: false, phase: "launch_pending", provider: null, reason: null }
  await writeLaunchRecord(path, record)
  const context: LaunchContext = { paths: { hostKey: agent.definition.hostId, persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "handler.sock") }, adapter: { platform: "linux", bootId: async () => "boot-a", readProcess: async () => null, readGroup: async () => [], signalGroup: async () => undefined }, state: { hostId: agent.definition.hostId, handlerGeneration: agent.launch.handlerGeneration, phase: "ready", reconciliation: { classified: 1, total: 1, uncertain: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] }, mutations: { queue: new MutationQueue(), accepted: [{ path, record }] }, shutdownPending: () => false }
  return { context, record, path }
}

test("launch publication is inventory-bound and uninvoked restoration uses separate authority", async t => {
  const f = await transitionContext(t), attempted: LaunchRecord = { ...f.record, launchAttempted: true }
  await f.context.mutations.queue.run(() => commitLaunchTransition(f.context, f.record, attempted))
  await assert.rejects(commitLaunchTransition(f.context, attempted, f.record))
  const restored = await f.context.mutations.queue.run(() => restoreUninvokedLaunch(f.context, attempted, { spawnInvoked: false }))
  assert.deepEqual(restored, f.record)
  const foreign: LaunchRecord = { ...restored, owner: { kind: "agent", agentId: agentId(55), providerGeneration: agentId(56) } }, path = f.path
  await writeLaunchRecord(path, foreign)
  await assert.rejects(commitLaunchTransition(f.context, restored, attempted), { code: "UNAVAILABLE" })
  assert.deepEqual(await readLaunchRecordForReconciliation(path), foreign)
})

test("visible launch publication failure updates attribution without authorizing the next stage", async t => {
  const f = await transitionContext(t), attempted: LaunchRecord = { ...f.record, launchAttempted: true }
  const io = { read: readLaunchRecordForReconciliation, async publish(path: string, record: LaunchRecord) { await writeLaunchRecord(path, record); throw new Error("after publication") } }
  await assert.rejects(f.context.mutations.queue.run(() => commitLaunchTransition(f.context, f.record, attempted, io)), /after publication/)
  assert.deepEqual(f.context.mutations.accepted[0]!.record, attempted)
  await assert.rejects(restoreUninvokedLaunch(f.context, attempted, { spawnInvoked: false }, io))
  assert.equal(f.context.mutations.accepted[0]!.record.launchAttempted, false)
})