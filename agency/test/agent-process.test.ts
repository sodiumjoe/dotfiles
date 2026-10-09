import assert from "node:assert/strict"
import test from "node:test"
import { EDITOR_TURN_LIMITS, type AcpObservation } from "../src/agent/session-events.js"

test("owned provider forwards observations and nonfatal cancellation through its ACP connection", async t => {
  const seen: AcpObservation[] = []
  const f = await syntheticAgentProcess(t, "cancel", false, { onUpdate: event => seen.push(event) })
  await f.owner.initialize(new AbortController().signal)
  const first = f.owner.prompt("cancel me", new AbortController().signal, EDITOR_TURN_LIMITS)
  await f.owner.cancelPrompt()
  assert.deepEqual(await first, { stopReason: "cancelled", text: "" })
  assert.deepEqual(await f.owner.prompt("second", new AbortController().signal, EDITOR_TURN_LIMITS), { stopReason: "end_turn", text: "second" })
  assert.deepEqual(seen.at(-1)?.update.content, { type: "text", text: "second" })
  assert.equal(f.signals.length, 0)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { DarwinObservationUnavailable } from "../src/platform/darwin.js"
import { agentFailure } from "../src/agent/types.js"
import { syntheticAgentProcess } from "./agent-support.js"

test("agent process publishes a managed launch and spawns in the exact caller directory with profile-derived adapter routing", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  const session = await f.owner.initialize(new AbortController().signal)
  assert.equal(session.sessionId, "fixture-session")
  assert.equal(f.spawnInputReleases(), 1)
  assert.equal(f.releasesAtSpawn(), 1)
  const options = f.options()!
  assert.equal(options.cwd, f.spec.cwd)
  assert.deepEqual(options.env, { HOME: "/fixture-home", FIXTURE: "yes", NODE_OPTIONS: "preserved", NODE_PATH: "preserved", AGENCY_TEST: "preserved", GIT_DIR: "preserved", CODEX_PATH: "/fixture/codex" })
  const launch = await f.record()
  assert.equal(launch.version, 2)
  if (launch.version !== 2 || launch.owner.kind !== "agent") throw new Error("wrong launch owner")
  assert.equal(launch.owner.agentId, f.spec.agentId)
  assert.equal(launch.owner.providerGeneration, f.spec.providerGeneration)
  assert.equal(launch.phase, "readiness")
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  await assert.rejects(lstat(join(f.root, "agents/provider-state")), { code: "ENOENT" })
})

test("owned restoration initializes the recorded provider session in a fresh process", async t => {
  const f = await syntheticAgentProcess(t, "load")
  assert.equal((await f.owner.initialize(new AbortController().signal)).sessionId, "fixture-session")
  assert.equal(f.spawnCount(), 1)
  assert.deepEqual(f.requests.slice(0, 2).map(request => request.method), ["initialize", "session/load"])
  assert.deepEqual(f.requests[1]!.params, { sessionId: "fixture-session", cwd: "/workspace/a", mcpServers: [] })
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})

test("process identity mismatch never becomes a ready launch", async t => {
  const f = await syntheticAgentProcess(t, "identity-mismatch")
  await assert.rejects(f.owner.initialize(new AbortController().signal), { code: "STARTUP_FAILED" })
  assert.equal(f.owner.record().phase !== "active", true)
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.deepEqual(f.signals, [])
})

test("spawn failure retains exact launch attribution and verifies cleanup", async t => {
  const f = await syntheticAgentProcess(t, "spawn-throws")
  await assert.rejects(f.owner.initialize(new AbortController().signal))
  assert.equal(f.spawnInputReleases(), 1)
  assert.equal(f.releasesAtSpawn(), 1)
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.equal(f.owner.record().launchAttemptId, f.spec.launchAttemptId)
  assert.equal(f.spawnCount(), 1)
})

test("failed attempted transition prevents spawn and retains a clean launch", async t => {
  const f = await syntheticAgentProcess(t, "attempt-write")
  await assert.rejects(f.owner.initialize(new AbortController().signal))
  assert.equal(f.spawnCount(), 0)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})

test("provider exit fails the owned process and cleanup targets its retained group", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  const result = await f.owner.cleanup()
  assert.equal(result.phase, "cleanup_verified")
  assert.deepEqual(f.signals, ["SIGTERM"])
  assert.equal(f.owner.record().provider?.group.leader.pid, 12345)
})

