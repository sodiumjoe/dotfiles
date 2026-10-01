import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, mkdir, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { readShutdownReceipt, writeShutdownReceipt, assertSameShutdown, type ShutdownReceipt } from "../src/handler/receipt.js"
import { shutdownHandler, type ShutdownContext } from "../src/handler/shutdown.js"
import { type HandlerStatus, type ControlRequest } from "../src/control/protocol.js"
import { privateRoot, launch } from "./control-support.js"
import { writeLaunchRecord } from "../src/platform/private-state.js"
import type { HandlerGenerationRecord, PlatformAdapter } from "../src/platform/types.js"
import { MutationQueue } from "../src/handler/mutations.js"
import { createAdmissionController } from "../src/checkout/admission.js"
import { resolveCheckout } from "../src/checkout/identity.js"
import { writeAdmission } from "../src/checkout/records.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import { admissionFixture } from "./checkout-support.js"
import { agentServiceFixture } from "./agent-support.js"
import { until } from "./control-support.js"

const generation = randomUUID(), marker = randomUUID()
const identity = { bootId: "boot-a", pid: 101, birth: `1:agy-handler:${marker}`, parentPid: 1, processGroupId: 101, sessionId: 101, uid: process.getuid!(), gid: process.getgid!() }
const receipt = (): ShutdownReceipt => ({ version: 1, commandId: randomUUID(), hostId: "a".repeat(64), handlerGeneration: generation, handlerIdentity: identity, stopAgents: false, state: "accepted" })
const request = (commandId = randomUUID()): ControlRequest & { op: "shutdown" } => ({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: generation, op: "shutdown", commandId, stopAgents: false })

async function context(t: test.TestContext): Promise<ShutdownContext> {
  const root = await privateRoot(t)
  await mkdir(join(root, "launches"), { mode: 0o700 })
  const record: HandlerGenerationRecord = { version: 1, hostId: "a".repeat(64), launchBootId: "boot-a", generation, launchAttemptId: marker, launchAttempted: true, phase: "ready", process: identity, socketPath: join(root, "handler.sock"), writer: "handler", reconciliation: { classified: 0, total: 0, quarantined: 0 }, reason: null }
  const state: HandlerStatus = { hostId: record.hostId, handlerGeneration: generation, phase: "ready", reconciliation: { classified: 0, total: 0, uncertain: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] }
  const adapter: PlatformAdapter = { platform: "linux", bootId: async () => "boot-a", readProcess: async () => { throw new Error("unexpected process observation") }, readGroup: async () => { throw new Error("unexpected group observation") }, signalGroup: async () => { throw new Error("unauthorized signal") } }
  return { record, state, paths: { hostKey: record.hostId, persistentRoot: root, runtimeRoot: root, handlerSocketPath: record.socketPath }, adapter, mutations: { queue: new MutationQueue(), accepted: [], unavailable: null }, closeAfterReply: async () => undefined }
}

test("receipts preserve exact identity and reject changed fields or unsafe storage", async t => {
  const root = await privateRoot(t), value = receipt()
  assert.equal(await readShutdownReceipt(root, value.commandId), null)
  await writeShutdownReceipt(root, value)
  assert.deepEqual(await readShutdownReceipt(root, value.commandId), value)
  assert.doesNotThrow(() => assertSameShutdown(value, value))
  for (const changed of [{ ...value, handlerGeneration: randomUUID() }, { ...value, stopAgents: true }]) {
    assert.throws(() => assertSameShutdown(value, changed), /COMMAND_CONFLICT/)
    await assert.rejects(writeShutdownReceipt(root, changed), /COMMAND_CONFLICT/)
  }
  await assert.rejects(readShutdownReceipt(root, "../../outside"))
  const path = join(root, "shutdown", `${value.commandId}.json`)
  await chmod(path, 0o644)
  await assert.rejects(readShutdownReceipt(root, value.commandId))
  await chmod(path, 0o600)
  const alias = randomUUID()
  await symlink(path, join(root, "shutdown", `${alias}.json`))
  await assert.rejects(readShutdownReceipt(root, alias))
  await writeFile(path, JSON.stringify({ ...value, handlerIdentity: { ...identity, pid: 1 } }))
  await assert.rejects(readShutdownReceipt(root, value.commandId))
})

