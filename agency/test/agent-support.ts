import { PassThrough } from "node:stream"
import { isDeepStrictEqual } from "node:util"
import { EventEmitter } from "node:events"
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process"
import { mkdir, open, rename, rm, writeFile, readFile, readdir } from "node:fs/promises"
import assert from "node:assert/strict"
import { createConnection } from "node:net"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { ATTACHMENT_PROTOCOL, createNdjsonDecoder, parseAttachmentFrame, type AttachmentFrame } from "../src/agent/attachment-protocol.js"
import { createAgentProcess, type OwnedAgentProcess } from "../src/agent/process.js"
import { AgentError } from "../src/agent/types.js"
import { splitLaunchSpec, startCommand } from "../src/agent/types.js"
import { privateRoot, controlFixture, until, fileExists, failFixtureBatch } from "./control-support.js"
import { MutationQueue } from "../src/handler/mutations.js"
import type { LaunchContext } from "../src/handler/launch-transitions.js"
import { readHandlerRecord, readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import type { LaunchRecord, ProcessIdentity } from "../src/platform/types.js"
import { createAgentService, type AgentService } from "../src/agent/service.js"
import { createAgentStore, type AgentStore } from "../src/agent/store.js"
import { createCatalogStore } from "../src/catalog/store.js"
import { observeConfig } from "../src/catalog/config.js"
import { isFresh, type CatalogSnapshot, type ProviderProfile } from "../src/catalog/types.js"
import type { CatalogService } from "../src/catalog/service.js"
import { launchContractFingerprint, productionLaunchContracts } from "../src/agent/contracts.js"
import { inventoryLaunches } from "../src/handler/inventory.js"
import { AGENT_PROTOCOL, exchangeAgent, type AgentRequest } from "../src/agent/protocol.js"
import { PROTOCOL } from "../src/control/protocol.js"
import { reconcileRecord } from "../src/platform/reconcile.js"
import type { TestContext } from "node:test"
import type { RetentionFixtureOptions } from "./retention-support.js"
import { createAcpConnection } from "../src/agent/acp.js"
import type { AcpObservation } from "../src/agent/session-events.js"
import type { ConfiguredLaunchContract, LaunchContract } from "../src/agent/contracts.js"
import type { AgentCommand, AgentRecord, LaunchSpec, SessionEvidence, StartInput, StartSelection, AgentTuple, CommandView } from "../src/agent/types.js"

export type AgentHandlerOptions = RetentionFixtureOptions & { pauseAt?: "intent" | "attempted" | "identity" | "session" | "prompt" | "ready" | "receipt" | "stop-intent" | "stop-cleanup" | "stop-verified" | "stop-receipt-before" | "stop-receipt-after"; startupHang?: "evidence" | "publication"; failReceiptSync?: boolean; providerScenario?: string }

export async function agentHandlerFixture(t: TestContext, options: AgentHandlerOptions = {}, handlerEnv?: NodeJS.ProcessEnv) {
  const f = await controlFixture(t, {}, fileURLToPath(new URL("./fixtures/agent-handler.js", import.meta.url)), handlerEnv)
  const workspace = join(f.root, "workspace"), otherWorkspace = join(f.root, "other-workspace")
  await mkdir(workspace, { mode: 0o700 }); await mkdir(otherWorkspace, { mode: 0o700 })
  const owned = new Map<string, LaunchRecord>(), seen = new Set<string>(), requests: Promise<unknown>[] = []
  const inventory = async () => ({ ...await createAgentStore(f.paths.persistentRoot).inventory(), launches: await inventoryLaunches(join(f.paths.persistentRoot, "launches")) })
  async function trackProviders(): Promise<void> {
    for (const name of (await readdir(f.root)).filter(name => /^spawn-.*\.json$/.test(name))) {
      const hint = JSON.parse(await readFile(join(f.root, name), "utf8")) as { pid: number; agentId: string; attempt: string }
      if (seen.has(hint.attempt)) continue
      assert.ok(Number.isSafeInteger(hint.pid) && hint.pid > 1)
      const agent = await createAgentStore(f.paths.persistentRoot).readAgent(hint.agentId)
      assert.ok(agent); assert.equal(agent.launch.launchAttemptId, hint.attempt)
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
        const record: LaunchRecord = { version: 2, owner: { kind: "agent", agentId: hint.agentId, providerGeneration: agent.launch.providerGeneration }, handlerGeneration: agent.launch.handlerGeneration, launchAttemptId: hint.attempt, launchBootId: identity.bootId, launchAttempted: true, provider: { kind: "process-group", group: { leader: identity, observed: members } }, phase: "active", reason: null }
        await writeLaunchRecord(join(f.root, `owned-${hint.attempt}.json`), record)
        owned.set(hint.attempt, record)
      }
      seen.add(hint.attempt)
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
      try { await f.call({ protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: current.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true }) } catch {}
      await trackProviders()
      await f.signal(current.process, "SIGKILL"); await proveAbsent(current.process)
    }
    await trackProviders()
    const agents = await inventory(), launches = await inventoryLaunches(join(f.paths.persistentRoot, "launches")), probes = await createCatalogStore(f.paths.persistentRoot).inventory()
    assert.deepEqual(agents.issues, []); assert.deepEqual(probes.issues, [])
    assert.deepEqual(probes.launches, [])
    for (const record of owned.values()) {
      const path = join(f.root, `${record.launchAttemptId}-supervisor-cleanup.json`)
      await writeLaunchRecord(path, record)
      assert.equal((await reconcileRecord(path, f.adapter, record)).record.phase, "cleanup_verified")
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
  const configure = (settings: AgentHandlerOptions) => writeFile(f.configPath, JSON.stringify({ paths: f.paths, profile, ...settings }), { mode: 0o600 })
  await configure(options)
  if (options.pauseAt === "session") await writeFile(join(f.root, "pause-session"), "pause", { mode: 0o600 })
  if (options.pauseAt === "prompt") await writeFile(join(f.root, "pause-prompt"), "pause", { mode: 0o600 })
  await f.start(15000)
  async function call(operation: Omit<Extract<AgentRequest, { op: "agent_start" }>, "protocol" | "requestId" | "handlerGeneration"> | Omit<Extract<AgentRequest, { op: "agent_restore" }>, "protocol" | "requestId" | "handlerGeneration"> | Omit<Extract<AgentRequest, { op: "agent_stop" }>, "protocol" | "requestId" | "handlerGeneration"> | Omit<Extract<AgentRequest, { op: "agent_prompt" }>, "protocol" | "requestId" | "handlerGeneration"> | { op: "agent_choices" } | { op: "agent_page"; input: import("../src/agent/queries.js").PageInput } | { op: "agent_list" } | { op: "agent_current"; cwd: string } | { op: "agent_command"; commandId: string; commandGeneration: string }) {
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
  return { root: f.root, configPath: f.configPath, paths: f.paths, workspace, otherWorkspace, inventory, startAt, currentAt, command, releaseBarrier,
    async choices() { const result = await call({ op: "agent_choices" }); if (result.state !== "choices") throw new Error("wrong reply"); return result },
    async page(input: import("../src/agent/queries.js").PageInput) { const result = await call({ op: "agent_page", input }); if (result.state !== "page") throw new Error("wrong reply"); return result },
    start: (selection?: Partial<StartSelection>) => startAt(workspace, selection),
    current: () => currentAt(workspace),
    async list() { const result = await call({ op: "agent_list" }); assert.equal(result.state, "agents"); if (result.state !== "agents") throw new Error("wrong reply"); return result },
    stop: async (target: AgentTuple, commandId = randomUUID()) => commandView(await call({ op: "agent_stop", input: { ...target, commandId } })),
    restore: async (agentId: string) => commandView(await call({ op: "agent_restore", input: { agentId, commandId: randomUUID(), handlerGeneration: (await handler()).generation, environment: providerEnvironment() } })),
    providerRequests: async () => (await readFile(join(f.root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> }),
    async prompt(target: AgentTuple, text: string) { const result = await call({ op: "agent_prompt", input: { ...target, text } }); assert.equal(result.state, "prompt"); if (result.state !== "prompt") throw new Error("wrong reply"); return result },
    retry: async (value: AgentCommand) => command(value.commandId, value.handlerGeneration),
    async retryOperation(value: AgentCommand) {
      const operation = value.op === "start" ? { op: "agent_start" as const, input: { commandId: value.commandId, handlerGeneration: value.handlerGeneration, cwd: (value.input as import("../src/agent/types.js").StartCommandInput).cwd, selection: (value.input as import("../src/agent/types.js").StartCommandInput).selection, environment: providerEnvironment() } } : value.op === "restore" ? { op: "agent_restore" as const, input: { commandId: value.commandId, handlerGeneration: value.handlerGeneration, agentId: value.target!.agentId, environment: providerEnvironment() } } : { op: "agent_stop" as const, input: { ...value.target!, commandId: value.commandId } }
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
      assert.ok(agent)
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
    async cleanupEvidence() { return JSON.parse(await readFile(join(f.root, "agent-cleanup.json"), "utf8")) as { providers: LaunchRecord[]; launches: Array<{ path: string; record: LaunchRecord }>; survivors: unknown[] } },
  }
}

type StreamInput = { op: "submit"; submissionId: string; text: string } | { op: "cancel" | "inspect-submission"; submissionId: string }
type ResponseFrame = Extract<AttachmentFrame, { type: "response" }>

export async function attachmentHandlerFixture(t: TestContext, options: AgentHandlerOptions = {}) {
  const f = await agentHandlerFixture(t, options), readers = new Set<ReturnType<typeof createConnection>>()
  t.after(() => { for (const socket of readers) socket.destroy() })
  async function attach(target: AgentTuple) {
    const socket = createConnection(join(f.paths.runtimeRoot, "attachment.sock")), frames: AttachmentFrame[] = []
    readers.add(socket)
    let failure: unknown
    socket.on("error", error => { failure = error })
    const decoder = createNdjsonDecoder(value => frames.push(parseAttachmentFrame(value)), error => { failure = error })
    socket.on("data", bytes => decoder.feed(bytes))
    const send = (input: StreamInput | { op: "attach" }) => {
      const requestId = randomUUID()
      socket.write(JSON.stringify({ protocol: ATTACHMENT_PROTOCOL, target, requestId, ...input }) + "\n")
      return requestId
    }
    async function wait(predicate: (frame: AttachmentFrame) => boolean, timeout = 15000) {
      return until(async () => {
        const frame = frames.find(predicate)
        if (frame) return frame
        if (failure) throw failure
        const fault = frames.find(row => row.type === "fault")
        if (fault?.type === "fault") throw new AgentError(fault.error.code)
        if (socket.destroyed) throw new Error("attachment closed before observation")
        return undefined
      }, timeout)
    }
    send({ op: "attach" })
    await wait(frame => frame.type === "snapshot_end")
    return { socket, frames, send, wait,
      close() { socket.destroy(); readers.delete(socket) },
      async request(input: StreamInput): Promise<ResponseFrame> {
        const id = send(input)
        return await wait(frame => frame.type === "response" && frame.requestId === id) as ResponseFrame
      },
      completed: (id: string) => wait(frame => frame.type === "event" && frame.event.kind === "turn" && frame.event.submissionId === id && (frame.event.state === "completed" || frame.event.state === "failed"), 35000),
    }
  }
  return { ...f, attach,
    async stopAndVerify(target: AgentTuple) {
      const stopped = await f.waitCompleted(await f.stop(target))
      assert.equal(stopped.command.result?.outcome, "stopped")
      await f.assertProviderAbsent(target)
    },
  }
}

export async function neovimAttachmentFixture(t: TestContext, options: AgentHandlerOptions = {}) {
  const f = await attachmentHandlerFixture(t, options)
  const executable = join(f.root, "agy-fixture.mjs"), repository = fileURLToPath(new URL("../../../", import.meta.url))
  const source = (path: string) => new URL(path, import.meta.url).href
  await writeFile(executable, `#!${process.execPath}\nimport { runControl, productionControlDependencies } from ${JSON.stringify(source("../src/cli/control.js"))}\nimport { createDarwinAdapter } from ${JSON.stringify(source("../src/platform/darwin.js"))}\nimport { createLinuxAdapter } from ${JSON.stringify(source("../src/platform/linux.js"))}\nconst deps = productionControlDependencies()\ndeps.environment = async () => ({ paths: ${JSON.stringify(f.paths)}, adapter: process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter() })\ndeps.start = async env => { const found = await deps.inspect(env); if (!found) throw new Error("fixture Handler absent"); return found }\nprocess.exitCode = await runControl(process.argv.slice(2), deps)`, { mode: 0o700 })
  const editors = new Set<ChildProcess>()
  t.after(async () => {
    for (const child of editors) {
      child.kill("SIGTERM")
      await until(async () => child.exitCode !== null || child.signalCode !== null ? true : undefined)
    }
  })
  async function editor(target: AgentTuple, settings: Record<string, unknown> = {}) {
    const report = join(f.root, `editor-${randomUUID()}.jsonl`), config = join(f.root, `editor-${randomUUID()}.json`)
    await writeFile(report, "", { mode: 0o600 })
    const plugin = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "nvim/lazy/agentic.nvim")
    await writeFile(config, JSON.stringify({ executable, target, repository, plugin, report, ...settings }), { mode: 0o600 })
    const child = spawn(process.env.AGENCY_NVIM_EXECUTABLE ?? "/opt/homebrew/bin/nvim", ["--headless", "-u", "NONE", "-i", "NONE", "-n", "-l", resolve(repository, "tests/neovim/fixtures/agency_attachment_client.lua"), config], { cwd: f.workspace, env: process.env, stdio: ["pipe", "pipe", "pipe"] })
    editors.add(child)
    let diagnostics = "", failure: unknown, nextId = 0
    child.stdout!.on("data", bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-8192) })
    child.stderr!.on("data", bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-8192) })
    child.on("error", error => { failure = error })
    const deadline = setTimeout(() => { failure = new Error("editor lifetime exceeded"); child.kill("SIGTERM") }, 120000)
    child.once("exit", () => { clearTimeout(deadline); editors.delete(child) })
    async function response(id: number) {
      return until(async () => {
        const rows = (await readFile(report, "utf8")).split("\n").filter(Boolean)
        for (const line of rows) {
          let row: any
          try { row = JSON.parse(line) } catch { continue }
          if (row.id === id) { if (row.error) throw new Error(JSON.stringify(row.error)); return row }
        }
        if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`editor unavailable: ${diagnostics}`, { cause: failure })
        return undefined
      }, 40000)
    }
    const initial = await response(0)
    async function call(command: Record<string, unknown>): Promise<any> {
      const id = ++nextId
      child.stdin!.write(JSON.stringify({ ...command, id }) + "\n")
      return response(id)
    }
    return { initial, call,
      async exit() {
        await call({ op: "exit" })
        await until(async () => child.exitCode !== null || child.signalCode !== null ? true : undefined)
        assert.equal(child.exitCode, 0, diagnostics)
      },
    }
  }
  return { ...f, editor, executable }
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

