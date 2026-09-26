import { assertGitChildrenClosed, checkoutIdFor } from "../src/checkout/identity.js"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process"
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { createAgentProcess, type OwnedAgentProcess } from "../src/agent/process.js"
import { AgentError } from "../src/agent/types.js"
import { privateRoot } from "./control-support.js"
import { MutationQueue } from "../src/handler/mutations.js"
import type { AdmissionContext } from "../src/checkout/admission.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import type { LaunchRecord, ProcessIdentity } from "../src/platform/types.js"
import { createAgentService, type AgentService } from "../src/agent/service.js"
import { createAgentStore } from "../src/agent/store.js"
import { createCatalogStore } from "../src/catalog/store.js"
import { observeConfig } from "../src/catalog/config.js"
import { isFresh, type CatalogSnapshot, type ProviderProfile } from "../src/catalog/types.js"
import type { CatalogService } from "../src/catalog/service.js"
import { observeLaunchContract } from "../src/agent/contracts.js"
import { admissionFixture } from "./checkout-support.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import type { TestContext } from "node:test"
import { createAcpConnection } from "../src/agent/acp.js"
import type { LaunchContract } from "../src/agent/contracts.js"
import type { AgentCommand, AgentRecord, LaunchSpec, SessionEvidence } from "../src/agent/types.js"

export const agentId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

export function sampleSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  const hostId = "a".repeat(64), root = { path: "/checkout", device: "1", inode: "2" }, gitDirectory = { path: "/checkout/.git", device: "1", inode: "3" }
  return {
    version: 1, hostId, agentId: agentId(1), handlerGeneration: agentId(2), providerGeneration: agentId(3), leaseId: agentId(4), launchAttemptId: agentId(5), startCommandId: agentId(6),
    selection: { providerId: "codex-acp", modelId: "model-a", reasoning: { kind: "value", value: "high" }, mode: "review", permissionProfile: "fixture-deny-v1" },
    modelIdentity: "advertised", resolvedModelId: null,
    checkout: { version: 1, hostId, checkoutId: checkoutIdFor(hostId, root, gitDirectory), root, gitDirectory, commonDirectory: gitDirectory, ancestors: [{ path: "/", device: "1", inode: "1" }] },
    catalogSnapshotId: agentId(7),
    catalogEvidence: { providerId: "codex-acp", fingerprint: "b".repeat(64), verifiedAt: 1000, verifiedHandlerGeneration: agentId(2), providerVersion: null, providerVersionSource: "unknown", adapterVersion: "1.0.0", sdkVersion: null, error: null, models: [{ providerId: "codex-acp", modelId: "model-a", resolvedModelId: null, displayName: "Model A", reasoning: { state: "values", values: ["high", "low"] }, modes: { state: "unknown" }, availability: "advertised" }] },
    configuration: { fingerprint: "b".repeat(64), scope: "declared-config-v1", providerId: "codex-acp", adapterVersion: "1.0.0", sdkVersion: null },
    contractId: "fixture-v1", contractFingerprint: "c".repeat(64), containment: "direct-process-group-v1", authority: "normal-user",
    limits: { startupMs: 30000, rpcMs: 5000, frameBytes: 1048576, startupBytes: 8388608, writeQueueBytes: 1048576, stderrBytes: 8192 }, ...overrides,
  }
}

export function sampleContract(): LaunchContract {
  return { id: "fixture-v1", providerId: "codex-acp", adapterVersion: "1.0.0", entrypoint: "/fixture.mjs", fingerprint: "c".repeat(64), modes: { state: "values", values: ["plan", "review"] }, reasoning: { state: "values", values: ["high", "low"] }, effectiveMode: null, permissionProfiles: ["fixture-deny-v1"], modelOption: "model", reasoningOption: "reasoning", modeOption: "mode", environment: {}, permissionEvidence: "fixture-contract-v1" }
}

