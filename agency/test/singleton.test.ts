import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { fstatSync, readdirSync } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { createConnection, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Duplex } from "node:stream"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { bindPrivateSocket } from "../src/platform/private-socket.js"
import { readHandlerRecord, readLaunchRecord, writeHandlerRecord, writeLaunchRecord } from "../src/platform/private-state.js"
import {
  assertStartupLockMetadata,
  inspectHandlerGeneration,
  startOrConnect,
  startupLockCommand,
  type StartTransition,
} from "../src/platform/singleton.js"
import { RUNTIME_RECORD_VERSION, sameProcess, type HandlerGenerationRecord, type LaunchRecord, type PlatformAdapter, type ProcessIdentity } from "../src/platform/types.js"

const fixturePath = fileURLToPath(new URL("./fixtures/singleton-handler.js", import.meta.url))
const bootId = "task-3-boot"
const hostId = "task-3-host"

type FixtureConfig = {
  root: string
  bootId: string
  hostId: string
  handlerLog: string
  eventLog?: string
  resultPath?: string
  releasePath?: string
  launcherPauseAt?: StartTransition
  handlerPauseAt?: "before_socket_bind" | "after_socket_bind_before_publication" | "after_first_reconciliation" | "before_ready_ack"
  retainedDirectory: string
  fakeGroups?: FakeGroup[]
  signalLog?: string
  identityDelayMs?: number
  readyDelayMs?: number
  readyRecordMutation?: "socket_path" | "launch_attempt_id" | "host_id" | "process_identity"
  readySocketPath?: string
  combinedReadyFrames?: boolean
  response?: string
  timeoutMs?: number
  lockTimeoutSeconds?: number
}

type FakeGroup = {
  processGroupId: number
  currentLeader: ProcessIdentity | null
  members: ProcessIdentity[]
  termOutcome: "empty" | "survive"
}

function identity(pid: number, parentPid = 1): ProcessIdentity {
  return {
    bootId,
    pid,
    birth: `fixture-${pid}`,
    parentPid,
    processGroupId: pid,
    sessionId: pid,
    uid: process.getuid!(),
    gid: process.getgid!(),
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

class FakeAdapter implements PlatformAdapter {
  readonly platform = process.platform === "darwin" ? "darwin" : "linux"
  readonly ambiguous = new Set<number>()

  async bootId(): Promise<string> {
    return bootId
  }

  async readProcess(pid: number): Promise<ProcessIdentity | null> {
    if (!processExists(pid)) return null
    const observed = identity(pid)
    return this.ambiguous.has(pid) ? { ...observed, birth: `ambiguous-${pid}` } : observed
  }

  async readGroup(): Promise<ProcessIdentity[]> {
    return []
  }

  async signalGroup(): Promise<void> {
    throw new Error("the singleton fake adapter never signals groups")
  }
}

async function fixtureRoot(t: TestContext): Promise<string> {
  void t
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, "agency-singleton-"))
  await chmod(root, 0o700)
  return root
}

async function writeConfig(root: string, changes: Partial<FixtureConfig> = {}): Promise<{ config: FixtureConfig; path: string }> {
  const retainedDirectory = changes.retainedDirectory ?? join(root, `retained-${crypto.randomUUID()}`)
  try {
    await mkdir(retainedDirectory, { mode: 0o700 })
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error
  }
  const config: FixtureConfig = {
    root,
    bootId,
    hostId,
    handlerLog: join(root, "handlers.jsonl"),
    retainedDirectory,
    ...changes,
  }
  const path = join(root, `fixture-${crypto.randomUUID()}.json`)
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  return { config, path }
}

function providerIdentity(pid: number, birth = `fixture-provider-${pid}`): ProcessIdentity {
  return {
    bootId,
    pid,
    birth,
    parentPid: 1,
    processGroupId: pid,
    sessionId: pid,
    uid: process.getuid!(),
    gid: process.getgid!(),
  }
}