export function sampleProductionContract(): ConfiguredLaunchContract {
  const base: LaunchContract = { id: "codex-acp-1.7", sessionLoad: true, providerId: "codex-acp", adapterPackage: "@agentclientprotocol/codex-acp", adapterVersion: "1.7.0", modes: { state: "values", values: ["read-only"] }, reasoning: { state: "values", values: ["high"] }, effectiveMode: null, permissionProfiles: ["deny-all"], modelOption: "model", reasoningOption: "reasoning_effort", modeOption: "mode", permissionEvidence: "agency-deny-all-v1", deadlines: { commandMs: 5000, spawnMs: 5000, initializeMs: 15000, sessionMs: 15000, optionMs: 5000, promptMs: 90000, transportCloseMs: 1000, processTerminateMs: 5000, absenceMs: 2000, overallMs: 150000 } }
  const contract = { ...base, entrypoint: "/fixture/adapter.mjs", executable: "/fixture/codex" }
  return { ...contract, fingerprint: launchContractFingerprint(contract, "b".repeat(64)) }
}

export function sampleProductionSpec(): LaunchSpec {
  const spec = sampleSpec(), contract = sampleProductionContract()
  return { ...spec, contractId: contract.id, contractFingerprint: contract.fingerprint, selection: { providerId: "codex-acp", modelId: "gpt-5.6-sol", reasoning: { kind: "value", value: "high" }, mode: "read-only", permissionProfile: "deny-all" }, configuration: { ...spec.configuration, adapterVersion: "1.7.0" }, catalogEvidence: { ...spec.catalogEvidence, adapterVersion: "1.7.0", models: [{ ...spec.catalogEvidence.models[0]!, modelId: "gpt-5.6-sol" }] } }
}

