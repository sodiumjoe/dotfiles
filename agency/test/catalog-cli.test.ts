import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { runControl, type ControlDependencies } from "../src/cli/control.js"
import { ControlError } from "../src/control/protocol.js"
import { CATALOG_PROTOCOL, type CatalogReply, type CatalogRequest } from "../src/catalog/protocol.js"
import { unavailableControlDependencies } from "./control-support.js"
import type { HandlerInspection } from "../src/platform/types.js"
import { createConnection, createServer } from "node:net"
import { join } from "node:path"
import { privateRoot } from "./control-support.js"
import { exchangeCatalog } from "../src/catalog/protocol.js"
import { serveControl } from "../src/control/wire.js"

function fixture() {
  const generation = randomUUID(), hostId = "a".repeat(64), attempt = randomUUID(), calls: CatalogRequest[] = [], out: string[] = [], err: string[] = []
  let now = 0
  const inspection: HandlerInspection = { disposition: "live", record: { version: 1, hostId, generation, launchBootId: "boot", launchAttemptId: attempt, launchAttempted: true, phase: "ready", process: { bootId: "boot", pid: 1, parentPid: 0, birth: `1:agy-handler:${attempt}`, processGroupId: 1, sessionId: 1, uid: 1, gid: 1 }, socketPath: "/fixture/socket", writer: "handler", reconciliation: { classified: 0, total: 0, quarantined: 0 }, reason: null } }
  const reply = (r: CatalogRequest, pending = false): CatalogReply => ({ protocol: CATALOG_PROTOCOL, requestId: r.requestId, handlerGeneration: generation, ok: true, result: r.op === "model_list" ? { state: "catalog", hostId, handlerGeneration: generation, observedAt: 0, launchAuthorized: false, providers: ["claude-agent-acp", "codex-acp"].map(providerId => ({ providerId: providerId as "claude-agent-acp" | "codex-acp", fingerprint: null, verifiedAt: null, verifiedHandlerGeneration: null, providerVersion: null, providerVersionSource: "unknown", adapterVersion: null, sdkVersion: null, models: [], error: null, state: "unconfigured", freshness: "unverified" })), refresh: null, discovery: { state: "idle", error: null } } : { state: "refresh", command: { commandId: r.commandId, handlerGeneration: generation, state: pending ? "pending" : "completed", snapshotId: pending ? null : attempt }, snapshot: pending ? null : { version: 1, hostId, handlerGeneration: generation, snapshotId: attempt, createdAt: 0, providers: [] } } })
  const deps: ControlDependencies = { ...unavailableControlDependencies(), environment: async () => ({ paths: { hostKey: hostId, persistentRoot: "/fixture", runtimeRoot: "/fixture", handlerSocketPath: "/fixture/socket" }, adapter: { platform: "darwin", bootId: async () => "boot", readProcess: async () => { throw new Error("unexpected process read") }, readGroup: async () => { throw new Error("unexpected group read") }, signalGroup: async () => { throw new Error("unauthorized signal") } } }), start: async () => inspection, callCatalog: async (_env, r) => { calls.push(r); return reply(r) }, now: () => now, sleep: async ms => { now += ms }, stdout: value => out.push(value), stderr: value => err.push(value) }
  return { deps, generation, calls, out, err, reply, output: () => JSON.parse(out.join("")) }
}

test("model list routes independently and emits one non-launch-authorizing envelope", async () => {
  const f = fixture()
  assert.equal(await runControl(["model", "list", "--json"], f.deps), 0)
  assert.equal(f.out.length, 1)
  assert.equal(f.output().protocol, CATALOG_PROTOCOL)
  assert.equal(f.output().result.launchAuthorized, false)
})
test("malformed model commands fail before environment resolution", async () => {
  for (const args of [["model"], ["model", "start"], ["model", "refresh", "--command-id", randomUUID()], ["model", "list", "--handler-generation", randomUUID()], ["model", "refresh", "--stop-agents"]]) {
    const f = fixture()
    f.deps.environment = async () => { throw new Error("SECRET") }
    assert.equal(await runControl([...args, "--json"], f.deps), 64)
    assert.equal(f.out.length, 1)
    assert.equal(f.out.join("").includes("SECRET"), false)
  }
})
test("refresh retries a lost response with the same IDs and reports them on completion", async () => {
  const f = fixture(), commandId = randomUUID()
  f.deps.callCatalog = async (_env, r) => { f.calls.push(r); if (f.calls.length === 1) throw new ControlError("UNAVAILABLE"); return f.reply(r) }
  assert.equal(await runControl(["model", "refresh", "--command-id", commandId, "--handler-generation", f.generation, "--json"], f.deps), 0)
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every(r => r.op === "model_refresh" && r.commandId === commandId && r.handlerGeneration === f.generation))
  assert.equal(f.output().commandId, commandId)
  assert.equal(f.output().handlerGeneration, f.generation)
})
test("refresh timeout returns retry IDs without issuing a replacement command", async () => {
  const f = fixture()
  f.deps.callCatalog = async (_env, r) => { f.calls.push(r); return f.reply(r, true) }
  assert.equal(await runControl(["model", "refresh", "--json"], f.deps), 75)
  assert.equal(new Set(f.calls.map(r => r.op === "model_refresh" && r.commandId)).size, 1)
  assert.equal(f.output().handlerGeneration, f.generation)
  assert.equal(typeof f.output().commandId, "string")
  assert.equal(f.out.length, 1)
})
test("old or unavailable Handler support fails boundedly without shutdown or replacement", async () => {
  const f = fixture()
  f.deps.callCatalog = async () => { throw new ControlError("UNAVAILABLE", "socket closed before complete frame") }
  assert.equal(await runControl(["model", "list", "--json"], f.deps), 69)
  assert.match(f.output().error.message, /catalog.*restart/i)
  assert.doesNotMatch(f.output().error.message, /is an old Handler/)
  const stale = fixture()
  assert.equal(await runControl(["model", "refresh", "--command-id", randomUUID(), "--handler-generation", randomUUID(), "--json"], stale.deps), 69)
  assert.equal(stale.calls.length, 0)
})