test("pre-rename failure leaves no receipt and post-rename directory failure preserves uncertain evidence", async t => {
  const root = await privateRoot(t), value = receipt()
  await assert.rejects(writeShutdownReceipt(root, value, { open, rm, rename: async () => { throw new Error("rename failed") } }), /rename failed/)
  assert.equal(await readShutdownReceipt(root, value.commandId), null)
  await assert.rejects(writeShutdownReceipt(root, value, { rename, rm, open: async (path, flags, mode) => {
    if (flags === (constants.O_RDONLY | constants.O_DIRECTORY)) throw new Error("directory fsync unavailable")
    return open(path, flags, mode)
  } }), /directory fsync unavailable/)
  assert.deepEqual(await readShutdownReceipt(root, value.commandId), value)
  await writeShutdownReceipt(root, value)
  assert.deepEqual(await readShutdownReceipt(root, value.commandId), value)
})

test("shutdown serializes admission, persists before draining, and deduplicates accepted commands", async t => {
  const ctx = await context(t), first = request()
  const replies = await Promise.all([shutdownHandler(first, ctx), shutdownHandler({ ...first, requestId: randomUUID() }, ctx)])
  assert.ok(replies.every(reply => reply.ok))
  assert.equal(ctx.state.phase, "draining")
  assert.equal((await readShutdownReceipt(ctx.paths.persistentRoot, first.commandId))!.handlerGeneration, generation)
  const duplicate = await shutdownHandler({ ...first, requestId: randomUUID() }, ctx)
  assert.ok(duplicate.ok)
  const conflict = await shutdownHandler({ ...first, stopAgents: true }, ctx)
  assert.ok(!conflict.ok && conflict.error.code === "COMMAND_CONFLICT")
  const different = await shutdownHandler(request(), ctx)
  assert.ok(!different.ok && different.error.code === "INCOMPLETE")
})

test("shutdown refuses stale generations and incomplete startup without persisting", async t => {
  const ctx = await context(t)
  const stale = await shutdownHandler({ ...request(), handlerGeneration: randomUUID() }, ctx)
  assert.ok(!stale.ok && stale.error.code === "STALE_HANDLER")
  ctx.state.phase = "reconciling"
  const command = request(), busy = await shutdownHandler(command, ctx)
  assert.ok(!busy.ok && busy.error.code === "INCOMPLETE")
  assert.equal(await readShutdownReceipt(ctx.paths.persistentRoot, command.commandId), null)
})

test("shutdown freezes outside the mutation queue and installs pending before draining", async t => {
  const ctx = await context(t), command = request()
  let frozen = 0, drained = false, verified = false, resumed = 0
  ctx.catalog = {
    async freezeAndDrain() { assert.notEqual(ctx.pending, undefined); frozen++; await ctx.mutations.queue.run(async () => { drained = true }) },
    async verifyDischarged() { assert.equal(drained, true); verified = true },
    resume() { resumed++ },
  }
  const replies = await Promise.all([shutdownHandler(command, ctx), shutdownHandler({ ...command, requestId: randomUUID() }, ctx)])
  assert.ok(replies.every(reply => reply.ok))
  assert.equal(frozen, 1); assert.equal(verified, true); assert.equal(resumed, 0)
})

test("refused shutdown resumes scheduling but unverified catalog prevents a receipt", async t => {
  const ctx = await context(t), command = request()
  let resumed = 0
  ctx.catalog = { freezeAndDrain: async () => undefined, verifyDischarged: async () => { throw new Error("unverified probe") }, resume: () => { resumed++ } }
  const reply = await shutdownHandler(command, ctx)
  assert.ok(!reply.ok && reply.error.code === "INCOMPLETE")
  assert.equal(await readShutdownReceipt(ctx.paths.persistentRoot, command.commandId), null)
  assert.equal(ctx.pending, undefined)
  assert.equal(resumed, 1)
  assert.equal(ctx.state.phase, "ready")
})

