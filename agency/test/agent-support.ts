import { launchContractFingerprint, type ConfiguredLaunchContract } from "../src/agent/contracts.js"
import type { LaunchContract } from "../src/agent/contracts.js"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import assert from "node:assert/strict"
import { createConnection } from "node:net"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { AgentError } from "../src/agent/types.js"
import { controlFixture, until, fileExists, failFixtureBatch, shutdownFixtureHandler } from "./control-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import type { LaunchRecord, ProcessIdentity } from "../src/platform/types.js"
import { createAgentStore } from "../src/agent/store.js"
import { createCatalogStore } from "../src/catalog/store.js"
import { type ProviderProfile } from "../src/catalog/types.js"
import { inventoryLaunches } from "../src/handler/inventory.js"
import { AGENT_PROTOCOL, exchangeAgent, type AgentRequest } from "../src/agent/protocol.js"
import { PROTOCOL } from "../src/control/protocol.js"
import type { TestContext } from "node:test"
import type { AgentCommand, AgentCommandV3, LaunchSpec, StartSelection, AgentTuple, CommandView } from "../src/agent/types.js"

export type AgentHandlerOptions = { tasks?: "hold" | "reject"; entry?: "synthetic"; nativeAcp?: boolean; selectionCatalog?: boolean; legacyCount?: number; catalogState?: "missing" | "stale" | "prior-generation" | "failed"; pauseAt?: "source-completion" | "tasks-released" | "handler-completed" | "intent" | "attempted" | "identity" | "session" | "prompt" | "ready" | "receipt" | "stop-intent" | "stop-cleanup" | "stop-verified" | "stop-receipt-before" | "stop-receipt-after"; failReceiptSync?: boolean; providerScenario?: string }

export async function verifyFixtureProviderGroup(identity: ProcessIdentity, io: { readGroup(pid: number): Promise<ProcessIdentity[]>; observe(pid: number): Promise<ProcessIdentity | null> }): Promise<ProcessIdentity[] | null> {
  const members = await io.readGroup(identity.pid), again = await io.readGroup(identity.pid)
  for (const group of [members, again]) for (const member of group) assert.deepEqual(member, identity)
  assert.ok(members.length <= 1 && again.length <= 1)
  const latest = await io.observe(identity.pid)
  if (latest === null) {
    for (let n = 0; n < 2; n++) { assert.equal(await io.observe(identity.pid), null); assert.deepEqual(await io.readGroup(identity.pid), []) }
    return null
  }
  assert.deepEqual(latest, identity)
  assert.deepEqual(members, [identity]); assert.deepEqual(again, members)
  return members
}

export { shutdownFixtureHandler } from "./control-support.js"

