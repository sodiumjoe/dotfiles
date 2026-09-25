import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess, type ExecFileOptionsWithStringEncoding } from "node:child_process"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, rmdir, symlink, writeFile, type FileHandle } from "node:fs/promises"
import { createConnection } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { Duplex, type Readable } from "node:stream"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { createDarwinAdapter, DarwinObservationUnavailable, type DarwinCommandExecutor } from "../src/platform/darwin.js"
import { readHostId } from "../src/platform/host-id.js"
import { agencyLaunchMarker, parseAgencyLaunchMarker } from "../src/platform/launch-marker.js"
import { resolvePlatformPaths } from "../src/platform/paths.js"
import { readHandlerRecord, readLaunchRecord, writeHandlerRecord, writeLaunchRecord } from "../src/platform/private-state.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import { startOrConnect } from "../src/platform/singleton.js"
import { RUNTIME_RECORD_VERSION, sameProcess, type HandlerGenerationRecord, type LaunchPhase, type LaunchRecord, type PlatformAdapter, type ProcessIdentity } from "../src/platform/types.js"
import { leader as providerLeader, stopDescendant } from "./fixtures/provider-tree.js"

const node = "/Users/moon/.nodenv/versions/24.13.0/bin/node"
const providerFixture = fileURLToPath(new URL("./fixtures/provider-tree.js", import.meta.url))
const handlerFixture = fileURLToPath(new URL("./fixtures/handler.js", import.meta.url))
const singletonFixture = fileURLToPath(new URL("./fixtures/singleton-handler.js", import.meta.url))
const adapter = createDarwinAdapter()
const darwinTest = process.platform === "darwin" ? test : test.skip
const allEvidence: GroupEvidence[] = []
const allPending: PendingGroup[] = []
let finalSurvivorCount = 0
let independentSurvivorCount = 0

type ProviderMode = "normal" | "leader-exits-on-term"
type CrashPhase = "before-spawn" | "after-attempt" | "identity-published" | "readiness" | "active"

type GroupEvidence = {
  label: string
  marker: string
  leader: ProcessIdentity
  members: ProcessIdentity[]
  receiptPath: string
}

type PendingGroup = {
  label: string
  marker: string
  pid: number
  resolved: boolean
}

type ProviderFixture = {
  launchAttemptId: string
  leader: ProcessIdentity
  members: ProcessIdentity[]
  record: LaunchRecord
  evidence: GroupEvidence
}

type HandlerFrame = {
  type: "phase"
  phase: CrashPhase
  handler: ProcessIdentity
  provider: { leader: ProcessIdentity; members: ProcessIdentity[] } | null
}

type ProviderStructuralFrame = {
  type: "provider-structural"
  leaderPid: number
  descendantPid: number
}

type HandlerIdentityFrame = {
  type: "identity"
  identity: ProcessIdentity
}

type FixtureConfig = {
  root: string
  bootId: string
  hostId: string
  handlerLog: string
  retainedDirectory: string
  adapterMode: "darwin-real"
  response: string
  timeoutMs: number
  lockTimeoutSeconds: number
  eventLog?: string
  releasePath?: string
  handlerPauseAt?: "before_socket_bind" | "after_first_reconciliation"
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

const fixturesPresent = process.platform === "darwin" && await exists(providerFixture) && await exists(handlerFixture)
const qualificationTest = fixturesPresent ? test : test.skip
let privateUmaskScope: { active: number; previous: number } | undefined

async function withPrivateUmask<T>(create: () => Promise<T>): Promise<T> {
  const scope = privateUmaskScope ??= { active: 0, previous: process.umask(0o077) }
  scope.active += 1
  try {
    return await create()
  } finally {
    scope.active -= 1
    if (scope.active === 0) {
      process.umask(scope.previous)
      privateUmaskScope = undefined
    }
  }
}

async function writePrivateFile(path: string, data: string): Promise<void> {
  await withPrivateUmask(() => writeFile(path, data, { mode: 0o600 }))
}

async function makePrivateDirectory(path: string): Promise<void> {
  await withPrivateUmask(() => mkdir(path, { mode: 0o700 }))
}

async function writePrivateHandlerRecord(path: string, record: HandlerGenerationRecord): Promise<void> {
  await withPrivateUmask(() => writeHandlerRecord(path, record))
}

async function writePrivateLaunchRecord(path: string, record: LaunchRecord): Promise<void> {
  await withPrivateUmask(() => writeLaunchRecord(path, record))
}

async function reconcilePrivateRecord(path: string, source: PlatformAdapter) {
  return withPrivateUmask(() => reconcileRecord(path, source))
}

async function waitFor<T>(read: () => Promise<T | null>, message: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    let value: T | null
    try {
      value = await read()
    } catch (error) {
      if (!(error instanceof DarwinObservationUnavailable)) throw error
      value = null
    }
    if (value !== null) return value
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function waitUntil(read: () => Promise<boolean>, message: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await read()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function readProcessSettled(pid: number, timeoutMs: number): Promise<ProcessIdentity | null> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      return await adapter.readProcess(pid)
    } catch (error) {
      if (!(error instanceof DarwinObservationUnavailable)) throw error
    }
    if (Date.now() >= deadline) throw new Error(`fixture pid ${pid} remained unobservable`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

async function fileState(path: string): Promise<{ uid: number; gid: number; mode: number; size: number; ino: number; mtimeMs: number } | null> {
  try {
    const stats = await lstat(path)
    return { uid: stats.uid, gid: stats.gid, mode: stats.mode, size: stats.size, ino: stats.ino, mtimeMs: stats.mtimeMs }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

function sorted(identities: ProcessIdentity[]): ProcessIdentity[] {
  return [...identities].sort((left, right) => left.pid - right.pid)
}

function exactMarker(identity: ProcessIdentity, marker: string): boolean {
  const separator = identity.birth.indexOf(":")
  return separator > 0 && identity.birth.slice(separator + 1) === marker
}

function assertLeader(identity: ProcessIdentity, marker: string): void {
  assert.equal(identity.pid, identity.processGroupId)
  assert.equal(identity.pid, identity.sessionId)
  assert.equal(identity.uid, process.getuid!())
  assert.equal(identity.gid, process.getgid!())
  assert.equal(exactMarker(identity, marker), true)
}

async function stableGroup(processGroupId: number, source: PlatformAdapter = adapter): Promise<ProcessIdentity[]> {
  const first = sorted(await source.readGroup(processGroupId))
  const second = sorted(await source.readGroup(processGroupId))
  assert.deepEqual(second, first)
  return first
}

async function verifyOriginalIdentities(evidence: GroupEvidence): Promise<void> {
  for (const expected of evidence.members) {
    const current = await adapter.readProcess(expected.pid)
    if (current !== null && !sameProcess(expected, current)) throw new Error(`${evidence.label} pid ${expected.pid} was reused before cleanup`)
  }
}

async function authorized(evidence: GroupEvidence): Promise<{ leader: ProcessIdentity | null; members: ProcessIdentity[] }> {
  assert.equal(await adapter.bootId(), evidence.leader.bootId)
  const leader = await adapter.readProcess(evidence.leader.pid)
  if (leader !== null) {
    assert.equal(sameProcess(evidence.leader, leader), true)
    assertLeader(leader, evidence.marker)
  }
  const members = await stableGroup(evidence.leader.processGroupId)
  for (const member of members) {
    assert.equal(member.bootId, evidence.leader.bootId)
    assert.equal(member.processGroupId, evidence.leader.processGroupId)
    assert.equal(member.sessionId, evidence.leader.sessionId)
    assert.equal(member.uid, evidence.leader.uid)
    assert.equal(member.gid, evidence.leader.gid)
  }
  if (members.length > 0) {
    const retained = members.some(member => evidence.members.some(expected => sameProcess(expected, member)))
    assert.equal(retained, true)
    if (leader !== null) assert.equal(members.some(member => sameProcess(leader, member)), true)
  }
  return { leader, members }
}

async function cleanupEvidence(evidence: GroupEvidence): Promise<void> {
  await verifyOriginalIdentities(evidence)
  let observation = await authorized(evidence)
  const receipt = {
    label: evidence.label,
    leader: evidence.leader,
    authorizedMembers: observation.members,
    actions: [] as NodeJS.Signals[],
    completed: false,
  }
  await writePrivateFile(evidence.receiptPath, JSON.stringify(receipt))
  if (observation.members.length > 0 && observation.leader !== null) {
    observation = await authorized(evidence)
    assert.notEqual(observation.leader, null)
    await adapter.signalGroup(evidence.leader.processGroupId, "SIGTERM")
    receipt.actions.push("SIGTERM")
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      observation = await authorized(evidence)
      if (observation.members.length === 0) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  observation = await authorized(evidence)
  if (observation.members.length > 0) {
    observation = await authorized(evidence)
    assert.ok(observation.members.length > 0)
    await adapter.signalGroup(evidence.leader.processGroupId, "SIGKILL")
    receipt.actions.push("SIGKILL")
    await waitUntil(async () => (await adapter.readGroup(evidence.leader.processGroupId)).length === 0, `${evidence.label} survived fixture SIGKILL`, 3000)
  }
  assert.deepEqual(await adapter.readGroup(evidence.leader.processGroupId), [])
  assert.deepEqual(await adapter.readGroup(evidence.leader.processGroupId), [])
  await verifyOriginalIdentities(evidence)
  for (const expected of evidence.members) {
    const current = await adapter.readProcess(expected.pid)
    assert.equal(current !== null && sameProcess(expected, current), false)
  }
  receipt.completed = true
  await writePrivateFile(evidence.receiptPath, JSON.stringify(receipt))
  assert.deepEqual(await readJson(evidence.receiptPath), receipt)
}

class FixtureScope {
  readonly evidence: GroupEvidence[] = []
  readonly identityLogs = new Set<string>()
  readonly emptyRoots = new Set<string>()
  readonly pending: PendingGroup[] = []
  private readonly starts: Promise<unknown>[] = []
  private stopping = false

  private constructor(readonly root: string) {}

  start<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error("fixture startup cannot begin during teardown")
    const start = Promise.resolve().then(operation)
    this.starts.push(start)
    void start.catch(() => undefined)
    return start
  }

  static async create(t: TestContext): Promise<FixtureScope> {
    const root = await realpath(await withPrivateUmask(() => mkdtemp(join(tmpdir(), "agy-darwin-"))))
    await chmod(root, 0o700)
    const scope = new FixtureScope(root)
    t.after(async () => scope.cleanup())
    return scope
  }

  register(label: string, marker: string, leader: ProcessIdentity, members: ProcessIdentity[]): GroupEvidence {
    const existing = this.evidence.find(value => sameProcess(value.leader, leader))
    if (existing !== undefined) {
      for (const pending of this.pending) {
        if (pending.pid === leader.pid && pending.marker === marker) pending.resolved = true
      }
      return existing
    }
    const evidence = { label, marker, leader, members: sorted(members), receiptPath: join(this.root, `cleanup-${this.evidence.length}-${randomUUID()}.json`) }
    this.evidence.push(evidence)
    allEvidence.push(evidence)
    for (const pending of this.pending) {
      if (pending.pid === leader.pid && pending.marker === marker) pending.resolved = true
    }
    return evidence
  }

  track(label: string, marker: string, pid: number): void {
    const pending = { label, marker, pid, resolved: false }
    this.pending.push(pending)
    allPending.push(pending)
  }

  private async discoverHandlers(): Promise<void> {
    for (const path of this.identityLogs) {
      if (!await exists(path)) continue
      const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean)
      for (const line of lines) {
        const identity = JSON.parse(line) as ProcessIdentity
        const marker = identity.birth.slice(identity.birth.indexOf(":") + 1)
        this.register(`Handler ${identity.pid}`, marker, identity, [identity])
      }
    }
  }

  private async discoverPending(): Promise<void> {
    const failures: unknown[] = []
    for (const pending of this.pending) {
      if (pending.resolved) continue
      try {
        const leader = await readProcessSettled(pending.pid, 2000)
        if (leader === null) {
          const members = await stableGroup(pending.pid)
          if (members.length > 0) throw new Error(`${pending.label} became leaderless before exact identity registration`)
          pending.resolved = true
          continue
        }
        if (!exactMarker(leader, pending.marker)) throw new Error(`${pending.label} pending marker is not exact`)
        const members = await stableGroup(leader.processGroupId)
        this.register(pending.label, pending.marker, leader, members.length === 0 ? [leader] : members)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "pending fixture discovery failed")
  }

  private async cleanup(): Promise<void> {
    const failures: unknown[] = []
    this.stopping = true
    try {
      await settleStarts(this.starts)
    } catch (error) {
      failures.push(error)
    }
    for (const discover of [() => this.discoverHandlers(), () => this.discoverPending()]) {
      try {
        await discover()
      } catch (error) {
        failures.push(error)
      }
    }
    for (const evidence of this.evidence) {
      try {
        await cleanupEvidence(evidence)
      } catch (error) {
        failures.push(error)
      }
    }
    for (const path of this.emptyRoots) {
      try {
        await rmdir(path)
      } catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTEMPTY")) failures.push(error)
      }
    }
    if (failures.length === 0) await rm(this.root, { recursive: true, force: true })
    if (failures.length > 0) throw new AggregateError(failures, "fixture cleanup failed")
  }
}

function baseRecord(launchAttemptId: string, bootId: string, overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: RUNTIME_RECORD_VERSION,
    checkoutId: `checkout-${launchAttemptId}`,
    leaseId: `lease-${launchAttemptId}`,
    agentId: `agent-${launchAttemptId}`,
    handlerGeneration: `handler-${launchAttemptId}`,
    launchAttemptId,
    launchBootId: bootId,
    launchAttempted: true,
    phase: "active",
    provider: null,
    reason: null,
    ...overrides,
  }
}

function childPipe(child: ChildProcess, fd: number): Duplex {
  const stream = child.stdio[fd]
  if (stream === null) throw new Error(`fixture fd ${fd} is unavailable`)
  return stream as Duplex
}

async function readProviderStructural(child: ChildProcess, label: string): Promise<ProviderStructuralFrame> {
  const structural = JSON.parse(await readLine(childPipe(child, 3))) as ProviderStructuralFrame
  assert.deepEqual(Object.keys(structural).sort(), ["descendantPid", "leaderPid", "type"])
  assert.equal(structural.type, "provider-structural")
  assert.ok(Number.isSafeInteger(structural.leaderPid) && structural.leaderPid > 0)
  assert.ok(Number.isSafeInteger(structural.descendantPid) && structural.descendantPid > 0)
  if (structural.leaderPid === structural.descendantPid) throw new Error(`${label} structural pids are not distinct`)
  return structural
}

async function registerProvider(child: ChildProcess, scope: FixtureScope, label: string, marker: string, structural: ProviderStructuralFrame, expectedLeaderPid: number, source: PlatformAdapter = adapter): Promise<GroupEvidence> {
  try {
    assert.equal(structural.leaderPid, expectedLeaderPid)
    const leader = await waitFor(() => source.readProcess(structural.leaderPid), `${label} leader was not observable`)
    assertLeader(leader, marker)
    assert.equal(await source.bootId(), leader.bootId)
    const members = await waitFor(async () => {
      const current = await stableGroup(leader.processGroupId, source)
      return current.some(member => member.pid === structural.descendantPid) ? current : null
    }, `${label} descendant was not observable`)
    assert.equal(members.some(member => sameProcess(leader, member)), true)
    for (const member of members) {
      assert.equal(member.bootId, leader.bootId)
      assert.equal(member.processGroupId, leader.processGroupId)
      assert.equal(member.sessionId, leader.sessionId)
      assert.equal(member.uid, leader.uid)
      assert.equal(member.gid, leader.gid)
    }
    return scope.register(label, marker, leader, members)
  } catch (error) {
    childPipe(child, 4).destroy()
    throw error
  }
}

async function acknowledgeProvider(child: ChildProcess, timeoutMs = 1000): Promise<void> {
  const acknowledgement = childPipe(child, 4)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let completed = false
    let closeObserved = false
    let closeCheck: NodeJS.Immediate | undefined
    let failure: Error | undefined
    const timer = setTimeout(() => finish(new Error("provider acknowledgement timed out")), timeoutMs)
    const finish = (error?: Error): void => {
      if (settled) return
      if (error !== undefined) failure ??= error
      completed = true
      acknowledgement.destroy()
      if (!closeObserved) {
        if (acknowledgement.closed && closeCheck === undefined) closeCheck = setImmediate(closed)
        return
      }
      settled = true
      clearTimeout(timer)
      if (closeCheck !== undefined) clearImmediate(closeCheck)
      acknowledgement.off("error", failed)
      acknowledgement.off("close", closed)
      if (failure === undefined) resolve()
      else reject(failure)
    }
    const failed = (error: Error): void => finish(error)
    const closed = (): void => {
      closeObserved = true
      finish(completed ? undefined : new Error("provider acknowledgement path closed"))
    }
    acknowledgement.on("error", failed)
    acknowledgement.once("close", closed)
    acknowledgement.end("registered\n", (error?: Error | null) => finish(error ?? undefined))
  })
}

async function spawnProvider(scope: FixtureScope, label: string, mode: ProviderMode = "normal"): Promise<ProviderFixture> {
  const launchAttemptId = randomUUID()
  const marker = agencyLaunchMarker("provider", launchAttemptId)
  const readyPath = join(scope.root, `provider-${randomUUID()}.json`)
  const child = spawn(node, [providerFixture, "leader", readyPath, mode, "5000"], { argv0: marker, detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] })
  assert.notEqual(child.pid, undefined)
  scope.track(label, marker, child.pid!)
  const structural = await readProviderStructural(child, label)
  const evidence = await registerProvider(child, scope, label, marker, structural, child.pid!)
  await acknowledgeProvider(child)
  const published = await waitFor(async () => await exists(readyPath) ? readJson<{ leaderPid: number; descendantPid: number }>(readyPath) : null, `${label} did not publish structural pids`)
  assert.deepEqual(published, { leaderPid: structural.leaderPid, descendantPid: structural.descendantPid })
  child.unref()
  const record = baseRecord(launchAttemptId, evidence.leader.bootId, {
    provider: { kind: "process-group", group: { leader: evidence.leader, observed: evidence.members } },
  })
  return { launchAttemptId, leader: evidence.leader, members: evidence.members, record, evidence }
}