export function sampleAgent(): AgentRecord { return { version: 2, ...splitLaunchSpec(sampleSpec()), phase: "starting", session: null, failure: null } }
export function sampleSession(): SessionEvidence { return { sessionId: "fixture-session", sessionGeneration: agentId(8), protocolVersion: 1, modelId: "model-a", reasoning: { kind: "value", value: "high" }, mode: "review", permissionProfile: "fixture-deny-v1", permissionEvidence: "fixture-contract-v1" } }
export function sampleCommand(): AgentCommand {
  const spec = sampleSpec()
  return startCommand({ commandId: spec.commandId, handlerGeneration: spec.handlerGeneration, cwd: spec.cwd, selection: spec.selection, environment: {} }, { agentId: spec.agentId, handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration }, spec.hostId)
}

export function agentGate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

export async function syntheticAgentProcess(t: TestContext, scenario: string, startupEnvelope = false, settings: { onUpdate?(event: AcpObservation): void } = {}) {
  const root = await privateRoot(t), spec = sampleSpec(), contract = sampleContract(), beforeSpawn = agentGate(), publication = agentGate(), spawned = agentGate(), absentEntered = agentGate(), absentReleased = agentGate(), terminated = agentGate(), cleanupObservation = agentGate(), removalEntered = agentGate(), removalReleased = agentGate()
  const path = join(root, "launches", spec.launchAttemptId + ".json")
  await mkdir(join(root, "launches"), { mode: 0o700 })
  const launch: LaunchRecord = { version: 2, owner: { kind: "agent", agentId: spec.agentId, providerGeneration: spec.providerGeneration }, handlerGeneration: spec.handlerGeneration, launchAttemptId: spec.launchAttemptId, launchBootId: "boot-a", launchAttempted: false, provider: null, phase: "launch_pending", reason: null }
  let firstPrompt: any
  const peer = scriptedAcp(t, "exact", { notification(request, send) {
    if (request.method === "session/cancel" && firstPrompt) send({ jsonrpc: "2.0", id: firstPrompt.id, result: { stopReason: "cancelled" } })
  }, prompt(request, send) {
    if (scenario === "cancel" && !firstPrompt) { firstPrompt = request; return }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: request.params.prompt[0].text } } } })
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } }); peer.connection.close()
  const child = new EventEmitter() as ChildProcess
  let unrefs = 0
  Object.assign(child, { pid: 12345, stdin: peer.writable, stdout: peer.readable, stderr: new PassThrough(), exitCode: null, signalCode: null, unref() { unrefs++ } })
  let live = false, count = 0, bootCalls = 0, absentGroups = 0, lateAbsenceReads = 0, observedOptions: SpawnOptions | undefined, identityPublished = false, attemptPublished = false, readbackFailed = false, earlyWrites = 0, invalidation = "", checks = 0, spawnInputReleases = 0, releasesAtSpawn = -1
  const signals: NodeJS.Signals[] = []
  let identity: ProcessIdentity = { pid: 12345, bootId: "boot-a", birth: `100:agy-provider:${spec.launchAttemptId}`, parentPid: process.pid, processGroupId: 12345, sessionId: 12345, uid: process.getuid!(), gid: process.getgid!() }
  if (scenario === "identity-mismatch") identity.birth = "100:other"
  if (scenario === "wrong-birth") identity.birth = `invalid:agy-provider:${spec.launchAttemptId}`
  if (scenario === "wrong-boot") identity.bootId = "other-boot"
  if (scenario === "wrong-group") identity.processGroupId++
  if (scenario === "wrong-uid") identity.uid++
  const context: LaunchContext = {
    paths: { hostKey: spec.hostId, persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "handler.sock") },
    state: { hostId: spec.hostId, handlerGeneration: spec.handlerGeneration, phase: "ready", reconciliation: { classified: 1, total: 1, uncertain: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] },
    mutations: { queue: new MutationQueue(), accepted: [] }, shutdownPending: () => false,
    adapter: { platform: "linux", bootId: async () => {
      if (scenario === "cleanup-boot-hang" && ++bootCalls === 3) { cleanupObservation.resolve(); return new Promise<string>(() => undefined) }
      return "boot-a"
    }, readProcess: async () => {
      if (scenario === "absence-paused" && absentGroups >= 3) lateAbsenceReads++
      return scenario === "identity-hang" && live ? new Promise<ProcessIdentity>(() => undefined) : live ? structuredClone(identity) : null
    }, readGroup: async () => {
      if (!live && scenario === "absence-hang" && ++absentGroups === 3) { absentEntered.resolve(); return new Promise<ProcessIdentity[]>(() => undefined) }
      if (!live && scenario === "absence-paused" && ++absentGroups === 3) { absentEntered.resolve(); await absentReleased.promise }
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
  const owner = createAgentProcess({ ...settings, context, spec, ...(scenario === "load" ? { session: { kind: "load" as const, sessionId: "fixture-session" } } : {}), environment: { HOME: "/fixture-home", FIXTURE: "yes", NODE_OPTIONS: "preserved", NODE_PATH: "preserved", AGENCY_TEST: "preserved", GIT_DIR: "preserved", CODEX_PATH: "/caller/codex" }, ...(startupEnvelope ? { isReady: () => false } : {}), contract, async revalidate() {
    checks++
    if (invalidation || scenario === "restore-failure" && checks > 1) throw new AgentError("CONFIG_CHANGED")
  } }, { spawn: ((executable: string, args: string[], options: SpawnOptions) => {
    count++; observedOptions = options; releasesAtSpawn = spawnInputReleases; spawned.resolve()
    if (executable !== process.execPath || JSON.stringify(args) !== '["/fixture.mjs"]') throw new Error("wrong executable")
    if (scenario === "spawn-throws") throw new Error("spawn invocation failed")
    live = scenario !== "child-exit"
    if (!live) queueMicrotask(() => child.emit("exit", 1, null))
    return child
  }) as typeof spawn, onSpawnInputReleased() { spawnInputReleases++ }, transitionIO: {
    async publish(file, record) {
      if (scenario === "attempt-write" && record.launchAttempted && !record.provider) throw new Error("attempt write failed")
      if (scenario === "restore-failure" && !record.launchAttempted) throw new Error("restore failed")
      await writeLaunchRecord(file, record)
      if (record.launchAttempted && !record.provider) attemptPublished = true
      if (record.provider) identityPublished = true
      if (scenario === "publication-paused" && record.launchAttempted && !record.provider) { beforeSpawn.resolve(); await publication.promise }
      if (scenario === "publication-never" && record.launchAttempted && !record.provider) { beforeSpawn.resolve(); await new Promise<void>(() => undefined) }
      if (scenario === "identity-publication-paused" && record.provider) { beforeSpawn.resolve(); await publication.promise }
    },
    async read(file) { if (scenario === "attempt-readback" && attemptPublished && !readbackFailed) { readbackFailed = true; throw new Error("readback failed") }; return readLaunchRecordForReconciliation(file) },
  }, now: () => Date.now() })
  return { owner, root, spec, context, signals, requests: peer.sent, beforeSpawn, removalEntered: removalEntered.promise, releaseRemoval: removalReleased.resolve, spawned: spawned.promise, absentEntered: absentEntered.promise, releaseAbsence: absentReleased.resolve, lateAbsenceReads: () => lateAbsenceReads, terminated: terminated.promise, cleanupObservation: cleanupObservation.promise, releasePublication: publication.resolve, spawnCount: () => count, spawnInputReleases: () => spawnInputReleases, releasesAtSpawn: () => releasesAtSpawn, unrefs: () => unrefs, record: () => readLaunchRecordForReconciliation(path), writesBeforeIdentity: () => earlyWrites, options: () => observedOptions, invalidate: (why: string) => { invalidation = why }, replaceIdentity() { identity.birth = `200:agy-provider:${spec.launchAttemptId}` }, eof: () => peer.readable.end(), pipesDestroyed: () => child.stdin!.destroyed && child.stdout!.destroyed && child.stderr!.destroyed }
}

const NO_ACP_RESPONSE = Symbol("no-acp-response")
export function scriptedAcp(t: TestContext, scenario = "exact", settings: { onUpdate?: (event: any) => void; notification?: (request: any, send: (value: unknown) => void) => void; productionContract?: boolean; response?: (request: any, reply: any) => unknown | typeof NO_ACP_RESPONSE; prompt?: (request: any, send: (value: unknown) => void) => void; hold?: number; now?: () => number } = {}) {
  const readable = new PassThrough(), writable = new PassThrough(), sent: Array<{ jsonrpc: "2.0"; id: number; method: string; params: any }> = [], permissionReplies: unknown[] = []
  const options = [
    { id: "model", type: "select", name: "Model", currentValue: "model-a", options: [{ value: "model-a", name: "Model α" }] },
    { id: "reasoning", type: "select", name: "Reasoning", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    { id: "mode", type: "select", name: "Mode", currentValue: "plan", options: [{ value: "plan", name: "Plan" }, { value: "review", name: "Review" }] },
  ]
  if (settings.productionContract) {
    options[0]!.currentValue = "gpt-5.6-sol"; options[0]!.options = [{ value: "gpt-5.6-sol", name: "Model" }]
    options[1]!.id = "reasoning_effort"; options[2]!.options.push({ value: "read-only", name: "Read only" })
  }
  const send = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value) + "\n")
    if (scenario === "fragmented") for (const byte of bytes) readable.write(Buffer.from([byte]))
    else readable.write(bytes)
  }
  const connection = createAcpConnection({ readable, writable, limits: sampleSpec().limits, ...(settings.now ? { now: settings.now } : {}), ...(settings.onUpdate ? { onUpdate: settings.onUpdate } : {}) })
  writable.on("data", (bytes: Buffer) => {
    for (const line of bytes.toString().trim().split("\n")) {
      const request = JSON.parse(line)
      if (!request.method) { permissionReplies.push(request); continue }
      sent.push(request)
      if (!Object.hasOwn(request, "id")) { settings.notification?.(request, send); continue }
      if (sent.length === settings.hold) continue
      if (scenario === "hang") continue
      if (scenario === "utf8") { readable.write(Buffer.from([255, 10])); continue }
      if (scenario === "oversized") { readable.write(Buffer.alloc(1048577, 32)); continue }
      if (scenario === "empty-eof") { readable.end(); continue }
      if (scenario === "incomplete-eof") { readable.end("{\"jsonrpc\":"); continue }
      if (scenario === "error" || scenario === "auth") { send({ jsonrpc: "2.0", id: request.id, error: { code: scenario === "auth" ? -32000 : -32603, message: "sensitive remote diagnostic" } }); continue }
      if (scenario === "wrong-id") { send({ jsonrpc: "2.0", id: 999, result: {} }); continue }
      let result: unknown
      if (request.method === "initialize") result = { protocolVersion: scenario === "version" ? 2 : 1, agentCapabilities: { loadSession: true } }
      else if (request.method === "session/new" || request.method === "session/load") {
        result = { sessionId: "fixture-session", configOptions: scenario === "missing" ? [] : scenario === "duplicate-option" ? [options[0], options[0]] : options }
      } else if (request.method === "session/prompt") {
        if (!settings.prompt) continue
        settings.prompt(request, send)
        continue
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
      const response = settings.response ? settings.response(request, reply) : reply
      if (response !== NO_ACP_RESPONSE) send(response)
      if (scenario === "duplicate-id") send(reply)
    }
  })
  t.after(() => { connection.close(); readable.destroy(); writable.destroy() })
  return { connection, sent, permissionReplies, readable, writable, send, triggerDrift() { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } } }) } }
}

