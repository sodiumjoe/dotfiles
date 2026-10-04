import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { join } from "node:path"
import test from "node:test"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import { ControlError } from "../src/control/protocol.js"
import { readHandlerRecord, writeLaunchRecord } from "../src/platform/private-state.js"
import { readShutdownReceipt } from "../src/handler/receipt.js"
import { controlFixture, until, launch, delay, privateRoot } from "./control-support.js"

function client(f: Awaited<ReturnType<typeof controlFixture>>) {
  const out: string[] = []
  const deps = { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), start: async () => f.start(), stdout: (value: string) => { out.push(value) }, stderr: () => undefined }
  return { out, deps, run: (args: string[]) => runControl([...args, "--json"], deps), result: () => JSON.parse(out.at(-1)!) }
}

test("32 concurrent clients select one real generation and observe the same readiness boundary", { timeout: 20000 }, async t => {
  const f = await controlFixture(t)
  const settled = await Promise.allSettled(Array.from({ length: 32 }, () => f.start()))
  const rejected = settled.filter(result => result.status === "rejected")
  assert.deepEqual(rejected, [])
  const generations = settled.map(result => result.status === "fulfilled" ? result.value.record.generation : "failed")
  assert.equal(new Set(generations).size, 1)
  assert.equal(f.owned.length, 1)
  const status = await f.call()
  assert.ok(status.ok && "reconciliation" in status.result)
  assert.equal(status.result.reconciliation.classified, status.result.reconciliation.total)
})

test("historical admission state does not participate in Handler lifecycle", { timeout: 20000 }, async t => {
  const trap = await privateRoot(t), marker = join(trap, "admissions-accessed"), gitMarker = join(trap, "git-invoked"), preload = join(trap, "forbid-admissions.cjs")
  await writeFile(preload, `const fs = require("node:fs")\nconst fsp = require("node:fs/promises")\nconst cp = require("node:child_process")\nfor (const name of ["lstat", "stat", "readdir", "opendir", "readFile", "open", "mkdir", "rm", "rename", "writeFile"]) { const original = fsp[name]; fsp[name] = function(path, ...args) { if (String(path).includes("/admissions")) { fs.writeFileSync(${JSON.stringify(marker)}, String(path)); throw new Error("admissions access forbidden") }; return original.call(this, path, ...args) } }\nfor (const name of ["execFile", "spawn"]) { const original = cp[name]; cp[name] = function(file, ...args) { if (String(file).includes("git")) { fs.writeFileSync(${JSON.stringify(gitMarker)}, String(file)); throw new Error("Git subprocess forbidden") }; return original.call(this, file, ...args) } }\nrequire("node:module").syncBuiltinESMExports()`, { mode: 0o600 })
  const f = await controlFixture(t, {}, undefined, { NODE_OPTIONS: `--require=${preload}` }), directory = join(f.paths.persistentRoot, "admissions")
  await mkdir(directory, { mode: 0o700 })
  await writeFile(join(directory, "historical.json"), "{", { mode: 0o600 })
  const before = await lstat(directory)
  const handler = await f.start()
  const cli = client(f)
  assert.equal(await cli.run(["status"]), 0)
  assert.equal(await cli.run(["doctor"]), 0)
  assert.equal(JSON.stringify(cli.result()).includes("admission"), false)
  assert.equal((await lstat(directory)).ino, before.ino)
  assert.equal(await readFile(join(directory, "historical.json"), "utf8"), "{")
  await assert.rejects(lstat(marker), { code: "ENOENT" })
  await assert.rejects(lstat(gitMarker), { code: "ENOENT" })
  assert.equal(await cli.run(["shutdown"]), 0)
  assert.equal(handler.record.phase, "ready")
})

test("restart after exact Handler death rejects the old command target without stopping replacement", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), first = await f.start()
  await f.signal(f.owned[0]!, "SIGKILL")
  await until(async () => await f.observe(f.owned[0]!.pid) === null ? true : undefined)
  const second = await f.start()
  assert.notEqual(second.record.generation, first.record.generation)
  const cli = client(f)
  assert.equal(await cli.run(["shutdown", "--command-id", randomUUID(), "--handler-generation", first.record.generation]), 69)
  assert.equal((await f.start()).record.generation, second.record.generation)
})