async function killExactHandler(identity: ProcessIdentity): Promise<void> {
  await signalExactHandlerGroup(adapter, identity, "SIGKILL")
  await waitUntil(async () => await adapter.readProcess(identity.pid) === null, `Handler ${identity.pid} survived SIGKILL`, 5000)
}

async function signalExactHandlerGroup(source: PlatformAdapter, identity: ProcessIdentity, signal: NodeJS.Signals): Promise<void> {
  const separator = identity.birth.indexOf(":")
  if (separator <= 0) throw new Error("stored Handler birth is malformed")
  const marker = identity.birth.slice(separator + 1)
  if (parseAgencyLaunchMarker(marker)?.role !== "handler") throw new Error("stored Handler marker is not exact")
  assertLeader(identity, marker)
  assert.equal(await source.bootId(), identity.bootId)
  const first = await source.readProcess(identity.pid)
  const second = await source.readProcess(identity.pid)
  assert.notEqual(first, null)
  assert.notEqual(second, null)
  assert.equal(sameProcess(identity, first!), true)
  assert.equal(sameProcess(identity, second!), true)
  assertLeader(first!, marker)
  assertLeader(second!, marker)
  const firstGroup = sorted(await source.readGroup(identity.processGroupId))
  const secondGroup = sorted(await source.readGroup(identity.processGroupId))
  assert.ok(firstGroup.length > 0)
  assert.deepEqual(secondGroup, firstGroup)
  for (const member of firstGroup) {
    assert.equal(member.bootId, identity.bootId)
    assert.equal(member.processGroupId, identity.processGroupId)
    assert.equal(member.sessionId, identity.sessionId)
    assert.equal(member.uid, identity.uid)
    assert.equal(member.gid, identity.gid)
  }
  assert.equal(firstGroup.some(member => sameProcess(identity, member)), true)
  await source.signalGroup(identity.processGroupId, signal)
}

async function readLine(stream: Readable, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ""
    const timer = setTimeout(() => finish(new Error("fixture status timed out")), timeoutMs)
    const finish = (error?: Error, value?: string): void => {
      clearTimeout(timer)
      stream.off("data", data)
      stream.off("error", failed)
      stream.off("end", ended)
      if (error === undefined) resolve(value!)
      else reject(error)
    }
    const data = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      const newline = buffer.indexOf("\n")
      if (newline !== -1) finish(undefined, buffer.slice(0, newline))
    }
    const failed = (error: Error): void => finish(error)
    const ended = (): void => finish(new Error("fixture status ended before a line"))
    stream.on("data", data)
    stream.once("error", failed)
    stream.once("end", ended)
  })
}

async function waitChild(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", exited)
      reject(new Error(`fixture child ${child.pid ?? "unknown"} did not exit`))
    }, timeoutMs)
    const exited = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    child.once("exit", exited)
  })
}

function pendingHandlerRecord(root: string, hostId: string, bootId: string, launchAttemptId: string, generation: string): HandlerGenerationRecord {
  return {
    version: RUNTIME_RECORD_VERSION,
    hostId,
    launchBootId: bootId,
    generation,
    launchAttemptId,
    launchAttempted: true,
    phase: "launch_pending",
    process: null,
    socketPath: join(root, "handler.sock"),
    writer: "launcher",
    reconciliation: null,
    reason: null,
  }
}

