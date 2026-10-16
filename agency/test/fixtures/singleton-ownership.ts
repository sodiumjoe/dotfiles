import childProcess, { type ChildProcess } from "node:child_process"
import { Socket } from "node:net"
import type { Duplex } from "node:stream"
import { fileURLToPath } from "node:url"
import { syncBuiltinESMExports } from "node:module"
import { closeSync, constants, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import { cp, lstat, readFile, readlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import { startOrConnect, type StartOrConnectOptions } from "../../src/platform/singleton.js"
import { sameProcess, type PlatformAdapter, type ProcessIdentity } from "../../src/platform/types.js"

export type SingletonLaunch = { launchId: string; role: string }
type LockLaunch = { helper: SingletonLaunch; holder?: SingletonLaunch | undefined; launcherPid: number; root: string }

function record(root: string, value: unknown): void {
  const fd = openSync(join(root, "ownership.jsonl"), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeSync(fd, JSON.stringify({ at: Date.now(), ...value as object }) + "\n"); fsyncSync(fd) } finally { closeSync(fd) }
}

export function createSingletonRecorder(root: string, adapter: PlatformAdapter, signal: (pid: number, signal: NodeJS.Signals) => void = process.kill) {
  const observe = async (launch: SingletonLaunch, pid: number): Promise<ProcessIdentity> => {
    const startedAt = Date.now()
    try {
      const identity = await adapter.readProcess(pid)
      if (identity === null) throw new Error("singleton fixture exited before ownership registration")
      record(root, { type: "identity", ...launch, identity, elapsedMs: Date.now() - startedAt })
      return identity
    } catch (error) {
      record(root, { type: "registration-failure", ...launch, pid, error: String(error) })
      throw error
    }
  }
  return {
    intent(role: string): SingletonLaunch {
      const launch = { launchId: crypto.randomUUID(), role }
      record(root, { type: "intent", ...launch })
      return launch
    },
    observe,
    async spawn(launch: SingletonLaunch, pid: number | undefined): Promise<ProcessIdentity | null> {
      record(root, { type: "spawn", ...launch, pid: pid ?? null })
      if (pid === undefined) { record(root, { type: "no-process", ...launch }); return null }
      return observe(launch, pid)
    },
    async kill(expected: ProcessIdentity, requested: NodeJS.Signals): Promise<void> {
      const observed = await adapter.readProcess(expected.pid)
      if (observed === null) { record(root, { type: "signal-unneeded", expected }); return }
      if (!sameProcess(expected, observed)) {
        record(root, { type: "signal-refused", expected, observed })
        throw new Error("singleton cleanup identity mismatch")
      }
      record(root, { type: "signal-authorized", expected, observed, signal: requested })
      signal(expected.pid, requested)
    },
  }
}

const realAdapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
let root: string | undefined
let fallback = false
let installed = false
let originalSpawn = childProcess.spawn
const observations: Promise<unknown>[] = []
const lockReleases = new WeakSet<object>()
const spawnedHandlers = new Map<number, ChildProcess>()

function evidenceRoot(): string {
  if (root !== undefined) return root
  root = process.env.AGENCY_SINGLETON_EVIDENCE_ROOT ?? process.env.AGENCY_TEST_EVIDENCE_ROOT
  if (root === undefined) {
    root = mkdtempSync(join(process.env.AGENCY_TEST_FIXTURE_ROOT ?? tmpdir(), "singleton-evidence-"))
    fallback = true
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  mkdirSync(join(root, "singleton-registrations"), { recursive: true, mode: 0o700 })
  return root
}

function recorder() { return createSingletonRecorder(evidenceRoot(), realAdapter) }
function registrationPath(launch: SingletonLaunch): string { return join(evidenceRoot(), "singleton-registrations", launch.launchId + ".json") }

function retainSpawn(launch: SingletonLaunch, child: ChildProcess): void {
  record(evidenceRoot(), { type: "spawn", ...launch, pid: child.pid ?? null })
  if (child.pid === undefined) record(evidenceRoot(), { type: "no-process", ...launch })
  child.once("error", error => record(evidenceRoot(), { type: "spawn-error", ...launch, error: String(error) }))
  child.once("exit", (exitCode, signal) => record(evidenceRoot(), { type: "exit", ...launch, pid: child.pid, exitCode, signal }))
}

async function waitRegistration(launch: SingletonLaunch, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5000
  while (true) {
    try { await readFile(registrationPath(launch), "utf8"); return } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) throw new Error("singleton fixture ownership registration did not complete")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

export function installSingletonOwnership(): void {
  if (installed) return
  installed = true
  evidenceRoot()
  originalSpawn = childProcess.spawn
  childProcess.spawn = ((file: string, args: string[], options: childProcess.SpawnOptions) => {
    if (file !== "/usr/bin/lockf" && file !== "/usr/bin/flock") {
      const child = originalSpawn(file, args, options)
      if (args[0] === fileURLToPath(new URL("./singleton-handler.js", import.meta.url)) && args[1] === "handler" && child.pid !== undefined) spawnedHandlers.set(child.pid, child)
      return child
    }
    const helper = recorder().intent("singleton-lock-helper")
    const holder = process.platform === "darwin" ? recorder().intent("singleton-lock-holder") : undefined
    const launch: LockLaunch = { helper, holder, launcherPid: process.pid, root: evidenceRoot() }
    const env = { ...process.env, ...options.env }
    env.NODE_OPTIONS = [env.NODE_OPTIONS, "--import=" + import.meta.url].filter(Boolean).join(" ")
    env.AGENCY_SINGLETON_LOCK_LAUNCH = JSON.stringify(launch)
    env.AGENCY_SINGLETON_EVIDENCE_ROOT = evidenceRoot()
    let child: ChildProcess
    try { child = originalSpawn(file, args, { ...options, env }) } catch (error) {
      void recorder().spawn(helper, undefined)
      if (holder) void recorder().spawn(holder, undefined)
      throw error
    }
    const release = (child.stdio as Array<object | null | undefined>)[5]
    if (release !== null && release !== undefined) lockReleases.add(release)
    retainSpawn(helper, child)
    if (child.pid === undefined && holder) void recorder().spawn(holder, undefined)
    if (child.pid !== undefined) {
      const observation = recorder().observe(helper, child.pid)
      observation.catch(() => undefined)
      observations.push(observation)
      child.once("exit", exitCode => {
        if (exitCode === 75 && holder !== undefined) {
          const rows = readFileSync(join(evidenceRoot(), "ownership.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
          if (!rows.some(row => row.launchId === holder.launchId && row.type === "spawn")) void recorder().spawn(holder, undefined)
        }
      })
    }
    return child
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()
}

export async function ownedStartOrConnect(options: StartOrConnectOptions) {
  let launch: SingletonLaunch | undefined
  let spawned = false
  try {
    return await startOrConnect({ ...options, onTransition: async (transition, pid) => {
      if (transition === "launch_attempt_recorded") launch = recorder().intent("singleton-handler")
      if (transition === "handler_spawned") {
        if (launch === undefined) throw new Error("singleton Handler spawn has no ownership intent")
        spawned = true
        const child = pid === undefined ? undefined : spawnedHandlers.get(pid)
        if (pid !== undefined && child === undefined) throw new Error("singleton Handler has no tracked child")
        if (child === undefined) await recorder().spawn(launch, pid)
        else await recordSingletonChild(launch, child)
      }
      await options.onTransition?.(transition, pid)
    } })
  } catch (error) {
    if (launch !== undefined && !spawned) await recorder().spawn(launch, undefined)
    throw error
  }
}

export async function spawnSingletonContender(fixturePath: string, configPath: string): Promise<ChildProcess> {
  const launch = recorder().intent("singleton-contender")
  const child = originalSpawn(process.execPath, [fixturePath, "contender", configPath], {
    env: { ...process.env, AGENCY_SINGLETON_CONTENDER_LAUNCH: JSON.stringify(launch), AGENCY_SINGLETON_EVIDENCE_ROOT: evidenceRoot() },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  })
  retainSpawn(launch, child)
  try {
    await admitSingletonChild(child, () => waitRegistration(launch, child))
    return child
  } catch (error) {
    record(evidenceRoot(), { type: "registration-failure", ...launch, pid: child.pid, error: String(error), exitCode: child.exitCode, signal: child.signalCode, reaped: child.exitCode !== null || child.signalCode !== null, failures: error instanceof AggregateError ? error.errors.map(String) : undefined })
    throw error
  }
}

export async function registerSingletonContender(): Promise<void> {
  const value = process.env.AGENCY_SINGLETON_CONTENDER_LAUNCH
  delete process.env.AGENCY_SINGLETON_CONTENDER_LAUNCH
  if (value === undefined) throw new Error("singleton contender ownership intent is missing")
  const launch = JSON.parse(value) as SingletonLaunch
  const admission = new Socket({ fd: 3, readable: true, writable: true })
  const admitted = new Promise<void>((resolve, reject) => {
    let buffer = "", settled = false
    admission.on("data", chunk => {
      buffer += String(chunk)
      if (buffer === "admit\n") { settled = true; resolve() }
    })
    const closed = () => { if (!settled) reject(new Error("singleton contender admission closed")) }
    admission.once("end", closed)
    admission.once("close", closed)
    admission.once("error", reject)
  })
  admitted.catch(() => undefined)
  try {
    const identity = await recorder().observe(launch, process.pid)
    await writeFile(registrationPath(launch), JSON.stringify(identity), { mode: 0o600, flag: "wx" })
    await admitted
  } finally {
    admission.destroy()
  }
}

export async function recordSingletonChild(launch: SingletonLaunch, child: ChildProcess): Promise<void> {
  child.once("exit", (exitCode, signal) => record(evidenceRoot(), { type: "exit", ...launch, pid: child.pid, exitCode, signal }))
  try {
    await registerSingletonChildBeforeRelease(child, async () => { await recorder().spawn(launch, child.pid) })
  } catch (error) {
    record(evidenceRoot(), { type: "registration-closure", ...launch, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, reaped: child.exitCode !== null || child.signalCode !== null, failures: error instanceof AggregateError ? error.errors.map(String) : undefined })
    throw error
  }
}

export function isSingletonLockRelease(value: object): boolean { return lockReleases.has(value) }

export function singletonIntent(role: string): SingletonLaunch { return recorder().intent(role) }

export async function killSingletonPid(pid: number, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  const rows = readFileSync(join(evidenceRoot(), "ownership.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  const expected = rows.findLast(row => row.type === "identity" && row.identity.pid === pid)?.identity as ProcessIdentity | undefined
  if (expected === undefined) throw new Error("singleton cleanup has no real ownership identity")
  await recorder().kill(expected, signal)
}

export async function finishSingletonOwnership(): Promise<void> {
  try { await Promise.all(observations) } finally {
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
  const rows = readFileSync(join(evidenceRoot(), "ownership.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  const failures = rows.filter(row => row.type === "registration-failure")
  if (failures.length) throw new Error("singleton ownership registration failed: " + JSON.stringify(failures))
  const intents = rows.filter(row => row.type === "intent" && row.role.startsWith("singleton-"))
  for (const intent of intents) {
    if (!rows.some(row => row.launchId === intent.launchId && (row.type === "identity" || row.type === "no-process"))) throw new Error("singleton ownership intent is unresolved: " + intent.launchId)
  }
  if (fallback) rmSync(evidenceRoot(), { recursive: true, force: true })
}

const lockValue = process.env.AGENCY_SINGLETON_LOCK_LAUNCH
if (lockValue !== undefined) {
  delete process.env.AGENCY_SINGLETON_LOCK_LAUNCH
  const launch = JSON.parse(lockValue) as LockLaunch
  root = launch.root
  try {
    if (launch.holder !== undefined) {
      if (process.ppid === launch.launcherPid) throw new Error("Darwin lock holder has no lockf parent")
      await recorder().observe(launch.helper, process.ppid)
      await recorder().spawn(launch.holder, process.pid)
    } else {
      await recorder().observe(launch.helper, process.pid)
    }
  } catch (error) {
    record(evidenceRoot(), { type: "registration-failure", ...launch.helper, pid: process.pid, error: String(error) })
    process.exit(1)
  }
}

async function closeAndReap(child: ChildProcess, descriptors: number[]): Promise<void> {
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("singleton child did not exit after registration refusal")), 10000)
    child.once("exit", () => { clearTimeout(timer); resolve() })
  })
  for (const descriptor of descriptors) (child.stdio[descriptor] as Duplex | null)?.destroy()
  await exited
}

export async function admitSingletonChild(child: ChildProcess, registered: () => Promise<void>): Promise<void> {
  try {
    await registered()
    const admission = child.stdio[3] as Duplex
    await new Promise<void>((resolve, reject) => {
      admission.once("error", reject)
      admission.end("admit\n", () => { admission.off("error", reject); resolve() })
    })
  } catch (error) {
    await reapRegistrationRefusal(child, [3], error)
  }
}

export async function registerSingletonChildBeforeRelease(child: ChildProcess, registered: () => Promise<void>): Promise<void> {
  try { await registered() } catch (error) {
    await reapRegistrationRefusal(child, [3, 4], error)
  }
}

export async function preserveSingletonFixture(source: string, destination: string): Promise<void> {
  const links: Array<{ path: string; target: string }> = []
  await cp(source, destination, { recursive: true, filter: async path => {
    const observed = await lstat(path)
    if (observed.isSymbolicLink()) {
      links.push({ path: relative(source, path), target: await readlink(path) })
      return false
    }
    return !observed.isSocket()
  } })
  await writeFile(join(destination, "singleton-symlinks.json"), JSON.stringify(links.sort((a, b) => a.path.localeCompare(b.path))), { mode: 0o600, flag: "wx" })
}

async function reapRegistrationRefusal(child: ChildProcess, descriptors: number[], registration: unknown): Promise<never> {
  try { await closeAndReap(child, descriptors) } catch (closure) {
    throw new AggregateError([registration, closure], "singleton registration and closure failed", { cause: registration })
  }
  throw registration
}