export function sampleAgent(): AgentRecord { return { version: 1, spec: sampleSpec(), phase: "starting", session: null, failure: null } }
export function sampleSession(): SessionEvidence { return { sessionId: "fixture-session", sessionGeneration: agentId(8), protocolVersion: 1, modelId: "model-a", reasoning: { kind: "value", value: "high" }, mode: "review", permissionProfile: "fixture-deny-v1", permissionEvidence: "fixture-contract-v1" } }
export function sampleCommand(): AgentCommand {
  const spec = sampleSpec()
  return { version: 1, hostId: spec.hostId, commandId: spec.startCommandId, handlerGeneration: spec.handlerGeneration, op: "start", input: { commandId: spec.startCommandId, handlerGeneration: spec.handlerGeneration, cwd: spec.checkout.root.path, selection: spec.selection }, target: { agentId: spec.agentId, handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration }, state: "pending", result: null }
}

export function agentGate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

export async function syntheticAgentProcess(t: TestContext, scenario: string) {
  const root = await privateRoot(t), spec = sampleSpec(), contract = sampleContract(), beforeSpawn = agentGate(), publication = agentGate()
  const path = join(root, "launches", spec.launchAttemptId + ".json")
  await mkdir(join(root, "launches"), { mode: 0o700 })
  const launch: LaunchRecord = { version: 1, checkoutId: spec.checkout.checkoutId, agentId: spec.agentId, leaseId: spec.leaseId, handlerGeneration: spec.handlerGeneration, launchAttemptId: spec.launchAttemptId, launchBootId: "boot-a", launchAttempted: false, provider: null, phase: "launch_pending", reason: null }
  await writeLaunchRecord(path, launch)
  const peer = scriptedAcp(t); peer.connection.close()
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid: 12345, stdin: peer.writable, stdout: peer.readable, stderr: new PassThrough(), exitCode: null, signalCode: null })
  let live = false, count = 0, observedOptions: SpawnOptions | undefined, identityPublished = false, earlyWrites = 0, invalidation = "", checks = 0
  const signals: NodeJS.Signals[] = []
  let identity: ProcessIdentity = { pid: 12345, bootId: "boot-a", birth: `100:agy-provider:${spec.launchAttemptId}`, parentPid: process.pid, processGroupId: 12345, sessionId: 12345, uid: process.getuid!(), gid: process.getgid!() }
  if (scenario === "identity-mismatch") identity.birth = "100:other"
  if (scenario === "wrong-birth") identity.birth = `invalid:agy-provider:${spec.launchAttemptId}`
  if (scenario === "wrong-boot") identity.bootId = "other-boot"
  if (scenario === "wrong-group") identity.processGroupId++
  if (scenario === "wrong-uid") identity.uid++
  const context: AdmissionContext = {
    paths: { hostKey: spec.hostId, persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "handler.sock") },
    state: { hostId: spec.hostId, handlerGeneration: spec.handlerGeneration, phase: "ready", reconciliation: { classified: 1, total: 1, quarantined: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] },
    mutations: { queue: new MutationQueue(), accepted: [{ path, record: launch }], unavailable: null }, shutdownPending: () => false,
    adapter: { platform: "linux", bootId: async () => "boot-a", readProcess: async () => live ? structuredClone(identity) : null, readGroup: async () => live ? [structuredClone(identity)] : [], async signalGroup(group, signal) {
      if (group !== 12345) throw new Error("wrong signal target")
      signals.push(signal)
      if (signal === "SIGTERM" && ["ignore-term", "esrch-survivor"].includes(scenario)) {
        if (scenario === "esrch-survivor") throw Object.assign(new Error("missing"), { code: "ESRCH" })
        return
      }
      live = false
      queueMicrotask(() => { child.emit("exit", 0, signal); if (scenario !== "close-held") child.emit("close", 0, signal) })
    } },
  }
  peer.writable.on("data", () => { if (!identityPublished) earlyWrites++ })
  const owner = createAgentProcess({ context, spec, contract: { ...contract, environment: { HOME: "/fixture-home", FIXTURE: "yes", NODE_OPTIONS: "forbidden", NODE_PATH: "forbidden", AGENCY_TEST: "forbidden", GIT_DIR: "forbidden" } }, reservation: { launch, admission: { version: 1, checkout: spec.checkout, handlerGeneration: spec.handlerGeneration, agentId: spec.agentId, leaseId: spec.leaseId, launchAttemptId: spec.launchAttemptId } }, async revalidate() {
    checks++
    if (invalidation || scenario === "restore-failure" && checks > 1) throw new AgentError("CONFIG_CHANGED")
  } }, { spawn: ((executable: string, args: string[], options: SpawnOptions) => {
    count++; observedOptions = options
    if (executable !== process.execPath || JSON.stringify(args) !== '["/fixture.mjs"]') throw new Error("wrong executable")
    if (scenario === "spawn-throws") throw new Error("spawn invocation failed")
    live = scenario !== "child-exit"
    if (!live) queueMicrotask(() => child.emit("exit", 1, null))
    return child
  }) as typeof spawn, transitionIO: {
    async publish(file, record) {
      if (scenario === "attempt-write" && record.launchAttempted && !record.provider) throw new Error("attempt write failed")
      if (scenario === "restore-failure" && !record.launchAttempted) throw new Error("restore failed")
      await writeLaunchRecord(file, record)
      if (record.provider) identityPublished = true
      if (scenario === "publication-paused" && record.launchAttempted && !record.provider) { beforeSpawn.resolve(); await publication.promise }
    },
    async read(file) { if (scenario === "attempt-readback" && checks === 1) { checks++; throw new Error("readback failed") }; return readLaunchRecordForReconciliation(file) },
  } })
  return { owner, spec, signals, beforeSpawn, releasePublication: publication.resolve, spawnCount: () => count, record: () => readLaunchRecordForReconciliation(path), writesBeforeIdentity: () => earlyWrites, options: () => observedOptions, invalidate: (why: string) => { invalidation = why }, replaceIdentity() { identity.birth = `200:agy-provider:${spec.launchAttemptId}` }, eof: () => peer.readable.end(), pipesDestroyed: () => child.stdin!.destroyed && child.stdout!.destroyed && child.stderr!.destroyed }
}