async function crashHandler(scope: FixtureScope, phase: CrashPhase, providerMode: ProviderMode = "normal"): Promise<{ recordPath: string; frame: HandlerFrame; evidence: GroupEvidence | null; child: ChildProcess }> {
  const launchAttemptId = randomUUID()
  const marker = agencyLaunchMarker("handler", launchAttemptId)
  const recordPath = join(scope.root, `launch-${phase}-${randomUUID()}.json`)
  const configPath = join(scope.root, `handler-${phase}-${randomUUID()}.json`)
  const providerReadyPath = join(scope.root, `provider-ready-${phase}-${randomUUID()}.json`)
  await writePrivateFile(configPath, JSON.stringify({ phase, recordPath, providerReadyPath, providerMode, timeoutMs: 5000 }))
  const child = spawn(node, [handlerFixture, configPath], { argv0: marker, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] })
  assert.notEqual(child.pid, undefined)
  scope.track(`crash Handler ${phase}`, marker, child.pid!)
  let providerEvidence: GroupEvidence | null = null
  if (phase !== "before-spawn") {
    const structural = await readProviderStructural(child, `crash provider ${phase}`)
    const record = await readLaunchRecord(recordPath)
    const providerMarker = agencyLaunchMarker("provider", record.launchAttemptId)
    scope.track(`crash provider ${phase}`, providerMarker, structural.leaderPid)
    providerEvidence = await registerProvider(child, scope, `crash provider ${phase}`, providerMarker, structural, structural.leaderPid)
    await acknowledgeProvider(child)
  }
  const frame = JSON.parse(await readLine(child.stdout!)) as HandlerFrame
  assert.equal(frame.type, "phase")
  assert.equal(frame.phase, phase)
  assert.equal(frame.handler.pid, child.pid)
  assertLeader(frame.handler, marker)
  scope.register(`crash Handler ${phase}`, marker, frame.handler, [frame.handler])
  if (frame.provider !== null) {
    const providerMarker = agencyLaunchMarker("provider", (await readLaunchRecord(recordPath)).launchAttemptId)
    assertLeader(frame.provider.leader, providerMarker)
    const publishedEvidence = scope.register(`crash provider ${phase}`, providerMarker, frame.provider.leader, frame.provider.members)
    assert.notEqual(providerEvidence, null)
    assert.equal(sameProcess(providerEvidence!.leader, publishedEvidence.leader), true)
    assert.deepEqual(providerEvidence!.members, publishedEvidence.members)
  }
  await killExactHandler(frame.handler)
  return { recordPath, frame, evidence: providerEvidence, child }
}

function signalTracking(source: PlatformAdapter): { adapter: PlatformAdapter; signals: NodeJS.Signals[] } {
  const signals: NodeJS.Signals[] = []
  return {
    signals,
    adapter: {
      ...source,
      signalGroup: async (processGroupId, signal) => {
        signals.push(signal)
        await source.signalGroup(processGroupId, signal)
      },
    },
  }
}

function mutateProvider(record: LaunchRecord, mutate: (identity: ProcessIdentity) => ProcessIdentity): LaunchRecord {
  assert.equal(record.provider?.kind, "process-group")
  const provider = record.provider!
  if (provider.kind !== "process-group") throw new Error("process group fixture is required")
  const leader = mutate(provider.group.leader)
  const observed = provider.group.observed.map(identity => sameProcess(provider.group.leader, identity) ? leader : identity)
  return { ...record, provider: { kind: "process-group", group: { leader, observed } } }
}

function changeMarker(identity: ProcessIdentity, replacement: string): ProcessIdentity {
  return { ...identity, birth: `${identity.birth.slice(0, identity.birth.indexOf(":"))}:${replacement}` }
}

function singletonCommand(configPath: string): { file: string; args: string[] } {
  return { file: node, args: [singletonFixture, "handler", configPath] }
}

async function lines(path: string): Promise<string[]> {
  if (!await exists(path)) return []
  return (await readFile(path, "utf8")).split("\n").filter(Boolean)
}

function assertContenderConvergence(starts: Array<{ record: HandlerGenerationRecord }>, handlerPublications: string[]): void {
  const first = starts[0]?.record
  assert.notEqual(first, undefined, "contender results are empty")
  assert.notEqual(first!.process, null, "contender process identity is incomplete")
  for (const start of starts) {
    assert.deepEqual(start.record.process, first!.process, "contender process identities diverged")
    assert.equal(start.record.socketPath, first!.socketPath, "contender socket paths diverged")
  }
  assert.equal(handlerPublications.length, 1, "expected exactly one Handler identity publication")
  assert.deepEqual(JSON.parse(handlerPublications[0]!) as ProcessIdentity, first!.process, "Handler identity publication diverged")
}

async function settleStarts<T>(starts: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(starts)
  const failures: unknown[] = []
  const values: T[] = []
  for (const result of results) {
    if (result.status === "rejected") failures.push(result.reason)
    else values.push(result.value)
  }
  if (failures.length > 0) throw new AggregateError(failures, "fixture startup operations failed after draining")
  return values
}

async function independentFixtureSurvivors(execute: (file: string, args: string[], options: ExecFileOptionsWithStringEncoding, callback: (error: Error | null, stdout: string) => void) => unknown = execFile): Promise<Array<{ pid: number; command: string }>> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execute("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", env: { LANG: "C", TZ: "UTC" }, maxBuffer: 1024 * 1024, shell: false, timeout: 2000 }, (error, value) => {
      if (error === null) resolve(value)
      else reject(error)
    })
  })
  const paths = [providerFixture, handlerFixture, singletonFixture]
  const survivors = new Map<number, { pid: number; command: string }>()
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[2]!
    const executable = command.slice(0, command.search(/\s|$/))
    const marker = parseAgencyLaunchMarker(executable)
    if (marker !== null || paths.some(path => command.includes(path))) survivors.set(pid, { pid, command })
  }
  return [...survivors.values()].sort((left, right) => left.pid - right.pid)
}

async function exchange(path: string, connect: (path: string) => Duplex = createConnection): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let response = ""
    let settled = false
    let completed = false
    let closeObserved = false
    let failure: Error | undefined
    const timer = setTimeout(() => finish(new Error("fixture socket exchange timed out")), 5000)
    const finish = (error?: Error): void => {
      if (settled) return
      if (error !== undefined) failure ??= error
      completed = true
      socket.destroy()
      if (!closeObserved) return
      settled = true
      clearTimeout(timer)
      socket.off("connect", connected)
      socket.off("data", received)
      socket.off("end", ended)
      socket.off("error", failed)
      socket.off("close", closed)
      if (failure === undefined) resolve(response)
      else reject(failure)
    }
    const connected = (): void => { socket.end("ping") }
    const received = (chunk: Buffer | string): void => { response += chunk.toString() }
    const ended = (): void => finish()
    const failed = (error: Error): void => finish(error)
    const closed = (): void => {
      closeObserved = true
      finish(completed ? undefined : new Error("fixture socket exchange closed before response ended"))
    }
    socket.once("connect", connected)
    socket.on("data", received)
    socket.once("end", ended)
    socket.on("error", failed)
    socket.once("close", closed)
  })
}

darwinTest("provides the Darwin qualification fixture programs", async t => {
  const evidenceCount = allEvidence.length
  t.after(() => assert.equal(allEvidence.length, evidenceCount))
  for (const path of [providerFixture, handlerFixture]) {
    const stats = await lstat(path)
    assert.equal(stats.isFile(), true)
  }
})

darwinTest("authorizes a Handler group signal from exact stable complete evidence", async () => {
  const marker = agencyLaunchMarker("handler", randomUUID())
  const leader: ProcessIdentity = { bootId: "boot", pid: 41001, birth: `1790000000:${marker}`, parentPid: 1, processGroupId: 41001, sessionId: 41001, uid: process.getuid!(), gid: process.getgid!() }
  const descendant: ProcessIdentity = { ...leader, pid: 41002, birth: "1790000001:descendant", parentPid: leader.pid }
  const calls: string[] = []
  const source: PlatformAdapter = {
    platform: "darwin",
    bootId: async () => {
      calls.push("boot")
      return leader.bootId
    },
    readProcess: async pid => {
      calls.push(`leader:${pid}`)
      return { ...leader }
    },
    readGroup: async processGroupId => {
      calls.push(`group:${processGroupId}`)
      return [{ ...descendant }, { ...leader }]
    },
    signalGroup: async (processGroupId, signal) => {
      calls.push(`signal:${processGroupId}:${signal}`)
    },
  }
  await signalExactHandlerGroup(source, leader, "SIGKILL")
  assert.deepEqual(calls, ["boot", "leader:41001", "leader:41001", "group:41001", "group:41001", "signal:41001:SIGKILL"])
})

darwinTest("fails closed before Handler group signaling on incomplete or unauthorized evidence", async t => {
  const marker = agencyLaunchMarker("handler", randomUUID())
  const leader: ProcessIdentity = { bootId: "boot", pid: 42001, birth: `1790000000:${marker}`, parentPid: 1, processGroupId: 42001, sessionId: 42001, uid: process.getuid!(), gid: process.getgid!() }
  const descendant: ProcessIdentity = { ...leader, pid: 42002, birth: "1790000001:descendant", parentPid: leader.pid }
  const scenarios = [
    { name: "absent leader", leaders: [null, null], groups: [[leader, descendant], [leader, descendant]] },
    { name: "changed leader", leaders: [leader, { ...leader, birth: `${leader.birth}-changed` }], groups: [[leader, descendant], [leader, descendant]] },
    { name: "empty group", leaders: [leader, leader], groups: [[], []] },
    { name: "unstable group", leaders: [leader, leader], groups: [[leader], [leader, descendant]] },
    { name: "unauthorized member", leaders: [leader, leader], groups: [[leader, { ...descendant, uid: descendant.uid + 1 }], [leader, { ...descendant, uid: descendant.uid + 1 }]] },
  ]
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let leaderRead = 0
      let groupRead = 0
      const signals: Array<{ processGroupId: number; signal: NodeJS.Signals }> = []
      const source: PlatformAdapter = {
        platform: "darwin",
        bootId: async () => leader.bootId,
        readProcess: async () => scenario.leaders[leaderRead++] ?? null,
        readGroup: async () => scenario.groups[groupRead++] ?? [],
        signalGroup: async (processGroupId, signal) => {
          signals.push({ processGroupId, signal })
        },
      }
      await assert.rejects(signalExactHandlerGroup(source, leader, "SIGKILL"))
      assert.deepEqual(signals, [])
    })
  }
})

darwinTest("restores the process umask after private fixture metadata creation", async t => {
  const original = process.umask()
  let root = ""
  await withPrivateUmask(async () => {
    assert.equal(process.umask(), 0o077)
    root = await mkdtemp(join(tmpdir(), "agy-darwin-umask-"))
    await mkdir(join(root, "state"))
    await writeFile(join(root, "state", "evidence.json"), "{}")
  })
  t.after(async () => rm(root, { recursive: true, force: true }))
  assert.equal(process.umask(), original)
  assert.equal((await lstat(root)).mode & 0o777, 0o700)
  assert.equal((await lstat(join(root, "state"))).mode & 0o777, 0o700)
  assert.equal((await lstat(join(root, "state", "evidence.json"))).mode & 0o777, 0o600)
})

