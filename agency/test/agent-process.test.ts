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

test("thrown spawn retains exact launch attribution with unresolved cleanup", async t => {
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
  const readProcess = f.context.adapter.readProcess
  let reads = 0
  f.context.adapter.readProcess = async pid => {
    if (++reads === 1) throw new DarwinObservationUnavailable("transient fixture observation")
    return readProcess(pid)
  }
  assert.equal((await f.owner.initialize(new AbortController().signal)).sessionId, "fixture-session")
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})

test("startup captures the leader without group observation", async t => {
  const f = await syntheticAgentProcess(t, "normal"), readGroup = f.context.adapter.readGroup
  f.context.adapter.readGroup = async () => { throw new Error("group observation before stop") }
  assert.equal((await f.owner.initialize(new AbortController().signal)).sessionId, "fixture-session")
  assert.equal(f.owner.record().provider!.group.observed.length, 1)
  f.context.adapter.readGroup = readGroup
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

test("stderr output beyond the former lifetime threshold leaves prompts ready and retains later exit diagnostics", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  const first = Buffer.alloc(8192, 255), last = Buffer.from([0])
  f.emitStderr(first); f.emitStderr(last)
  for (let i = 0; i < 32; i++) f.emitStderr(Buffer.from("warning\n"))
  assert.deepEqual(await f.owner.prompt("still ready", new AbortController().signal), { stopReason: "end_turn", text: "still ready" })
  assert.deepEqual(f.signals, [])
  f.emitProcess("exit", 13, "SIGABRT")
  const failure = await f.owner.fault
  const all = Buffer.concat([first, last, Buffer.from("warning\n".repeat(32))])
  assert.deepEqual(failure, { code: "STARTUP_FAILED", message: "startup failed", diagnostic: { boundary: "provider_process", event: "exit", causeCode: null, exitCode: 13, signal: "SIGABRT", stderrBytes: 8449, stderrTailBase64: all.subarray(-2048).toString("base64") } })
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.deepEqual(await f.owner.fault, failure)
})

test("stderr output drains a huge binary chunk with only a bounded tail on a later stream error", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  const bytes = Buffer.alloc(2097152, 255), last = Buffer.from([0, 128, 254])
  f.emitStderr(bytes); f.emitStderr(last)
  assert.deepEqual(await f.owner.prompt("still ready", new AbortController().signal), { stopReason: "end_turn", text: "still ready" })
  assert.deepEqual(f.signals, [])
  f.emitError("stderr_error", Object.assign(new Error("private error"), { code: "EIO" }))
  const diagnostic = (await f.owner.fault as any).diagnostic
  assert.equal(diagnostic.event, "stderr_error"); assert.equal(diagnostic.causeCode, "EIO")
  assert.equal(diagnostic.stderrBytes, 2097155)
  assert.equal(diagnostic.stderrTailBase64, Buffer.concat([bytes.subarray(-2045), last]).toString("base64"))
  assert.ok(diagnostic.stderrTailBase64.length <= 2732)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})

test("stderr output during startup does not abort provider initialization", async t => {
  const f = await syntheticAgentProcess(t, "identity-publication-paused"), pending = f.owner.initialize(new AbortController().signal)
  void pending.catch(() => undefined)
  await f.beforeSpawn.promise
  f.emitStderr(Buffer.alloc(131072, 255))
  f.releasePublication()
  assert.equal((await pending).sessionId, "fixture-session")
  assert.deepEqual(await f.owner.prompt("after startup", new AbortController().signal), { stopReason: "end_turn", text: "after startup" })
  assert.deepEqual(f.signals, [])
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
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
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
})

test("ACP transport diagnostic retains its protocol failure boundary", async t => {
  const f = await syntheticAgentProcess(t, "normal")
  await f.owner.initialize(new AbortController().signal)
  f.eof()
  assert.deepEqual((await f.owner.fault as any).diagnostic, { boundary: "acp_transport", causeCode: "STARTUP_FAILED" })
  await f.owner.cleanup()
})

test("an error without exit cannot become verified cleanup", async t => {
  const f = await syntheticAgentProcess(t, "error-without-exit")
  await f.owner.initialize(new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  f.emitError("error", new Error("IPC failure"))
  const pending = f.owner.cleanup(), rejected = assert.rejects(pending, { code: "CLEANUP_UNVERIFIED" })
  await f.terminated
  t.mock.timers.tick(5001)
  await rejected
})

test("a terminal leader with a surviving descendant remains unresolved without signals", async t => {
  const f = await syntheticAgentProcess(t, "leader-exit-descendant-live")
  await f.owner.initialize(new AbortController().signal)
  f.emitProcess("exit", 0, null); f.emitProcess("close", 0, null)
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.deepEqual(f.signals, [])
})

test("visible cleanup publication failure needs a durability-only retry", async t => {
  const f = await syntheticAgentProcess(t, "cleanup-publication-after-write")
  await f.owner.initialize(new AbortController().signal)
  await assert.rejects(f.owner.cleanup(), { code: "CLEANUP_UNVERIFIED" })
  assert.equal(f.owner.record().phase, "cleanup_verified")
  assert.equal(f.owner.record().launchAttemptId, f.spec.launchAttemptId)
  const signals = [...f.signals]
  f.failCleanupPublication(false)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
  assert.deepEqual(f.signals, signals)
})

for (const scenario of ["cleanup-boot-hang", "absence-hang", "absence-paused"]) test(scenario + " has a bounded cleanup and no late stages", async t => {
  const f = await syntheticAgentProcess(t, scenario)
  await f.owner.initialize(new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  const pending = f.owner.cleanup(), rejected = assert.rejects(pending, { code: "CLEANUP_UNVERIFIED" })
  await (scenario === "cleanup-boot-hang" ? f.cleanupObservation : f.absentEntered)
  t.mock.timers.tick(8001)
  await rejected
  f.releaseAbsence()
  for (let n = 0; n < 8; n++) await Promise.resolve()
  assert.equal(f.lateAbsenceReads(), 0)
})

test("held transport close is discharged by destroying pipes", async t => {
  const f = await syntheticAgentProcess(t, "close-held")
  await f.owner.initialize(new AbortController().signal)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  const pending = f.owner.cleanup()
  await f.terminated
  for (let n = 0; n < 16; n++) await Promise.resolve()
  t.mock.timers.tick(1000)
  assert.equal((await pending).phase, "cleanup_verified")
  assert.equal(f.pipesDestroyed(), true)
})

test("cancellation after capture prevents readiness and still cleans the registered child", async t => {
  const f = await syntheticAgentProcess(t, "identity-publication-paused"), controller = new AbortController()
  const pending = f.owner.initialize(controller.signal)
  await f.beforeSpawn.promise
  controller.abort(); f.releasePublication()
  await assert.rejects(pending)
  assert.equal((await f.owner.cleanup()).phase, "cleanup_verified")
})