import { fixtureRuntime, fixtureSpawner, signalFixturePid } from "./fixtures/fixture-spawn.js"
import { mkdtemp, realpath, rm, mkdir, readFile, writeFile, chown } from "node:fs/promises"
import { join } from "node:path"
import type { TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import type { LaunchRecord, LegacyLaunchRecord } from "../src/platform/types.js"
import assert from "node:assert/strict"
import { createConnection } from "node:net"
import { fileURLToPath } from "node:url"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { createLinuxAdapter } from "../src/platform/linux.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { startOrConnect, type StartTransition } from "../src/platform/singleton.js"
import { sameProcess, type ProcessIdentity } from "../src/platform/types.js"
import { exchange } from "../src/control/wire.js"
import { PROTOCOL, type ControlRequest } from "../src/control/protocol.js"
import type { PlatformPaths } from "../src/platform/paths.js"
import type { ControlDependencies } from "../src/cli/control.js"
import { ControlError } from "../src/control/protocol.js"
import { spawn, type ChildProcess } from "node:child_process"
import type { Duplex } from "node:stream"
import { writeLaunchRecord } from "../src/platform/private-state.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import type { ProviderProfile } from "../src/catalog/types.js"

export function unavailableControlDependencies(): ControlDependencies {
  const unavailable = async (): Promise<never> => { throw new ControlError("UNAVAILABLE") }
  return { environment: unavailable, start: unavailable, inspect: unavailable, call: unavailable, callCatalog: unavailable, receipt: unavailable, inventory: unavailable, cwd: () => { throw new Error("unexpected cwd lookup") }, now: Date.now, sleep: delay, stdout: () => undefined, stderr: () => undefined }
}

export const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("fixture observation timed out")
    await delay(20)
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try { await readFile(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
}

export type ControlFixtureConfig = { paths: PlatformPaths; pauseAt?: string; mutateAt?: string; mutate?: "add" | "replace"; delayMs?: number; failSignalGroup?: number; failSignalMessage?: string; failBootIdOnce?: boolean; catalog?: { profiles: ProviderProfile[]; scenario: "normal" | "uncertain" } }

let fixtureBatchFailure: Error | undefined
export function assertFixtureBatchHealthy(): void {
  if (fixtureBatchFailure !== undefined) throw fixtureBatchFailure
}
export function failFixtureBatch(error: unknown): Error {
  fixtureBatchFailure ??= error instanceof Error ? error : new Error(String(error))
  return fixtureBatchFailure
}

export async function controlFixture(t: TestContext, overrides: Omit<ControlFixtureConfig, "paths"> = {}, handlerFile?: string, handlerEnv?: NodeJS.ProcessEnv) {
  assertFixtureBatchHealthy()
  const root = await mkdtemp(join(await realpath(process.env.AGENCY_TEST_FIXTURE_ROOT ?? "/tmp"), process.env.AGENCY_TEST_FIXTURE_ROOT ? "f-" : "agy-control-"))
  const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  const paths: PlatformPaths = { hostKey: "a".repeat(64), persistentRoot: join(root, "state"), runtimeRoot: join(root, "run"), handlerSocketPath: join(root, "run/handler.sock") }
  const { scope } = await fixtureRuntime(), spawnFixture = await fixtureSpawner()
  scope.artifact(root)
  const firstLaunch = scope.snapshot().launches.length
  const registrations = () => scope.snapshot().launches.slice(firstLaunch)
  const owned: ProcessIdentity[] = [], starts: Promise<unknown>[] = []
  const failedStarts: unknown[] = []
  const cleanupBarriers: Array<() => Promise<void>> = [], cleanupChecks: Array<() => Promise<void>> = []
  const providers: Array<{ child: ChildProcess; marker: string; attempt: string; record?: LaunchRecord }> = []
  async function observe(pid: number): Promise<ProcessIdentity | null> {
    return until(async () => { try { return await adapter.readProcess(pid) } catch (error) { if (!(error instanceof Error) || !error.name.endsWith("ObservationUnavailable")) throw error; return undefined } })
  }
  async function signal(expected: ProcessIdentity, value: NodeJS.Signals): Promise<void> {
    const launch = registrations().find(item => item.pid === expected.pid)
    if (!launch) throw new Error("No current-run fixture registration")
    if (launch.identity && !sameProcess(launch.identity, expected)) throw new Error("fixture generation changed")
    const handler = ["agent-handler", "control-handler"].includes(launch.role)
    await signalFixturePid(expected.pid, value, handler, !handler)
  }
  const verifyCatalogCleanup = async (): Promise<void> => {
    try {
      const evidence = JSON.parse(await readFile(join(root, "catalog-cleanup-failure.json"), "utf8"))
      throw failFixtureBatch(Object.assign(new Error(`unverified Handler catalog cleanup; retained ${root}`), { evidence }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failFixtureBatch(error)
    }
  }
  let cleanupOperation: Promise<void> | undefined
  const cleanup = (): Promise<void> => cleanupOperation ??= (async () => {
    await Promise.allSettled(starts)
    await verifyCatalogCleanup()
    assertFixtureBatchHealthy()
    for (const barrier of cleanupBarriers) await barrier()
    for (const launch of registrations()) {
      if (!launch.pid || launch.exit || launch.absent) continue
      const owning = ["agent-handler", "control-handler", "catalog-worker"].includes(launch.role)
      await signalFixturePid(launch.pid, "SIGTERM", owning)
      const deadline = Date.now() + 1000
      while (await observe(launch.pid) !== null && Date.now() < deadline) await delay(25)
      if (await observe(launch.pid) !== null) await signalFixturePid(launch.pid, "SIGKILL")
      await until(async () => await observe(launch.pid!) === null ? true : undefined)
    }
    for (const provider of providers) {
      if (provider.record === undefined) {
        for (const fd of [3, 4]) provider.child.stdio[fd]?.destroy()
        if (provider.child.pid !== undefined) {
          await until(async () => await observe(provider.child.pid!) === null ? true : undefined)
          assert.deepEqual(await adapter.readGroup(provider.child.pid), [])
        }
        continue
      }

      for (const identity of provider.record.provider!.group.observed) assert.equal(await observe(identity.pid), null)
      assert.deepEqual(await adapter.readGroup(provider.record.provider!.group.leader.pid), [])
    }
    for (const check of cleanupChecks) await check()
    await writeFile(join(root, "cleanup.json"), JSON.stringify({ identities: owned, survivors: [], failedStarts: failedStarts.map(String) }), { mode: 0o600 })
    t.diagnostic("retained fixture root: " + root)
  })().catch(error => { throw failFixtureBatch(error) })
  t.after(cleanup)
  await chown(root, process.getuid!(), process.getgid!())
  await mkdir(paths.persistentRoot, { mode: 0o700 })
  await mkdir(paths.runtimeRoot, { mode: 0o700 })
  await mkdir(join(paths.persistentRoot, "launches"), { mode: 0o700 })
  const configPath = join(root, "config.json")
  await writeFile(configPath, JSON.stringify({ paths, ...overrides }), { mode: 0o600 })
  const start = async (timeoutMs = 5000, hook?: (transition: StartTransition) => Promise<void>) => {
    assertFixtureBatchHealthy()
    const role = handlerFile?.endsWith("agent-handler.js") ? "agent-handler" : "control-handler"
    const dependencies = { spawn: (file: string, args: readonly string[], options: import("node:child_process").SpawnOptions) => file === "/usr/bin/lockf" || file === "/usr/bin/flock" ? spawn(file, [...args], options) : spawnFixture(role, file, args, options, { source: true }) }
    const operation = scope.operation("control start", () => startOrConnect({ root: paths.runtimeRoot, hostId: paths.hostKey, adapter, timeoutMs, lockTimeoutSeconds: 20, handler: { file: process.execPath, args: [handlerFile ?? fileURLToPath(new URL("./fixtures/control-handler.js", import.meta.url)), configPath], ...(handlerEnv === undefined ? {} : { env: handlerEnv }) }, onTransition: async (transition, pid) => {
      if (transition === "handler_spawned" && pid !== undefined) {
        const identity = await observe(pid)
        if (identity) owned.push(identity)
      }
      await hook?.(transition)
    } }, dependencies)).then(async result => { await verifyCatalogCleanup(); return result }, async error => {
      await verifyCatalogCleanup()
      throw error
    })
    starts.push(operation)
    void operation.catch(error => failedStarts.push(error))
    return operation
  }
  const call = async (request?: ControlRequest) => {
    const record = await readHandlerRecord(join(paths.runtimeRoot, "handler.json"))
    return exchange(createConnection(paths.handlerSocketPath), request ?? { protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: record.generation, op: "status" }, 5000)
  }
  const spawnProvider = async (): Promise<LaunchRecord> => {
    assertFixtureBatchHealthy()
    const attempt = randomUUID(), marker = `agy-provider:${attempt}`, ready = join(root, `${attempt}-ready.json`)
    const child = spawnFixture("provider-tree", process.execPath, [fileURLToPath(new URL("./fixtures/provider-tree.js", import.meta.url)), "leader", ready, "normal", "5000"], { argv0: marker, detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] }, { source: true })
    const provider: typeof providers[number] = { child, marker, attempt }
    providers.push(provider)
    child.on("error", () => undefined)
    let diagnostics = ""
    child.stderr?.on("data", (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-8192) })
    assert.notEqual(child.pid, undefined)
    const status = child.stdio[3] as Duplex, ack = child.stdio[4] as Duplex
    status.on("error", () => undefined); ack.on("error", () => undefined)
    try {
      const structural = await new Promise<{ leaderPid: number; descendantPid: number }>((resolve, reject) => {
        let text = ""
        const timer = setTimeout(() => finish(new Error("provider structure timed out")), 5000)
        const finish = (error?: Error): void => { clearTimeout(timer); status.off("data", data); status.off("error", failed); status.off("close", failed); if (error) reject(error) }
        const failed = (): void => finish(new Error("provider structure unavailable"))
        const data = (bytes: Buffer): void => {
          text += bytes.toString()
          if (text.length > 4096) return finish(new Error("oversized provider structure"))
          if (!text.includes("\n")) return
          try { const value = JSON.parse(text); assert.equal(value.type, "provider-structural"); finish(); resolve(value) } catch (error) { finish(error as Error) }
        }
        status.on("data", data); status.once("error", failed); status.once("close", failed)
      })
      assert.equal(structural.leaderPid, child.pid)
      const leader = await observe(child.pid!)
      assert.notEqual(leader, null)
      assert.equal(leader!.birth.slice(leader!.birth.indexOf(":") + 1), marker)
      assert.equal(leader!.pid, leader!.processGroupId)
      assert.equal(leader!.pid, leader!.sessionId)
      const members = await adapter.readGroup(child.pid!)
      assert.deepEqual(await adapter.readGroup(child.pid!), members)
      assert.deepEqual(members.map(value => value.pid).sort((a, b) => a - b), [structural.leaderPid, structural.descendantPid].sort((a, b) => a - b))
      for (const member of members) {
        assert.equal(member.uid, process.getuid!()); assert.equal(member.gid, process.getgid!())
        assert.equal(member.bootId, leader!.bootId); assert.equal(member.sessionId, leader!.pid); assert.equal(member.processGroupId, leader!.pid)
      }
      provider.record = launch({ launchAttemptId: attempt, launchBootId: leader!.bootId, phase: "active", provider: { kind: "process-group", group: { leader: leader!, observed: members } } })
      ack.end("registered\n")
      await until(async () => await fileExists(ready) ? true : undefined).catch(error => { throw new Error(`provider readiness failed: ${diagnostics}`, { cause: error }) })
      child.unref()
      return provider.record
    } finally { status.destroy(); ack.destroy() }
  }
  return { root, paths, adapter, owned, registrations, start, call, signal, observe, configPath, spawnProvider, cleanup, beforeCleanup: (barrier: () => Promise<void>) => { cleanupBarriers.push(barrier) }, afterCleanup: (check: () => Promise<void>) => { cleanupChecks.push(check) } }
}

export async function privateRoot(t: TestContext, options: { retainRoot?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(await realpath(process.env.AGENCY_TEST_FIXTURE_ROOT ?? "/tmp"), process.env.AGENCY_TEST_FIXTURE_ROOT ? "f-" : "agy-control-"))
  t.after(async () => { if (options.retainRoot) t.diagnostic("retained fixture root: " + root); else await rm(root, { recursive: true, force: true }) })
  return root
}

export function launch(overrides: Partial<LegacyLaunchRecord> = {}): LegacyLaunchRecord {
  return { version: 1, checkoutId: "checkout-a", leaseId: randomUUID(), agentId: "agent-a", handlerGeneration: randomUUID(), launchAttemptId: randomUUID(), launchBootId: "boot-a", launchAttempted: true, phase: "launch_pending", provider: null, reason: null, ...overrides }
}