for (const firstExit of [0, 1]) {
  for (const rejectSecond of [false, true]) {
    darwinTest(`preserves private umask for overlapping scopes exiting in ${firstExit === 0 ? "entry" : "reverse"} order with ${rejectSecond ? "a rejection" : "successful results"}`, async () => {
      const initial = firstExit === 0 ? 0o022 : 0o027
      const ambient = process.umask(initial)
      const gates = [Promise.withResolvers<number>(), Promise.withResolvers<number>()]
      const entered: number[] = []
      const failure = new Error("deterministic private scope failure")
      const scopes = gates.map((gate, index) => withPrivateUmask(() => {
        entered.push(index)
        return gate.promise
      }))
      const completed = scopes.map(scope => scope.then(() => undefined, () => undefined))
      const results = Promise.allSettled(scopes)
      const settle = (index: number): void => {
        if (rejectSecond && index === 1) gates[index]!.reject(failure)
        else gates[index]!.resolve(index)
      }
      try {
        assert.deepEqual(entered, [0, 1])
        const bothActive = process.umask()
        settle(firstExit)
        await completed[firstExit]
        const oneActive = process.umask()
        settle(1 - firstExit)
        const settled = await results
        assert.deepEqual({ bothActive, oneActive, noneActive: process.umask() }, {
          bothActive: 0o077,
          oneActive: 0o077,
          noneActive: initial,
        })
        assert.deepEqual(settled, [
          { status: "fulfilled", value: 0 },
          rejectSecond ? { status: "rejected", reason: failure } : { status: "fulfilled", value: 1 },
        ])
      } finally {
        for (const gate of gates) gate.resolve(0)
        await results
        process.umask(ambient)
      }
    })
  }
}

darwinTest("preserves private umask after a nested scope rejects", async () => {
  const initial = 0o027
  const ambient = process.umask(initial)
  const failure = new Error("deterministic nested private scope failure")
  try {
    await withPrivateUmask(async () => {
      assert.equal(process.umask(), 0o077)
      await assert.rejects(withPrivateUmask(async () => {
        assert.equal(process.umask(), 0o077)
        throw failure
      }), error => error === failure)
      assert.equal(process.umask(), 0o077)
    })
    assert.equal(process.umask(), initial)
  } finally {
    process.umask(ambient)
  }
})

darwinTest("routes process-bearing qualification cleanup through FixtureScope", async () => {
  const source = await readFile(fileURLToPath(import.meta.url), "utf8")
  assert.doesNotMatch(source, /\bprocess\.kill\(/)
  assert.doesNotMatch(source, /\bchild\.kill\(/)
})

darwinTest("rejects descendant SIGKILL delivery errors without leaking listeners or fixtures", async () => {
  class ScriptedDescendant extends EventEmitter {
    readonly exitCode = null
    readonly signalCode = null

    kill(): boolean {
      queueMicrotask(() => this.emit("error", new Error("scripted SIGKILL delivery failure")))
      return true
    }
  }

  const descendant = new ScriptedDescendant()
  await assert.rejects(stopDescendant(descendant as unknown as Parameters<typeof stopDescendant>[0], 100), error => {
    assert.match(String(error), /provider-tree descendant SIGKILL delivery failed/)
    assert.match(String((error as Error & { cause?: unknown }).cause), /scripted SIGKILL delivery failure/)
    return true
  })
  assert.equal(descendant.listenerCount("exit"), 0)
  assert.equal(descendant.listenerCount("error"), 0)
  assert.deepEqual(await independentFixtureSurvivors(), [])
})

darwinTest("rejects contender results with divergent identity, socket, or Handler publication", async () => {
  const launchAttemptId = randomUUID()
  const marker = agencyLaunchMarker("handler", launchAttemptId)
  const identity: ProcessIdentity = {
    bootId: "boot",
    pid: 43001,
    birth: `1790000000:${marker}`,
    parentPid: 1,
    processGroupId: 43001,
    sessionId: 43001,
    uid: process.getuid!(),
    gid: process.getgid!(),
  }
  const record: HandlerGenerationRecord = {
    version: RUNTIME_RECORD_VERSION,
    hostId: "host",
    launchBootId: identity.bootId,
    generation: "generation",
    launchAttemptId,
    launchAttempted: true,
    phase: "ready",
    process: identity,
    socketPath: "/private/tmp/handler.sock",
    writer: "handler",
    reconciliation: null,
    reason: null,
  }
  const start = { record }
  const publication = JSON.stringify(identity)
  assert.throws(() => assertContenderConvergence([start, { record: { ...record, process: { ...identity, birth: `${identity.birth}-changed` } } }], [publication]), /process identities diverged/)
  assert.throws(() => assertContenderConvergence([start, { record: { ...record, socketPath: `${record.socketPath}-changed` } }], [publication]), /socket paths diverged/)
  assert.throws(() => assertContenderConvergence([start], [publication, publication]), /exactly one Handler identity publication/)
})

for (const readiness of ["delayed", "before-registration", "timeout", "end", "close", "error", "invalid"] as const) {
  darwinTest(`provider descendant readiness ${readiness} gates publication and contains failures`, async t => {
    const scope = await FixtureScope.create(t)
    t.mock.timers.enable({ apis: ["setInterval"] })
    const readyPath = join(scope.root, "descendant-ready.json")
    const published: string[] = []
    const status = new Duplex({ read() {}, write(chunk, _encoding, callback) { published.push(chunk.toString()); callback() } })
    const acknowledgement = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const descendantReady = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    let descendantExited = false
    class ScriptedDescendant extends EventEmitter {
      readonly pid = 44002
      readonly exitCode = null
      readonly signalCode = null
      readonly stdio = [null, null, null, descendantReady]

      kill(signal: NodeJS.Signals): boolean {
        assert.equal(signal, "SIGKILL")
        setImmediate(() => {
          descendantExited = true
          this.emit("exit", null, signal)
        })
        return true
      }
    }
    const descendant = new ScriptedDescendant()
    let failure: unknown
    const running = providerLeader(readyPath, "normal", 1000, {
      spawnDescendant: () => descendant as unknown as ChildProcess,
      socketForFd: fd => fd === 3 ? status : acknowledgement,
    }).catch(error => { failure = error })
    try {
      assert.deepEqual(published.map(line => JSON.parse(line)), [{ type: "provider-structural", leaderPid: process.pid, descendantPid: descendant.pid }])
      if (readiness === "before-registration") {
        descendantReady.push(Buffer.from("ready\n"))
        descendantReady.push(null)
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(await exists(readyPath), false, "provider published before harness registration")
      }
      acknowledgement.push(Buffer.from("registered\n"))
      acknowledgement.push(null)
      if (readiness !== "before-registration") {
        await waitUntil(async () => (acknowledgement.listenerCount("data") === 0 && descendantReady.listenerCount("data") > 0) || await exists(readyPath), "provider did not reach the descendant readiness boundary", 2000)
        assert.equal(await exists(readyPath), false, "provider published readiness before its descendant installed the TERM handler")
      }
      if (readiness === "delayed" || readiness === "before-registration") {
        if (readiness === "delayed") {
          descendantReady.push(Buffer.from("ready\n"))
          descendantReady.push(null)
        }
        await waitUntil(async () => await exists(readyPath) && status.destroyed, "provider ignored descendant readiness", 1000)
        assert.deepEqual(await readJson(readyPath), { leaderPid: process.pid, descendantPid: descendant.pid })
        assert.equal(descendantExited, false)
        assert.equal(failure, undefined)
      } else {
        if (readiness === "end") descendantReady.push(null)
        else if (readiness === "close") descendantReady.destroy()
        else if (readiness === "error") descendantReady.destroy(new Error("scripted descendant readiness failure"))
        else if (readiness === "invalid") descendantReady.push(Buffer.from("not-ready\n"))
        await running
        assert.match(String(failure), readiness === "timeout" ? /timed out/ : readiness === "error" ? /scripted descendant readiness failure/ : readiness === "invalid" ? /invalid/ : /closed/)
        assert.equal(descendantExited, true)
        assert.equal(await exists(readyPath), false)
      }
      await new Promise<void>(resolve => setImmediate(resolve))
      for (const socket of [status, acknowledgement, descendantReady]) {
        assert.equal(socket.destroyed, true)
        for (const event of ["data", "end", "error", "close"]) assert.equal(socket.listenerCount(event), 0, `${event} listener survived ${readiness}`)
      }
      assert.equal(descendant.listenerCount("exit"), 0)
      assert.equal(descendant.listenerCount("error"), 0)
    } finally {
      for (const socket of [status, acknowledgement, descendantReady]) socket.destroy()
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  })
}

for (const outcome of ["complete", "write-error", "close-error", "rename-error", "existing-file", "existing-symlink", "invalid-mode"] as const) {
  darwinTest(`provider atomic ready publication ${outcome} preserves complete visibility and cleans failures`, async t => {
    const scope = await FixtureScope.create(t)
    t.mock.timers.enable({ apis: ["setInterval"] })
    const readyPath = join(scope.root, "atomic-ready.json")
    const sentinelPath = join(scope.root, "sentinel.json")
    const status = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const acknowledgement = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const descendantReady = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const gate = Promise.withResolvers<void>()
    let prepared = false
    let temporaryPath: string | undefined
    let temporaryHandle: FileHandle | undefined
    let descendantExited = false
    let failure: unknown
    const previousMask = process.umask()
    class ScriptedDescendant extends EventEmitter {
      readonly pid = 44002
      readonly exitCode = null
      readonly signalCode = null
      readonly stdio = [null, null, null, descendantReady]

      kill(signal: NodeJS.Signals): boolean {
        assert.equal(signal, "SIGKILL")
        setImmediate(() => {
          descendantExited = true
          this.emit("exit", null, signal)
        })
        return true
      }
    }
    const descendant = new ScriptedDescendant()
    const dependencies = {
      spawnDescendant: () => descendant as unknown as ChildProcess,
      socketForFd: (fd: number) => fd === 3 ? status : acknowledgement,
      readyFileSystem: {
        open: async (...args: Parameters<typeof open>) => {
          assert.equal(process.umask(), 0o077)
          assert.equal(typeof args[0], "string")
          assert.equal(typeof args[1], "number")
          assert.equal((args[1] as number) & (constants.O_EXCL | constants.O_NOFOLLOW), constants.O_EXCL | constants.O_NOFOLLOW)
          assert.equal(args[2], 0o600)
          temporaryPath = args[0] as string
          temporaryHandle = await open(...args)
          const handle = temporaryHandle
          const close = handle.close.bind(handle)
          let closing = false
          t.mock.method(handle, "close", async () => {
            if (outcome === "close-error" && !closing) {
              closing = true
              throw new Error("scripted ready close failure")
            }
            await close()
          })
          t.mock.method(handle, "writeFile", async (data: string) => {
            await handle.write(data.slice(0, 1))
            prepared = true
            await gate.promise
            if (outcome === "write-error") throw new Error("scripted ready write failure")
            await handle.write(data.slice(1))
            if (outcome === "invalid-mode") await handle.chmod(0o644)
          })
          return handle
        },
        rename: async (...args: Parameters<typeof rename>) => {
          assert.equal(await exists(readyPath), false)
          assert.deepEqual(await readJson(args[0] as string), { leaderPid: process.pid, descendantPid: descendant.pid })
          assert.equal(temporaryHandle?.fd, -1)
          if (outcome === "rename-error") throw new Error("scripted ready rename failure")
          await rename(...args)
        },
      },
    }
    const running = providerLeader(readyPath, "normal", 1000, dependencies).catch(error => { failure = error })
    acknowledgement.push(Buffer.from("registered\n"))
    descendantReady.push(Buffer.from("ready\n"))
    try {
      await waitUntil(async () => prepared || status.destroyed, "provider did not reach ready-file preparation", 1000)
      assert.equal(await exists(readyPath), false, "provider exposed the final ready path before atomic publication")
      assert.equal(prepared, true)
      assert.notEqual(temporaryPath, readyPath)
      assert.equal(dirname(temporaryPath!), scope.root)
      const metadata = await lstat(temporaryPath!)
      assert.equal(metadata.isFile(), true)
      assert.equal(metadata.mode & 0o777, 0o600)
      assert.equal(metadata.uid, process.getuid!())
      assert.equal(metadata.nlink, 1)
      assert.equal(await readFile(temporaryPath!, "utf8"), "{")
      await assert.rejects(readFile(readyPath, "utf8"), { code: "ENOENT" })
      if (outcome === "existing-file") await writePrivateFile(readyPath, "unexpected destination")
      if (outcome === "existing-symlink") {
        await writePrivateFile(sentinelPath, "unchanged sentinel")
        await symlink(sentinelPath, readyPath)
      }
      gate.resolve()
      await waitUntil(async () => status.destroyed, "provider did not settle ready-file publication", 1000)
      if (outcome === "complete") {
        assert.equal(failure, undefined)
        assert.equal(descendantExited, false)
        assert.deepEqual(await readJson(readyPath), { leaderPid: process.pid, descendantPid: descendant.pid })
        assert.equal((await lstat(readyPath)).mode & 0o777, 0o600)
      } else {
        await running
        assert.ok(failure instanceof Error)
        assert.equal(descendantExited, true)
        if (outcome === "existing-file") assert.equal(await readFile(readyPath, "utf8"), "unexpected destination")
        else if (outcome === "existing-symlink") {
          assert.equal((await lstat(readyPath)).isSymbolicLink(), true)
          assert.equal(await readFile(sentinelPath, "utf8"), "unchanged sentinel")
        } else assert.equal(await exists(readyPath), false)
      }
      assert.equal(await exists(temporaryPath!), false)
      assert.equal(temporaryHandle?.fd, -1)
      assert.deepEqual((await readdir(scope.root)).sort(), outcome === "complete" || outcome === "existing-file" ? ["atomic-ready.json"] : outcome === "existing-symlink" ? ["atomic-ready.json", "sentinel.json"] : [])
      assert.equal(process.umask(), previousMask)
      await new Promise<void>(resolve => setImmediate(resolve))
      for (const socket of [status, acknowledgement, descendantReady]) {
        assert.equal(socket.destroyed, true)
        for (const event of ["data", "end", "error", "close"]) assert.equal(socket.listenerCount(event), 0)
      }
      assert.equal(descendant.listenerCount("exit"), 0)
      assert.equal(descendant.listenerCount("error"), 0)
    } finally {
      gate.resolve()
      await waitUntil(async () => status.destroyed, "provider did not settle after the preparation gate released", 1000)
      for (const socket of [status, acknowledgement, descendantReady]) socket.destroy()
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  })
}

for (const missingAcknowledgement of [false, true]) {
  darwinTest(`retains publication write-error handling through descendant cleanup with ${missingAcknowledgement ? "missing" : "present"} acknowledgement fd`, async () => {
    const writeFailure = new Error("deterministic publication write failure")
    const observedErrors: Error[] = []
    const retainedListeners: number[] = []
    const status = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback(writeFailure)
      },
    })
    const acknowledgement = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
    const observer = (error: Error): void => {
      observedErrors.push(error)
      retainedListeners.push(status.listenerCount("error") - 1)
    }
    status.on("error", observer)
    let descendantExited = false
    class ScriptedDescendant extends EventEmitter {
      readonly pid = 44002
      readonly exitCode = null
      readonly signalCode = null
      readonly stdio = [null, null, null, new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })]

      kill(signal: NodeJS.Signals): boolean {
        assert.equal(signal, "SIGKILL")
        setImmediate(() => {
          retainedListeners.push(status.listenerCount("error") - 1)
          descendantExited = true
          this.emit("exit", null, signal)
        })
        return true
      }
    }
    const descendant = new ScriptedDescendant()
    await assert.rejects(providerLeader("unused-ready-file", "normal", 1000, {
      spawnDescendant: () => descendant as unknown as ChildProcess,
      socketForFd: fd => {
        if (fd === 3) return status
        if (missingAcknowledgement) throw new Error("deterministic missing acknowledgement fd")
        return acknowledgement
      },
    }), missingAcknowledgement ? /missing acknowledgement fd/ : /publication write failure/)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(descendantExited, true)
    assert.deepEqual(observedErrors, [writeFailure])
    assert.equal(retainedListeners.length, 2)
    assert.ok(retainedListeners.every(count => count > 0), `publication error handler missing before cleanup: ${retainedListeners}`)
    assert.equal(status.destroyed, true)
    status.off("error", observer)
    assert.equal(status.listenerCount("error"), 0)
    assert.equal(status.listenerCount("close"), 0)
    assert.equal(descendant.listenerCount("exit"), 0)
    assert.equal(descendant.listenerCount("error"), 0)
    acknowledgement.destroy()
  })
}

