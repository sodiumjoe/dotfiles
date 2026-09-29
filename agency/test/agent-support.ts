import { assertGitChildrenClosed, checkoutIdFor } from "../src/checkout/identity.js"
import { PassThrough } from "node:stream"
import { isDeepStrictEqual } from "node:util"
import { EventEmitter } from "node:events"
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process"
import { mkdir, open, rename, rm, writeFile, readFile, readdir } from "node:fs/promises"
import assert from "node:assert/strict"
import { createConnection } from "node:net"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { createAgentProcess, type OwnedAgentProcess } from "../src/agent/process.js"
import { removeProviderState } from "../src/agent/state.js"
import { AgentError } from "../src/agent/types.js"
import { privateRoot, controlFixture, until, fileExists, failFixtureBatch } from "./control-support.js"
import { MutationQueue } from "../src/handler/mutations.js"
import type { AdmissionContext } from "../src/checkout/admission.js"
import { readHandlerRecord, readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import type { LaunchRecord, ProcessIdentity } from "../src/platform/types.js"
import { createAgentService, type AgentService } from "../src/agent/service.js"
import { createAgentStore } from "../src/agent/store.js"
import { createCatalogStore } from "../src/catalog/store.js"
import { observeConfig } from "../src/catalog/config.js"
import { isFresh, type CatalogSnapshot, type ProviderProfile } from "../src/catalog/types.js"
import type { CatalogService } from "../src/catalog/service.js"
import { observeLaunchContract } from "../src/agent/contracts.js"
import { contractFromQualifiedCandidate, qualificationFingerprint, type CodexQualificationManifest } from "../src/agent/qualification.js"
import { admissionFixture, gitFixture } from "./checkout-support.js"
import { inventoryAdmissions } from "../src/checkout/records.js"
import { inventoryLaunches } from "../src/handler/inventory.js"
import { AGENT_PROTOCOL, exchangeAgent, type AgentRequest } from "../src/agent/protocol.js"
import { PROTOCOL } from "../src/control/protocol.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import type { TestContext } from "node:test"
import { createAcpConnection } from "../src/agent/acp.js"
import type { LaunchContract } from "../src/agent/contracts.js"
import type { AgentCommand, AgentRecord, LaunchSpec, SessionEvidence, StartInput, StartSelection, AgentTuple, CommandView } from "../src/agent/types.js"

export type AgentHandlerOptions = { pauseAt?: "intent" | "reservation" | "attempted" | "identity" | "session" | "ready" | "receipt" | "stop-intent" | "stop-cleanup" | "stop-verified" | "stop-receipt-before" | "stop-receipt-after"; reservationHang?: "before" | "launch" | "admission"; failReceiptSync?: boolean; fatalClose?: boolean }

export async function agentHandlerFixture(t: TestContext, options: AgentHandlerOptions = {}) {
  const git = await gitFixture(t), f = await controlFixture(t, {}, git, fileURLToPath(new URL("./fixtures/agent-handler.js", import.meta.url)))
  const owned = new Map<string, LaunchRecord>(), seen = new Set<string>(), requests: Promise<unknown>[] = []
  const inventory = async () => ({ ...await createAgentStore(f.paths.persistentRoot).inventory(), launches: await inventoryLaunches(join(f.paths.persistentRoot, "launches")) })
  async function trackProviders(): Promise<void> {
    for (const name of (await readdir(f.root)).filter(name => /^spawn-.*\.json$/.test(name))) {
      const hint = JSON.parse(await readFile(join(f.root, name), "utf8")) as { pid: number; agentId: string; attempt: string }
      if (seen.has(hint.attempt)) continue
      assert.ok(Number.isSafeInteger(hint.pid) && hint.pid > 1)
      const agent = await createAgentStore(f.paths.persistentRoot).readAgent(hint.agentId)
      assert.ok(agent); assert.equal(agent.spec.launchAttemptId, hint.attempt)
      const identity = await f.observe(hint.pid)
      if (identity === null) {
        for (let n = 0; n < 2; n++) { assert.equal(await f.observe(hint.pid), null); assert.deepEqual(await f.adapter.readGroup(hint.pid), []) }
      } else {
        assert.equal(identity.birth.slice(identity.birth.indexOf(":") + 1), `agy-provider:${hint.attempt}`)
        assert.equal(identity.bootId, await f.adapter.bootId())
        assert.equal(identity.pid, identity.processGroupId); assert.equal(identity.pid, identity.sessionId)
        assert.equal(identity.uid, process.getuid!()); assert.equal(identity.gid, process.getgid!())
        const members = await f.adapter.readGroup(hint.pid)
        assert.deepEqual(await f.adapter.readGroup(hint.pid), members); assert.deepEqual(members, [identity])
        const record: LaunchRecord = { version: 1, checkoutId: agent.spec.checkout.checkoutId, agentId: hint.agentId, leaseId: agent.spec.leaseId, handlerGeneration: agent.spec.handlerGeneration, launchAttemptId: hint.attempt, launchBootId: identity.bootId, launchAttempted: true, provider: { kind: "process-group", group: { leader: identity, observed: members } }, phase: "active", reason: null }
        await writeLaunchRecord(join(f.root, `owned-${hint.attempt}.json`), record)
        owned.set(hint.attempt, record)
      }
      seen.add(hint.attempt)
    }
  }
  const handler = () => readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  const releaseBarrier = async () => { for (const name of ["release-barrier", "release-session"]) await writeFile(join(f.root, name), "released", { mode: 0o600 }) }
  async function proveAbsent(identity: ProcessIdentity): Promise<void> {
    await until(async () => await f.observe(identity.pid) === null ? true : undefined, 15000)
    for (let n = 0; n < 2; n++) { assert.equal(await f.observe(identity.pid), null); assert.deepEqual(await f.adapter.readGroup(identity.pid), []) }
  }
  let cleaned: Promise<void> | undefined
  const cleanupOwned = () => cleaned ??= (async () => {
    await trackProviders(); await releaseBarrier(); await Promise.allSettled(requests)
    const current = await handler().catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return null })
    if (current?.process && await f.observe(current.process.pid) !== null) {
      try { await f.call({ protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: current.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true }) } catch {}
      await trackProviders()
      await f.signal(current.process, "SIGKILL"); await proveAbsent(current.process)
    }
    await trackProviders()
    const agents = await inventory(), launches = await inventoryLaunches(join(f.paths.persistentRoot, "launches")), admissions = await inventoryAdmissions(f.paths.persistentRoot), probes = await createCatalogStore(f.paths.persistentRoot).inventory()
    assert.deepEqual(agents.issues, []); assert.deepEqual(admissions.issues, []); assert.deepEqual(probes.issues, [])
    assert.deepEqual(probes.launches, [])
    for (const record of owned.values()) {
      const path = join(f.root, `${record.launchAttemptId}-supervisor-cleanup.json`)
      await writeLaunchRecord(path, record)
      assert.equal((await reconcileRecord(path, f.adapter, record)).record.phase, "cleanup_verified")
      for (const identity of record.provider!.group.observed) await proveAbsent(identity)
    }
    for (const entry of launches) if (entry.record.provider) for (const identity of entry.record.provider.group.observed) await proveAbsent(identity)
    for (const identity of f.owned) await proveAbsent(identity)
    assertGitChildrenClosed(); git.verifyCleanup()
    const evidence = { handlers: f.owned, providers: [...owned.values()], launches, admissions, agents, probes, survivors: [] }
    await writeFile(join(f.root, "agent-cleanup.json"), JSON.stringify(evidence), { mode: 0o600 })
    t.diagnostic("agent cleanup verified: " + JSON.stringify(evidence))
  })().catch(error => { throw failFixtureBatch(new Error(`agent fixture cleanup incomplete; retained ${f.root} and ${git.root}`, { cause: error })) })
  f.beforeCleanup(cleanupOwned)
  for (const name of ["home", "profile"]) await mkdir(join(f.root, name), { mode: 0o700 })
  const executable = join(f.root, "profile/native"), adapterPackageJson = join(f.root, "profile/adapter.json"), configuration = join(f.root, "profile/declared.json")
  await writeFile(executable, "fixture metadata only", { mode: 0o700 }); await writeFile(adapterPackageJson, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.0.0" }), { mode: 0o600 }); await writeFile(configuration, "{}", { mode: 0o600 })
  const profile: ProviderProfile = { id: "codex-acp", enabled: true, executable, adapterPackageJson, sdkPackageJson: null, configurationFiles: [configuration] }
  await mkdir(join(f.paths.persistentRoot, "catalog"), { mode: 0o700 })
  await writeFile(join(f.paths.persistentRoot, "catalog/providers.json"), JSON.stringify({ version: 1, providers: [profile] }), { mode: 0o600 })
  const configure = (settings: AgentHandlerOptions) => writeFile(f.configPath, JSON.stringify({ paths: f.paths, profile, ...settings }), { mode: 0o600 })
  await configure(options)
  if (options.pauseAt === "session") await writeFile(join(f.root, "pause-session"), "pause", { mode: 0o600 })
  const starting = f.start(15000)
  if (options.fatalClose) {
    void starting.catch(() => undefined)
    await until(async () => { try { return (await handler()).phase === "ready" ? true : undefined } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined } }, 10000)
  } else await starting
  async function call(operation: Omit<Extract<AgentRequest, { op: "agent_start" }>, "protocol" | "requestId" | "handlerGeneration"> | Omit<Extract<AgentRequest, { op: "agent_stop" }>, "protocol" | "requestId" | "handlerGeneration"> | { op: "agent_list" } | { op: "agent_current"; cwd: string } | { op: "agent_command"; commandId: string; commandGeneration: string }) {
    const current = await handler()
    const operationPromise = exchangeAgent(createConnection(f.paths.handlerSocketPath), { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: current.generation, ...operation }, 15000)
    requests.push(operationPromise)
    try {
      const reply = await operationPromise
      if (!reply.ok) throw new AgentError(reply.error.code)
      return reply.result
    } finally { await trackProviders() }
  }
  const commandView = (result: Awaited<ReturnType<typeof call>>): CommandView => { assert.equal(result.state, "command"); if (result.state !== "command") throw new Error("wrong reply"); return result }
  const startAt = async (cwd: string, selection: Partial<StartSelection> = {}) => commandView(await call({ op: "agent_start", input: { commandId: randomUUID(), handlerGeneration: (await handler()).generation, cwd, selection: { ...sampleSpec().selection, ...selection } } }))
  const command = async (commandId: string, commandGeneration: string) => commandView(await call({ op: "agent_command", commandId, commandGeneration }))
  const currentAt = async (cwd: string) => { const result = await call({ op: "agent_current", cwd }); assert.equal(result.state, "current"); if (result.state !== "current") throw new Error("wrong reply"); return result }
  return { paths: f.paths, git, inventory, startAt, currentAt, command, releaseBarrier,
    start: (selection?: Partial<StartSelection>) => startAt(git.repo, selection),
    current: () => currentAt(git.repo),
    async list() { const result = await call({ op: "agent_list" }); assert.equal(result.state, "agents"); if (result.state !== "agents") throw new Error("wrong reply"); return result },
    stop: async (target: AgentTuple, commandId = randomUUID()) => commandView(await call({ op: "agent_stop", input: { ...target, commandId } })),
    retry: async (value: AgentCommand) => commandView(await call({ op: "agent_start", input: value.input as StartInput })),
    waitCompleted: (value: CommandView) => until(async () => { const result = await command(value.command.commandId, value.command.handlerGeneration); return result.command.state !== "pending" ? result : undefined }, 35000),
    providerCount: () => seen.size,
    async waitBarrier() { await until(async () => await fileExists(join(f.root, options.pauseAt === "session" ? "at-session" : "barrier.json")) ? true : undefined, 35000); assertGitChildrenClosed(); await trackProviders() },
    async crashHandler() { await trackProviders(); const current = await handler(); assert.ok(current.process); await f.signal(current.process, "SIGKILL"); await proveAbsent(current.process) },
    async failHandler() { await trackProviders(); await writeFile(join(f.root, "fatal-close"), "fail", { mode: 0o600 }); await until(async () => await fileExists(join(f.root, "failure")) ? true : undefined) },
    async waitHandlerExit() { const current = await handler(); assert.ok(current.process); await proveAbsent(current.process) },
    async reservationTimeoutEvidence() { return JSON.parse(await readFile(join(f.root, "reservation-timeout.json"), "utf8")) as { pid: number; signal: string; attempt: string } },
    async restart() { await configure({}); await releaseBarrier(); await f.start(15000) },
    async killProvider(target: AgentTuple) { await trackProviders(); const record = [...owned.values()].find(record => record.agentId === target.agentId && record.handlerGeneration === target.handlerGeneration); assert.ok(record?.provider); await f.signal(record.provider.group.leader, "SIGKILL"); await proveAbsent(record.provider.group.leader) },
    verifyZeroSurvivors: cleanupOwned,
  }
}

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
  return { id: "fixture-v1", providerId: "codex-acp", adapterVersion: "1.0.0", entrypoint: "/fixture.mjs", fingerprint: "c".repeat(64), modes: { state: "values", values: ["plan", "review"] }, reasoning: { state: "values", values: ["high", "low"] }, effectiveMode: null, permissionProfiles: ["fixture-deny-v1"], modelOption: "model", reasoningOption: "reasoning", modeOption: "mode", environment: { fixed: {}, private: {} }, permissionEvidence: "fixture-contract-v1", qualification: null }
}