test("provider identity publication retries a transient platform observation", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  const readGroup = f.context.adapter.readGroup
  let reads = 0
  f.context.adapter.readGroup = async group => {
    if (++reads === 1) throw new DarwinObservationUnavailable("transient fixture observation")
    return readGroup(group)
  }
  assert.equal((await f.owner.initialize(new AbortController().signal)).sessionId, "fixture-session")
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})

test("provider identity publication waits for consecutive matching group snapshots", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  const readGroup = f.context.adapter.readGroup
  const leader = { bootId: "boot-a", pid: 12345, birth: `100:agy-provider:${f.spec.launchAttemptId}`, parentPid: process.pid, processGroupId: 12345, sessionId: 12345, uid: process.getuid!(), gid: process.getgid!() }
  const child = { ...leader, pid: 12346, birth: "101:unmarked:/fixture-child", parentPid: leader.pid }
  let reads = 0
  f.context.adapter.readGroup = async group => {
    const current = await readGroup(group)
    if (!current.length) return current
    return ++reads === 1 ? current : [...current, child]
  }
  assert.equal((await f.owner.initialize(new AbortController().signal)).sessionId, "fixture-session")
  assert.equal(f.owner.record().provider?.group.observed.length, 2)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})

test("spawn identity observation times out without publishing a late process identity", async t => {
  const f = await syntheticAgentProcess(t, "identity-hang")
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  const pending = f.owner.initialize(new AbortController().signal)
  void pending.catch(() => undefined)
  await f.spawned
  t.mock.timers.tick(5000)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.equal(f.owner.record().provider, null)
  assert.equal(f.writesBeforeIdentity(), 0)
  assert.deepEqual(f.signals, [])
})

test("attempted launch publication cannot spawn after the startup deadline", async t => {
  const f = await syntheticAgentProcess(t, "publication-paused")
  t.after(() => f.releasePublication())
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  const pending = f.owner.initialize(new AbortController().signal)
  void pending.catch(() => undefined)
  await f.beforeSpawn.promise
  t.mock.timers.tick(5000)
  await assert.rejects(pending, { code: "STARTUP_TIMEOUT" })
  f.releasePublication()
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.equal(f.spawnCount(), 0)
})

test("disposal while launch preparation is queued prevents a provider spawn", async t => {
  const f = await syntheticAgentProcess(t, "queued-preparation")
  const pending = f.owner.initialize(new AbortController().signal)
  await f.beforeSpawn.promise
  f.owner.dispose()
  f.releasePublication()
  await assert.rejects(pending)
  assert.equal(f.spawnCount(), 0)
  await assert.rejects(f.record(), { code: "ENOENT" })
  assert.deepEqual(f.signals, [])
})

test("cancellation during attempted publication prevents a provider spawn", async t => {
  const f = await syntheticAgentProcess(t, "publication-paused")
  const controller = new AbortController(), pending = f.owner.initialize(controller.signal)
  await f.beforeSpawn.promise
  controller.abort()
  f.releasePublication()
  await assert.rejects(pending)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.equal(f.spawnCount(), 0)
})

test("ready provider prompt and cleanup use fresh budgets after startup", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  t.mock.timers.tick(45001)
  assert.deepEqual(await f.owner.prompt("after startup", new AbortController().signal), { stopReason: "end_turn", text: "after startup" })
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.deepEqual(f.signals, ["SIGTERM"])
})

test("changed process generation does not acquire signal authority", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  f.replaceIdentity()
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.deepEqual(f.signals, [])
})