darwinTest("rejects acknowledgement end callback errors after safely closing the stream", async () => {
  const writeFailure = new Error("deterministic acknowledgement write failure")
  const observedErrors: Error[] = []
  const retainedListeners: number[] = []
  const acknowledgement = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback(writeFailure)
    },
  })
  const observer = (error: Error): void => {
    observedErrors.push(error)
    retainedListeners.push(acknowledgement.listenerCount("error") - 1)
  }
  acknowledgement.on("error", observer)
  const child = { stdio: [null, null, null, null, acknowledgement] } as unknown as ChildProcess
  await assert.rejects(acknowledgeProvider(child), /acknowledgement write failure/)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(observedErrors, [writeFailure])
  assert.ok(retainedListeners.every(count => count > 0), `acknowledgement error handler missing before close: ${retainedListeners}`)
  assert.equal(acknowledgement.closed, true)
  acknowledgement.off("error", observer)
  assert.equal(acknowledgement.listenerCount("error"), 0)
  assert.equal(acknowledgement.listenerCount("close"), 0)
})

darwinTest("settles acknowledgement failure when its stream already emitted close", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const acknowledgement = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
  acknowledgement.destroy()
  await new Promise<void>(resolve => setImmediate(resolve))
  const child = { stdio: [null, null, null, null, acknowledgement] } as unknown as ChildProcess
  let failure: unknown
  const result = acknowledgeProvider(child).then(() => assert.fail("closed acknowledgement accepted"), error => { failure = error })
  t.mock.timers.tick(1000)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(failure instanceof Error, "acknowledgement remained pending after its deadline and prior close")
  await result
  assert.equal(acknowledgement.listenerCount("error"), 0)
  assert.equal(acknowledgement.listenerCount("close"), 0)
})

darwinTest("drains all 32 contender starts and aggregates failures before returning", async () => {
  const gates = Array.from({ length: 32 }, () => Promise.withResolvers<number>())
  let settled = false
  const outcome = settleStarts(gates.map(gate => gate.promise)).then(
    value => { settled = true; return value },
    error => { settled = true; return error as unknown },
  )
  gates[0]!.reject(new Error("first contender failed"))
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(settled, false, "a failed contender escaped before queued starts drained")
  } finally {
    for (let index = 1; index < 31; index += 1) gates[index]!.resolve(index)
    gates[31]!.reject(new Error("last contender failed"))
  }
  const failure = await outcome
  assert.ok(failure instanceof AggregateError)
  assert.deepEqual(failure.errors.map(String), ["Error: first contender failed", "Error: last contender failed"])
})

for (const count of [32, 1]) {
  darwinTest(`drains ${count === 32 ? "contender starts" : "replacementStart"} in the registered after hook before fixture discovery and root removal`, async t => {
    const hooks: Array<() => Promise<void>> = []
    const scope = await FixtureScope.create({ after: (hook: () => Promise<void>) => hooks.push(hook) } as unknown as TestContext)
    const gate = Promise.withResolvers<void>()
    const events: string[] = []
    const discovery = scope["discoverHandlers"].bind(scope)
    scope["discoverHandlers"] = async () => {
      events.push("discover")
      await discovery()
    }
    const starts = Array.from({ length: count }, (_, index) => scope.start(async () => {
      await gate.promise
      events.push(`started:${index}`)
      assert.equal(await exists(scope.root), true)
    }))
    const completion = Promise.allSettled(starts)
    const teardown = hooks[0]!()
    const cleanup = teardown.then(() => undefined, error => error as unknown)
    t.after(async () => {
      gate.resolve()
      await completion
      await cleanup
      await rm(scope.root, { recursive: true, force: true })
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    const beforeRelease = [...events]
    gate.resolve()
    const results = await completion
    assert.equal(await cleanup, undefined)
    assert.deepEqual(beforeRelease, [], "fixture discovery ran while startup was pending")
    assert.deepEqual(events, [...Array.from({ length: count }, (_, index) => `started:${index}`), "discover"])
    assert.ok(results.every(result => result.status === "fulfilled"))
    assert.equal(await exists(scope.root), false)
  })
}

darwinTest("bounds independent survivor ps execution with the qualification command options", async () => {
  const calls: Array<{ file: string; args: string[]; options: ExecFileOptionsWithStringEncoding }> = []
  assert.deepEqual(await independentFixtureSurvivors((file, args, options, callback) => {
    calls.push({ file, args, options })
    callback(null, "")
  }), [])
  assert.deepEqual(calls, [{
    file: "/bin/ps",
    args: ["-axo", "pid=,command="],
    options: { encoding: "utf8", env: { LANG: "C", TZ: "UTC" }, maxBuffer: 1024 * 1024, shell: false, timeout: 2000 },
  }])
})

darwinTest("rejects independent survivor ps timeout at its fixed deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const timeoutFailure = new Error("ps command timed out")
  let failure: unknown
  const scan = independentFixtureSurvivors((_file, _args, options, callback) => {
    setTimeout(() => callback(timeoutFailure, ""), options.timeout ?? 1_000_000)
  }).then(() => assert.fail("ps timeout was ignored"), error => { failure = error })
  t.mock.timers.tick(1999)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(failure, undefined)
  t.mock.timers.tick(1)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(failure, timeoutFailure, "independent ps observation exceeded 2000 ms")
  await scan
})

for (const terminal of ["end", "error", "close", "timeout"] as const) {
  darwinTest(`settles socket exchange on ${terminal} with no timer or listener survivors`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const socket = new Duplex({ autoDestroy: false, read() {}, write(_chunk, _encoding, callback) { callback() } })
    const destroyed = t.mock.method(socket, "destroy", socket.destroy.bind(socket))
    const result = exchange("scripted-socket", () => socket).then(value => ({ value }), error => ({ error: error as Error }))
    socket.emit("connect")
    if (terminal === "end") {
      socket.push(Buffer.from("pong"))
      socket.push(null)
    } else if (terminal === "error") socket.destroy(new Error("scripted socket failure"))
    else if (terminal === "close") socket.destroy()
    else t.mock.timers.tick(5000)
    await new Promise<void>(resolve => setImmediate(resolve))
    if (terminal === "close") t.mock.timers.tick(5000)
    const outcome = await result
    try {
      if (terminal === "end") assert.deepEqual(outcome, { value: "pong" })
      else {
        assert.ok("error" in outcome)
        assert.match(outcome.error.message, terminal === "error" ? /scripted socket failure/ : terminal === "close" ? /closed/ : /timed out/)
      }
      assert.equal(socket.destroyed, true)
      for (const event of ["connect", "data", "end", "error", "close"]) assert.equal(socket.listenerCount(event), 0, `${event} listener survived ${terminal}`)
      const calls = destroyed.mock.callCount()
      t.mock.timers.tick(5000)
      assert.equal(destroyed.mock.callCount(), calls, "socket timeout survived settlement")
    } finally {
      socket.removeAllListeners()
      socket.destroy()
    }
  })
}