test("unverified launches block shutdown; --stop-agents cannot release provider-null ambiguity", async t => {
  const ctx = await context(t), record = launch(), path = join(ctx.paths.persistentRoot, "launches", `${record.launchAttemptId}.json`)
  await writeLaunchRecord(path, record)
  const command = request(), refused = await shutdownHandler(command, ctx)
  assert.ok(!refused.ok && refused.error.code === "ACTIVE_AGENTS")
  const incomplete = await shutdownHandler({ ...command, stopAgents: true }, ctx)
  assert.ok(!incomplete.ok && incomplete.error.code === "INCOMPLETE")
  assert.equal(JSON.parse(await readFile(path, "utf8")).phase, "quarantined")
  assert.equal(ctx.state.phase, "ready")
  assert.equal(await readShutdownReceipt(ctx.paths.persistentRoot, command.commandId), null)
})

test("uncertain receipt publication remains serviceable and retries the same pinned intent", async t => {
  const ctx = await context(t), command = request()
  ctx.publishReceipt = async (root, value) => writeShutdownReceipt(root, value, { rename, rm, open: async (path, flags, mode) => {
    if (flags === (constants.O_RDONLY | constants.O_DIRECTORY)) throw new Error("ENOSPC")
    return open(path, flags, mode)
  } })
  const failed = await shutdownHandler(command, ctx)
  assert.ok(!failed.ok && failed.error.code === "INCOMPLETE")
  assert.equal(ctx.state.phase, "ready")
  assert.notEqual(await readShutdownReceipt(ctx.paths.persistentRoot, command.commandId), null)
  ctx.publishReceipt = writeShutdownReceipt
  assert.ok((await shutdownHandler(command, ctx)).ok)
  assert.equal(ctx.state.phase, "draining")
})

async function checkoutContext(t: test.TestContext) {
  const f = await admissionFixture(t), base = await context(t)
  const ctx: ShutdownContext = { ...base, paths: f.context.paths, adapter: f.context.adapter, state: f.context.state, mutations: f.context.mutations, record: { ...base.record, generation: f.context.state.handlerGeneration } }
  f.context.shutdownPending = () => ctx.pending !== undefined || ctx.accepted !== undefined
  const command = { ...request(), handlerGeneration: ctx.record.generation }
  return { f, ctx, command }
}