for (const command of ["list", "refresh"]) test(`model ${command} handles the real pre-catalog socket close as unavailable support`, async t => {
  const f = fixture(), root = await privateRoot(t), path = join(root, "legacy.sock")
  let starts = 0, dispatched = 0
  const start = f.deps.start
  f.deps.start = async env => { starts++; return start(env) }
  const server = createServer({ allowHalfOpen: true }, socket => { void serveControl(socket, async () => { dispatched++; throw new Error("unexpected legacy dispatch") }) })
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  await new Promise<void>(resolve => server.listen(path, resolve))
  f.deps.callCatalog = async (_env, request, timeoutMs) => { f.calls.push(request); return exchangeCatalog(createConnection(path), request, timeoutMs) }
  assert.equal(await runControl(["model", command, "--json"], f.deps), 69)
  assert.equal(f.output().error.code, "UNAVAILABLE")
  assert.match(f.output().error.message, /catalog.*restart/i)
  assert.doesNotMatch(f.output().error.message, /is an old Handler/)
  assert.equal(starts, 1)
  assert.equal(dispatched, 0)
  assert.ok(f.deps.now() <= 60000)
  if (command === "refresh") assert.equal(new Set(f.calls.map(r => r.op === "model_refresh" && r.commandId)).size, 1)
})

test("nonempty malformed catalog replies retain invalid-protocol classification", async t => {
  const f = fixture(), root = await privateRoot(t), path = join(root, "malformed.sock")
  const server = createServer({ allowHalfOpen: true }, socket => { socket.resume(); socket.on("end", () => socket.end("malformed\n")) })
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  await new Promise<void>(resolve => server.listen(path, resolve))
  f.deps.callCatalog = async (_env, request) => exchangeCatalog(createConnection(path), request)
  assert.equal(await runControl(["model", "list", "--json"], f.deps), 65)
  assert.equal(f.output().error.code, "INVALID_PROTOCOL")
})

test("refresh with no catalog reply reports unavailable instead of claiming an old version", async () => {
  const f = fixture()
  f.deps.callCatalog = async () => { throw new ControlError("UNAVAILABLE", "EOF") }
  assert.equal(await runControl(["model", "refresh", "--json"], f.deps), 69)
  assert.match(f.output().error.message, /catalog.*restart/i)
  assert.equal(typeof f.output().commandId, "string")
})

test("partial provider failures are completed refresh results, not healthy invented models", async () => {
  const f = fixture()
  f.deps.callCatalog = async (_env, request) => {
    const reply = f.reply(request)
    if (reply.ok && reply.result.state === "refresh" && reply.result.snapshot) reply.result.snapshot.providers = [{ providerId: "claude-agent-acp", fingerprint: null, verifiedAt: null, verifiedHandlerGeneration: null, providerVersion: null, providerVersionSource: "unknown", adapterVersion: null, sdkVersion: null, models: [], error: { code: "PROBE_FAILED", message: "Provider discovery failed" } }]
    return reply
  }
  assert.equal(await runControl(["model", "refresh", "--json"], f.deps), 0)
  assert.deepEqual(f.output().result.snapshot.providers[0].models, [])
  assert.equal(f.output().result.snapshot.providers[0].error.code, "PROBE_FAILED")
})

test("refresh socket exchanges respect the remaining sixty-second polling budget", async () => {
  const f = fixture()
  f.deps.callCatalog = async (_env, request, ...timeouts: number[]) => { await f.deps.sleep(timeouts[0] ?? 5000); return f.reply(request, true) }
  assert.equal(await runControl(["model", "refresh", "--json"], f.deps), 75)
  assert.equal(f.deps.now(), 60000)
})