qualificationTest("provider publication pipe closure self-cleans the unacknowledged tree", async t => {
  const scope = await FixtureScope.create(t)
  const launchAttemptId = randomUUID()
  const marker = agencyLaunchMarker("provider", launchAttemptId)
  const readyPath = join(scope.root, "publication-closed-ready.json")
  const child = spawn(node, [providerFixture, "leader", readyPath, "normal", "1000"], { argv0: marker, detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] })
  assert.notEqual(child.pid, undefined)
  scope.track("publication-closed provider", marker, child.pid!)
  const leader = await waitFor(() => adapter.readProcess(child.pid!), "publication-closed provider leader was not observable")
  assertLeader(leader, marker)
  const members = await waitFor(async () => {
    const current = await stableGroup(leader.processGroupId)
    return current.length >= 2 ? current : null
  }, "publication-closed provider descendant was not observable")
  const evidence = scope.register("publication-closed provider", marker, leader, members)
  childPipe(child, 3).destroy()
  const exit = await waitChild(child, 1500)
  assert.notEqual(exit.code, 0)
  await waitUntil(async () => (await adapter.readGroup(leader.processGroupId)).length === 0, "publication-closed provider tree survived", 1000)
  for (const identity of evidence.members) assert.equal(await adapter.readProcess(identity.pid), null)
  assert.equal(await exists(readyPath), false)
  childPipe(child, 4).destroy()
})

qualificationTest("provider missing acknowledgement descriptor self-cleans the unacknowledged tree", async t => {
  const scope = await FixtureScope.create(t)
  const launchAttemptId = randomUUID()
  const marker = agencyLaunchMarker("provider", launchAttemptId)
  const readyPath = join(scope.root, "acknowledgement-missing-ready.json")
  const child = spawn(node, [providerFixture, "leader", readyPath, "normal", "1000"], { argv0: marker, detached: true, stdio: ["ignore", "ignore", "pipe", "pipe"] })
  if (child.pid === undefined) throw new Error("acknowledgement-missing provider pid is unavailable")
  scope.track("acknowledgement-missing provider", marker, child.pid)
  const leader = await waitFor(() => adapter.readProcess(child.pid!), "acknowledgement-missing provider leader was not observable")
  const members = await waitFor(async () => {
    const current = await stableGroup(leader.processGroupId)
    return current.length >= 2 ? current : null
  }, "acknowledgement-missing provider descendant was not observable")
  const evidence = scope.register("acknowledgement-missing provider", marker, leader, members)
  assertLeader(evidence.leader, marker)
  const structural = await readProviderStructural(child, "acknowledgement-missing provider")
  assert.equal(structural.leaderPid, evidence.leader.pid)
  assert.equal(evidence.members.some(member => member.pid === structural.descendantPid), true)
  childPipe(child, 3).destroy()
  const exit = await waitChild(child, 1500)
  assert.notEqual(exit.code, 0)
  await waitUntil(async () => (await adapter.readGroup(evidence.leader.processGroupId)).length === 0, "acknowledgement-missing provider tree survived", 1000)
  for (const identity of evidence.members) assert.equal(await adapter.readProcess(identity.pid), null)
  assert.equal(await exists(readyPath), false)
})

qualificationTest("provider acknowledgement pipe closure self-cleans the published tree", async t => {
  const scope = await FixtureScope.create(t)
  const launchAttemptId = randomUUID()
  const marker = agencyLaunchMarker("provider", launchAttemptId)
  const readyPath = join(scope.root, "acknowledgement-closed-ready.json")
  const child = spawn(node, [providerFixture, "leader", readyPath, "normal", "1000"], { argv0: marker, detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] })
  assert.notEqual(child.pid, undefined)
  scope.track("acknowledgement-closed provider", marker, child.pid!)
  const structural = await readProviderStructural(child, "acknowledgement-closed provider")
  const evidence = await registerProvider(child, scope, "acknowledgement-closed provider", marker, structural, child.pid!)
  childPipe(child, 4).destroy()
  const exit = await waitChild(child, 1500)
  assert.notEqual(exit.code, 0)
  await waitUntil(async () => (await adapter.readGroup(evidence.leader.processGroupId)).length === 0, "acknowledgement-closed provider tree survived", 1000)
  for (const identity of evidence.members) assert.equal(await adapter.readProcess(identity.pid), null)
  assert.equal(await exists(readyPath), false)
  childPipe(child, 3).destroy()
})

qualificationTest("provider registration closes acknowledgement on an unauthorized member", async t => {
  const scope = await FixtureScope.create(t)
  const launchAttemptId = randomUUID()
  const marker = agencyLaunchMarker("provider", launchAttemptId)
  const readyPath = join(scope.root, "unauthorized-registration-ready.json")
  const child = spawn(node, [providerFixture, "leader", readyPath, "normal", "1000"], { argv0: marker, detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] })
  assert.notEqual(child.pid, undefined)
  scope.track("unauthorized-registration provider", marker, child.pid!)
  const structural = await readProviderStructural(child, "unauthorized-registration provider")
  const leader = await waitFor(() => adapter.readProcess(structural.leaderPid), "unauthorized-registration provider leader was not observable")
  assertLeader(leader, marker)
  const members = await waitFor(async () => {
    const current = await stableGroup(leader.processGroupId)
    return current.some(member => member.pid === structural.descendantPid) ? current : null
  }, "unauthorized-registration provider descendant was not observable")
  scope.register("unauthorized-registration provider cleanup", marker, leader, members)
  const signals: Array<{ processGroupId: number; signal: NodeJS.Signals }> = []
  const unauthorized: PlatformAdapter = {
    ...adapter,
    readGroup: async processGroupId => (await adapter.readGroup(processGroupId)).map(member => member.pid === structural.descendantPid ? { ...member, uid: member.uid + 1 } : member),
    signalGroup: async (processGroupId, signal) => {
      signals.push({ processGroupId, signal })
    },
  }
  await assert.rejects(registerProvider(child, scope, "unauthorized-registration provider", marker, structural, child.pid!, unauthorized))
  assert.deepEqual(signals, [])
  const exit = await waitChild(child, 1500)
  assert.notEqual(exit.code, 0)
  await waitUntil(async () => (await adapter.readGroup(leader.processGroupId)).length === 0, "unauthorized-registration provider tree survived", 1000)
  assert.equal(await exists(readyPath), false)
  childPipe(child, 3).destroy()
  childPipe(child, 4).destroy()
})

qualificationTest("Handler acknowledgement pipe closure self-cleans its provider tree", async t => {
  const scope = await FixtureScope.create(t)
  const handlerLaunchAttemptId = randomUUID()
  const handlerMarker = agencyLaunchMarker("handler", handlerLaunchAttemptId)
  const recordPath = join(scope.root, "handler-acknowledgement-closed-launch.json")
  const configPath = join(scope.root, "handler-acknowledgement-closed.json")
  const providerReadyPath = join(scope.root, "handler-acknowledgement-closed-ready.json")
  await writePrivateFile(configPath, JSON.stringify({ phase: "active", recordPath, providerReadyPath, providerMode: "normal", timeoutMs: 2000 }))
  const child = spawn(node, [handlerFixture, configPath], { argv0: handlerMarker, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] })
  assert.notEqual(child.pid, undefined)
  scope.track("acknowledgement-closed Handler", handlerMarker, child.pid!)
  const structural = await readProviderStructural(child, "Handler acknowledgement-closed provider")
  const record = await readLaunchRecord(recordPath)
  const providerMarker = agencyLaunchMarker("provider", record.launchAttemptId)
  scope.track("Handler acknowledgement-closed provider", providerMarker, structural.leaderPid)
  const evidence = await registerProvider(child, scope, "Handler acknowledgement-closed provider", providerMarker, structural, structural.leaderPid)
  const handler = await waitFor(() => adapter.readProcess(child.pid!), "acknowledgement-closed Handler was not observable")
  assertLeader(handler, handlerMarker)
  scope.register("acknowledgement-closed Handler", handlerMarker, handler, [handler])
  childPipe(child, 4).destroy()
  await waitUntil(async () => (await adapter.readGroup(evidence.leader.processGroupId)).length === 0, "Handler acknowledgement-closed provider tree survived", 1000)
  for (const identity of evidence.members) assert.equal(await adapter.readProcess(identity.pid), null)
  await killExactHandler(handler)
  assert.equal(await exists(providerReadyPath), false)
})

qualificationTest("bounds the singleton Handler launch gate by timeoutMs", async t => {
  const scope = await FixtureScope.create(t)
  const retainedDirectory = join(scope.root, "retained")
  await makePrivateDirectory(retainedDirectory)
  const handlerLog = join(scope.root, "gate-timeout-handlers.jsonl")
  scope.identityLogs.add(handlerLog)
  const timeoutMs = 150
  const bootId = await adapter.bootId()
  const launchAttemptId = randomUUID()
  const generation = randomUUID()
  const hostId = "gate-timeout-host"
  const recordPath = join(scope.root, "handler.json")
  const configPath = join(scope.root, "gate-timeout.json")
  await writePrivateHandlerRecord(recordPath, pendingHandlerRecord(scope.root, hostId, bootId, launchAttemptId, generation))
  await writePrivateFile(configPath, JSON.stringify({ root: scope.root, bootId, hostId, handlerLog, retainedDirectory, adapterMode: "darwin-real", timeoutMs }))
  const marker = agencyLaunchMarker("handler", launchAttemptId)
  const child = spawn(node, [singletonFixture, "handler", configPath], {
    argv0: marker,
    detached: true,
    env: { ...process.env, AGENCY_HANDLER_RECORD: recordPath, AGENCY_HANDLER_GENERATION: generation },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  })
  assert.notEqual(child.pid, undefined)
  scope.track("gate-timeout Handler", marker, child.pid!)
  const frame = JSON.parse(await readLine(childPipe(child, 3))) as HandlerIdentityFrame
  assert.equal(frame.type, "identity")
  assert.equal(frame.identity.pid, child.pid)
  assertLeader(frame.identity, marker)
  scope.register("gate-timeout Handler", marker, frame.identity, [frame.identity])
  const started = Date.now()
  const exit = await waitChild(child, 1000)
  const elapsed = Date.now() - started
  assert.deepEqual(exit, { code: 0, signal: null })
  assert.ok(elapsed >= timeoutMs - 25)
  assert.ok(elapsed < 750)
  assert.equal(await adapter.readProcess(frame.identity.pid), null)
  assert.equal(await exists(join(scope.root, "handler.sock")), false)
  childPipe(child, 3).destroy()
  childPipe(child, 4).destroy()
})

