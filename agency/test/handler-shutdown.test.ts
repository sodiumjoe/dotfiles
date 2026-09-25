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

const generation = randomUUID(), marker = randomUUID()
const identity = { bootId: "boot-a", pid: 101, birth: `1:agy-handler:${marker}`, parentPid: 1, processGroupId: 101, sessionId: 101, uid: process.getuid!(), gid: process.getgid!() }
const receipt = (): ShutdownReceipt => ({ version: 1, commandId: randomUUID(), hostId: "a".repeat(64), handlerGeneration: generation, handlerIdentity: identity, stopAgents: false, state: "accepted" })
const request = (commandId = randomUUID()): ControlRequest & { op: "shutdown" } => ({ protocol: "agency-control/1", requestId: randomUUID(), handlerGeneration: generation, op: "shutdown", commandId, stopAgents: false })

async function context(t: test.TestContext): Promise<ShutdownContext> {
  const root = await privateRoot(t)
  await mkdir(join(root, "launches"), { mode: 0o700 })
  const record: HandlerGenerationRecord = { version: 1, hostId: "a".repeat(64), launchBootId: "boot-a", generation, launchAttemptId: marker, launchAttempted: true, phase: "ready", process: identity, socketPath: join(root, "handler.sock"), writer: "handler", reconciliation: { classified: 0, total: 0, quarantined: 0 }, reason: null }
  const state: HandlerStatus = { hostId: record.hostId, handlerGeneration: generation, phase: "ready", reconciliation: { classified: 0, total: 0, quarantined: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] }
  const adapter: PlatformAdapter = { platform: "linux", bootId: async () => "boot-a", readProcess: async () => { throw new Error("unexpected process observation") }, readGroup: async () => { throw new Error("unexpected group observation") }, signalGroup: async () => { throw new Error("unauthorized signal") } }
  return { record, state, paths: { hostKey: record.hostId, persistentRoot: root, runtimeRoot: root, handlerSocketPath: record.socketPath }, adapter, closeAfterReply: async () => undefined }
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