export function scriptedAcp(t: TestContext, scenario = "exact") {
  const readable = new PassThrough(), writable = new PassThrough(), sent: Array<{ method: string; params: any }> = [], permissionReplies: unknown[] = []
  const options = [
    { id: "model", type: "select", name: "Model", currentValue: "model-a", options: [{ value: "model-a", name: "Model α" }] },
    { id: "reasoning", type: "select", name: "Reasoning", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    { id: "mode", type: "select", name: "Mode", currentValue: "plan", options: [{ value: "plan", name: "Plan" }, { value: "review", name: "Review" }] },
  ]
  const send = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value) + "\n")
    if (scenario === "fragmented") for (const byte of bytes) readable.write(Buffer.from([byte]))
    else readable.write(bytes)
  }
  const connection = createAcpConnection({ readable, writable, limits: sampleSpec().limits })
  writable.on("data", (bytes: Buffer) => {
    for (const line of bytes.toString().trim().split("\n")) {
      const request = JSON.parse(line)
      if (!request.method) { permissionReplies.push(request); continue }
      sent.push(request)
      if (scenario === "hang") continue
      if (scenario === "utf8") { readable.write(Buffer.from([255, 10])); continue }
      if (scenario === "oversized") { readable.write(Buffer.alloc(1048577, 32)); continue }
      if (scenario === "empty-eof") { readable.end(); continue }
      if (scenario === "incomplete-eof") { readable.end("{\"jsonrpc\":"); continue }
      if (scenario === "error" || scenario === "auth") { send({ jsonrpc: "2.0", id: request.id, error: { code: scenario === "auth" ? -32000 : -32603, message: "sensitive remote diagnostic" } }); continue }
      if (scenario === "wrong-id") { send({ jsonrpc: "2.0", id: 999, result: {} }); continue }
      let result: unknown
      if (request.method === "initialize") result = { protocolVersion: scenario === "version" ? 2 : 1, agentCapabilities: {} }
      else if (request.method === "session/new") {
        result = { sessionId: "fixture-session", configOptions: scenario === "missing" ? [] : scenario === "duplicate-option" ? [options[0], options[0]] : options }
      } else {
        if (["permission", "wrong-session", "filesystem", "terminal"].includes(scenario)) {
          send({ jsonrpc: "2.0", id: "request-1", method: scenario === "filesystem" ? "fs/read_text_file" : scenario === "terminal" ? "terminal/create" : "session/request_permission", params: { sessionId: scenario === "wrong-session" ? "other" : "fixture-session", toolCall: { toolCallId: "tool-1", title: "fixture" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } })
          continue
        }
        const option = options.find(option => option.id === request.params.configId)!
        if (scenario === "late-permission" && option.id === "mode") send({ jsonrpc: "2.0", id: "request-1", method: "session/request_permission", params: { sessionId: "fixture-session", toolCall: { toolCallId: "tool-1", title: "fixture" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } })
        option.currentValue = scenario === "alias" && option.id === "model" ? "model-b" : request.params.value
        if (scenario === "clamp" && option.id === "mode") options[1]!.currentValue = "low"
        result = scenario === "empty-ack" ? {} : { configOptions: options }
      }
      if (scenario === "grouped" && typeof result === "object" && result !== null && "configOptions" in result) {
        result = { ...result, configOptions: (result.configOptions as typeof options).map(option => ({ ...option, options: [{ group: "choices", name: "Choices", options: option.options }] })) }
      }
      const reply = { jsonrpc: "2.0", id: request.id, result }
      send(reply)
      if (scenario === "duplicate-id") send(reply)
    }
  })
  t.after(() => { connection.close(); readable.destroy(); writable.destroy() })
  return { connection, sent, permissionReplies, readable, writable, send, triggerDrift() { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } } }) } }
}