export function sampleQualifiedContract(): LaunchContract {
  const pin = (path: string) => ({ path, sha256: "a".repeat(64), identity: ["1", "2", "3", "4", "5", "448", "501", "20", "1"] as const })
  const manifest: CodexQualificationManifest = {
    version: 1, policy: "agency-codex-deny-all-v1", platform: "darwin", architecture: "arm64", providerId: "codex-acp", contractId: "codex-darwin-arm64-agency-deny-all-v1", adapterPackage: "@agentclientprotocol/codex-acp", adapterVersion: "1.7.0",
    adapterPackageJson: pin("/fixture/package.json"), adapterEntrypoint: pin("/fixture/adapter.mjs"), codexExecutable: pin("/Users/moon/.cache/stripe/codex/0.155.1/codex-aarch64-apple-darwin"), nodeExecutable: pin(process.execPath), nodeVersion: "24.13.0", protocolVersion: 1,
    qualificationCwd: { source: "attempt-root", relative: "checkout" },
    deadlines: { commandMs: 5000, reservationMs: 5000, spawnMs: 5000, initializeMs: 15000, sessionMs: 15000, optionMs: 5000, transportCloseMs: 1000, processTerminateMs: 5000, absenceMs: 2000, overallMs: 45000 },
    selection: { modelId: "gpt-5.6-sol", reasoning: "high", mode: "read-only", permissionProfile: "deny-all" }, optionIds: { model: "model", reasoning: "reasoning_effort", mode: "mode" },
    environment: { fixed: { CODEX_PATH: "/Users/moon/.cache/stripe/codex/0.155.1/codex-aarch64-apple-darwin", INITIAL_AGENT_MODE: "read-only", MODEL_PROVIDER: "litellm", PATH: "/usr/local/bin:/usr/bin:/bin", CODEX_CONFIG: JSON.stringify({ approval_policy: "on-request", approvals_reviewer: "user", sandbox_mode: "workspace-write", mcp_servers: {} }) }, private: { HOME: "home", CODEX_HOME: "home/codex", XDG_CONFIG_HOME: "xdg/config", XDG_CACHE_HOME: "xdg/cache", XDG_STATE_HOME: "xdg/state", TMPDIR: "tmp" } }, userStatePaths: ["/Users/moon/.codex"],
  }
  return contractFromQualifiedCandidate({ version: 1, manifest, fingerprint: qualificationFingerprint(manifest) })
}

