import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { TestContext } from "node:test"
import { privateRoot } from "./control-support.js"
import type { ProviderProfile } from "../src/catalog/types.js"
import { randomUUID } from "node:crypto"
import { ChildProcess } from "node:child_process"
import { PassThrough } from "node:stream"
import { createProbeRuntime, type ProbeRequest } from "../src/catalog/probes.js"
import { createCatalogStore } from "../src/catalog/store.js"
import { observeConfig } from "../src/catalog/config.js"
import { MutationQueue } from "../src/handler/mutations.js"
import type { PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"

export async function profileFixture(t: TestContext) {
  const root = await privateRoot(t)
  const catalog = join(root, "catalog"), sdk = join(root, "sdk"), adapter = join(root, "adapter")
  for (const directory of [catalog, sdk, adapter]) await mkdir(directory, { mode: 0o700 })
  const executable = join(root, "native"), config = join(root, "declared-config.json")
  await writeFile(executable, "fixture executable", { mode: 0o700 })
  await writeFile(join(adapter, "package.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.70.0" }), { mode: 0o600 })
  await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.232", main: "sdk.mjs" }), { mode: 0o600 })
  await writeFile(join(sdk, "sdk.mjs"), "throw new Error('SDK must not be imported during configuration discovery')", { mode: 0o600 })
  const profile: ProviderProfile = { id: "claude-agent-acp", enabled: true, executable, adapterPackageJson: join(adapter, "package.json"), sdkPackageJson: join(sdk, "package.json"), configurationFiles: [config] }
  const manifest = join(catalog, "providers.json")
  const save = async (providers: unknown = [profile]) => writeFile(manifest, JSON.stringify({ version: 1, providers }), { mode: 0o600 })
  return { root, catalog, sdk, adapter, executable, config, profile, manifest, save }
}

export function gate<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

export async function syntheticProbeFixture(t: TestContext, scenario = "success") {
  const f = await profileFixture(t), store = createCatalogStore(f.root), generation = randomUUID(), attemptId = randomUUID(), commandId = randomUUID(), batchId = randomUUID()
  const evidence = await observeConfig(f.profile), queue = new MutationQueue()
  const request: ProbeRequest = { profile: f.profile, evidence, meta: { version: 1, hostId: "a".repeat(64), handlerGeneration: generation, commandId, providerId: f.profile.id, attemptId, agentId: randomUUID(), leaseId: randomUUID(), fingerprint: evidence.fingerprint, workPath: join(f.root, "catalog/work", attemptId) } }
  await store.writeCommand({ version: 1, commandId, hostId: request.meta.hostId, handlerGeneration: generation, batchId, fingerprints: [{ providerId: f.profile.id, fingerprint: evidence.fingerprint }], attempts: [{ providerId: f.profile.id, attemptId }], state: "pending", snapshotId: null }, null)
  const path = join(f.root, "catalog/probe-launches", attemptId + ".json"), workerObserved = gate(), workerGate = gate(), nativeRegistered = gate(), spawnObserved = gate(), nativeGate = gate()
  const child = new ChildProcess(), processes = new Map<number, ProcessIdentity>(), signals: string[] = []
  const stdout = new PassThrough(), stderr = new PassThrough()
  Object.assign(child, { pid: 10001, stdout, stderr, connected: true })
  let spawned = false, native = false, first = true, durableAtSpawn = false
  const identity: ProcessIdentity = { bootId: "boot", pid: 10001, parentPid: process.pid, processGroupId: 10001, sessionId: 10001, uid: process.getuid!(), gid: process.getgid!(), birth: `100:agy-provider:${attemptId}` }
  const result = { models: [], providerVersion: null, providerVersionSource: "unknown" }
  child.send = ((message: { type: string }, callback?: (error: Error | null) => void) => {
    if (message.type === "start") {
      native = true
      if (scenario !== "native-death") processes.set(10002, { ...identity, pid: 10002, parentPid: scenario === "native-mismatch" ? 99999 : 10001, birth: "101:unmarked:node" })
      queueMicrotask(() => child.emit("message", { type: "native", attemptId, generation, pid: 10002 }))
    }
    if (message.type === "registered") {
      nativeRegistered.resolve()
      void nativeGate.promise.then(() => {
        if (scenario === "timeout") return
        if (scenario === "closed") { child.emit("disconnect"); return }
        if (scenario === "malformed") { child.emit("message", { type: "result", attemptId: "bad" }); return }
        if (scenario === "stdout") stdout.write(Buffer.alloc(65537))
        if (scenario === "stderr") stderr.write(Buffer.alloc(8193))
        if (scenario === "ipc") child.emit("message", { type: "bad", padding: "x".repeat(1048577) })
        child.emit("message", { type: "result", attemptId, generation, result })
        if (scenario === "double") child.emit("message", { type: "result", attemptId, generation, result })
        if (scenario === "early-exit") { processes.delete(10001); child.emit("exit", 1, null); child.emit("close", 1, null) }
      })
    }
    callback?.(null)
    return true
  }) as typeof child.send
  const adapter: PlatformAdapter = {
    platform: "darwin", bootId: async () => "boot",
    readProcess: async pid => {
      if (spawned && first && pid === 10001) { first = false; workerObserved.resolve(); await workerGate.promise }
      const value = processes.get(pid) ?? null
      return value !== null && scenario === "worker-mismatch" && pid === 10001 ? { ...value, birth: "100:wrong" } : value
    },
    readGroup: async () => [...processes.values()],
    signalGroup: async (_pid, signal) => {
      signals.push(signal)
      if (scenario === "cleanup-failure") throw new Error("observation unavailable")
      processes.clear()
      child.emit("exit", null, signal)
      if (scenario !== "missing-close") child.emit("close", null, signal)
    },
  }
  const runtime = createProbeRuntime({ paths: { hostKey: request.meta.hostId, persistentRoot: f.root, runtimeRoot: f.root, handlerSocketPath: join(f.root, "handler.sock") }, adapter, queue, store, generation, canStart: () => true, dependencies: {
    timeoutMs: scenario === "timeout" ? 50 : 1000, closeMs: 10,
    publish: async (path, record) => {
      const stage = record.provider === null ? record.launchAttempted ? "attempted" : "unattempted" : record.provider.group.observed.length === 1 ? "worker" : "native"
      if (scenario === `before-${stage}`) throw new Error("publication")
      await writeLaunchRecord(path, record)
      if (scenario === `after-${stage}`) throw new Error("publication")
    },
    spawn: ((file, args, options) => {
      assertSpawn(file, args, options)
      spawned = true
      processes.set(10001, identity)
      if (scenario === "worker-error") queueMicrotask(() => child.emit("error", new Error("fixture spawn")))
      void readLaunchRecordForReconciliation(path).then(record => { durableAtSpawn = record.launchAttempted; spawnObserved.resolve() })
      return child
    }) as typeof import("node:child_process").spawn,
  } })
  function assertSpawn(file: unknown, args: unknown, options: unknown) {
    if (file !== process.execPath || !Array.isArray(args) || typeof options !== "object" || options === null || !(options as { detached?: boolean }).detached) throw new Error("invalid worker spawn")
  }
  return { ...f, store, runtime, request, path, signals, child, processes, workerObserved, spawnObserved, nativeRegistered, nativeSpawned: () => native, durableAtSpawn: () => durableAtSpawn, releaseWorkerIdentity: () => workerGate.resolve(), releaseResult: () => nativeGate.resolve() }
}