function providerRecord(checkoutId: string, leader: ProcessIdentity): LaunchRecord {
  return launchRecord({
    checkoutId,
    launchAttempted: true,
    phase: "active",
    provider: {
      kind: "process-group",
      group: { leader, observed: [leader] },
    },
  })
}

function handlerCommand(configPath: string): { file: string; args: string[] } {
  return { file: process.execPath, args: [fixturePath, "handler", configPath] }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, message: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

async function handlerIdentities(path: string): Promise<ProcessIdentity[]> {
  return (await lines(path)).map(line => JSON.parse(line) as ProcessIdentity)
}

async function stopIdentity(expected: ProcessIdentity, adapter: FakeAdapter): Promise<void> {
  const observed = await adapter.readProcess(expected.pid)
  if (observed === null || !sameProcess(expected, observed)) return
  process.kill(expected.pid, "SIGKILL")
  await waitFor(async () => await adapter.readProcess(expected.pid) === null, `Handler ${expected.pid} survived cleanup`)
}

async function cleanupHandlers(root: string, handlerLog: string, adapter: FakeAdapter): Promise<void> {
  const receipts: ProcessIdentity[] = []
  for (const expected of await handlerIdentities(handlerLog)) {
    await stopIdentity(expected, adapter)
    assert.equal(await adapter.readProcess(expected.pid), null)
    receipts.push(expected)
  }
  const receiptPath = join(root, "fixture-cleanup.json")
  await writeFile(receiptPath, JSON.stringify(receipts), { mode: 0o600 })
  assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), receipts)
  await rm(root, { recursive: true, force: true })
}

async function exchange(path: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let response = ""
    socket.setEncoding("utf8")
    socket.once("connect", () => socket.write(request))
    socket.on("data", chunk => response += chunk)
    socket.once("end", () => resolve(response))
    socket.once("error", reject)
  })
}