export function sampleQualifiedSpec(): LaunchSpec {
  const spec = sampleSpec(), contract = sampleQualifiedContract()
  return { ...spec, contractId: contract.id, contractFingerprint: contract.fingerprint, selection: { providerId: "codex-acp", modelId: "gpt-5.6-sol", reasoning: { kind: "value", value: "high" }, mode: "read-only", permissionProfile: "deny-all" }, configuration: { ...spec.configuration, adapterVersion: "1.7.0" }, catalogEvidence: { ...spec.catalogEvidence, adapterVersion: "1.7.0", models: [{ ...spec.catalogEvidence.models[0]!, modelId: "gpt-5.6-sol" }] } }
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
  const root = await privateRoot(t), spec = sampleSpec(), contract = sampleContract(), beforeSpawn = agentGate(), publication = agentGate(), spawned = agentGate(), absentEntered = agentGate(), terminated = agentGate(), cleanupObservation = agentGate()
  const path = join(root, "launches", spec.launchAttemptId + ".json")
  await mkdir(join(root, "launches"), { mode: 0o700 })
  const launch: LaunchRecord = { version: 1, checkoutId: spec.checkout.checkoutId, agentId: spec.agentId, leaseId: spec.leaseId, handlerGeneration: spec.handlerGeneration, launchAttemptId: spec.launchAttemptId, launchBootId: "boot-a", launchAttempted: false, provider: null, phase: "launch_pending", reason: null }
  await writeLaunchRecord(path, launch)
  const peer = scriptedAcp(t); peer.connection.close()
  const child = new EventEmitter() as ChildProcess
  let unrefs = 0
  Object.assign(child, { pid: 12345, stdin: peer.writable, stdout: peer.readable, stderr: new PassThrough(), exitCode: null, signalCode: null, unref() { unrefs++ } })
  let live = false, count = 0, bootCalls = 0, absentGroups = 0, observedOptions: SpawnOptions | undefined, identityPublished = false, earlyWrites = 0, invalidation = "", checks = 0
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
    adapter: { platform: "linux", bootId: async () => {
      if (scenario === "cleanup-boot-hang" && ++bootCalls === 3) { cleanupObservation.resolve(); return new Promise<string>(() => undefined) }
      return "boot-a"
    }, readProcess: async () => scenario === "identity-hang" && live ? new Promise<ProcessIdentity>(() => undefined) : live ? structuredClone(identity) : null, readGroup: async () => {
      if (!live && scenario === "absence-hang" && ++absentGroups === 3) { absentEntered.resolve(); return new Promise<ProcessIdentity[]>(() => undefined) }
      return live ? [structuredClone(identity)] : []
    }, async signalGroup(group, signal) {
      if (group !== 12345) throw new Error("wrong signal target")
      signals.push(signal)
      if (signal === "SIGTERM" && ["ignore-term", "esrch-survivor"].includes(scenario)) {
        if (scenario === "esrch-survivor") throw Object.assign(new Error("missing"), { code: "ESRCH" })
        return
      }
      live = false
      terminated.resolve()
      if (scenario !== "termination-hang") queueMicrotask(() => { child.emit("exit", 0, signal); if (scenario !== "close-held") child.emit("close", 0, signal) })
    } },
  }
  if (scenario === "queued-preparation") void context.mutations.queue.run(async () => { beforeSpawn.resolve(); await publication.promise })
  peer.writable.on("data", () => { if (!identityPublished) earlyWrites++ })
  const owner = createAgentProcess({ context, spec, contract: { ...contract, environment: { fixed: { HOME: "/fixture-home", FIXTURE: "yes", NODE_OPTIONS: "forbidden", NODE_PATH: "forbidden", AGENCY_TEST: "forbidden", GIT_DIR: "forbidden" }, private: {} } }, reservation: { launch, admission: { version: 1, checkout: spec.checkout, handlerGeneration: spec.handlerGeneration, agentId: spec.agentId, leaseId: spec.leaseId, launchAttemptId: spec.launchAttemptId } }, async revalidate() {
    checks++
    if (invalidation || scenario === "restore-failure" && checks > 1) throw new AgentError("CONFIG_CHANGED")
  } }, { spawn: ((executable: string, args: string[], options: SpawnOptions) => {
    count++; observedOptions = options; spawned.resolve()
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
      if (scenario === "identity-publication-paused" && record.provider) { beforeSpawn.resolve(); await publication.promise }
    },
    async read(file) { if (scenario === "attempt-readback" && checks === 1) { checks++; throw new Error("readback failed") }; return readLaunchRecordForReconciliation(file) },
  }, now: () => Date.now() })
  return { owner, root, spec, context, signals, beforeSpawn, spawned: spawned.promise, absentEntered: absentEntered.promise, terminated: terminated.promise, cleanupObservation: cleanupObservation.promise, releasePublication: publication.resolve, spawnCount: () => count, unrefs: () => unrefs, record: () => readLaunchRecordForReconciliation(path), writesBeforeIdentity: () => earlyWrites, options: () => observedOptions, invalidate: (why: string) => { invalidation = why }, replaceIdentity() { identity.birth = `200:agy-provider:${spec.launchAttemptId}` }, eof: () => peer.readable.end(), pipesDestroyed: () => child.stdin!.destroyed && child.stdout!.destroyed && child.stderr!.destroyed }
}

