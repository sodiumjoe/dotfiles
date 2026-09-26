import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createConnection } from "node:net"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { catalogHandlerFixture } from "./catalog-support.js"
import { controlFixture, until } from "./control-support.js"
import { gitFixture } from "./checkout-support.js"
import { CATALOG_PROTOCOL } from "../src/catalog/protocol.js"
import { createCatalogStore } from "../src/catalog/store.js"
import { sameProcess } from "../src/platform/types.js"

test("empty catalog configuration starts no probes", { timeout: 60000 }, async t => {
  const f = await catalogHandlerFixture(t, { enabled: [] })
  await f.start()
  assert.deepEqual((await f.list()).providers.map(p => p.state), ["unconfigured", "unconfigured"])
  const inventory = await f.inventory()
  assert.equal(inventory.launches.length, 0)
  assert.equal(inventory.commands.length, 0)
  assert.deepEqual(inventory.issues, [])
})

test("real discovery retains provenance, stale failure history and removed models", { timeout: 60000 }, async t => {
  const f = await catalogHandlerFixture(t)
  const handler = await f.start(), first = randomUUID()
  await f.refresh(first); const initial = await f.waitCommand(first)
  assert.equal(initial.state, "completed")
  const before = await f.list()
  assert.deepEqual(before.providers.map(p => p.freshness), ["fresh", "fresh"])
  assert.deepEqual(before.providers.map(p => p.models[0]!.modes), [{ state: "unknown" }, { state: "unknown" }])
  assert.equal(before.providers[0]!.providerVersion, null)
  assert.equal(before.providers[0]!.sdkVersion, "0.3.232")
  const inventory = await f.inventory()
  assert.deepEqual(inventory.issues, [])
  assert.equal(inventory.launches.length, 2)
  for (const entry of inventory.launches) assert.equal(entry.record.phase, "cleanup_verified")
  const claude = inventory.metadata.find(m => m.providerId === "claude-agent-acp")!
  assert.deepEqual(JSON.parse(await readFile(join(claude.workPath, "sdk-observed.json"), "utf8")), { prompts: 0, cwd: claude.workPath, settingSources: [], mcpServers: {}, tools: [], persistSession: false })
  await f.scenario("claude-agent-acp", { fail: true }); await f.scenario("codex-acp", { models: ["replacement"] })
  const second = randomUUID()
  await f.refresh(second); await f.waitCommand(second)
  const after = await f.list()
  assert.equal(after.providers[0]!.verifiedAt, before.providers[0]!.verifiedAt)
  assert.equal(after.providers[0]!.verifiedHandlerGeneration, handler.record.generation)
  assert.equal(after.providers[0]!.freshness, "stale")
  assert.deepEqual(after.providers[1]!.models.map(m => m.modelId), ["replacement"])
  assert.equal(after.providers[1]!.freshness, "fresh")
  const retry = await f.refresh(first)
  assert.equal(retry.command.snapshotId, initial.snapshotId)
  assert.equal((await f.inventory()).launches.length, 4)
  assert.equal(JSON.stringify(after).includes("SECRET"), false)
})

test("client disconnect leaves a durable refresh with exact retry and responsive status", { timeout: 60000 }, async t => {
  const f = await catalogHandlerFixture(t, { enabled: ["codex-acp"], wait: true }), handler = await f.start(), commandId = randomUUID()
  const socket = createConnection(f.paths.handlerSocketPath)
  socket.on("error", () => undefined)
  socket.on("data", () => socket.destroy())
  socket.end(JSON.stringify({ protocol: CATALOG_PROTOCOL, requestId: randomUUID(), handlerGeneration: handler.record.generation, op: "model_refresh", commandId }) + "\n")
  await until(async () => (await createCatalogStore(f.paths.persistentRoot).readCommand(commandId)) ?? undefined)
  const active = await f.waitNative("codex-acp")
  const status = await f.call()
  assert.ok(status.ok && "phase" in status.result && status.result.phase === "ready")
  assert.equal((await f.refresh(commandId)).command.state, "pending")
  assert.equal((await f.inventory()).launches.length, 1)
  await f.release("codex-acp")
  await f.waitCommand(commandId)
  assert.equal((await f.refresh(commandId)).command.state, "completed")
  assert.equal((await f.inventory()).launches[0]!.record.launchAttemptId, active.record.launchAttemptId)
})

test("ordinary shutdown cancels a registered discovery group without agent flags", { timeout: 60000 }, async t => {
  const f = await catalogHandlerFixture(t, { enabled: ["codex-acp"], wait: true }), handler = await f.start(), commandId = randomUUID()
  await f.refresh(commandId); const active = await f.waitNative("codex-acp")
  const reply = await f.call({ protocol: "agency-control/1", requestId: randomUUID(), handlerGeneration: handler.record.generation, op: "shutdown", commandId: randomUUID(), stopAgents: false })
  assert.ok(reply.ok)
  await until(async () => await f.observe(handler.record.process!.pid) === null ? true : undefined)
  assert.equal((await createCatalogStore(f.paths.persistentRoot).readCommand(commandId))!.state, "interrupted")
  for (const identity of active.record.provider!.group.observed) assert.equal(await f.adapter.readProcess(identity.pid), null)
})