export async function agentServiceFixture(t: TestContext, options: { contract?: boolean; pause?: "reservation" | "attempted" | "spawn" | "ready" } = {}) {
  const teardown: Array<() => unknown> = [], childContext = Object.create(t) as TestContext
  childContext.after = fn => { teardown.push(() => fn?.(t, error => { if (error) throw error })) }
  const f = await admissionFixture(childContext), root = f.root, entered = agentGate(), released = agentGate(), readyCommitEntered = agentGate(), readyCommitReleased = agentGate(), publications: string[] = []
  const requests: Promise<unknown>[] = [], owners: OwnedAgentProcess[] = []
  const track = (service: AgentService): AgentService => {
    const start = service.start.bind(service), stop = service.stop.bind(service)
    service.start = request => { const operation = start(request); requests.push(operation); return operation }
    service.stop = request => { const operation = stop(request); requests.push(operation); return operation }
    return service
  }
  const directory = join(root, "catalog"), config = join(root, "declared.json"), executable = join(root, "native"), adapterPackageJson = join(root, "adapter.json")
  await mkdir(directory, { mode: 0o700 })
  await writeFile(config, "{}", { mode: 0o600 }); await writeFile(executable, "fixture", { mode: 0o700 }); await writeFile(adapterPackageJson, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.0.0" }), { mode: 0o600 })
  const profile: ProviderProfile = { id: "codex-acp", enabled: true, executable, adapterPackageJson, sdkPackageJson: null, configurationFiles: [config] }
  await writeFile(join(directory, "providers.json"), JSON.stringify({ version: 1, providers: [profile] }), { mode: 0o600 })
  const configuration = await observeConfig(profile), catalogStore = createCatalogStore(root)
  let snapshot: CatalogSnapshot = { version: 1, hostId: f.context.paths.hostKey, snapshotId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, createdAt: Date.now(), providers: [{ ...sampleSpec().catalogEvidence, fingerprint: configuration.fingerprint, verifiedAt: Date.now(), verifiedHandlerGeneration: f.context.state.handlerGeneration }] }
  const saveCatalog = async () => { await catalogStore.writeSnapshot(snapshot); await catalogStore.publishCurrent(snapshot) }
  await saveCatalog()
  const contract = { ...sampleContract(), entrypoint: fileURLToPath(new URL("./fixtures/agent-provider.js", import.meta.url)), environment: { HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root, FIXTURE_ROOT: root } }
  contract.fingerprint = await observeLaunchContract(contract)
  let refreshes = 0, catalogReads = 0, spawnCount = 0, failReceipt = false, failReady = false, holdReady = false, failTerminal = false, failInitialAgent = false, writingReady = false, writingTerminal = false, writingReceipt = false, readyFailures = 0, terminalFailures = 0
  const base = createAgentStore(root, { mkdir, rename, rm, async open(path, flags, mode) {
    const handle = await open(path, flags, mode), sync = handle.sync.bind(handle)
    handle.sync = async () => {
      if (holdReady && writingReady && path === join(root, "agents/records")) { readyCommitEntered.resolve(); await readyCommitReleased.promise }
      if (failReceipt && writingReceipt && path === join(root, "agents/commands")) throw new Error("receipt directory fsync")
      if (failReady && writingReady && path === join(root, "agents/records")) { readyFailures++; throw new Error("ready directory fsync") }
      if (failTerminal && writingTerminal && path === join(root, "agents/records")) { terminalFailures++; throw new Error("terminal directory fsync") }
      await sync()
    }
    return handle
  } })
  const store = { ...base, async writeAgent(value: AgentRecord, expected: AgentRecord | null) {
    publications.push("agent:" + value.phase)
    if (failInitialAgent && expected === null) throw new Error("initial agent publication")
    writingReady = value.phase === "ready"
    writingTerminal = value.phase === "stopped"
    try { await base.writeAgent(value, expected) } finally { writingReady = false; writingTerminal = false }
  }, async writeCommand(value: AgentCommand, expected: AgentCommand | null) {
    publications.push(`${value.op}:${value.state}`); writingReceipt = value.state === "completed"
    try { await base.writeCommand(value, expected) } finally { writingReceipt = false }
  } }
  const unsupported = async (): Promise<never> => { throw new Error("unexpected catalog operation") }
  const catalog: CatalogService = { initialize: async () => undefined, startScheduling() {}, list: unsupported, refresh: async () => { refreshes++; return unsupported() }, freezeAndDrain: async () => undefined, resume() {}, verifyDischarged: async () => undefined, close() {}, async launchEvidence(id) {
    catalogReads++
    return f.context.mutations.queue.run(async () => {
      const provider = snapshot.providers.find(p => p.providerId === id)
      if (!provider || !isFresh(provider.verifiedAt, Date.now()) || provider.verifiedHandlerGeneration !== f.context.state.handlerGeneration || provider.error || (await observeConfig(profile)).fingerprint !== configuration.fingerprint) throw new AgentError("MODEL_UNAVAILABLE")
      return structuredClone({ snapshotId: snapshot.snapshotId, provider, profile, configuration })
    })
  } }
  const processes = new Map<number, { identity: ProcessIdentity; child: ChildProcess }>(), peers = new Map<string, ReturnType<typeof scriptedAcp>>()
  f.context.adapter = { platform: "linux", bootId: async () => "boot-a", readProcess: async pid => processes.get(pid)?.identity ?? null, readGroup: async group => [...processes.values()].map(v => v.identity).filter(v => v.processGroupId === group), async signalGroup(group, signal) {
    for (const [pid, value] of processes) if (value.identity.processGroupId === group) { processes.delete(pid); value.child.emit("exit", 0, signal); value.child.emit("close", 0, signal) }
  } }
  const pause = async (at: typeof options.pause, signal?: AbortSignal) => {
    if (options.pause !== at) return
    entered.resolve()
    if (!signal) { await released.promise; return }
    if (signal.aborted) return
    let aborted!: () => void
    const cancelled = new Promise<void>(resolve => { aborted = resolve; signal.addEventListener("abort", aborted, { once: true }) })
    try { await Promise.race([released.promise, cancelled]) } finally { signal.removeEventListener("abort", aborted) }
  }
  const processFactory: typeof createAgentProcess = input => {
    const peer = scriptedAcp(t); peer.connection.close(); peers.set(input.spec.agentId, peer)
    const owner = createAgentProcess(input, { spawn: (() => {
      const pid = 20000 + ++spawnCount, child = new EventEmitter() as ChildProcess
      Object.assign(child, { pid, stdin: peer.writable, stdout: peer.readable, stderr: new PassThrough(), exitCode: null, signalCode: null })
      processes.set(pid, { child, identity: { pid, birth: `100:agy-provider:${input.spec.launchAttemptId}`, bootId: "boot-a", parentPid: process.pid, processGroupId: pid, sessionId: pid, uid: process.getuid!(), gid: process.getgid!() } })
      return child
    }) as typeof spawn, transitionIO: { read: readLaunchRecordForReconciliation, async publish(path, record) {
      await writeLaunchRecord(path, record)
      if (record.launchAttempted && record.provider === null) await pause("attempted")
    } } })
    owners.push(owner)
    return { ...owner, async initialize(signal) { await pause("spawn", signal); const session = await owner.initialize(signal); await pause("ready", signal); return session } }
  }
  const composition = { context: f.context, admission: { ...f.controller, async reserve(request: Parameters<typeof f.controller.reserve>[0]) { await pause("reservation"); publications.push("reservation"); return f.controller.reserve(request) } }, catalog, contracts: options.contract === false ? [] : [contract], store, processFactory }
  let service = track(createAgentService(composition))
  t.after(async () => {
    released.resolve(); readyCommitReleased.resolve()
    await Promise.allSettled(requests)
    await service.freezeAndDrain(true).catch(() => undefined)
    service.close()
    await Promise.allSettled(owners.map(owner => owner.cleanup()))
    await f.context.mutations.queue.run(async () => undefined)
    assertGitChildrenClosed()
    for (const finish of teardown) await finish()
  })
  await service.initialize()
  const input = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, cwd: f.git.repo, selection: sampleSpec().selection }
  return { ...f, service, input, store, catalogStore, contract, profile, configuration, config, publications, entered: entered.promise, release: released.resolve, spawns: () => spawnCount, refreshes: () => refreshes, catalogReads: () => catalogReads, readyFailures: () => readyFailures,
    failReceipt(value: boolean) { failReceipt = value }, failReady(value: boolean) { failReady = value }, failInitialAgent(value: boolean) { failInitialAgent = value },
    failTerminal(value: boolean) { failTerminal = value }, terminalFailures: () => terminalFailures,
    holdReady(value: boolean) { holdReady = value }, readyCommitEntered: readyCommitEntered.promise, releaseReadyCommit: readyCommitReleased.resolve,
    fault(agent: string) { peers.get(agent)!.triggerDrift() },
    cleanupOwned: () => Promise.all(owners.map(owner => owner.cleanup())),
    async changeCatalog(kind: "stale" | "rollback" | "missing" | "refresh") {
      snapshot = structuredClone(snapshot); snapshot.snapshotId = randomUUID(); snapshot.createdAt = Date.now()
      if (kind === "stale") snapshot.providers[0]!.verifiedAt = Date.now() - 600000
      if (kind === "rollback") snapshot.providers[0]!.verifiedAt = Date.now() + 100000
      if (kind === "missing") snapshot.providers[0]!.models = []
      await saveCatalog()
    },
    async restart() {
      service.close(); released.resolve()
      await Promise.allSettled(owners.map(owner => owner.cleanup()))
      await f.context.mutations.queue.run(async () => {
        for (const entry of f.context.mutations.accepted) entry.record = (await reconcileRecord(entry.path, f.context.adapter, entry.record)).record
      })
      f.context.state.handlerGeneration = randomUUID()
      service = track(createAgentService({ ...composition, store: createAgentStore(root) })); await service.initialize(); return service
    },
  }
}