export function scriptedAcp(t: TestContext, scenario = "exact", settings: { qualified?: boolean; response?: (request: any, reply: any) => unknown; hold?: number } = {}) {
  const readable = new PassThrough(), writable = new PassThrough(), sent: Array<{ method: string; params: any }> = [], permissionReplies: unknown[] = []
  const options = [
    { id: "model", type: "select", name: "Model", currentValue: "model-a", options: [{ value: "model-a", name: "Model α" }] },
    { id: "reasoning", type: "select", name: "Reasoning", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    { id: "mode", type: "select", name: "Mode", currentValue: "plan", options: [{ value: "plan", name: "Plan" }, { value: "review", name: "Review" }] },
  ]
  if (settings.qualified) {
    options[0]!.currentValue = "gpt-5.6-sol"; options[0]!.options = [{ value: "gpt-5.6-sol", name: "Model" }]
    options[1]!.id = "reasoning_effort"; options[2]!.options.push({ value: "read-only", name: "Read only" })
  }
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
      if (sent.length === settings.hold) continue
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
      send(settings.response ? settings.response(request, reply) : reply)
      if (scenario === "duplicate-id") send(reply)
    }
  })
  t.after(() => { connection.close(); readable.destroy(); writable.destroy() })
  return { connection, sent, permissionReplies, readable, writable, send, triggerDrift() { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } } }) } }
}

