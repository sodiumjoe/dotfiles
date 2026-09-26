import assert from "node:assert/strict"
import test from "node:test"
import { constants } from "node:fs"
import { chmod, link, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createAgentStore } from "../src/agent/store.js"
import { commitLaunchTransition, restoreUninvokedLaunch } from "../src/handler/launch-transitions.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import type { CatalogFileSystem } from "../src/catalog/store.js"
import { agentFailure, AgentError, type AgentCommand } from "../src/agent/types.js"
import { agentId, sampleAgent, sampleCommand, sampleSession } from "./agent-support.js"
import { privateRoot } from "./control-support.js"
import { admissionFixture } from "./checkout-support.js"

const filesystem = { open, rename, rm, mkdir }

test("missing agent storage is read-only and valid updates cannot mutate specification or session", async t => {
  const root = await privateRoot(t), store = createAgentStore(root), initial = sampleAgent()
  assert.deepEqual(await store.inventory(), { agents: [], commands: [], issues: [] })
  assert.equal(await store.readAgent(initial.spec.agentId), null)
  assert.deepEqual(await readdir(root), [])
  await store.writeAgent(initial, null)
  await store.writeAgent(initial, null)
  await assert.rejects(store.writeAgent({ ...initial, spec: { ...initial.spec, contractId: "different" } }, initial))
  const ready = { ...initial, phase: "ready" as const, session: sampleSession() }
  await store.writeAgent(ready, initial)
  await assert.rejects(store.writeAgent(initial, ready))
  await assert.rejects(store.writeAgent({ ...ready, session: { ...ready.session, sessionId: "different" } }, ready))
  const stopping = { ...ready, phase: "stopping" as const }, stopped = { ...stopping, phase: "stopped" as const }
  await store.writeAgent(stopping, ready); await store.writeAgent(stopped, stopping)
  await assert.rejects(store.writeAgent(ready, stopped))
  assert.deepEqual(await store.readAgent(initial.spec.agentId), stopped)
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

for (const kind of ["mode", "hardlink", "symlink", "utf8", "oversized", "wrong-name", "unknown", "deleted", "replaced"] as const) {
  test(`unsafe or changed agent evidence is retained and blocks writes: ${kind}`, async t => {
    const root = await privateRoot(t), store = createAgentStore(root), value = sampleAgent(), directory = join(root, "agents/records"), path = join(directory, value.spec.agentId + ".json")
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
    assert.ok((await store.inventory()).issues.length > 0)
    await assert.rejects(store.writeCommand(sampleCommand(), null))
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

test("launch publication is inventory-bound and uninvoked restoration uses separate authority", async t => {
  const f = await admissionFixture(t), reserved = await f.controller.reserve(f.request()), attempted = { ...reserved.launch, launchAttempted: true }
  await f.context.mutations.queue.run(() => commitLaunchTransition(f.context, reserved.launch, attempted))
  await assert.rejects(commitLaunchTransition(f.context, attempted, reserved.launch))
  const restored = await f.context.mutations.queue.run(() => restoreUninvokedLaunch(f.context, attempted, { spawnInvoked: false }))
  assert.deepEqual(restored, reserved.launch)
  const foreign = { ...restored, leaseId: agentId(55) }, path = f.context.mutations.accepted[0]!.path
  await writeLaunchRecord(path, foreign)
  await assert.rejects(commitLaunchTransition(f.context, restored, attempted), { code: "ADMISSION_UNAVAILABLE" })
  assert.deepEqual(await readLaunchRecordForReconciliation(path), foreign)
})

test("visible launch publication failure updates attribution without authorizing the next stage", async t => {
  const f = await admissionFixture(t), reserved = await f.controller.reserve(f.request()), attempted = { ...reserved.launch, launchAttempted: true }
  const io = { read: readLaunchRecordForReconciliation, async publish(path: string, record: typeof attempted) { await writeLaunchRecord(path, record); throw new Error("after publication") } }
  await assert.rejects(f.context.mutations.queue.run(() => commitLaunchTransition(f.context, reserved.launch, attempted, io)), /after publication/)
  assert.deepEqual(f.context.mutations.accepted[0]!.record, attempted)
  await assert.rejects(restoreUninvokedLaunch(f.context, attempted, { spawnInvoked: false }, io))
  assert.equal(f.context.mutations.accepted[0]!.record.launchAttempted, false)
})