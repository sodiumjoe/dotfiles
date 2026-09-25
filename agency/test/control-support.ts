import { mkdtemp, realpath, rm, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { TestContext } from "node:test"
import { randomUUID } from "node:crypto"
import type { LaunchRecord } from "../src/platform/types.js"
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

export type ControlFixtureConfig = { paths: PlatformPaths; pauseAt?: string; mutateAt?: string; mutate?: "add" | "replace"; delayMs?: number }

export async function controlFixture(t: TestContext, overrides: Omit<ControlFixtureConfig, "paths"> = {}) {
  const root = await mkdtemp(join(await realpath("/tmp"), "agy-control-"))
  const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  const paths: PlatformPaths = { hostKey: "a".repeat(64), persistentRoot: join(root, "state"), runtimeRoot: join(root, "run"), handlerSocketPath: join(root, "run/handler.sock") }
  const owned: ProcessIdentity[] = [], pending: Array<{ pid: number; marker: string }> = [], starts: Promise<unknown>[] = []
  const failedStarts: unknown[] = []
  async function observe(pid: number): Promise<ProcessIdentity | null> {
    return until(async () => { try { return await adapter.readProcess(pid) } catch (error) { if (!(error instanceof Error) || !error.name.endsWith("ObservationUnavailable")) throw error; return undefined } })
  }
  async function authorize(expected: ProcessIdentity): Promise<boolean> {
    const current = await observe(expected.pid)
    if (current === null) { assert.deepEqual(await adapter.readGroup(expected.pid), []); return false }
    assert.ok(sameProcess(expected, current), "fixture generation changed")
    assert.equal(await adapter.bootId(), expected.bootId)
    const first = await adapter.readGroup(expected.pid), second = await adapter.readGroup(expected.pid)
    assert.deepEqual(first, second)
    assert.equal(first.length, 1)
    assert.ok(sameProcess(first[0]!, expected))
    return true
  }
  async function signal(expected: ProcessIdentity, value: NodeJS.Signals): Promise<void> {
    if (await authorize(expected) && await authorize(expected)) await adapter.signalGroup(expected.pid, value)
  }
  t.after(async () => {
    await Promise.allSettled(starts)
    for (const item of pending) {
      if (owned.some(identity => identity.pid === item.pid)) continue
      const identity = await observe(item.pid)
      if (identity === null) { assert.deepEqual(await adapter.readGroup(item.pid), []); continue }
      assert.equal(identity.birth.slice(identity.birth.indexOf(":") + 1), item.marker)
      assert.equal(identity.pid, identity.processGroupId)
      assert.equal(identity.pid, identity.sessionId)
      assert.equal(identity.uid, process.getuid!())
      assert.equal(identity.gid, process.getgid!())
      owned.push(identity)
    }
    for (const identity of owned) {
      await signal(identity, "SIGTERM")
      const deadline = Date.now() + 1000
      while (await observe(identity.pid) !== null && Date.now() < deadline) await delay(25)
      if (await observe(identity.pid) !== null) await signal(identity, "SIGKILL")
      await until(async () => await observe(identity.pid) === null ? true : undefined)
      assert.deepEqual(await adapter.readGroup(identity.pid), [])
      assert.equal(await observe(identity.pid), null)
    }
    await writeFile(join(root, "cleanup.json"), JSON.stringify({ identities: owned, survivors: [], failedStarts: failedStarts.map(String) }), { mode: 0o600 })
    await rm(root, { recursive: true })
  })
  await mkdir(paths.persistentRoot, { mode: 0o700 })
  await mkdir(paths.runtimeRoot, { mode: 0o700 })
  await mkdir(join(paths.persistentRoot, "launches"), { mode: 0o700 })
  const configPath = join(root, "config.json")
  await writeFile(configPath, JSON.stringify({ paths, ...overrides }), { mode: 0o600 })
  const start = (timeoutMs = 5000, hook?: (transition: StartTransition) => Promise<void>) => {
    let marker: string | undefined
    const operation = startOrConnect({ root: paths.runtimeRoot, hostId: paths.hostKey, adapter, timeoutMs, handler: { file: process.execPath, args: [fileURLToPath(new URL("./fixtures/control-handler.js", import.meta.url)), configPath] }, onTransition: async (transition, pid) => {
      if (transition === "launch_pending_written") marker = `agy-handler:${(await readHandlerRecord(join(paths.runtimeRoot, "handler.json"))).launchAttemptId}`
      if (transition === "handler_spawned" && pid !== undefined) {
        assert.notEqual(marker, undefined)
        pending.push({ pid, marker: marker! })
        const identity = await observe(pid)
        if (identity !== null) { assert.equal(identity.birth.slice(identity.birth.indexOf(":") + 1), marker); owned.push(identity) }
      }
      await hook?.(transition)
    } })
    starts.push(operation)
    void operation.catch(error => failedStarts.push(error))
    return operation
  }
  const call = async (request?: ControlRequest) => {
    const record = await readHandlerRecord(join(paths.runtimeRoot, "handler.json"))
    return exchange(createConnection(paths.handlerSocketPath), request ?? { protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: record.generation, op: "status" }, 5000)
  }
  return { root, paths, adapter, owned, start, call, signal, observe, configPath }
}

export async function privateRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(await realpath("/tmp"), "agy-control-"))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

export function launch(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return { version: 1, checkoutId: "checkout-a", leaseId: randomUUID(), agentId: "agent-a", handlerGeneration: randomUUID(), launchAttemptId: randomUUID(), launchBootId: "boot-a", launchAttempted: true, phase: "launch_pending", provider: null, reason: null, ...overrides }
}