qualificationTest("bounds singleton Handler phase pauses by timeoutMs", async t => {
  const scope = await FixtureScope.create(t)
  const retainedDirectory = join(scope.root, "retained")
  await makePrivateDirectory(retainedDirectory)
  const handlerLog = join(scope.root, "pause-timeout-handlers.jsonl")
  const eventLog = join(scope.root, "pause-timeout-events.log")
  const releasePath = join(scope.root, "release-never-created")
  scope.identityLogs.add(handlerLog)
  const timeoutMs = 200
  const bootId = await adapter.bootId()
  const launchAttemptId = randomUUID()
  const generation = randomUUID()
  const hostId = "pause-timeout-host"
  const recordPath = join(scope.root, "handler.json")
  const config = { root: scope.root, bootId, hostId, handlerLog, retainedDirectory, adapterMode: "darwin-real", timeoutMs, eventLog, releasePath, handlerPauseAt: "before_socket_bind" }
  const configPath = join(scope.root, "pause-timeout.json")
  await writePrivateFile(configPath, JSON.stringify(config))
  await writePrivateHandlerRecord(recordPath, pendingHandlerRecord(scope.root, hostId, bootId, launchAttemptId, generation))
  const marker = agencyLaunchMarker("handler", launchAttemptId)
  const child = spawn(node, [singletonFixture, "handler", configPath], {
    argv0: marker,
    detached: true,
    env: { ...process.env, AGENCY_HANDLER_RECORD: recordPath, AGENCY_HANDLER_GENERATION: generation },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  })
  assert.notEqual(child.pid, undefined)
  scope.track("pause-timeout Handler", marker, child.pid!)
  const frame = JSON.parse(await readLine(childPipe(child, 3))) as HandlerIdentityFrame
  assert.equal(frame.type, "identity")
  assertLeader(frame.identity, marker)
  scope.register("pause-timeout Handler", marker, frame.identity, [frame.identity])
  await writePrivateHandlerRecord(recordPath, { ...pendingHandlerRecord(scope.root, hostId, bootId, launchAttemptId, generation), phase: "identity_published", process: frame.identity })
  childPipe(child, 4).end("start\n")
  const released = JSON.parse(await readLine(childPipe(child, 3))) as { type: string; generation: string }
  assert.deepEqual(released, { type: "gate_released", generation })
  await waitFor(async () => (await lines(eventLog)).includes("handler:before_socket_bind") ? true : null, "pause-timeout Handler did not reach its pause", 500)
  const started = Date.now()
  const exit = await waitChild(child, 1000)
  const elapsed = Date.now() - started
  assert.notEqual(exit.code, 0)
  assert.ok(elapsed >= timeoutMs - 25)
  assert.ok(elapsed < 750)
  assert.equal(await adapter.readProcess(frame.identity.pid), null)
  assert.equal(await exists(join(scope.root, "handler.sock")), false)
  childPipe(child, 3).destroy()
  childPipe(child, 4).destroy()
})

qualificationTest("bounds singleton launcher transition pauses by timeoutMs", async t => {
  const scope = await FixtureScope.create(t)
  const root = scope.root
  const retainedDirectory = join(root, "retained")
  await makePrivateDirectory(retainedDirectory)
  const handlerLog = join(root, "launcher-pause-timeout-handlers.jsonl")
  const eventLog = join(root, "launcher-pause-timeout-events.log")
  const resultPath = join(root, "launcher-pause-timeout-result.json")
  const releasePath = join(root, "release-never-created")
  const timeoutMs = 200
  const configPath = join(root, "launcher-pause-timeout.json")
  scope.identityLogs.add(handlerLog)
  await writePrivateFile(configPath, JSON.stringify({ root, bootId: await adapter.bootId(), hostId: "launcher-pause-timeout-host", handlerLog, retainedDirectory, adapterMode: "darwin-real", timeoutMs, lockTimeoutSeconds: 2, eventLog, resultPath, releasePath, launcherPauseAt: "lock_acquired" }))
  const launchAttemptId = randomUUID()
  const marker = agencyLaunchMarker("handler", launchAttemptId)
  const started = Date.now()
  const child = spawn(node, [singletonFixture, "contender", configPath], { argv0: marker, detached: true, stdio: ["ignore", "ignore", "pipe"] })
  if (child.pid === undefined) throw new Error("launcher pause contender pid is unavailable")
  scope.track("launcher pause contender", marker, child.pid)
  const exit = await waitChild(child, 1000)
  const elapsed = Date.now() - started
  assert.equal(exit.signal, null)
  assert.notEqual(exit.code, null)
  assert.notEqual(exit.code, 0)
  assert.ok(elapsed >= timeoutMs - 25)
  assert.ok(elapsed < 750)
  assert.ok((await lines(eventLog)).includes("launcher:lock_acquired"))
  assert.equal(await readProcessSettled(child.pid, 1000), null)
  assert.deepEqual(await stableGroup(child.pid), [])
  const result = await readJson<{ ok: boolean; error: string }>(resultPath)
  assert.equal(result.ok, false)
  assert.match(result.error, /launcher lock_acquired pause timed out/)
  assert.deepEqual(await lines(handlerLog), [])
  assert.equal(await exists(join(root, "handler.sock")), false)
  child.stderr?.destroy()
})

qualificationTest("independent survivor scan detects a registered fixture command", async t => {
  const scope = await FixtureScope.create(t)
  const fixture = await spawnProvider(scope, "survivor scan provider")
  const hits: Array<{ pid: number; command: string }> = await waitFor(async () => {
    const current: Array<{ pid: number; command: string }> = await independentFixtureSurvivors()
    return current.some(hit => hit.pid === fixture.leader.pid) ? current : null
  }, "independent survivor scan missed a registered fixture command")
  assert.equal(hits.some(hit => hit.pid === fixture.leader.pid && hit.command.includes(providerFixture)), true)
  await cleanupEvidence(fixture.evidence)
  assert.equal((await independentFixtureSurvivors()).some(hit => fixture.members.some(member => member.pid === hit.pid)), false)
})

darwinTest("resolves production Darwin paths from the real host identity without launching there", async t => {
  const scope = await FixtureScope.create(t)
  const hostKey = await readHostId("darwin")
  assert.match(hostKey, /^[0-9a-f]{64}$/)
  const home = homedir()
  const configuredStateHome = process.env.XDG_STATE_HOME
  const xdgStateHome = configuredStateHome === undefined || configuredStateHome.length === 0 ? undefined : configuredStateHome
  assert.equal(isAbsolute(home), true)
  if (xdgStateHome !== undefined) assert.equal(isAbsolute(xdgStateHome), true)
  const persistentBase = xdgStateHome ?? join(home, ".local/state")
  const persistentPath = join(persistentBase, "agency", "hosts", hostKey)
  const runtimePath = join("/private/tmp", `agy-${process.getuid!()}-${hostKey.slice(0, 12)}`)
  const runtimeExisted = await exists(runtimePath)
  const handlerRecordPath = join(runtimePath, "handler.json")
  const handlerRecordState = await fileState(handlerRecordPath)
  const paths = await withPrivateUmask(() => resolvePlatformPaths({ platform: "darwin", uid: process.getuid!(), hostKey, home, ...(xdgStateHome === undefined ? {} : { xdgStateHome }) }))
  if (!runtimeExisted) scope.emptyRoots.add(paths.runtimeRoot)
  assert.equal(paths.hostKey, hostKey)
  assert.equal(paths.persistentRoot, persistentPath)
  assert.equal(paths.runtimeRoot, runtimePath)
  assert.equal(paths.handlerSocketPath, join(runtimePath, "handler.sock"))
  assert.ok(Buffer.byteLength(paths.handlerSocketPath, "utf8") < 100)
  for (const path of [paths.persistentRoot, paths.runtimeRoot]) {
    const stats = await lstat(path)
    assert.equal(stats.uid, process.getuid!())
    assert.equal(stats.mode & 0o777, 0o700)
    assert.equal(await realpath(path), path)
  }
  assert.deepEqual(await fileState(handlerRecordPath), handlerRecordState)
})

qualificationTest("converges 32 real lockf contenders and replaces an exactly dead Handler before retained classification", async t => {
  const scope = await FixtureScope.create(t)
  const retainedDirectory = join(scope.root, "retained")
  await makePrivateDirectory(retainedDirectory)
  const handlerLog = join(scope.root, "handlers.jsonl")
  const eventLog = join(scope.root, "events.log")
  const releasePath = join(scope.root, "release")
  scope.identityLogs.add(handlerLog)
  const config: FixtureConfig = {
    root: scope.root,
    bootId: "unused-real-darwin-boot",
    hostId: "real-darwin-host",
    handlerLog,
    retainedDirectory,
    adapterMode: "darwin-real",
    response: "pong",
    timeoutMs: 10000,
    lockTimeoutSeconds: 15,
    eventLog,
    releasePath,
    handlerPauseAt: "after_first_reconciliation",
  }
  const configPath = join(scope.root, "singleton.json")
  await writePrivateFile(configPath, JSON.stringify(config))
  const starts = await withPrivateUmask(() => settleStarts(Array.from({ length: 32 }, () => scope.start(() => startOrConnect({
    root: scope.root,
    hostId: config.hostId,
    adapter,
    handler: singletonCommand(configPath),
    timeoutMs: config.timeoutMs,
    lockTimeoutSeconds: config.lockTimeoutSeconds,
  })))))
  assert.equal(new Set(starts.map(result => result.record.generation)).size, 1)
  assertContenderConvergence(starts, await lines(handlerLog))
  assert.ok(starts.every(result => result.disposition === "live" && result.record.phase === "ready"))
  const first = starts[0]!.record
  assert.notEqual(first.process, null)
  assert.equal(exactMarker(first.process!, agencyLaunchMarker("handler", first.launchAttemptId)), true)
  scope.register("singleton first Handler", agencyLaunchMarker("handler", first.launchAttemptId), first.process!, [first.process!])
  await killExactHandler(first.process!)
  assert.equal((await lstat(first.socketPath)).isSocket(), true)
  const clean = await spawnProvider(scope, "singleton cleanup provider")
  const ambiguous = await spawnProvider(scope, "singleton quarantine provider")
  const cleanPath = join(retainedDirectory, "a-clean.json")
  const ambiguousPath = join(retainedDirectory, "b-ambiguous.json")
  await writePrivateLaunchRecord(cleanPath, clean.record)
  const wrongMarker = agencyLaunchMarker("provider", randomUUID())
  await writePrivateLaunchRecord(ambiguousPath, mutateProvider(ambiguous.record, identity => changeMarker(identity, wrongMarker)))
  const replacementStart = scope.start(() => withPrivateUmask(() => startOrConnect({
    root: scope.root,
    hostId: config.hostId,
    adapter,
    handler: singletonCommand(configPath),
    timeoutMs: config.timeoutMs,
    lockTimeoutSeconds: config.lockTimeoutSeconds,
  })))
  await waitFor(async () => (await lines(eventLog)).includes("handler:after_first_reconciliation") ? true : null, "replacement Handler did not pause after first classification", 10000)
  const reconciling = await readHandlerRecord(join(scope.root, "handler.json"))
  assert.equal(reconciling.phase, "reconciling")
  assert.deepEqual(reconciling.reconciliation, { classified: 1, total: 2, quarantined: 0 })
  assert.equal((await readLaunchRecord(cleanPath)).phase, "cleanup_verified")
  assert.equal((await readLaunchRecord(ambiguousPath)).phase, "active")
  await writePrivateFile(releasePath, "release")
  const replacement = await replacementStart
  assert.equal(replacement.disposition, "live")
  assert.equal(replacement.record.phase, "ready")
  assert.notEqual(replacement.record.generation, first.generation)
  assert.deepEqual(replacement.record.reconciliation, { classified: 2, total: 2, quarantined: 1 })
  assert.equal((await readLaunchRecord(cleanPath)).phase, "cleanup_verified")
  assert.equal((await readLaunchRecord(ambiguousPath)).phase, "quarantined")
  assert.deepEqual(await adapter.readGroup(clean.leader.processGroupId), [])
  assert.ok((await adapter.readGroup(ambiguous.leader.processGroupId)).length > 0)
  assert.equal(await exchange(replacement.record.socketPath), "pong")
  assert.notEqual(replacement.record.process, null)
  scope.register("singleton replacement Handler", agencyLaunchMarker("handler", replacement.record.launchAttemptId), replacement.record.process!, [replacement.record.process!])
})

