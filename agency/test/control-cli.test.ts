import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { chmod, copyFile, mkdir, symlink, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import test from "node:test"
import { runControl, type ControlDependencies } from "../src/cli/control.js"
import { ControlError, type ControlReply, type ControlRequest } from "../src/control/protocol.js"
import type { HandlerInspection, ProcessIdentity } from "../src/platform/types.js"
import type { ShutdownReceipt } from "../src/handler/receipt.js"
import { privateRoot, unavailableControlDependencies } from "./control-support.js"
import { DarwinObservationUnavailable } from "../src/platform/darwin.js"
import { LinuxObservationUnavailable } from "../src/platform/linux.js"

function model() {
  const generation = randomUUID(), attempt = randomUUID(), hostId = "a".repeat(64)
  const identity: ProcessIdentity = { bootId: "boot-a", pid: 101, birth: `1:agy-handler:${attempt}`, parentPid: 1, processGroupId: 101, sessionId: 101, uid: process.getuid!(), gid: process.getgid!() }
  const inspection: HandlerInspection = { disposition: "live", record: { version: 1, hostId, generation, launchBootId: "boot-a", launchAttemptId: attempt, launchAttempted: true, phase: "ready", process: identity, socketPath: "/test/handler.sock", writer: "handler", reconciliation: { classified: 0, total: 0, quarantined: 0 }, reason: null } }
  const state = { inspection: inspection as HandlerInspection | null, receipt: null as ShutdownReceipt | null, observed: identity as ProcessIdentity | null, boot: "boot-a", calls: [] as ControlRequest[], starts: 0, now: 0, out: [] as string[], err: [] as string[] }
  const status = (request: ControlRequest): ControlReply => ({ protocol: "agency-control/1", requestId: request.requestId, handlerGeneration: generation, ok: true, result: { hostId, handlerGeneration: generation, phase: "ready", reconciliation: { classified: 0, total: 0, quarantined: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] } })
  const deps: ControlDependencies = {
    ...unavailableControlDependencies(),
    environment: async () => ({ paths: { hostKey: hostId, runtimeRoot: "/test", persistentRoot: "/state", handlerSocketPath: "/test/handler.sock" }, adapter: { platform: "darwin", bootId: async () => state.boot, readProcess: async () => state.observed, readGroup: async () => { throw new Error("unexpected group read") }, signalGroup: async () => { throw new Error("unauthorized CLI signal") } } }),
    start: async () => { state.starts++; return inspection },
    inspect: async () => state.inspection,
    receipt: async () => state.receipt,
    inventory: async () => [],
    call: async (_env, request) => {
      state.calls.push(request)
      if (request.op === "status") return status(request)
      state.receipt = { version: 1, commandId: request.commandId, hostId, handlerGeneration: generation, handlerIdentity: identity, state: "accepted", stopAgents: request.stopAgents }
      state.observed = null
      return { protocol: request.protocol, requestId: request.requestId, handlerGeneration: generation, ok: true, result: { state: "shutdown_accepted", commandId: request.commandId, handlerGeneration: generation } }
    },
    now: () => state.now,
    sleep: async ms => { state.now += ms },
    stdout: text => state.out.push(text), stderr: text => state.err.push(text),
  }
  return { state, deps, generation, identity, status, output: () => JSON.parse(state.out.join("")) }
}

test("invalid and unsupported commands fail before environment resolution with one JSON envelope", async () => {
  for (const args of [["agent", "start"], ["status", "--stop-agents"], ["shutdown", "--command-id", randomUUID()], ["shutdown", "--handler-generation", randomUUID()], ["doctor", "--json", "--json"], ["status", "unexpected"]]) {
    const m = model(); let touched = false
    m.deps.environment = async () => { touched = true; throw new Error("unexpected environment resolution") }
    assert.equal(await runControl([...args, ...(args.includes("--json") ? [] : ["--json"])], m.deps), 64)
    assert.equal(touched, false)
    assert.equal(m.output().ok, false)
    assert.equal(m.state.out.length, 1)
  }
})

test("status aliases start one Handler and validate the wire response", async () => {
  for (const args of [["status"], ["handler", "status"]]) {
    const m = model()
    assert.equal(await runControl([...args, "--json"], m.deps), 0)
    assert.equal(m.state.starts, 1)
    assert.equal(m.output().result.handlerGeneration, m.generation)
  }
  for (const fault of ["generation", "request", "non-json"]) {
    const m = model()
    m.deps.call = async (_env, request) => fault === "non-json" ? "diagnostic noise" as unknown as ControlReply : { ...m.status(request), ...(fault === "generation" ? { handlerGeneration: randomUUID() } : { requestId: randomUUID() }) }
    assert.equal(await runControl(["status", "--json"], m.deps), fault === "generation" ? 69 : 65)
  }
})

test("doctor inspects without starting or calling the daemon", async () => {
  const m = model()
  assert.equal(await runControl(["doctor", "--json"], m.deps), 0)
  assert.equal(m.state.starts, 0)
  assert.deepEqual(m.state.calls, [])
  assert.equal(m.output().result.handler.record.generation, m.generation)
})

test("shutdown success requires a receipt and independent absence, including a lost reply", async () => {
  for (const lost of [false, true]) {
    const m = model(), original = m.deps.call
    m.deps.call = async (env, request) => { const reply = await original(env, request); if (lost) throw new ControlError("INCOMPLETE"); return reply }
    assert.equal(await runControl(["shutdown", "--json"], m.deps), 0)
    assert.equal(m.state.starts, 0)
    assert.equal(m.output().result.state, "shutdown_complete")
    assert.equal(m.output().result.commandId, m.state.receipt!.commandId)
  }
})

test("no receipt retry never selects a replacement generation", async () => {
  const m = model()
  assert.equal(await runControl(["shutdown", "--command-id", randomUUID(), "--handler-generation", randomUUID(), "--json"], m.deps), 69)
  assert.deepEqual(m.state.calls, [])
  assert.equal(m.state.starts, 0)
})

test("receipt retry verifies absence after transport loss during its status probe", async () => {
  const m = model(), commandId = randomUUID()
  m.state.receipt = { version: 1, commandId, hostId: "a".repeat(64), handlerGeneration: m.generation, handlerIdentity: m.identity, state: "accepted", stopAgents: false }
  m.deps.call = async (_env, request) => {
    m.state.calls.push(request)
    m.state.observed = null
    throw new ControlError("UNAVAILABLE", "Handler exited during status")
  }
  assert.equal(await runControl(["shutdown", "--command-id", commandId, "--handler-generation", m.generation, "--json"], m.deps), 0)
  assert.equal(m.output().result.state, "shutdown_complete")
  assert.deepEqual(m.state.calls.map(request => request.op), ["status"])
})

test("shutdown observation failures retain retry identity and report incomplete", async () => {
  for (const Failure of [DarwinObservationUnavailable, LinuxObservationUnavailable]) for (const boundary of ["bootId", "readProcess"] as const) for (const retry of [false, true]) {
    const m = model(), commandId = randomUUID(), environment = m.deps.environment
    if (retry) m.state.receipt = { version: 1, commandId, hostId: "a".repeat(64), handlerGeneration: m.generation, handlerIdentity: m.identity, state: "accepted", stopAgents: false }
    m.deps.environment = async () => { const env = await environment(); env.adapter[boundary] = async () => { throw new Failure("observation unavailable") }; return env }
    const args = retry ? ["shutdown", "--command-id", commandId, "--handler-generation", m.generation, "--json"] : ["shutdown", "--json"]
    assert.equal(await runControl(args, m.deps), 75)
    assert.equal(m.output().error.code, "INCOMPLETE")
    assert.equal(m.output().handlerGeneration, m.generation)
    assert.equal(m.output().commandId, m.state.receipt!.commandId)
    assert.deepEqual(m.state.calls.map(request => request.op), retry ? [] : ["shutdown"])
  }
})

test("status classifies expected singleton failures without hiding internal defects", async () => {
  for (const [failure, expected] of [
    [new Error("Handler status timed out"), 75],
    [new Error("Handler generation is unavailable before readiness"), 75],
    [new Error("Handler socket readiness timed out"), 75],
    [new Error("Handler gate delivery timed out"), 75],
    [new Error("startup lock is unavailable"), 75],
    [new Error('Handler identity is ambiguous; startup is unavailable: {}'), 75],
    [new Error('Handler identity became ambiguous; startup is unavailable: {}'), 75],
    [new Error("Handler generation disappeared"), 69],
    [new Error("Handler status peer closed"), 69],
    [new Error("Handler exited before acknowledgement: 1"), 69],
    [Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), 69],
    [new DarwinObservationUnavailable("ps unavailable"), 75],
    [new LinuxObservationUnavailable("procfs unavailable"), 75],
    [new Error("unexpected invariant failure"), 70],
  ] as const) {
    const m = model()
    m.deps.start = async () => { throw failure }
    assert.equal(await runControl(["status", "--json"], m.deps), expected, failure.message)
    assert.deepEqual(m.state.calls, [])
  }
})