test("shutdown waits for an executing reservation before checking active leases", { timeout: 20000 }, async t => {
  const { f, ctx, command } = await checkoutContext(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const controller = createAdmissionController(f.context, { resolve: resolveCheckout, publishAdmission: writeAdmission, reconcile: reconcileRecord, publishLaunch: async (path, value) => { entered.resolve(); await release.promise; await writeLaunchRecord(path, value) } })
  const reservation = controller.reserve(f.request())
  await entered.promise
  const shutdown = shutdownHandler(command, ctx)
  assert.notEqual(ctx.pending, undefined)
  assert.equal(ctx.state.phase, "ready")
  release.resolve()
  assert.equal((await reservation).launch.phase, "launch_pending")
  const reply = await shutdown
  assert.ok(!reply.ok && reply.error.code === "ACTIVE_AGENTS")
  assert.equal(ctx.state.launches.length, 1)
  assert.equal(ctx.state.reconciliation.total, 1)
})

test("a pending shutdown coalesces retries and prevents queued reservations", { timeout: 20000 }, async t => {
  const { f, ctx, command } = await checkoutContext(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let publications = 0
  ctx.publishReceipt = async (root, value) => { publications++; entered.resolve(); await release.promise; await writeShutdownReceipt(root, value) }
  const first = shutdownHandler(command, ctx)
  await entered.promise
  const second = shutdownHandler({ ...command, requestId: randomUUID() }, ctx)
  const reservation = assert.rejects(f.controller.reserve(f.request()), { code: "NOT_READY" })
  release.resolve()
  assert.ok((await first).ok)
  assert.ok((await second).ok)
  await reservation
  assert.equal(publications, 1)
  assert.equal(ctx.state.phase, "draining")
  assert.equal(ctx.state.launches.length, 0)
})

for (const pause of ["reservation", "ready"] as const) test(`ordinary lifecycle shutdown refuses synchronously without cancelling ${pause}`, async t => {
  const f = await agentServiceFixture(t, { pause }), base = await context(t)
  const ctx: ShutdownContext = { ...base, paths: f.context.paths, state: f.context.state, adapter: f.context.adapter, mutations: f.context.mutations, record: { ...base.record, generation: f.input.handlerGeneration }, agents: f.service }
  f.context.shutdownPending = () => ctx.pending !== undefined
  await f.service.start(f.input); await f.entered
  const reply = await shutdownHandler({ ...request(), handlerGeneration: f.input.handlerGeneration }, ctx)
  assert.ok(!reply.ok && reply.error.code === "ACTIVE_AGENTS"); assert.equal(ctx.pending, undefined)
  f.release()
  const completed = await until(async () => { const v = await f.service.command(f.input.commandId, f.input.handlerGeneration); return v.command.state === "completed" ? v : undefined })
  assert.equal(completed.command.result!.outcome, "started")
})

test("forced lifecycle and catalog drain independently release the mutation queue", async t => {
  const f = await agentServiceFixture(t, { pause: "ready" }), base = await context(t)
  const ctx: ShutdownContext = { ...base, paths: f.context.paths, state: f.context.state, adapter: f.context.adapter, mutations: f.context.mutations, record: { ...base.record, generation: f.input.handlerGeneration }, agents: f.service }
  f.context.shutdownPending = () => ctx.pending !== undefined
  let catalogDrained = false
  ctx.catalog = { async freezeAndDrain() { await ctx.mutations.queue.run(async () => { catalogDrained = true }) }, resume() {}, async verifyDischarged() { assert.equal(catalogDrained, true) } }
  await f.service.start(f.input); await f.entered
  const reply = await shutdownHandler({ ...request(), handlerGeneration: f.input.handlerGeneration, stopAgents: true }, ctx)
  assert.ok(reply.ok, JSON.stringify(reply)); assert.equal(ctx.state.phase, "draining")
  f.release()
  assert.equal((await f.service.command(f.input.commandId, f.input.handlerGeneration)).command.result!.outcome, "failed")
})

test("incomplete forced lifecycle cleanup leaves Handler status and quarantine readable", async t => {
  const f = await agentServiceFixture(t), base = await context(t)
  const ctx: ShutdownContext = { ...base, paths: f.context.paths, state: f.context.state, adapter: f.context.adapter, mutations: f.context.mutations, record: { ...base.record, generation: f.input.handlerGeneration }, agents: f.service }
  f.context.shutdownPending = () => ctx.pending !== undefined
  await f.service.start(f.input)
  await until(async () => (await f.service.command(f.input.commandId, f.input.handlerGeneration)).command.state === "completed" ? true : undefined)
  const read = f.context.adapter.readProcess
  f.context.adapter.readProcess = async pid => { const identity = await read(pid); return identity ? { ...identity, birth: identity.birth.replace(/^100:/, "200:") } : null }
  const command = { ...request(), handlerGeneration: f.input.handlerGeneration, stopAgents: true }
  const reply = await shutdownHandler(command, ctx)
  assert.ok(!reply.ok && reply.error.code === "INCOMPLETE", JSON.stringify(reply))
  assert.equal(ctx.pending, undefined); assert.equal(ctx.state.phase, "ready")
  assert.equal(await readShutdownReceipt(ctx.paths.persistentRoot, command.commandId), null)
  assert.equal((await f.service.list()).agents[0]!.cleanup, "unknown")
})