export async function agentServiceFixture(t: TestContext, options: { retirement?: import("../src/retention/store.js").RetirementView; beforeOwnerPage?: boolean; pauseCleanup?: boolean; launchContracts?: Array<LaunchContract | ConfiguredLaunchContract>; productionCatalog?: boolean; advertiseUnsupportedClaude?: boolean; contract?: boolean; sessionLoad?: boolean; productionContract?: boolean; injectedOnly?: boolean; pause?: "attempted" | "spawn" | "ready"; observe?: (count: number, spec: LaunchSpec) => Promise<void>; pauseCommand?: boolean; pauseStateRemoval?: boolean; failStateRemoval?: boolean; failAfterStateRemoval?: boolean; prompt?: "normal" | "hang" } = {}) {
  if (options.productionCatalog) options = { ...options, productionContract: true }
  const teardown: Array<() => unknown> = [], childContext = Object.create(t) as TestContext
  childContext.after = fn => { teardown.push(() => fn?.(t, error => { if (error) throw error })) }
  const root = await privateRoot(childContext), workspace = join(root, "workspace")
  await mkdir(join(root, "launches"), { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 })
  const forbidden = async (): Promise<never> => { throw new Error("unexpected process operation") }
  const context: LaunchContext = {
    paths: { hostKey: "a".repeat(64), persistentRoot: root, runtimeRoot: root, handlerSocketPath: join(root, "handler.sock") },
    adapter: { platform: "linux", bootId: async () => "boot-a", readProcess: forbidden, readGroup: forbidden, signalGroup: forbidden },
    state: { hostId: "a".repeat(64), handlerGeneration: randomUUID(), phase: "ready", reconciliation: { classified: 0, total: 0, uncertain: 0 }, launches: [], capabilities: ["status", "doctor", "shutdown"] },
    mutations: { queue: new MutationQueue(), accepted: [] },
    shutdownPending: () => false,
  }
  const f = { root, workspace, context }, entered = agentGate(), commandEntered = agentGate(), released = agentGate(), readyCommitEntered = agentGate(), readyCommitReleased = agentGate(), stateRemovalReleased = agentGate(), promptEntered = agentGate(), publications: string[] = []
  let stateRemovalCalls = 0, evidenceCalls = 0, fatalCalls = 0, cleanupCalls = 0
  let beforeOwnerPage: Promise<import("../src/agent/queries.js").AgentPage> | undefined
  const cleanupEntered = agentGate(), cleanupReleased = agentGate()
  const requests: Promise<unknown>[] = [], owners: OwnedAgentProcess[] = []
  const track = (service: AgentService): AgentService => {
    const start = service.start.bind(service), stop = service.stop.bind(service)
    service.start = request => { const operation = start(request); requests.push(operation); return operation }
    service.stop = request => { const operation = stop(request); requests.push(operation); return operation }
    return service
  }
  const directory = join(root, "catalog"), config = join(root, "declared.json"), executable = join(root, "native"), adapterPackageJson = join(root, "adapter.json")
  if (!options.injectedOnly) await mkdir(directory, { mode: 0o700 })
  const providerFile = join(root, "agent-provider.js")
  await writeFile(config, "{}", { mode: 0o600 }); await writeFile(executable, "fixture", { mode: 0o700 }); await writeFile(adapterPackageJson, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: options.productionContract ? "1.7.0" : "1.0.0", main: "agent-provider.js" }), { mode: 0o600 }); await writeFile(providerFile, await readFile(fileURLToPath(new URL("./fixtures/agent-provider.js", import.meta.url))), { mode: 0o600 })
  const profile: ProviderProfile = { id: "codex-acp", enabled: true, executable, adapterPackageJson, sdkPackageJson: null, configurationFiles: [config] }
  if (!options.injectedOnly) await writeFile(join(directory, "providers.json"), JSON.stringify({ version: 1, providers: [profile] }), { mode: 0o600 })
  const configuration = await observeConfig(profile), catalogStore = createCatalogStore(root)
  const selectedSpec = options.productionContract ? sampleProductionSpec() : sampleSpec()
  let snapshot: CatalogSnapshot = { version: 1, hostId: f.context.paths.hostKey, snapshotId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, createdAt: Date.now(), providers: [{ ...selectedSpec.catalogEvidence, fingerprint: configuration.fingerprint, verifiedAt: Date.now(), verifiedHandlerGeneration: f.context.state.handlerGeneration }] }
  if (options.advertiseUnsupportedClaude) snapshot.providers.push({ ...snapshot.providers[0]!, providerId: "claude-agent-acp", models: snapshot.providers[0]!.models.map(model => ({ ...model, providerId: "claude-agent-acp" })) })
  const saveCatalog = async () => { if (!options.injectedOnly) { await catalogStore.writeSnapshot(snapshot); await catalogStore.publishCurrent(snapshot) } }
  await saveCatalog()
  const contract = { ...(options.productionContract ? productionLaunchContracts()[0]! : sampleStaticContract()), sessionLoad: options.sessionLoad ?? true }
  let refreshes = 0, catalogReads = 0, spawnCount = 0, failReceipt = false, failReady = false, holdReady = false, failTerminal = false, failTerminalBeforeRename = false, failInitialAgent = false, failInitialCommand = false, writingReady = false, writingTerminal = false, writingReceipt = false, readyFailures = 0, terminalFailures = 0, terminalWriteFailures = 0
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
  } }, options.retirement)
  const store = { ...base, async writeAgent(value: AgentRecord, expected: AgentRecord | null) {
    publications.push("agent:" + value.phase)
    if (failInitialAgent && expected === null) throw new Error("initial agent publication")
    if (failTerminalBeforeRename && ["failed", "recoverable", "stopped"].includes(value.phase)) { terminalWriteFailures++; throw new Error("terminal publication before rename") }
    writingReady = value.phase === "ready"
    writingTerminal = ["failed", "recoverable", "stopped"].includes(value.phase)
    try {
      await base.writeAgent(value, expected)
      if (options.beforeOwnerPage && ["starting", "restoring"].includes(value.phase)) beforeOwnerPage = service.page({ limit: 100, activeOnly: true })
    } finally { writingReady = false; writingTerminal = false }
  }, async writeCommand(value: AgentCommand, expected: AgentCommand | null) {
    publications.push(`${value.op}:${value.state}`); writingReceipt = value.state === "completed"
    if (failStopReceipt && value.op === "stop" && value.state === "completed") throw new Error("stop receipt publication")
    if (failInitialCommand && value.op === "start" && value.state === "pending" && expected === null) throw new Error("initial command publication")
    if (options.pauseCommand && value.op === "start" && value.state === "pending") { commandEntered.resolve(); await released.promise }
    try { await base.writeCommand(value, expected) } finally { writingReceipt = false }
  } }
  const unsupported = async (): Promise<never> => { throw new Error("unexpected catalog operation") }
  const catalog: CatalogService = { retentionPins: () => ({ paths: [] }), forgetRemoved() {}, initialize: async () => undefined, startScheduling() {}, list: unsupported, refresh: async () => { refreshes++; return unsupported() }, freezeAndDrain: async () => undefined, resume() {}, verifyDischarged: async () => undefined, close() {}, async launchEvidence(id) {
    catalogReads++
    return f.context.mutations.queue.run(async () => {
      const provider = snapshot.providers.find(p => p.providerId === id)
      if (!provider || !isFresh(provider.verifiedAt, Date.now()) || provider.verifiedHandlerGeneration !== f.context.state.handlerGeneration || provider.error || (await observeConfig(profile)).fingerprint !== configuration.fingerprint) throw new AgentError("MODEL_UNAVAILABLE")
      return structuredClone({ snapshotId: snapshot.snapshotId, provider, profile, configuration })
    })
  } }
  const processes = new Map<number, { agentId: string; identity: ProcessIdentity; child: ChildProcess }>(), peers = new Map<string, ReturnType<typeof scriptedAcp>>(), pendingPrompts = new Map<string, { request: any; send(value: unknown): void }>()
  const spawnOptions: SpawnOptions[] = [], methodHistory: string[] = []
  let loadBehavior = "normal", failStopReceipt = false
  let restorePause = ""
  const restoreEntered = agentGate(), restoreReleased = agentGate()
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
    const peer = scriptedAcp(t, "exact", { productionContract: options.productionContract === true, hold: input.session?.kind === "load" && restorePause === "spawned" ? 1 : Infinity, response(request, reply) {
      methodHistory.push(request.method)
      if (input.session?.kind === "load" && request.method === "initialize" && loadBehavior === "unsupported") reply.result.agentCapabilities.loadSession = false
      if (request.method === "session/load" && loadBehavior === "timeout") return NO_ACP_RESPONSE
      if (request.method === "session/load" && loadBehavior === "invalid-protocol") return { jsonrpc: "2.0", id: request.id, result: { sessionId: "other", configOptions: [] } }
      if (request.method === "session/load" && loadBehavior !== "normal") return { jsonrpc: "2.0", id: request.id, error: { code: loadBehavior === "auth" ? -32000 : ["missing", "invalid-params", "cwd"].includes(loadBehavior) ? -32602 : -32603, message: loadBehavior === "auth" ? "Authentication required" : loadBehavior === "missing" ? "Session not found" : loadBehavior === "invalid-params" ? "Invalid params" : loadBehavior === "cwd" ? "Invalid params: cwd must refer to an accessible directory" : "fixture failure" } }
      if (request.method === "session/load") peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "restored history" } } } })
      return reply
    }, notification(request, send) {
      const pending = pendingPrompts.get(input.spec.agentId)
      if (request.method === "session/cancel" && pending) send({ jsonrpc: "2.0", id: pending.request.id, result: { stopReason: "cancelled" } })
    }, prompt(request, send) {
      methodHistory.push(request.method)
      promptEntered.resolve()
      pendingPrompts.set(input.spec.agentId, { request, send })
      if (options.prompt === "hang") return
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer:${request.params.prompt[0].text}` } } } })
      send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
    } }); peer.connection.close(); peers.set(input.spec.agentId, peer)
    if (input.session?.kind === "load" && restorePause === "spawned") peer.writable.on("data", (bytes: Buffer) => { if (JSON.parse(bytes.toString()).method === "initialize") restoreEntered.resolve() })
    const processDependencies = { spawn: ((_executable: string, _args: string[], observed: SpawnOptions) => {
      spawnOptions.push(observed)
      const pid = 20000 + ++spawnCount, child = new EventEmitter() as ChildProcess
      Object.assign(child, { pid, stdin: peer.writable, stdout: peer.readable, stderr: new PassThrough(), exitCode: null, signalCode: null, unref() {} })
      processes.set(pid, { agentId: input.spec.agentId, child, identity: { pid, birth: `100:agy-provider:${input.spec.launchAttemptId}`, bootId: "boot-a", parentPid: process.pid, processGroupId: pid, sessionId: pid, uid: process.getuid!(), gid: process.getgid!() } })
      return child
    }) as typeof spawn, transitionIO: { read: readLaunchRecordForReconciliation, async publish(path: string, record: LaunchRecord) {
      await writeLaunchRecord(path, record)
      if (record.launchAttempted && record.provider === null) await pause("attempted")
    } } }
    const owner = createAgentProcess(input, processDependencies)
    owners.push(owner)
    return { ...owner, async cleanup() { cleanupCalls++; if (options.pauseCleanup) { cleanupEntered.resolve(); await cleanupReleased.promise }; return owner.cleanup() }, async initialize(signal) {
      if (input.session?.kind === "load" && restorePause === "spawn") { restoreEntered.resolve(); await restoreReleased.promise }
      await pause("spawn", signal)
      const session = await owner.initialize(signal)
      if (input.session?.kind === "load" && restorePause === "ready") { restoreEntered.resolve(); await restoreReleased.promise }
      await pause("ready", signal); return session
    } }
  }
  const supplied = options.launchContracts?.map(value => Object.fromEntries(Object.entries(value).filter(([key]) => !["entrypoint", "executable", "fingerprint"].includes(key))) as LaunchContract)
  const composition = { context: f.context, catalog, contracts: options.contract === false ? [] : supplied ?? [contract], store, ...(options.retirement ? { retirement: options.retirement } : {}) }
  const retired: Array<{ agentId: string; commandId: string }> = []
  const dependencies = { processFactory, onOperationRetired(agentId: string, commandId: string) { retired.push({ agentId, commandId }) }, async observeLaunchEvidence(spec: LaunchSpec, expected: { profile: ProviderProfile }) {
    publications.push("evidence"); evidenceCalls++; await options.observe?.(evidenceCalls, spec)
    if (snapshot.snapshotId !== spec.catalogSnapshotId || !isDeepStrictEqual(snapshot.providers[0], spec.catalogEvidence) || !isDeepStrictEqual(profile, expected.profile) || !isDeepStrictEqual(await observeConfig(profile), spec.configuration)) throw new AgentError("CONFIG_CHANGED")
  }, fatalStartupTimeout(): never { fatalCalls++; throw new Error("fixture Handler fail-stop") } }
  let service = track(createAgentService(composition, dependencies))
  t.after(async () => {
    released.resolve(); readyCommitReleased.resolve(); stateRemovalReleased.resolve(); restoreReleased.resolve(); cleanupReleased.resolve()
    await Promise.allSettled(requests)
    if (!fatalCalls) await service.freezeAndDrain(true).catch(() => undefined)
    service.close()
    await Promise.allSettled(owners.map(owner => owner.cleanup()))
    await f.context.mutations.queue.run(async () => undefined)
    for (const finish of teardown) await finish()
  })
  await service.initialize()
  const input: StartInput = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, cwd: workspace, selection: selectedSpec.selection, environment: { ...process.env, FIXTURE_ROOT: root } as Record<string, string> }
  return { ...f, service, input, store, catalogStore, contract, profile, configuration, config, publications, spawnOptions, methodHistory, loadBehavior(value: string) { loadBehavior = value }, entered: entered.promise, release: released.resolve, spawns: () => spawnCount, refreshes: () => refreshes, catalogReads: () => catalogReads, readyFailures: () => readyFailures,
    beforeOwnerPage: () => beforeOwnerPage, cleanupEntered: cleanupEntered.promise, releaseCleanup: cleanupReleased.resolve,
    failStopReceipt(value: boolean) { failStopReceipt = value },
    pauseRestore(value: string) { restorePause = value }, restoreEntered: restoreEntered.promise,
    evidenceCalls: () => evidenceCalls, fatalCalls: () => fatalCalls, cleanupCalls: () => cleanupCalls, commandEntered: commandEntered.promise, promptEntered: promptEntered.promise,
    failReceipt(value: boolean) { failReceipt = value }, failReady(value: boolean) { failReady = value }, failInitialAgent(value: boolean) { failInitialAgent = value }, failInitialCommand(value: boolean) { failInitialCommand = value },
    failTerminal(value: boolean) { failTerminal = value }, terminalFailures: () => terminalFailures, failTerminalBeforeRename(value: boolean) { failTerminalBeforeRename = value }, terminalWriteFailures: () => terminalWriteFailures, retired: () => structuredClone(retired),
    holdReady(value: boolean) { holdReady = value }, readyCommitEntered: readyCommitEntered.promise, releaseReadyCommit: readyCommitReleased.resolve,
    fault(agent: string) { peers.get(agent)!.triggerDrift() },
    completePrompt(agent: string, answer = "answer:challenge", stopReason = "end_turn") { const pending = pendingPrompts.get(agent); if (!pending) throw new Error("prompt not pending"); if (answer) pending.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } }); pending.send({ jsonrpc: "2.0", id: pending.request.id, result: { stopReason } }) },
    exit(agent: string) { const owner = [...processes.entries()].find(([, value]) => value.agentId === agent); if (!owner) throw new Error("provider not live"); const [pid, value] = owner; processes.delete(pid); value.child.emit("exit", 1, null); value.child.emit("close", 1, null) },
    cleanupOwned: () => Promise.all(owners.map(owner => owner.cleanup())), stateRemovalCalls: () => stateRemovalCalls, releaseStateRemoval: stateRemovalReleased.resolve,
    async changeCatalog(kind: "stale" | "rollback" | "missing" | "refresh") {
      snapshot = structuredClone(snapshot); snapshot.snapshotId = randomUUID(); snapshot.createdAt = Date.now()
      if (kind === "stale") snapshot.providers[0]!.verifiedAt = Date.now() - 600000
      if (kind === "rollback") snapshot.providers[0]!.verifiedAt = Date.now() + 100000
      if (kind === "missing") snapshot.providers[0]!.models = []
      await saveCatalog()
    },
    async restart(unresolvedAgent?: string, replacementStore?: AgentStore) {
      service.close(); released.resolve(); restoreReleased.resolve(); restorePause = ""
      await Promise.allSettled(owners.map(owner => owner.cleanup()))
      await f.context.mutations.queue.run(async () => {
        for (const entry of f.context.mutations.accepted) entry.record = (await reconcileRecord(entry.path, f.context.adapter, entry.record)).record
        for (const entry of f.context.mutations.accepted) if (entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === unresolvedAgent) {
          entry.record = { ...entry.record, phase: "quarantined", reason: "fixture same-boot process could not be verified" }
          await writeLaunchRecord(entry.path, entry.record)
        }
      })
      f.context.state.handlerGeneration = randomUUID()
      snapshot = { ...snapshot, snapshotId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, providers: snapshot.providers.map(provider => ({ ...provider, verifiedHandlerGeneration: f.context.state.handlerGeneration, verifiedAt: Date.now() })) }
      await saveCatalog()
      service = track(createAgentService({ ...composition, store: replacementStore ?? createAgentStore(root) }, dependencies)); await service.initialize(); return service
    },
  }
}