async function waitChild(child: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  if (child.signalCode !== null) return null
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child ${child.pid ?? "unknown"} did not exit`)), timeoutMs)
    child.once("exit", code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

function spawnContender(configPath: string): ChildProcess {
  return spawn(process.execPath, [fixturePath, "contender", configPath], { stdio: ["ignore", "ignore", "pipe"] })
}

async function waitEvent(path: string, event: string): Promise<void> {
  await waitFor(async () => (await lines(path)).includes(event), `event ${event} was not observed`)
}

function launchRecord(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: RUNTIME_RECORD_VERSION,
    checkoutId: "checkout",
    leaseId: "lease",
    agentId: "agent",
    handlerGeneration: "previous",
    launchAttemptId: crypto.randomUUID(),
    launchBootId: bootId,
    launchAttempted: false,
    phase: "launch_pending",
    provider: null,
    reason: null,
    ...overrides,
  }
}

function handlerRecord(root: string, processIdentity: ProcessIdentity, overrides: Partial<HandlerGenerationRecord> = {}): HandlerGenerationRecord {
  return {
    version: RUNTIME_RECORD_VERSION,
    hostId,
    launchBootId: bootId,
    generation: "generation",
    launchAttemptId: "attempt",
    launchAttempted: true,
    phase: "ready",
    process: processIdentity,
    socketPath: join(root, "handler.sock"),
    writer: "handler",
    reconciliation: { classified: 0, total: 0, quarantined: 0 },
    reason: null,
    ...overrides,
  }
}

test("constructs exact lock helper argument vectors", () => {
  const argv = ["/path with spaces/node", "$(touch /tmp/not-run)", "semi;colon"]
  assert.deepEqual(startupLockCommand("darwin", 3, argv), {
    file: "/usr/bin/lockf",
    args: ["-s", "-t", "10", "/dev/fd/3", ...argv],
  })
  assert.deepEqual(startupLockCommand("linux", 3, argv), {
    file: "/usr/bin/flock",
    args: ["--no-fork", "-w", "10", "/proc/self/fd/3", ...argv],
  })
  assert.throws(() => startupLockCommand("darwin", 4, argv), /fd 3/i)
})

test("rejects socket escape and symlink paths", async t => {
  const root = await fixtureRoot(t)
  const outside = join(await realpath(tmpdir()), `agency-outside-${crypto.randomUUID()}.sock`)
  await assert.rejects(bindPrivateSocket(root, outside), /name|absolute|separator|root/i)
  await assert.rejects(bindPrivateSocket(root, "../outside.sock"), /name|separator|root/i)
  await assert.rejects(bindPrivateSocket(root, "x".repeat(120)), /length|bound/i)
  const target = join(root, "target")
  await writeFile(target, "target", { mode: 0o600 })
  await symlink(target, join(root, "handler.sock"))
  await assert.rejects(bindPrivateSocket(root, "handler.sock"), /symlink|exists/i)
  await unlink(join(root, "handler.sock"))
  const link = `${root}-link`
  await symlink(root, link)
  t.after(async () => rm(link, { force: true }))
  t.after(async () => rm(root, { recursive: true, force: true }))
  await assert.rejects(bindPrivateSocket(link, "handler.sock"), /symlink|canonical/i)
})

test("validates unsafe lock metadata before starting a helper", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const { config, path } = await writeConfig(root)
  t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
  const lockPath = join(root, "startup.lock")
  const unsafe = async (prepare: () => Promise<void>, pattern: RegExp): Promise<void> => {
    await rm(lockPath, { recursive: true, force: true })
    await prepare()
    await assert.rejects(startOrConnect({ root, hostId, adapter, handler: handlerCommand(path), timeoutMs: 500 }), pattern)
    assert.deepEqual(await lines(config.handlerLog), [])
  }
  await unsafe(async () => symlink(join(root, "missing"), lockPath), /symlink|nofollow|loop/i)
  await unsafe(async () => { await (await import("node:fs/promises")).mkdir(lockPath) }, /regular|file|directory/i)
  await unsafe(async () => {
    await writeFile(lockPath, "", { mode: 0o600 })
    await chmod(lockPath, 0o622)
  }, /private|writable|permission/i)
  await unsafe(async () => {
    await writeFile(lockPath, "", { mode: 0o600 })
    await chmod(lockPath, 0o640)
  }, /private|permission/i)
  assert.throws(() => assertStartupLockMetadata({ isFile: () => true, uid: process.getuid!() + 1, mode: 0o100600 }, process.getuid!()), /owner/i)
})

test("read-only inspection preserves live and ambiguous sockets", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const server = await bindPrivateSocket(root, "handler.sock")
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const current = identity(process.pid, process.ppid)
  await writeHandlerRecord(join(root, "handler.json"), handlerRecord(root, current))
  const live = await inspectHandlerGeneration(root, adapter)
  assert.equal(live?.disposition, "live")
  assert.equal(await pathExists(join(root, "handler.sock")), true)
  adapter.ambiguous.add(process.pid)
  const ambiguous = await inspectHandlerGeneration(root, adapter)
  assert.equal(ambiguous?.disposition, "ambiguous")
  assert.equal(await pathExists(join(root, "handler.sock")), true)
  assert.equal((await lstat(join(root, "handler.sock"))).isSymbolicLink(), false)
})

test("selects one generation across 32 contenders and reconciles all records before readiness", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const cleanLeader = providerIdentity(7101)
  const ambiguousLeader = providerIdentity(7201)
  const currentAmbiguousLeader = { ...ambiguousLeader, birth: "replacement-7201" }
  const signalLog = join(root, "signals.jsonl")
  const { config, path } = await writeConfig(root, {
    response: "pong",
    signalLog,
    fakeGroups: [
      { processGroupId: cleanLeader.processGroupId, currentLeader: cleanLeader, members: [cleanLeader], termOutcome: "empty" },
      { processGroupId: ambiguousLeader.processGroupId, currentLeader: currentAmbiguousLeader, members: [currentAmbiguousLeader], termOutcome: "survive" },
    ],
  })
  const releasedPath = join(config.retainedDirectory, "released.json")
  const quarantinedPath = join(config.retainedDirectory, "quarantined.json")
  await writeLaunchRecord(releasedPath, providerRecord("released", cleanLeader))
  await writeLaunchRecord(quarantinedPath, providerRecord("quarantined", ambiguousLeader))
  t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
  const results = await Promise.all(Array.from({ length: 32 }, () => startOrConnect({
    root,
    hostId,
    adapter,
    handler: handlerCommand(path),
    timeoutMs: 5000,
  })))
  assert.equal(new Set(results.map(result => result.record.generation)).size, 1)
  assert.ok(results.every(result => result.disposition === "live" && result.record.phase === "ready"))
  const handlers = await handlerIdentities(config.handlerLog)
  assert.equal(handlers.length, 1)
  assert.equal(new Set(handlers.map(handler => handler.pid)).size, 1)
  const ready = await readHandlerRecord(join(root, "handler.json"))
  assert.deepEqual(ready.reconciliation, { classified: 2, total: 2, quarantined: 1 })
  assert.equal((await readLaunchRecord(releasedPath)).phase, "cleanup_verified")
  assert.equal((await readLaunchRecord(quarantinedPath)).phase, "quarantined")
  assert.deepEqual((await lines(signalLog)).map(line => JSON.parse(line)), [{ processGroupId: 7101, signal: "SIGTERM" }])
  assert.equal((await lstat(root)).mode & 0o777, 0o700)
  const socketStats = await lstat(join(root, "handler.sock"))
  assert.equal(socketStats.isSocket(), true)
  assert.equal(socketStats.isSymbolicLink(), false)
  assert.equal(socketStats.mode & 0o777, 0o600)
  assert.equal(await exchange(join(root, "handler.sock"), "ping"), "pong")
})

test("discovers an unnamed retained record from the qualified inventory", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const { config, path } = await writeConfig(root)
  t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
  const unnamedPath = join(config.retainedDirectory, "not-present-in-config.json")
  await writeLaunchRecord(unnamedPath, launchRecord({ checkoutId: "unnamed" }))
  const result = await startOrConnect({ root, hostId, adapter, handler: handlerCommand(path) })
  assert.deepEqual(result.record.reconciliation, { classified: 1, total: 1, quarantined: 0 })
  assert.equal((await readLaunchRecord(unnamedPath)).phase, "cleanup_verified")
})

test("rejects a changed ready socket path without crossing confinement", async t => {
  const root = await fixtureRoot(t)
  const outsideRoot = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  let outsideConnections = 0
  const outsideServer = await bindPrivateSocket(outsideRoot, "outside.sock", socket => {
    outsideConnections += 1
    socket.end("outside")
  })
  const outsideSocket = join(outsideRoot, "outside.sock")
  const { config, path } = await writeConfig(root, { readyRecordMutation: "socket_path", readySocketPath: outsideSocket })
  t.after(async () => {
    await cleanupHandlers(root, config.handlerLog, adapter)
    await new Promise<void>(resolve => outsideServer.close(() => resolve()))
    await rm(outsideRoot, { recursive: true, force: true })
  })
  await assert.rejects(startOrConnect({ root, hostId, adapter, handler: handlerCommand(path) }), /ready|published|socket/i)
  assert.equal(outsideConnections, 0)
  assert.equal(await pathExists(join(root, "handler.sock")), true)
  assert.equal((await readHandlerRecord(join(root, "handler.json"))).socketPath, outsideSocket)
})

test("rejects changed ready launch identity fields", async t => {
  for (const mutation of ["launch_attempt_id", "host_id", "process_identity"] as const) {
    await t.test(mutation, async t => {
      const root = await fixtureRoot(t)
      const adapter = new FakeAdapter()
      const { config, path } = await writeConfig(root, { readyRecordMutation: mutation })
      t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
      await assert.rejects(startOrConnect({ root, hostId, adapter, handler: handlerCommand(path) }), /ready|published|identity/i)
      assert.equal(await pathExists(join(root, "handler.sock")), true)
      assert.equal((await readHandlerRecord(join(root, "handler.json"))).socketPath, join(root, "handler.sock"))
    })
  }
})

test("rejects a dead or reused Handler after ready acknowledgement", async t => {
  for (const disposition of ["dead", "reused"] as const) {
    await t.test(disposition, async t => {
      const root = await fixtureRoot(t)
      const adapter = new FakeAdapter()
      const { config, path } = await writeConfig(root)
      let handler: ProcessIdentity | undefined
      t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
      try {
        await assert.rejects(startOrConnect({
          root,
          hostId,
          adapter,
          handler: handlerCommand(path),
          onTransition: async transition => {
            if (transition !== "ready_acknowledged") return
            const handlers = await handlerIdentities(config.handlerLog)
            assert.equal(handlers.length, 1)
            handler = handlers[0]
            if (disposition === "dead") await stopIdentity(handler!, adapter)
            else adapter.ambiguous.add(handler!.pid)
          },
        }), /identity|live/i)
      } finally {
        if (handler !== undefined) adapter.ambiguous.delete(handler.pid)
      }
      assert.equal(await pathExists(join(root, "handler.sock")), true)
      assert.equal((await readHandlerRecord(join(root, "handler.json"))).socketPath, join(root, "handler.sock"))
    })
  }
})

test("consumes coalesced gate and ready status frames in order", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const { config, path } = await writeConfig(root, { combinedReadyFrames: true })
  t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
  const result = await startOrConnect({ root, hostId, adapter, handler: handlerCommand(path), timeoutMs: 1000 })
  assert.equal(result.disposition, "live")
  assert.equal(result.record.phase, "ready")
})

test("rejects symlinked and non-regular retained inventory entries before readiness", async t => {
  for (const kind of ["symlink", "directory"] as const) {
    await t.test(kind, async t => {
      const root = await fixtureRoot(t)
      const adapter = new FakeAdapter()
      const { config, path } = await writeConfig(root)
      t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
      const entry = join(config.retainedDirectory, "unsafe-entry")
      if (kind === "directory") await mkdir(entry, { mode: 0o700 })
      else {
        const target = join(root, "target.json")
        await writeLaunchRecord(target, launchRecord())
        await symlink(target, entry)
      }
      await assert.rejects(startOrConnect({ root, hostId, adapter, handler: handlerCommand(path), timeoutMs: 1000 }), /inventory|regular|symlink|status peer closed|exited before acknowledgement/i)
      assert.notEqual((await readHandlerRecord(join(root, "handler.json"))).phase, "ready")
    })
  }
})

test("replaces one exactly stale generation and never unlinks an ambiguous one", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const { config, path } = await writeConfig(root)
  t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
  const first = await startOrConnect({ root, hostId, adapter, handler: handlerCommand(path) })
  const firstIdentity = first.record.process
  assert.notEqual(firstIdentity, null)
  await stopIdentity(firstIdentity!, adapter)
  assert.equal(await pathExists(join(root, "handler.sock")), true)
  const second = await startOrConnect({ root, hostId, adapter, handler: handlerCommand(path) })
  assert.notEqual(second.record.generation, first.record.generation)
  assert.equal((await handlerIdentities(config.handlerLog)).length, 2)
  const secondIdentity = second.record.process
  assert.notEqual(secondIdentity, null)
  adapter.ambiguous.add(secondIdentity!.pid)
  await assert.rejects(startOrConnect({ root, hostId, adapter, handler: handlerCommand(path), timeoutMs: 500 }), /ambiguous|unavailable/i)
  assert.equal(await pathExists(join(root, "handler.sock")), true)
  assert.equal((await handlerIdentities(config.handlerLog)).length, 2)
  adapter.ambiguous.delete(secondIdentity!.pid)
})

test("times out under contention without starting outside the lock", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const { config, path } = await writeConfig(root)
  t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
  let releaseLock: (() => void) | undefined
  const held = new Promise<void>(resolve => releaseLock = resolve)
  let lockAcquired: (() => void) | undefined
  const acquired = new Promise<void>(resolve => lockAcquired = resolve)
  const owner = startOrConnect({
    root,
    hostId,
    adapter,
    handler: handlerCommand(path),
    onTransition: async transition => {
      if (transition !== "lock_acquired") return
      lockAcquired!()
      await held
    },
  })
  await acquired
  await assert.rejects(startOrConnect({
    root,
    hostId,
    adapter,
    handler: handlerCommand(path),
    lockTimeoutSeconds: 1,
    timeoutMs: 1500,
  }), /unavailable|timeout|lock/i)
  assert.deepEqual(await lines(config.handlerLog), [])
  releaseLock!()
  await owner
  assert.equal((await handlerIdentities(config.handlerLog)).length, 1)
})

test("launcher death before gate release starts no usable Handler", async t => {
  for (const scenario of [
    { transition: "launch_pending_written" as const, attempted: false, expectsHandler: false },
    { transition: "handler_spawned" as const, attempted: true, expectsHandler: true },
    { transition: "identity_published" as const, attempted: true, expectsHandler: true },
  ]) {
    await t.test(scenario.transition, async t => {
      const root = await fixtureRoot(t)
      const adapter = new FakeAdapter()
      const eventLog = join(root, "events.log")
      const releasePath = join(root, "release")
      const resultPath = join(root, "result.json")
      const retainedDirectory = join(root, "retained")
      await mkdir(retainedDirectory, { mode: 0o700 })
      const retainedPath = join(retainedDirectory, "retained.json")
      const retained = launchRecord({ checkoutId: scenario.transition })
      await writeLaunchRecord(retainedPath, retained)
      const { config, path } = await writeConfig(root, {
        eventLog,
        releasePath,
        resultPath,
        launcherPauseAt: scenario.transition,
        retainedDirectory,
      })
      t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
      const launcher = spawnContender(path)
      await waitEvent(eventLog, `launcher:${scenario.transition}`)
      launcher.kill("SIGKILL")
      await waitChild(launcher)
      await waitFor(async () => {
        const identities = await handlerIdentities(config.handlerLog)
        return identities.every(handler => !processExists(handler.pid))
      }, "pre-gate Handler survived launcher death")
      const record = await readHandlerRecord(join(root, "handler.json"))
      assert.equal(record.launchAttempted, scenario.attempted)
      assert.notEqual(record.phase, "ready")
      assert.equal(record.writer, "launcher")
      if (scenario.transition === "identity_published") {
        assert.equal(record.phase, "identity_published")
        assert.notEqual(record.process, null)
      } else {
        assert.equal(record.phase, "launch_pending")
        assert.equal(record.process, null)
      }
      assert.deepEqual(await readLaunchRecord(retainedPath), retained)
      assert.equal(await pathExists(join(root, "handler.sock")), false)
      const handlers = await handlerIdentities(config.handlerLog)
      if (scenario.expectsHandler) assert.ok(handlers.length <= 1)
      else assert.equal(handlers.length, 0)
      if (handlers.length === 1) assert.equal(await adapter.readProcess(handlers[0]!.pid), null)
    })
  }
})

test("a pre-release Handler exits on either gate or status-peer EOF", async t => {
  for (const closedFd of [3, 4] as const) {
    await t.test(`fd ${closedFd}`, async t => {
      const root = await fixtureRoot(t)
      const adapter = new FakeAdapter()
      const { config, path } = await writeConfig(root)
      t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
      const child = spawn(process.execPath, [fixturePath, "handler", path], {
        detached: true,
        env: {
          ...process.env,
          AGENCY_HANDLER_RECORD: join(root, "handler.json"),
          AGENCY_HANDLER_GENERATION: "never-released",
        },
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      })
      await waitFor(async () => (await handlerIdentities(config.handlerLog)).length === 1, "Handler did not claim identity")
      const status = child.stdio[3] as Duplex
      const gate = child.stdio[4] as Duplex
      if (closedFd === 3) status.destroy()
      else gate.destroy()
      assert.equal(await waitChild(child), 0)
      status.destroy()
      gate.destroy()
      assert.equal(await pathExists(join(root, "handler.sock")), false)
    })
  }
})

test("launcher death after gate release does not kill or duplicate the Handler", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const eventLog = join(root, "events.log")
  const releasePath = join(root, "release")
  const { config, path } = await writeConfig(root, { eventLog, releasePath, launcherPauseAt: "gate_released" })
  t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
  const launcher = spawnContender(path)
  await waitEvent(eventLog, "launcher:gate_released")
  const events = await lines(eventLog)
  assert.ok(events.indexOf("handler:gate_released") < events.indexOf("launcher:gate_released"))
  const generation = (await readHandlerRecord(join(root, "handler.json"))).generation
  launcher.kill("SIGKILL")
  await waitChild(launcher)
  const result = await startOrConnect({ root, hostId, adapter, handler: handlerCommand(path), timeoutMs: 5000 })
  assert.equal(result.record.generation, generation)
  assert.equal(result.record.phase, "ready")
  assert.equal((await handlerIdentities(config.handlerLog)).length, 1)
})

test("a post-gate readiness timeout detaches the launcher without duplicating the live Handler", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const eventLog = join(root, "events.log")
  const releasePath = join(root, "release")
  const { config, path } = await writeConfig(root, {
    eventLog,
    releasePath,
    resultPath: join(root, "result.json"),
    handlerPauseAt: "after_socket_bind_before_publication",
    timeoutMs: 250,
  })
  t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
  const launcher = spawnContender(path)
  await waitEvent(eventLog, "handler:after_socket_bind_before_publication")
  assert.notEqual(await waitChild(launcher, 1500), 0)
  const stalled = await readHandlerRecord(join(root, "handler.json"))
  assert.equal(stalled.phase, "identity_published")
  assert.equal(stalled.process === null ? false : processExists(stalled.process.pid), true)
  const later = startOrConnect({ root, hostId, adapter, handler: handlerCommand(path), timeoutMs: 3000 })
  await writeFile(releasePath, "release", { mode: 0o600 })
  const connected = await later
  assert.equal(connected.record.generation, stalled.generation)
  assert.equal((await handlerIdentities(config.handlerLog)).length, 1)
})

test("a missing Handler executable is a controlled classifiable launch failure", async t => {
  const root = await fixtureRoot(t)
  t.after(async () => rm(root, { recursive: true, force: true }))
  const adapter = new FakeAdapter()
  await assert.rejects(startOrConnect({
    root,
    hostId,
    adapter,
    handler: { file: join(root, "missing-handler"), args: [] },
    timeoutMs: 500,
  }), /ENOENT|spawn|executable/i)
  const record = await readHandlerRecord(join(root, "handler.json"))
  assert.equal(record.phase, "launch_pending")
  assert.equal(record.launchAttempted, true)
  assert.equal(record.process, null)
  assert.equal((await inspectHandlerGeneration(root, adapter))?.disposition, "stale")
  assert.equal(await pathExists(join(root, "handler.sock")), false)
})

test("identity and readiness share one launch deadline", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const { config, path } = await writeConfig(root, { identityDelayMs: 350, readyDelayMs: 350 })
  t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
  const started = Date.now()
  await assert.rejects(startOrConnect({ root, hostId, adapter, handler: handlerCommand(path), timeoutMs: 500 }), /timeout|timed out|unavailable/i)
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 450)
  assert.ok(elapsed < 800)
})

test("immediate Handler death after gate release is reported without waiting for the status timeout", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const { config, path } = await writeConfig(root)
  t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
  const started = Date.now()
  await assert.rejects(startOrConnect({
    root,
    hostId,
    adapter,
    handler: handlerCommand(path),
    timeoutMs: 5000,
    onTransition: async transition => {
      if (transition !== "gate_released") return
      const handlers = await handlerIdentities(config.handlerLog)
      assert.equal(handlers.length, 1)
      await stopIdentity(handlers[0]!, adapter)
    },
  }), /exited|closed|acknowledgement/i)
  assert.ok(Date.now() - started < 1000)
})

test("Handler death at every post-gate boundary remains classifiable and never yields false readiness", async t => {
  for (const stage of ["before_socket_bind", "after_socket_bind_before_publication", "after_first_reconciliation", "before_ready_ack"] as const) {
    await t.test(stage, async t => {
      const root = await fixtureRoot(t)
      const adapter = new FakeAdapter()
      const eventLog = join(root, "events.log")
      const releasePath = join(root, "release")
      const resultPath = join(root, "result.json")
      const { config, path } = await writeConfig(root, {
        eventLog,
        releasePath,
        resultPath,
        handlerPauseAt: stage,
      })
      const firstRetained = join(config.retainedDirectory, "a-first.json")
      const secondRetained = join(config.retainedDirectory, "b-second.json")
      const firstRecord = launchRecord({ checkoutId: "first" })
      const secondRecord = launchRecord({ checkoutId: "second" })
      await writeLaunchRecord(firstRetained, firstRecord)
      await writeLaunchRecord(secondRetained, secondRecord)
      t.after(async () => cleanupHandlers(root, config.handlerLog, adapter))
      const launcher = spawnContender(path)
      await waitEvent(eventLog, `handler:${stage}`)
      const handlers = await handlerIdentities(config.handlerLog)
      assert.equal(handlers.length, 1)
      await stopIdentity(handlers[0]!, adapter)
      assert.notEqual(await waitChild(launcher), 0)
      const inspection = await inspectHandlerGeneration(root, adapter)
      assert.equal(inspection?.disposition, "stale")
      const crashed = await readHandlerRecord(join(root, "handler.json"))
      const expected = {
        before_socket_bind: { phase: "identity_published", writer: "launcher" },
        after_socket_bind_before_publication: { phase: "identity_published", writer: "launcher" },
        after_first_reconciliation: { phase: "reconciling", writer: "handler" },
        before_ready_ack: { phase: "ready", writer: "handler" },
      } as const
      assert.equal(crashed.phase, expected[stage].phase)
      assert.equal(crashed.writer, expected[stage].writer)
      if (stage === "after_socket_bind_before_publication") assert.equal(await pathExists(join(root, "handler.sock")), true)
      if (stage === "after_first_reconciliation") {
        assert.deepEqual(crashed.reconciliation, { classified: 1, total: 2, quarantined: 0 })
        assert.equal((await readLaunchRecord(firstRetained)).phase, "cleanup_verified")
        assert.deepEqual(await readLaunchRecord(secondRetained), secondRecord)
      }
      assert.equal(await pathExists(resultPath), true)
      const result = JSON.parse(await readFile(resultPath, "utf8")) as { ok: boolean }
      assert.equal(result.ok, false)
      if (stage !== "before_ready_ack") assert.notEqual(crashed.phase, "ready")
    })
  }
})

test("closes the startup lock handle when helper release rejects", async t => {
  const root = await fixtureRoot(t)
  const adapter = new FakeAdapter()
  const server = await bindPrivateSocket(root, "handler.sock")
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  t.after(async () => rm(root, { recursive: true, force: true }))
  await writeHandlerRecord(join(root, "handler.json"), handlerRecord(root, identity(process.pid, process.ppid)))
  const originalEnd = Socket.prototype.end
  let injected = false
  Socket.prototype.end = function(this: Socket): Socket {
    this.destroy()
    if (!injected) {
      injected = true
      throw new Error("injected lock release failure")
    }
    return this
  } as typeof Socket.prototype.end
  try {
    await assert.rejects(startOrConnect({ root, hostId, adapter, handler: { file: process.execPath, args: [] } }), /injected lock release failure/)
  } finally {
    Socket.prototype.end = originalEnd
  }
  const lockStats = await lstat(join(root, "startup.lock"))
  const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"
  const matchingDescriptors = readdirSync(descriptorRoot).filter(value => /^\d+$/.test(value)).filter(value => {
    try {
      const stats = fstatSync(Number(value))
      return stats.dev === lockStats.dev && stats.ino === lockStats.ino
    } catch {
      return false
    }
  })
  assert.deepEqual(matchingDescriptors, [])
})