test("receipt retry discharges old generations without stopping their replacements", async () => {
  for (const kind of ["absent", "birth replacement", "boot transition", "marker changed"]) {
    const m = model(), commandId = randomUUID()
    m.state.receipt = { version: 1, commandId, hostId: "a".repeat(64), handlerGeneration: m.generation, handlerIdentity: m.identity, state: "accepted", stopAgents: false }
    m.state.inspection = { ...m.state.inspection!, record: { ...m.state.inspection!.record, generation: randomUUID() } }
    if (kind === "absent") m.state.observed = null
    if (kind === "birth replacement") m.state.observed = { ...m.identity, birth: "2:replacement" }
    if (kind === "boot transition") m.state.boot = "boot-b"
    if (kind === "marker changed") m.state.observed = { ...m.identity, birth: "1:other" }
    assert.equal(await runControl(["shutdown", "--command-id", commandId, "--handler-generation", m.generation, "--json"], m.deps), kind === "marker changed" ? 75 : 0)
    assert.deepEqual(m.state.calls, [])
  }
})

test("uncertain shutdown returns retry identity and never retries the mutation automatically", async () => {
  const m = model()
  m.deps.call = async (_env, request) => { m.state.calls.push(request); throw new ControlError("INCOMPLETE") }
  assert.equal(await runControl(["shutdown", "--json"], m.deps), 75)
  assert.equal(m.state.calls.length, 1)
  assert.equal(m.output().handlerGeneration, m.generation)
  assert.match(m.output().commandId, /^[0-9a-f-]{36}$/)
})