test("stderr boundary preserves the existing threshold and bounded byte-exact failure diagnostic", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  const first = Buffer.alloc(8192, 255), last = Buffer.from([0])
  f.emitStderr(first)
  assert.deepEqual(await f.owner.prompt("still ready", new AbortController().signal), { stopReason: "end_turn", text: "still ready" })
  assert.deepEqual(f.signals, [])
  f.emitStderr(last)
  const failure = await f.owner.fault
  assert.deepEqual(failure, { code: "STARTUP_FAILED", message: "startup failed", diagnostic: { boundary: "provider_process", event: "stderr_limit", causeCode: null, exitCode: null, signal: null, stderrBytes: 8193, stderrTailBase64: Buffer.concat([first, last]).subarray(-2048).toString("base64") } })
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.deepEqual(f.signals, ["SIGTERM"])
  assert.deepEqual(await f.owner.fault, failure)
})

test("stderr boundary bounds one huge binary chunk before diagnostic capture", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  const bytes = Buffer.alloc(200000, 255)
  f.emitStderr(bytes)
  const diagnostic = (await f.owner.fault as any).diagnostic
  assert.equal(diagnostic.stderrBytes, bytes.length)
  assert.equal(diagnostic.stderrTailBase64, bytes.subarray(-2048).toString("base64"))
  assert.ok(diagnostic.stderrTailBase64.length <= 2732)
  await f.owner.cleanup()
})

for (const event of ["exit", "close"] as const) test("process failure provenance retains " + event + " metadata before cleanup events", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  f.emitStderr(Buffer.from("warning\n"))
  f.emitProcess(event, 13, "SIGABRT")
  const failure = await f.owner.fault
  if (event === "close") f.emitProcess("exit", 99, "SIGKILL")
  else f.emitProcess("close", 99, "SIGKILL")
  assert.deepEqual((failure as any).diagnostic, { boundary: "provider_process", event, causeCode: null, exitCode: 13, signal: "SIGABRT", stderrBytes: 8, stderrTailBase64: Buffer.from("warning\n").toString("base64") })
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.deepEqual(await f.owner.fault, failure)
})

for (const event of ["error", "stdin_error", "stdout_error", "stderr_error"] as const) test("process failure provenance retains " + event + " machine code without raw messages", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  f.emitError(event, Object.assign(new Error("private error message"), { code: "EPIPE" }))
  const failure = await f.owner.fault
  assert.equal((failure as any).diagnostic.event, event); assert.equal((failure as any).diagnostic.causeCode, "EPIPE")
  assert.equal(JSON.stringify(failure).includes("private error message"), false)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})

for (const code of ["private code with spaces", "x".repeat(129), 1, undefined]) test("process failure provenance discards unsafe runtime code " + String(code).slice(0, 30), async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  f.emitError("stderr_error", Object.assign(new Error("private error"), { code }))
  assert.equal((await f.owner.fault as any).diagnostic.causeCode, null)
  await f.owner.cleanup()
})

test("initialization diagnostic rejection preserves the first observer fault over a later check error", async t => {
  const f = await syntheticAgentProcess(t, "identity-publication-paused"), pending = f.owner.initialize(new AbortController().signal)
  void pending.catch(() => undefined)
  await f.beforeSpawn.promise
  f.emitError("stdout_error", Object.assign(new Error("private initial error"), { code: "EIO" }))
  const first = await f.owner.fault
  assert.equal((first as any).diagnostic.event, "stdout_error")
  f.releasePublication()
  await assert.rejects(pending, error => { assert.deepEqual(agentFailure(error), first); return true })
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})

test("initialization diagnostic labels a synchronous spawn failure without raw exception content", async t => {
  const f = await syntheticAgentProcess(t, "spawn-throws")
  await assert.rejects(f.owner.initialize(new AbortController().signal), error => {
    assert.deepEqual((agentFailure(error) as any).diagnostic, { boundary: "provider_initialize", causeCode: null }); return true
  })
  assert.equal(JSON.stringify(await f.owner.fault).includes("spawn invocation failed"), false)
})

test("ACP transport diagnostic retains its protocol failure boundary", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  f.eof()
  assert.deepEqual((await f.owner.fault as any).diagnostic, { boundary: "acp_transport", causeCode: "STARTUP_FAILED" })
  await f.owner.cleanup()
})