export async function agentServiceFixture(t: TestContext, options: { contract?: boolean; injectedOnly?: boolean; pause?: "reservation" | "attempted" | "spawn" | "ready"; observe?: (count: number, spec: LaunchSpec) => Promise<void>; neverReserve?: boolean; pauseCommand?: boolean; pauseStateRemoval?: boolean; failStateRemoval?: boolean; failAfterStateRemoval?: boolean } = {}) {
  const teardown: Array<() => unknown> = [], childContext = Object.create(t) as TestContext
  childContext.after = fn => { teardown.push(() => fn?.(t, error => { if (error) throw error })) }
  const f = await admissionFixture(childContext), root = f.root, entered = agentGate(), reservationEntered = agentGate(), commandEntered = agentGate(), released = agentGate(), readyCommitEntered = agentGate(), readyCommitReleased = agentGate(), stateRemovalReleased = agentGate(), publications: string[] = []
  let stateRemovalCalls = 0, evidenceCalls = 0, fatalCalls = 0, reservationCalls = 0, cleanupCalls = 0
  const requests: Promise<unknown>[] = [], owners: OwnedAgentProcess[] = []
  const track = (service: AgentService): AgentService => {
    const start = service.start.bind(service), stop = service.stop.bind(service)
    service.start = request => { const operation = start(request); requests.push(operation); return operation }
    service.stop = request => { const operation = stop(request); requests.push(operation); return operation }
    return service
  }
  const directory = join(root, "catalog"), config = join(root, "declared.json"), executable = join(root, "native"), adapterPackageJson = join(root, "adapter.json")
  if (!options.injectedOnly) await mkdir(directory, { mode: 0o700 })
  await writeFile(config, "{}", { mode: 0o600 }); await writeFile(executable, "fixture", { mode: 0o700 }); await writeFile(adapterPackageJson, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.0.0" }), { mode: 0o600 })
  const profile: ProviderProfile = { id: "codex-acp", enabled: true, executable, adapterPackageJson, sdkPackageJson: null, configurationFiles: [config] }
  if (!options.injectedOnly) await writeFile(join(directory, "providers.json"), JSON.stringify({ version: 1, providers: [profile] }), { mode: 0o600 })
  const configuration = await observeConfig(profile), catalogStore = createCatalogStore(root)
  let snapshot: CatalogSnapshot = { version: 1, hostId: f.context.paths.hostKey, snapshotId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, createdAt: Date.now(), providers: [{ ...sampleSpec().catalogEvidence, fingerprint: configuration.fingerprint, verifiedAt: Date.now(), verifiedHandlerGeneration: f.context.state.handlerGeneration }] }
  const saveCatalog = async () => { if (!options.injectedOnly) { await catalogStore.writeSnapshot(snapshot); await catalogStore.publishCurrent(snapshot) } }
  await saveCatalog()
  const contract = { ...sampleContract(), entrypoint: join(root, "agent-provider.js"), environment: { fixed: { HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root, FIXTURE_ROOT: root }, private: {} } }
  await writeFile(contract.entrypoint, await readFile(fileURLToPath(new URL("./fixtures/agent-provider.js", import.meta.url))), { mode: 0o600 })
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
    if (options.pauseCommand && value.op === "start" && value.state === "pending") { commandEntered.resolve(); await released.promise }
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
    const processDependencies = { spawn: (() => {
      const pid = 20000 + ++spawnCount, child = new EventEmitter() as ChildProcess
      Object.assign(child, { pid, stdin: peer.writable, stdout: peer.readable, stderr: new PassThrough(), exitCode: null, signalCode: null, unref() {} })
      processes.set(pid, { child, identity: { pid, birth: `100:agy-provider:${input.spec.launchAttemptId}`, bootId: "boot-a", parentPid: process.pid, processGroupId: pid, sessionId: pid, uid: process.getuid!(), gid: process.getgid!() } })
      return child
    }) as typeof spawn, transitionIO: { read: readLaunchRecordForReconciliation, async publish(path: string, record: LaunchRecord) {
      await writeLaunchRecord(path, record)
      if (record.launchAttempted && record.provider === null) await pause("attempted")
    } }, ...((options.pauseStateRemoval || options.failStateRemoval || options.failAfterStateRemoval) ? { async removeProviderState(persistentRoot: string, attempt: string) {
      stateRemovalCalls++
      if (options.pauseStateRemoval) await stateRemovalReleased.promise
      if (options.failStateRemoval) throw new Error("state removal failed")
      await removeProviderState(persistentRoot, attempt, options.failAfterStateRemoval ? { afterQuarantineRemoval: async () => { throw new Error("parent sync failed") } } : {})
    } } : {}) }
    const owner = createAgentProcess(input, processDependencies)
    owners.push(owner)
    return { ...owner, cleanup() { cleanupCalls++; return owner.cleanup() }, async initialize(signal) { await pause("spawn", signal); const session = await owner.initialize(signal); await pause("ready", signal); return session } }
  }
  const composition = { context: f.context, admission: { ...f.controller, async reserve(request: Parameters<typeof f.controller.reserve>[0]) { reservationCalls++; reservationEntered.resolve(); await pause("reservation"); publications.push("reservation"); if (options.neverReserve) return new Promise<Awaited<ReturnType<typeof f.controller.reserve>>>(() => undefined); return f.controller.reserve(request) } }, catalog, contracts: options.contract === false ? [] : [contract], store }
  const dependencies = { processFactory, async observeLaunchEvidence(spec: LaunchSpec, expected: { profile: ProviderProfile }) {
    publications.push("evidence"); evidenceCalls++; await options.observe?.(evidenceCalls, spec)
    if (snapshot.snapshotId !== spec.catalogSnapshotId || !isDeepStrictEqual(snapshot.providers[0], spec.catalogEvidence) || !isDeepStrictEqual(profile, expected.profile) || !isDeepStrictEqual(await observeConfig(profile), spec.configuration)) throw new AgentError("CONFIG_CHANGED")
  }, fatalReservationTimeout(): never { fatalCalls++; throw new Error("fixture Handler fail-stop") } }
  let service = track(createAgentService(composition, dependencies))
  t.after(async () => {
    released.resolve(); readyCommitReleased.resolve(); stateRemovalReleased.resolve()
    await Promise.allSettled(requests)
    if (!options.neverReserve && !fatalCalls) await service.freezeAndDrain(true).catch(() => undefined)
    service.close()
    await Promise.allSettled(owners.map(owner => owner.cleanup()))
    await f.context.mutations.queue.run(async () => undefined)
    assertGitChildrenClosed()
    for (const finish of teardown) await finish()
  })
  await service.initialize()
  const input = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, cwd: f.git.repo, selection: sampleSpec().selection }
  return { ...f, service, input, store, catalogStore, contract, profile, configuration, config, publications, entered: entered.promise, release: released.resolve, spawns: () => spawnCount, refreshes: () => refreshes, catalogReads: () => catalogReads, readyFailures: () => readyFailures,
    evidenceCalls: () => evidenceCalls, fatalCalls: () => fatalCalls, reservationCalls: () => reservationCalls, cleanupCalls: () => cleanupCalls, reservationEntered: reservationEntered.promise, commandEntered: commandEntered.promise,
    failReceipt(value: boolean) { failReceipt = value }, failReady(value: boolean) { failReady = value }, failInitialAgent(value: boolean) { failInitialAgent = value },
    failTerminal(value: boolean) { failTerminal = value }, terminalFailures: () => terminalFailures,
    holdReady(value: boolean) { holdReady = value }, readyCommitEntered: readyCommitEntered.promise, releaseReadyCommit: readyCommitReleased.resolve,
    fault(agent: string) { peers.get(agent)!.triggerDrift() },
    cleanupOwned: () => Promise.all(owners.map(owner => owner.cleanup())), stateRemovalCalls: () => stateRemovalCalls, releaseStateRemoval: stateRemovalReleased.resolve,
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
      service = track(createAgentService({ ...composition, store: createAgentStore(root) }, dependencies)); await service.initialize(); return service
    },
  }
}