test("checkout admission remains responsive and refused shutdown resumes discovery", { timeout: 60000 }, async t => {
  const git = await gitFixture(t), operation = { checkoutPath: git.repo, action: "reserve" as const, agentId: randomUUID(), leaseId: randomUUID(), launchAttemptId: randomUUID() }
  const f = await catalogHandlerFixture(t, { enabled: ["codex-acp"], wait: true, admissionOperations: [operation] }, git), handler = await f.start()
  const first = await f.waitNative("codex-acp")
  await f.list()
  const status = await f.call()
  assert.ok(status.ok && "launches" in status.result && status.result.launches.some(l => l.launchAttemptId === operation.launchAttemptId))
  const reply = await f.call({ protocol: "agency-control/1", requestId: randomUUID(), handlerGeneration: handler.record.generation, op: "shutdown", commandId: randomUUID(), stopAgents: false })
  assert.ok(!reply.ok && reply.error.code === "ACTIVE_AGENTS")
  const resumed = await f.waitNative("codex-acp")
  assert.notEqual(resumed.record.launchAttemptId, first.record.launchAttemptId)
  assert.equal(await f.adapter.readProcess(first.record.provider!.group.leader.pid), null)
})

test("changed declared input discards a native candidate after cleanup", { timeout: 60000 }, async t => {
  const f = await catalogHandlerFixture(t, { enabled: ["codex-acp"], wait: true }), commandId = randomUUID()
  await f.start(); await f.refresh(commandId); await f.waitNative("codex-acp")
  await writeFile(f.profiles.find(p => p.id === "codex-acp")!.configurationFiles[0]!, "changed")
  await f.release("codex-acp"); await f.waitCommand(commandId)
  const provider = (await f.list()).providers.find(p => p.providerId === "codex-acp")!
  assert.equal(provider.error!.code, "CONFIG_CHANGED")
  assert.notEqual(provider.freshness, "fresh")
  assert.equal((await f.inventory()).launches[0]!.record.phase, "cleanup_verified")
})

test("restart cleans the exact old probe and interrupts its command before new work", { timeout: 60000 }, async t => {
  const f = await catalogHandlerFixture(t, { enabled: ["codex-acp"], wait: true }), old = await f.start(), commandId = randomUUID()
  await f.refresh(commandId); const retained = await f.waitNative("codex-acp")
  for (const identity of retained.record.provider!.group.observed) assert.ok(sameProcess(identity, (await f.adapter.readProcess(identity.pid))!))
  await f.signal(old.record.process!, "SIGKILL")
  await until(async () => await f.observe(old.record.process!.pid) === null ? true : undefined)
  assert.deepEqual(await f.adapter.readGroup(old.record.process!.pid), [])
  const replacement = await f.start()
  assert.notEqual(replacement.record.generation, old.record.generation)
  assert.equal((await createCatalogStore(f.paths.persistentRoot).readCommand(commandId))!.state, "interrupted")
  for (const identity of retained.record.provider!.group.observed) assert.equal(await f.adapter.readProcess(identity.pid), null)
  await assert.rejects(f.refresh(commandId), { code: "COMMAND_CONFLICT" })
  await f.release("codex-acp")
  const fresh = randomUUID(); await f.refresh(fresh); await f.waitCommand(fresh)
  assert.equal((await f.list()).providers[1]!.verifiedHandlerGeneration, replacement.record.generation)
})

test("synthetic cross-process probe uncertainty preserves roots and stops the fixture batch", { timeout: 60000 }, async t => {
  const cleanup: Array<() => Promise<void>> = []
  const context = { after: (fn: () => Promise<void>) => cleanup.push(fn) } as unknown as TestContext
  const f = await catalogHandlerFixture(context, { scenario: "uncertain" })
  try {
    await assert.rejects(f.start(), /unverified Handler catalog cleanup/)
    const evidence = JSON.parse(await readFile(join(f.root, "catalog-cleanup-failure.json"), "utf8"))
    assert.deepEqual(evidence.child, { pid: null, exited: false, closed: false })
    for (const fn of cleanup) await assert.rejects(fn(), /unverified Handler catalog cleanup/)
    assert.equal((await stat(f.root)).isDirectory(), true)
    await assert.rejects(controlFixture(context), /unverified Handler catalog cleanup/)
    await assert.rejects(f.start(), /unverified Handler catalog cleanup/)
  } finally {
    for (const fn of cleanup) await fn().catch(() => undefined)
    const evidence = JSON.parse(await readFile(join(f.root, "catalog-cleanup-failure.json"), "utf8"))
    assert.equal(evidence.child.pid, null)
    await until(async () => await f.observe(evidence.handlerPid) === null ? true : undefined)
    assert.deepEqual(await f.adapter.readGroup(evidence.handlerPid), [])
    assert.equal(await f.observe(evidence.handlerPid), null)
    const inventory = await createCatalogStore(f.paths.persistentRoot).inventory()
    assert.ok(inventory.launches.every(entry => entry.record.provider === null))
    await rm(f.root, { recursive: true })
  }
})