test("CLI errors map exits and bound diagnostics", async () => {
  for (const [code, expected] of [["UNAVAILABLE", 69], ["INTERNAL", 70], ["INCOMPLETE", 75]] as const) {
    const m = model()
    m.deps.environment = async () => { throw new ControlError(code, "x".repeat(10000)) }
    assert.equal(await runControl(["status", "--json"], m.deps), expected)
    assert.ok(Buffer.byteLength(m.state.err.join("")) <= 8192)
  }
})

test("wrapper follows deployed relative symlinks, preserves arguments and ignores cwd", async t => {
  const root = await privateRoot(t), repo = join(root, "repo with spaces"), user = join(root, "user")
  await mkdir(join(repo, "home/bin"), { recursive: true })
  await mkdir(join(repo, "agency/dist/src"), { recursive: true })
  await mkdir(join(user, ".nodenv/versions/24.13.0/bin"), { recursive: true })
  await symlink(process.execPath, join(user, ".nodenv/versions/24.13.0/bin/node"))
  const wrapper = join(repo, "home/bin/agy")
  await copyFile(fileURLToPath(new URL("../../../home/bin/agy", import.meta.url)), wrapper)
  await chmod(wrapper, 0o755)
  await writeFile(join(repo, "agency/dist/src/main.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))")
  await symlink("repo with spaces/home/bin/agy", join(root, "agy"))
  const result = await promisify(execFile)(join(root, "agy"), ["status", "argument with spaces"], { cwd: "/", env: { ...process.env, HOME: user } })
  assert.deepEqual(JSON.parse(result.stdout), ["status", "argument with spaces"])
  await assert.rejects(promisify(execFile)(join(root, "agy"), ["status"], { env: { ...process.env, HOME: root } }), (error: unknown) => (error as { code: number }).code === 69)
})

test("wrapper reports a missing build without creating it", async t => {
  const root = await privateRoot(t)
  await mkdir(join(root, "home/bin"), { recursive: true })
  const wrapper = join(root, "home/bin/agy")
  await copyFile(fileURLToPath(new URL("../../../home/bin/agy", import.meta.url)), wrapper)
  await chmod(wrapper, 0o755)
  await assert.rejects(promisify(execFile)(wrapper, ["status"], { env: { ...process.env } }), (error: unknown) => (error as { code: number; stderr: string }).code === 69 && /build/.test((error as { stderr: string }).stderr))
})