test("startup releases an unattempted lease and preserves attempted provider-null quarantine", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), boot = await f.adapter.bootId()
  const ambiguous = launch({ launchBootId: boot, checkoutId: "ambiguous" }), unattempted = launch({ launchBootId: boot, checkoutId: "unattempted", launchAttempted: false })
  for (const record of [ambiguous, unattempted]) await writeLaunchRecord(join(f.paths.persistentRoot, "launches", `${record.launchAttemptId}.json`), record)
  await f.start()
  const cli = client(f)
  assert.equal(await cli.run(["status"]), 0)
  const state = cli.result().result
  assert.equal(state.launches.find((record: { launchAttemptId: string }) => record.launchAttemptId === ambiguous.launchAttemptId).phase, "quarantined")
  assert.equal(state.launches.find((record: { launchAttemptId: string }) => record.launchAttemptId === unattempted.launchAttemptId).phase, "cleanup_verified")
  assert.equal(await cli.run(["shutdown", "--stop-agents"]), 75)
  assert.ok((await f.call()).ok)
})

test("startup cleans an exact retained provider tree and independently proves every member absent", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), record = await f.spawnProvider()
  const path = join(f.paths.persistentRoot, "launches", `${record.launchAttemptId}.json`)
  await writeLaunchRecord(path, record)
  await f.start()
  assert.equal(JSON.parse(await readFile(path, "utf8")).phase, "cleanup_verified")
  for (const member of record.provider!.group.observed) assert.equal(await f.observe(member.pid), null)
  assert.deepEqual(await f.adapter.readGroup(record.provider!.group.leader.pid), [])
})

test("a lost shutdown reply is resolved from receipts and cannot stop a later Handler", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), first = await f.start(), cli = client(f)
  const call = cli.deps.call
  cli.deps.call = async (env, request) => { const reply = await call(env, request); if (request.op === "shutdown") throw new ControlError("UNAVAILABLE", "reply lost"); return reply }
  assert.equal(await cli.run(["shutdown"]), 0)
  const completed = cli.result().result
  const receipt = await readShutdownReceipt(f.paths.persistentRoot, completed.commandId)
  assert.equal(receipt?.handlerGeneration, first.record.generation)
  assert.equal(await f.observe(first.record.process!.pid), null)
  const second = await f.start()
  assert.notEqual(second.record.generation, first.record.generation)
  assert.equal(await cli.run(["shutdown", "--command-id", completed.commandId, "--handler-generation", first.record.generation]), 0)
  assert.equal((await f.start()).record.generation, second.record.generation)
})

test("shutdown closes partial-request, idle control, and attachment clients before reporting complete", { timeout: 20000 }, async t => {
  const f = await controlFixture(t)
  await f.start()
  const idle = createConnection(f.paths.handlerSocketPath), partial = createConnection(f.paths.handlerSocketPath), attachment = createConnection(join(f.paths.runtimeRoot, "attachment.sock"))
  let attachmentError: unknown
  t.after(() => { idle.destroy(); partial.destroy(); attachment.destroy() })
  idle.on("error", () => undefined); partial.on("error", () => undefined); attachment.on("error", error => { attachmentError = error })
  partial.write('{"protocol":')
  const cli = client(f)
  assert.equal(await cli.run(["shutdown"]), 0)
  await delay(20)
  assert.ok(idle.destroyed)
  assert.ok(partial.destroyed)
  assert.equal(attachmentError, undefined)
  assert.ok(attachment.destroyed)
})

test("launcher readiness timeout after gate release leaves one live reconciling Handler", { timeout: 20000 }, async t => {
  const f = await controlFixture(t, { delayMs: 2400 })
  let released = false
  await assert.rejects(f.start(1800, async transition => { if (transition === "gate_released") released = true }))
  assert.ok(released)
  const pending = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  assert.equal(pending.phase, "reconciling")
  const ready = await f.start()
  assert.equal(ready.record.generation, pending.generation)
  assert.equal(f.owned.length, 1)
  assert.ok((await f.call()).ok)
})

test("a mismatched generation on the real socket is rejected before shutdown", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), current = await f.start()
  await assert.rejects(f.call({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: randomUUID(), op: "shutdown", commandId: randomUUID(), stopAgents: true }), /STALE_HANDLER/)
  assert.equal((await f.start()).record.generation, current.record.generation)
})