qualificationTest("classifies every Handler crash boundary with exact death confirmation", async t => {
  for (const phase of ["before-spawn", "after-attempt", "identity-published", "readiness", "active"] as const) {
    await t.test(phase, async t => {
      const scope = await FixtureScope.create(t)
      const crashed = await crashHandler(scope, phase)
      const tracking = signalTracking(adapter)
      const result = await reconcilePrivateRecord(crashed.recordPath, tracking.adapter)
      const expected = phase === "before-spawn" ? "released" : phase === "after-attempt" ? "quarantined" : "cleaned"
      assert.equal(result.disposition, expected)
      assert.deepEqual(result.record, await readLaunchRecord(crashed.recordPath))
      if (phase === "before-spawn" || phase === "after-attempt") assert.deepEqual(tracking.signals, [])
      else {
        assert.ok(tracking.signals.length >= 1)
        assert.deepEqual(await adapter.readGroup(crashed.frame.provider!.leader.processGroupId), [])
      }
      if (phase === "after-attempt") {
        assert.notEqual(crashed.evidence, null)
        assert.ok((await adapter.readGroup(crashed.evidence!.leader.processGroupId)).length > 0)
      }
    })
  }
})

qualificationTest("uses retained-member continuity for real leaderless TERM-to-KILL cleanup", async t => {
  const scope = await FixtureScope.create(t)
  const crashed = await crashHandler(scope, "active", "leader-exits-on-term")
  assert.notEqual(crashed.frame.provider, null)
  assert.ok(crashed.frame.provider!.members.length >= 2)
  const tracking = signalTracking(adapter)
  const result = await reconcilePrivateRecord(crashed.recordPath, tracking.adapter)
  assert.equal(result.disposition, "cleaned")
  assert.deepEqual(tracking.signals, ["SIGTERM", "SIGKILL"])
  assert.equal(await adapter.readProcess(crashed.frame.provider!.leader.pid), null)
  assert.deepEqual(await adapter.readGroup(crashed.frame.provider!.leader.processGroupId), [])
  assert.deepEqual(await adapter.readGroup(crashed.frame.provider!.leader.processGroupId), [])
})

qualificationTest("quarantines altered live identities without signaling", async t => {
  const cases: Array<{ name: string; mutate: (identity: ProcessIdentity) => ProcessIdentity }> = [
    { name: "wrong-marker", mutate: identity => changeMarker(identity, agencyLaunchMarker("provider", randomUUID())) },
    { name: "altered-start-time", mutate: identity => ({ ...identity, birth: `${Number(identity.birth.slice(0, identity.birth.indexOf(":"))) + 1}:${identity.birth.slice(identity.birth.indexOf(":") + 1)}` }) },
    { name: "missing-marker", mutate: identity => changeMarker(identity, "unmarked:/Users/fixture/provider") },
    { name: "truncated-marker", mutate: identity => changeMarker(identity, agencyLaunchMarker("provider", randomUUID()).slice(0, -1)) },
    { name: "pid-pgid-mismatch", mutate: identity => ({ ...identity, processGroupId: identity.processGroupId + 1 }) },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async t => {
      const scope = await FixtureScope.create(t)
      const fixture = await spawnProvider(scope, `altered ${scenario.name}`)
      const path = join(scope.root, `${scenario.name}.json`)
      await writePrivateLaunchRecord(path, mutateProvider(fixture.record, scenario.mutate))
      const tracking = signalTracking(adapter)
      const result = await reconcilePrivateRecord(path, tracking.adapter)
      assert.equal(result.disposition, "quarantined")
      assert.deepEqual(tracking.signals, [])
      const current = await adapter.readProcess(fixture.leader.pid)
      assert.notEqual(current, null)
      assert.equal(sameProcess(fixture.leader, current!), true)
    })
  }
})

qualificationTest("quarantines malformed repeated ps snapshots without signaling", async t => {
  const scope = await FixtureScope.create(t)
  const fixture = await spawnProvider(scope, "malformed snapshot provider")
  const path = join(scope.root, "malformed-snapshot.json")
  await writePrivateLaunchRecord(path, fixture.record)
  const bootId = await adapter.bootId()
  const execute: DarwinCommandExecutor = async file => file === "/usr/sbin/sysctl" ? { stdout: `${bootId}\n` } : { stdout: "malformed repeated ps snapshot\n" }
  const malformed = createDarwinAdapter(execute)
  const tracking = signalTracking(malformed)
  const result = await reconcilePrivateRecord(path, tracking.adapter)
  assert.equal(result.disposition, "quarantined")
  assert.match(result.record.reason ?? "", /observation|ps|unavailable/i)
  assert.deepEqual(tracking.signals, [])
  assert.notEqual(await adapter.readProcess(fixture.leader.pid), null)
})

qualificationTest("keeps quarantine checkout-scoped while clean read-only classification completes", async t => {
  const scope = await FixtureScope.create(t)
  const fixture = await spawnProvider(scope, "checkout quarantine provider")
  const alteredPath = join(scope.root, "altered-checkout.json")
  const cleanPath = join(scope.root, "clean-checkout.json")
  const altered = mutateProvider(fixture.record, identity => ({ ...identity, birth: `${Number(identity.birth.slice(0, identity.birth.indexOf(":"))) + 1}:${identity.birth.slice(identity.birth.indexOf(":") + 1)}` }))
  await writePrivateLaunchRecord(alteredPath, altered)
  await writePrivateLaunchRecord(cleanPath, baseRecord(randomUUID(), fixture.leader.bootId, { checkoutId: "second-clean-checkout", launchAttempted: false, phase: "launch_pending", provider: null }))
  const alteredTracking = signalTracking(adapter)
  const quarantined = await reconcilePrivateRecord(alteredPath, alteredTracking.adapter)
  const cleanTracking = signalTracking(adapter)
  const released = await reconcilePrivateRecord(cleanPath, cleanTracking.adapter)
  assert.equal(quarantined.disposition, "quarantined")
  assert.equal(released.disposition, "released")
  assert.deepEqual(alteredTracking.signals, [])
  assert.deepEqual(cleanTracking.signals, [])
  const classifications = await Promise.all([alteredPath, cleanPath].map(async path => (await readLaunchRecord(path)).phase))
  assert.deepEqual(classifications, ["quarantined", "cleanup_verified"])
  assert.notEqual(await adapter.readProcess(fixture.leader.pid), null)
})

qualificationTest("records the Darwin qualification trust and race limits", async t => {
  const scope = await FixtureScope.create(t)
  const evidence = {
    startTimeResolution: "seconds",
    markerVisibilityDependency: "the exact argv0 marker must remain visible in the stable ps command token",
    trustBoundary: "the observed Handler and provider run under the trusted current uid and gid",
    sessionIdentity: "the provider session identity is derived from its marked PID-equals-PGID leader",
    residualRace: "stable ps snapshots precede killpg and cannot eliminate the final snapshot-to-signal race",
  }
  const path = join(scope.root, "qualification-limits.json")
  await writePrivateFile(path, JSON.stringify(evidence))
  assert.deepEqual(await readJson(path), evidence)
})

test.after(async () => {
  const failures: unknown[] = []
  const survivors: Array<{ label: string; pid: number }> = []
  for (const evidence of allEvidence) {
    try {
      const leader = await adapter.readProcess(evidence.leader.pid)
      if (leader !== null && sameProcess(evidence.leader, leader)) survivors.push({ label: evidence.label, pid: leader.pid })
      for (const member of await adapter.readGroup(evidence.leader.processGroupId)) {
        if (evidence.members.some(expected => sameProcess(expected, member))) survivors.push({ label: evidence.label, pid: member.pid })
      }
    } catch (error) {
      failures.push(new Error(`final registered fixture observation failed for ${evidence.label}`, { cause: error }))
    }
  }
  for (const pending of allPending) {
    if (pending.resolved) continue
    try {
      const current = await adapter.readProcess(pending.pid)
      if (current !== null && exactMarker(current, pending.marker)) survivors.push({ label: pending.label, pid: pending.pid })
      for (const member of await adapter.readGroup(pending.pid)) survivors.push({ label: pending.label, pid: member.pid })
    } catch (error) {
      failures.push(new Error(`final pending fixture observation failed for ${pending.label}`, { cause: error }))
    }
  }
  try {
    const independent = await independentFixtureSurvivors()
    independentSurvivorCount = independent.length
    if (independent.length > 0) failures.push(new Error(`independent fixture survivors: ${JSON.stringify(independent)}`))
  } catch (error) {
    failures.push(new Error("independent fixture survivor observation failed", { cause: error }))
  }
  finalSurvivorCount = new Set(survivors.map(value => `${value.label}:${value.pid}`)).size
  if (finalSurvivorCount > 0) failures.push(new Error(`registered fixture survivors: ${JSON.stringify(survivors)}`))
  if (failures.length > 0) throw new AggregateError(failures, `fixture survivor verification failed with ${finalSurvivorCount} registered and ${independentSurvivorCount} independent survivors`)
})