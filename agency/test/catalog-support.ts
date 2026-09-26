import { mkdir, writeFile, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { createConnection } from "node:net"
import type { TestContext } from "node:test"
import { privateRoot, controlFixture, until, type AdmissionFixtureOperation } from "./control-support.js"
import { CatalogError, type ProviderProfile, type ProviderId } from "../src/catalog/types.js"
import { randomUUID } from "node:crypto"
import { ChildProcess } from "node:child_process"
import { PassThrough } from "node:stream"
import { createProbeRuntime, type ProbeRequest } from "../src/catalog/probes.js"
import { createCatalogStore } from "../src/catalog/store.js"
import { observeConfig } from "../src/catalog/config.js"
import { MutationQueue } from "../src/handler/mutations.js"
import type { PlatformAdapter, ProcessIdentity } from "../src/platform/types.js"
import { readHandlerRecord, readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import { CATALOG_PROTOCOL, exchangeCatalog, type CatalogRequest } from "../src/catalog/protocol.js"
import { ControlError, PROTOCOL } from "../src/control/protocol.js"
import { exchange } from "../src/control/wire.js"
import { readShutdownReceipt } from "../src/handler/receipt.js"
import { reconcileRecord } from "../src/platform/reconcile.js"

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

export async function catalogHandlerFixture(t: TestContext, options: { enabled?: ProviderId[]; wait?: boolean; admissionOperations?: AdmissionFixtureOperation[]; scenario?: "uncertain" } = {}, checkout?: Parameters<typeof controlFixture>[2]) {
  const f = await controlFixture(t, options.admissionOperations ? { admissionOperations: options.admissionOperations } : {}, checkout)
  f.beforeCleanup(async () => {
    let handler
    try { handler = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json")) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if (handler?.process && await f.observe(handler.process.pid) !== null) {
      const request = { protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: handler.generation, op: "shutdown" as const, commandId: randomUUID(), stopAgents: true }
      try {
        const reply = await exchange(createConnection(f.paths.handlerSocketPath), request, 15000)
        assert.ok(reply.ok, JSON.stringify(reply))
      } catch (error) {
        const receipt = await readShutdownReceipt(f.paths.persistentRoot, request.commandId)
        if (receipt?.handlerGeneration !== handler.generation || receipt.commandId !== request.commandId || !receipt.stopAgents) throw error
      }
      await until(async () => await f.observe(handler!.process!.pid) === null ? true : undefined)
      assert.deepEqual(await f.adapter.readGroup(handler.process.pid), [])
    }
    const inventory = await createCatalogStore(f.paths.persistentRoot).inventory()
    assert.deepEqual(inventory.issues, [])
    for (const entry of inventory.launches) {
      const path = join(f.root, entry.record.launchAttemptId + "-catalog-cleanup.json")
      await writeLaunchRecord(path, entry.record)
      assert.equal((await reconcileRecord(path, f.adapter, entry.record)).record.phase, "cleanup_verified")
      if (entry.record.provider === null) { assert.equal(entry.record.launchAttempted, false); continue }
      for (let observation = 0; observation < 2; observation++) {
        for (const identity of entry.record.provider.group.observed) assert.equal(await f.observe(identity.pid), null)
        assert.deepEqual(await f.adapter.readGroup(entry.record.provider.group.leader.pid), [])
      }
    }
  })
  for (const name of ["home", "config", "claude-agent-acp", "codex-acp"]) await mkdir(join(f.root, name), { mode: 0o700 })
  const profiles: ProviderProfile[] = []
  for (const id of ["claude-agent-acp", "codex-acp"] as const) {
    const directory = join(f.root, id), executable = join(directory, "native.mjs"), adapterPackageJson = join(directory, "adapter.json"), configuration = join(directory, "declared.json")
    await writeFile(executable, `#!${process.execPath}\n${await readFile(fileURLToPath(new URL("./fixtures/catalog-native.js", import.meta.url)), "utf8")}`, { mode: 0o700 })
    await writeFile(adapterPackageJson, JSON.stringify({ name: "@agentclientprotocol/" + id, version: "1.0.0" }), { mode: 0o600 })
    await writeFile(configuration, "{}", { mode: 0o600 })
    await writeFile(join(directory, "scenario.json"), JSON.stringify({ wait: options.wait ?? false }), { mode: 0o600 })
    let sdkPackageJson: string | null = null
    if (id === "claude-agent-acp") {
      sdkPackageJson = join(directory, "package.json")
      await writeFile(sdkPackageJson, JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.232", main: "sdk.mjs" }), { mode: 0o600 })
      await writeFile(join(directory, "sdk.mjs"), await readFile(fileURLToPath(new URL("./fixtures/catalog-sdk.js", import.meta.url))), { mode: 0o600 })
    }
    profiles.push({ id, enabled: options.enabled?.includes(id) ?? true, executable, adapterPackageJson, sdkPackageJson, configurationFiles: [configuration] })
  }
  await mkdir(join(f.paths.persistentRoot, "catalog"), { mode: 0o700 })
  if (options.enabled?.length !== 0) await writeFile(join(f.paths.persistentRoot, "catalog/providers.json"), JSON.stringify({ version: 1, providers: profiles }), { mode: 0o600 })
  await writeFile(f.configPath, JSON.stringify({ paths: f.paths, admissionOperations: options.admissionOperations, catalog: { profiles, scenario: options.scenario ?? "normal", admissionOnList: options.admissionOperations !== undefined } }), { mode: 0o600 })
  const inventory = () => createCatalogStore(f.paths.persistentRoot).inventory()
  const call = async (operation: { op: "model_list" } | { op: "model_refresh"; commandId: string }) => {
    const handler = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
    const request: CatalogRequest = { protocol: CATALOG_PROTOCOL, requestId: randomUUID(), handlerGeneration: handler.generation, ...operation }
    const reply = await exchangeCatalog(createConnection(f.paths.handlerSocketPath), request)
    if (!reply.ok) throw new ControlError(reply.error.code, reply.error.message)
    return reply.result
  }
  return {
    ...f, profiles, inventory,
    async list() { const result = await call({ op: "model_list" }); assert.equal(result.state, "catalog"); if (result.state !== "catalog") throw new Error("wrong result"); return result },
    async refresh(commandId: string) { const result = await call({ op: "model_refresh", commandId }); if (result.state !== "refresh") throw new Error("wrong result"); return result },
    waitCommand: (commandId: string) => until(async () => {
      try { const command = await createCatalogStore(f.paths.persistentRoot).readCommand(commandId); return command && command.state !== "pending" ? command : undefined }
      catch (error) { if (error instanceof CatalogError && error.code === "INVALID_CATALOG") return undefined; throw error }
    }, 15000),
    waitNative: (providerId: ProviderId) => until(async () => {
      const observed = await inventory(), attempts = observed.metadata.filter(m => m.providerId === providerId).map(m => m.attemptId)
      return observed.launches.find(e => attempts.includes(e.record.launchAttemptId) && e.record.phase !== "cleanup_verified" && e.record.provider?.group.observed.length === 2)
    }, 10000),
    scenario: (providerId: ProviderId, scenario: { fail?: boolean; models?: string[]; wait?: boolean }) => writeFile(join(dirname(profiles.find(p => p.id === providerId)!.executable), "scenario.json"), JSON.stringify(scenario), { mode: 0o600 }),
    release: (providerId: ProviderId) => writeFile(join(dirname(profiles.find(p => p.id === providerId)!.executable), "release"), "released", { mode: 0o600 }),
  }
}

export async function syntheticProbeFixture(t: TestContext, scenario = "success") {
  const f = await profileFixture(t), store = createCatalogStore(f.root), generation = randomUUID(), attemptId = randomUUID(), commandId = randomUUID(), batchId = randomUUID()
  const evidence = await observeConfig(f.profile), queue = new MutationQueue()
  const request: ProbeRequest = { profile: f.profile, evidence, meta: { version: 1, hostId: "a".repeat(64), handlerGeneration: generation, commandId, providerId: f.profile.id, attemptId, agentId: randomUUID(), leaseId: randomUUID(), fingerprint: evidence.fingerprint, workPath: join(f.root, "catalog/work", attemptId) } }
  await store.writeCommand({ version: 1, commandId, hostId: request.meta.hostId, handlerGeneration: generation, batchId, fingerprints: [{ providerId: f.profile.id, fingerprint: evidence.fingerprint }], attempts: [{ providerId: f.profile.id, attemptId }], state: "pending", snapshotId: null }, null)
  const path = join(f.root, "catalog/probe-launches", attemptId + ".json"), workerObserved = gate(), workerGate = gate(), nativeRegistered = gate(), spawnObserved = gate(), nativeGate = gate(), attemptedPublication = gate(), attemptedGate = gate()
  const child = new ChildProcess(), processes = new Map<number, ProcessIdentity>(), signals: string[] = []
  const stdout = new PassThrough(), stderr = new PassThrough()
  Object.assign(child, { pid: 10001, stdout, stderr, connected: true })
  let spawned = false, native = false, first = true, durableAtSpawn = false, attemptedPublished = false
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
      if (stage === "unattempted" && attemptedPublished && scenario === "restore-failure") throw new Error("restoration durability")
      if (stage === "attempted" && scenario === "pause-before-attempted") { attemptedPublication.resolve(); await attemptedGate.promise }
      if (scenario === `before-${stage}`) throw new Error("publication")
      await writeLaunchRecord(path, record)
      if (stage === "attempted") attemptedPublished = true
      if (stage === "attempted" && ["pause-after-attempted", "restore-failure"].includes(scenario)) { attemptedPublication.resolve(); await attemptedGate.promise }
      if (scenario === `after-${stage}`) throw new Error("publication")
    },
    spawn: ((file, args, options) => {
      assertSpawn(file, args, options)
      spawned = true
      if (scenario === "spawn-throws") throw new Error("ambiguous synchronous spawn failure")
      processes.set(10001, identity)
      if (scenario === "worker-error") queueMicrotask(() => child.emit("error", new Error("fixture spawn")))
      void readLaunchRecordForReconciliation(path).then(record => { durableAtSpawn = record.launchAttempted; spawnObserved.resolve() })
      return child
    }) as typeof import("node:child_process").spawn,
  } })
  function assertSpawn(file: unknown, args: unknown, options: unknown) {
    if (file !== process.execPath || !Array.isArray(args) || typeof options !== "object" || options === null || !(options as { detached?: boolean }).detached) throw new Error("invalid worker spawn")
  }
  return { ...f, store, runtime, request, path, signals, child, processes, workerObserved, spawnObserved, nativeRegistered, attemptedPublication, releaseAttempted: () => attemptedGate.resolve(), spawnInvoked: () => spawned, nativeSpawned: () => native, durableAtSpawn: () => durableAtSpawn, releaseWorkerIdentity: () => workerGate.resolve(), releaseResult: () => nativeGate.resolve() }
}