export async function agentHandlerFixture(t: TestContext, options: AgentHandlerOptions = {}, handlerEnv?: NodeJS.ProcessEnv) {
  const f = await controlFixture(t, {}, fileURLToPath(new URL("./fixtures/agent-handler.js", import.meta.url)), handlerEnv)
  const workspace = join(f.root, "workspace"), otherWorkspace = join(f.root, "other-workspace")
  await mkdir(workspace, { mode: 0o700 }); await mkdir(otherWorkspace, { mode: 0o700 })
  const owned = new Map<string, LaunchRecord>(), seen = new Set<string>(), requests: Promise<unknown>[] = []
  const inventory = async () => ({ ...await createAgentStore(f.paths.persistentRoot).inventory(), launches: await inventoryLaunches(join(f.paths.persistentRoot, "launches")) })
  async function trackProviders(): Promise<void> {
    const agents = (await createAgentStore(f.paths.persistentRoot).inventory()).agents
    for (const item of f.registrations().filter(item => item.role.startsWith("agent-provider/"))) {
      const attempt = item.role.slice("agent-provider/".length)
      seen.add(attempt)
      if (owned.has(attempt) || !item.identity) continue
      const agent = agents.find(agent => agent.launch?.launchAttemptId === attempt)
      if (!agent?.launch) continue
      const identity = item.identity
      const record: LaunchRecord = { version: 2, owner: { kind: "agent", agentId: agent.definition.agentId, providerGeneration: agent.launch.providerGeneration }, handlerGeneration: agent.launch.handlerGeneration, launchAttemptId: attempt, launchBootId: identity.bootId, launchAttempted: true, provider: { kind: "process-group", group: { leader: identity, observed: [identity] } }, phase: "active", reason: null }
      owned.set(attempt, record)
    }
  }
  const handler = () => readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  const releaseBarrier = async () => { for (const name of ["release-barrier", "release-session", "release-prompt"]) await writeFile(join(f.root, name), "released", { mode: 0o600 }) }
  async function proveAbsent(identity: ProcessIdentity, timeout = 15000): Promise<void> {
    await until(async () => await f.observe(identity.pid) === null ? true : undefined, timeout)
    for (let n = 0; n < 2; n++) { assert.equal(await f.observe(identity.pid), null); assert.deepEqual(await f.adapter.readGroup(identity.pid), []) }
  }
  let cleaned: Promise<void> | undefined
  const cleanupOwned = () => cleaned ??= (async () => {
    await trackProviders(); await releaseBarrier(); await Promise.allSettled(requests)
    const current = await handler().catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return null })
    if (current?.process && await f.observe(current.process.pid) !== null) {
      await f.shutdownOwnedHandler({ generation: current.generation, process: current.process }, {
        request: () => f.call({ protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: current.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true }),
        track: trackProviders, signal: () => f.signal(current.process!, "SIGKILL"), absent: () => proveAbsent(current.process!),
      })
    }
    await trackProviders()
    const agents = await inventory(), launches = await inventoryLaunches(join(f.paths.persistentRoot, "launches")), probes = await createCatalogStore(f.paths.persistentRoot).inventory()
    assert.deepEqual(agents.issues, []); assert.deepEqual(probes.issues, [])
    assert.deepEqual(probes.launches, [])
    for (const record of owned.values()) {
      const registered = f.registrations().find(item => item.role === "agent-provider/" + record.launchAttemptId)
      if (registered?.pid && await f.observe(registered.pid) !== null) await f.signal(record.provider!.group.leader, "SIGKILL")
      for (const identity of record.provider!.group.observed) await proveAbsent(identity)
    }
    for (const entry of launches) if (entry.record.provider) for (const identity of entry.record.provider.group.observed) await proveAbsent(identity)
    for (const identity of f.owned) await proveAbsent(identity)
    const evidence = { handlers: f.owned, providers: [...owned.values()], launches, agents, probes, survivors: [] }
    await writeFile(join(f.root, "agent-cleanup.json"), JSON.stringify(evidence), { mode: 0o600 })
    t.diagnostic("agent cleanup verified: " + JSON.stringify(evidence))
  })().catch(error => { throw failFixtureBatch(new Error(`agent fixture cleanup incomplete; retained ${f.root}`, { cause: error })) })
  f.beforeCleanup(cleanupOwned)
  for (const name of ["home", "profile"]) await mkdir(join(f.root, name), { mode: 0o700 })
  const executable = join(f.root, "profile/native"), adapterPackageJson = join(f.root, "profile/adapter.json"), configuration = join(f.root, "profile/declared.json")
  await writeFile(executable, "fixture metadata only", { mode: 0o700 }); await writeFile(adapterPackageJson, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.0.0", main: "agent-provider.js" }), { mode: 0o600 }); await writeFile(join(f.root, "profile/agent-provider.js"), await readFile(fileURLToPath(new URL("./fixtures/agent-provider.js", import.meta.url))), { mode: 0o600 }); await writeFile(configuration, "{}", { mode: 0o600 })
  const profile: ProviderProfile = { id: "codex-acp", enabled: true, executable, adapterPackageJson, sdkPackageJson: null, configurationFiles: [configuration] }
  await mkdir(join(f.paths.persistentRoot, "catalog"), { mode: 0o700 })
  await writeFile(join(f.paths.persistentRoot, "catalog/providers.json"), JSON.stringify({ version: 1, providers: [profile] }), { mode: 0o600 })
  await writeFile(join(f.paths.persistentRoot, "catalog/backends.json"), JSON.stringify({ version: 1, defaultBackendId: "codex-acp", backends: [{ id: "codex-acp", args: [], environmentDefaults: {}, initial: {}, compatibilityId: "fixture-v1" }] }), { mode: 0o600 })
  const profiles = [profile]
  if (options.nativeAcp) {
    await writeFile(join(f.root, "profile/agent-provider.js"), await readFile(fileURLToPath(new URL("./fixtures/acp-provider.js", import.meta.url))), { mode: 0o600 })
    const secondary = join(f.root, "secondary")
    await mkdir(secondary, { mode: 0o700 })
    await writeFile(join(secondary, "native"), "fixture metadata only", { mode: 0o700 })
    await writeFile(join(secondary, "adapter.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "1.0.0", main: "agent-provider.js" }), { mode: 0o600 })
    await writeFile(join(secondary, "agent-provider.js"), await readFile(fileURLToPath(new URL("./fixtures/acp-provider.js", import.meta.url))), { mode: 0o600 })
    await writeFile(join(secondary, "declared.json"), "{}", { mode: 0o600 })
    await writeFile(join(secondary, "sdk.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.232", main: "sdk.js" }), { mode: 0o600 })
    await writeFile(join(secondary, "sdk.js"), "", { mode: 0o600 })
    profiles.push({ ...profile, id: "claude-agent-acp", executable: join(secondary, "native"), adapterPackageJson: join(secondary, "adapter.json"), sdkPackageJson: join(secondary, "sdk.json"), configurationFiles: [join(secondary, "declared.json")] })
    await writeFile(join(f.paths.persistentRoot, "catalog/providers.json"), JSON.stringify({ version: 1, providers: profiles }), { mode: 0o600 })
    await writeFile(join(f.paths.persistentRoot, "catalog/backends.json"), JSON.stringify({ version: 1, defaultBackendId: "codex-acp", backends: profiles.map(value => ({ id: value.id, args: [], environmentDefaults: { FIXTURE_ROOT: f.root, FIXTURE_BACKEND: value.id, ...(options.selectionCatalog ? { FIXTURE_SELECTION: "true" } : {}) }, initial: {}, compatibilityId: "fixture-v1" })) }), { mode: 0o600 })
  }
  if (options.legacyCount) {
    const directory = join(f.paths.persistentRoot, "agents/records")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (let index = 0; index < options.legacyCount; index++) {
      const agentId = randomUUID()
      await writeFile(join(directory, agentId + ".json"), JSON.stringify({ version: 1,
        spec: { agentId, handlerGeneration: randomUUID(), providerGeneration: randomUUID(), launchAttemptId: randomUUID(), checkout: { root: { path: otherWorkspace } } },
        phase: "stopped", session: null, failure: null }), { mode: 0o600 })
    }
  }
  const configure = (settings: AgentHandlerOptions) => writeFile(f.configPath, JSON.stringify({ paths: f.paths, profile, profiles, ...settings }), { mode: 0o600 })
  await configure(options)
  if (options.pauseAt === "session") await writeFile(join(f.root, "pause-session"), "pause", { mode: 0o600 })
  if (options.pauseAt === "prompt") await writeFile(join(f.root, "pause-prompt"), "pause", { mode: 0o600 })
  try { await f.start(15000) } catch (error) {
    let detail = ""
    try { detail = await readFile(join(f.root, "failure"), "utf8") } catch {}
    throw new Error("fixture startup failed: " + detail, { cause: error })
  }
  async function call(operation: import("../src/agent/human-controls.js").RuntimeHumanRequest | Omit<Extract<AgentRequest, { op: "agent_start" }>, "protocol" | "requestId" | "handlerGeneration"> | Omit<Extract<AgentRequest, { op: "agent_restore" }>, "protocol" | "requestId" | "handlerGeneration"> | Omit<Extract<AgentRequest, { op: "agent_stop" }>, "protocol" | "requestId" | "handlerGeneration"> | Omit<Extract<AgentRequest, { op: "agent_prompt" }>, "protocol" | "requestId" | "handlerGeneration"> | { op: "agent_choices" } | { op: "agent_page"; input: import("../src/agent/queries.js").PageInput } | { op: "agent_list" } | { op: "agent_current"; cwd: string } | { op: "agent_command"; commandId: string; commandGeneration: string }) {
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
  const providerEnvironment = () => ({ ...process.env, FIXTURE_ROOT: f.root, FIXTURE_SCENARIO: options.providerScenario ?? "normal" } as Record<string, string>)
  const startAt = async (cwd: string, selection: Partial<StartSelection> = {}) => commandView(await call({ op: "agent_start", input: { commandId: randomUUID(), handlerGeneration: (await handler()).generation, cwd, selection: { ...sampleSpec().selection, ...selection }, environment: providerEnvironment() } }))
  const command = async (commandId: string, commandGeneration: string) => commandView(await call({ op: "agent_command", commandId, commandGeneration }))
  const currentAt = async (cwd: string) => { const result = await call({ op: "agent_current", cwd }); assert.equal(result.state, "current"); if (result.state !== "current") throw new Error("wrong reply"); return result }
  return { adapter: f.adapter, human: (operation: import("../src/agent/human-controls.js").RuntimeHumanRequest) => call(operation), control: f.call, root: f.root, configPath: f.configPath, paths: f.paths, owned: f.owned, observe: f.observe, workspace, otherWorkspace, inventory, startAt, currentAt, command, releaseBarrier,
    async choices() { const result = await call({ op: "agent_choices" }); if (result.state !== "choices") throw new Error("wrong reply"); return result },
    async page(input: import("../src/agent/queries.js").PageInput) { const result = await call({ op: "agent_page", input }); if (result.state !== "page") throw new Error("wrong reply"); return result },
    start: (selection?: Partial<StartSelection>) => startAt(workspace, selection),
    current: () => currentAt(workspace),
    async list() { const result = await call({ op: "agent_list" }); assert.equal(result.state, "agents"); if (result.state !== "agents") throw new Error("wrong reply"); return result },
    stop: async (target: AgentTuple, commandId = randomUUID()) => { await trackProviders(); return commandView(await call({ op: "agent_stop", input: { ...target, commandId } })) },
    restore: async (agentId: string) => commandView(await call({ op: "agent_restore", input: { agentId, commandId: randomUUID(), handlerGeneration: (await handler()).generation, environment: providerEnvironment() } })),
    providerRequests: async () => (await readFile(join(f.root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> }),
    async prompt(target: AgentTuple, text: string) { const result = await call({ op: "agent_prompt", input: { ...target, text } }); assert.equal(result.state, "prompt"); if (result.state !== "prompt") throw new Error("wrong reply"); return result },
    retry: async (value: AgentCommand | AgentCommandV3) => command(value.commandId, value.handlerGeneration),
    async retryOperation(value: AgentCommand | AgentCommandV3) {
      const selection: StartSelection = value.version === 2 ? (value.input as import("../src/agent/types.js").StartCommandInput).selection : sampleSpec().selection
      const operation = value.op === "start" ? { op: "agent_start" as const, input: { commandId: value.commandId, handlerGeneration: value.handlerGeneration, cwd: String((value.input as { cwd: string }).cwd), selection, environment: providerEnvironment() } } : value.op === "restore" ? { op: "agent_restore" as const, input: { commandId: value.commandId, handlerGeneration: value.handlerGeneration, agentId: value.target!.agentId, environment: providerEnvironment() } } : { op: "agent_stop" as const, input: { ...value.target!, commandId: value.commandId } }
      const reply = await exchangeAgent(createConnection(f.paths.handlerSocketPath), { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: value.handlerGeneration, ...operation })
      if (!reply.ok) throw new AgentError(reply.error.code)
      return reply.result
    },
    waitCompleted: (value: CommandView) => until(async () => { const result = await command(value.command.commandId, value.command.handlerGeneration); return result.command.state !== "pending" ? result : undefined }, 35000),
    providerCount: () => seen.size,
    async waitBarrier() { await until(async () => await fileExists(join(f.root, options.pauseAt === "session" ? "at-session" : "barrier.json")) ? true : undefined, 35000); await trackProviders() },
    async waitPrompt() { await until(async () => await fileExists(join(f.root, "at-prompt")) ? true : undefined, 35000); await trackProviders() },
    async crashHandler() { await trackProviders(); const current = await handler(); assert.ok(current.process); await f.signal(current.process, "SIGKILL"); await proveAbsent(current.process) },
    async waitHandlerExit(timeout?: number) { const current = await handler(); assert.ok(current.process); await proveAbsent(current.process, timeout); await trackProviders() },
    async restart(settings: AgentHandlerOptions = {}) { await configure(settings); await releaseBarrier(); await f.start(15000) },
    waitCleanupBarrier: () => until(async () => await fileExists(join(f.root, "cleanup-barrier.json")) ? true : undefined, 35000),
    async killProvider(target: AgentTuple) { await trackProviders(); const record = [...owned.values()].find(record => record.version === 2 && record.owner.kind === "agent" && record.owner.agentId === target.agentId && record.handlerGeneration === target.handlerGeneration); assert.ok(record?.provider); await f.signal(record.provider.group.leader, "SIGKILL"); await proveAbsent(record.provider.group.leader) },
    async assertProviderAbsent(target: AgentTuple) {
      await trackProviders()
      const agent = await createAgentStore(f.paths.persistentRoot).readAgent(target.agentId)
      assert.ok(agent?.launch)
      assert.equal(agent.launch.handlerGeneration, target.handlerGeneration)
      assert.equal(agent.launch.providerGeneration, target.providerGeneration)
      const record = owned.get(agent.launch.launchAttemptId)
      assert.ok(record?.provider)
      assert.equal(record.version === 2 && record.owner.kind === "agent" ? record.owner.agentId : null, target.agentId)
      assert.equal(record.handlerGeneration, target.handlerGeneration)
      const identities = new Map([record.provider.group.leader, ...record.provider.group.observed].map(identity => [identity.pid, identity]))
      for (let pass = 0; pass < 2; pass++) {
        for (const identity of identities.values()) assert.equal(await f.observe(identity.pid), null)
        assert.deepEqual(await f.adapter.readGroup(record.provider.group.leader.processGroupId), [])
      }
    },
    verifyZeroSurvivors: cleanupOwned,
    async cleanupEvidence() { return JSON.parse(await readFile(join(f.root, "agent-cleanup.json"), "utf8")) as { handlers: ProcessIdentity[]; providers: LaunchRecord[]; launches: Array<{ path: string; record: LaunchRecord }>; survivors: unknown[] } },
  }
}

export const agentId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

export function sampleSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  const hostId = "a".repeat(64)
  const contract = sampleContract()
  return {
    hostId, agentId: agentId(1), handlerGeneration: agentId(2), providerGeneration: agentId(3), launchAttemptId: agentId(5), commandId: agentId(6), createdCommandId: agentId(6), cwd: "/workspace/a",
    selection: { providerId: "codex-acp", modelId: "model-a", reasoning: { kind: "value", value: "high" }, mode: "review", permissionProfile: "fixture-deny-v1" },
    catalogSnapshotId: agentId(7),
    catalogEvidence: { providerId: "codex-acp", fingerprint: "b".repeat(64), verifiedAt: 1000, verifiedHandlerGeneration: agentId(2), providerVersion: null, providerVersionSource: "unknown", adapterVersion: "1.0.0", sdkVersion: null, error: null, models: [{ providerId: "codex-acp", modelId: "model-a", resolvedModelId: null, displayName: "Model A", reasoning: { state: "values", values: ["high", "low"] }, modes: { state: "unknown" }, availability: "advertised" }] },
    configuration: { fingerprint: "b".repeat(64), scope: "declared-config-v1", providerId: "codex-acp", adapterVersion: "1.0.0", sdkVersion: null },
    contractId: contract.id, contractFingerprint: contract.fingerprint, containment: "direct-process-group-v1", authority: "normal-user",
    limits: { startupMs: 30000, rpcMs: 5000, frameBytes: 1048576, startupBytes: 8388608, writeQueueBytes: 1048576, stderrBytes: 8192 }, ...overrides,
  }
}

export function sampleStaticContract(): LaunchContract {
  return { id: "fixture-v1", sessionLoad: true, providerId: "codex-acp", adapterPackage: "@agentclientprotocol/codex-acp", adapterVersion: "1.0.0", modes: { state: "values", values: ["plan", "review"] }, reasoning: { state: "values", values: ["high", "low"] }, effectiveMode: null, permissionProfiles: ["fixture-deny-v1"], modelOption: "model", reasoningOption: "reasoning", modeOption: "mode", permissionEvidence: "fixture-contract-v1", deadlines: { commandMs: 5000, spawnMs: 5000, initializeMs: 15000, sessionMs: 15000, optionMs: 5000, promptMs: 90000, transportCloseMs: 1000, processTerminateMs: 5000, absenceMs: 2000, overallMs: 150000 } }
}

export function sampleContract(): ConfiguredLaunchContract {
  const contract = { ...sampleStaticContract(), entrypoint: "/fixture.mjs", executable: "/fixture/codex" }
  return { ...contract, fingerprint: launchContractFingerprint(contract, "b".repeat(64)) }
}