import { createTaskService } from "../../src/tasks/service.js"
import { fixtureRuntime, fixtureSpawner, finishFixtureSource } from "./fixture-spawn.js"
import { setTimeout as delay } from "node:timers/promises"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir, open, rename, rm } from "node:fs/promises"
import { appendFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Socket } from "node:net"
import { runHandler } from "../../src/handler/daemon.js"
import { createAgentService } from "../../src/agent/service.js"
import { createAgentProcess, type OwnedAgentProcess } from "../../src/agent/process.js"
import { AgentError } from "../../src/agent/types.js"
import { createAgentStore } from "../../src/agent/store.js"
import type { LaunchContract } from "../../src/agent/contracts.js"
import { createCatalogService } from "../../src/catalog/service.js"
import { createCatalogStore } from "../../src/catalog/store.js"
import { observeConfig } from "../../src/catalog/config.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../../src/platform/private-state.js"
import type { PlatformPaths } from "../../src/platform/paths.js"
import type { CatalogSnapshot, ProviderProfile } from "../../src/catalog/types.js"
import type { AgentHandlerOptions } from "../agent-support.js"

const spawnFixture = await fixtureSpawner()
process.umask(0o077)
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as AgentHandlerOptions & { paths: PlatformPaths; profile: ProviderProfile; profiles?: ProviderProfile[] }
const root = dirname(config.paths.runtimeRoot), generation = process.env.AGENCY_HANDLER_GENERATION!
const platform = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
const adapter = { ...platform, async signalGroup(group: number, signal: NodeJS.Signals) { await pause("stop-cleanup"); mutation("signal:" + signal); await platform.signalGroup(group, signal) } }
const taskLifetime = new AbortController()
let taskInitialization: Promise<ReturnType<typeof createTaskService>> | undefined
let paused = false
let failedOnce = false
function mutation(event: string): void {
  if (config.failOnceAt || config.witness) appendFileSync(join(root, "mutations.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 })
}
function failOnce(stage: AgentHandlerOptions["failOnceAt"]): void {
  if (!stage || failedOnce || config.failOnceAt !== stage) return
  failedOnce = true
  mutation("failed:" + stage)
  throw new Error("fixture one-shot failure: " + stage)
}
async function pause(name: string): Promise<void> {
  if (paused || config.pauseAt !== name) return
  paused = true
  await writeFile(join(root, "barrier.json"), JSON.stringify({ name, generation }), { mode: 0o600 })
  while (true) {
    try { await readFile(join(root, name === "source-completion" ? "release-completion" : "release-barrier")); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const contract: LaunchContract = {
  id: "fixture-v1", sessionLoad: true, providerId: "codex-acp", adapterPackage: "@agentclientprotocol/codex-acp", adapterVersion: "1.0.0",
  modes: { state: "values", values: ["plan", "review"] }, reasoning: { state: "values", values: ["high", "low"] }, effectiveMode: null, permissionProfiles: ["fixture-deny-v1"], modelOption: "model", reasoningOption: "reasoning", modeOption: "mode",
  permissionEvidence: "fixture-contract-v1", deadlines: { commandMs: 5000, spawnMs: 5000, initializeMs: 15000, sessionMs: 15000, optionMs: 5000, promptMs: 90000, transportCloseMs: 1000, processTerminateMs: 5000, absenceMs: 2000, overallMs: 150000 },
}
if (config.selectionCatalog) {
  contract.modes = { state: "values", values: ["agent-full-access", "read-only"] }
  contract.reasoningOption = "reasoning_effort"
}
try {
  await runHandler({ taskFactory: input => taskInitialization = (async () => {
    try {
      if (config.tasks) await writeFile(join(root, "tasks-entered"), "entered", { mode: 0o600 })
      if (config.tasks === "reject") throw new Error("fixture task initialization failure")
      if (config.tasks === "hold") while (true) {
        try { await readFile(join(root, "release-tasks")); await pause("tasks-released"); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
        await delay(20, undefined, { signal: taskLifetime.signal })
      }
      taskLifetime.signal.throwIfAborted()
      await input.store.initialize()
      return createTaskService(input)
    } finally { if (config.tasks === "hold") await writeFile(join(root, "tasks-settled"), JSON.stringify({ generation }), { mode: 0o600 }) }
  })(), ...(config.entry === "synthetic" ? { entryDriver: (() => {
    let creations = 0, activations = 0, binding: import("../../src/entry/runtime.js").RuntimeEditor | null = null
    const editor = { editorId: randomUUID(), session: "synthetic-entry", pane: "%1", tmuxSocketPath: join(config.paths.runtimeRoot, "entry-tmux.sock") }
    return {
      async ensure() { await writeFile(join(root, "entry-creations"), String(++creations)); return editor },
      async activate() {
        await writeFile(join(root, "entry-activations"), String(++activations))
        while (true) {
          try { await readFile(join(root, "entry-release")); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        binding = editor
      },
      async inspect() { return binding }
    }
  })() } : {}), paths: config.paths, adapter, recordPath: process.env.AGENCY_HANDLER_RECORD!, generation,
    status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }), launchContracts: config.nativeAcp ? [{ ...contract, promptCapabilities: { image: true, audio: false, embeddedContext: true } }, { ...contract, providerId: "claude-agent-acp", adapterPackage: "@agentclientprotocol/claude-agent-acp", sdkVersion: "0.3.232", promptCapabilities: { image: false, audio: false, embeddedContext: true } }] : [contract],
    catalogFactory(context) {
      const store = context.store
      const service = createCatalogService({ ...context, queue: context.mutations.queue, store, probes: { verifyDischarged: async () => undefined, run: async () => { throw new Error("fixture catalog cannot spawn discovery") } } })
      return { ...service, async initialize() {
        const evidence = await observeConfig(config.profile)
        const snapshot: CatalogSnapshot = { version: 1 as const, hostId: config.paths.hostKey, handlerGeneration: generation, snapshotId: randomUUID(), createdAt: Date.now(), providers: [{ providerId: "codex-acp" as const, fingerprint: evidence.fingerprint, verifiedAt: Date.now(), verifiedHandlerGeneration: generation, providerVersion: null, providerVersionSource: "unknown" as const, adapterVersion: "1.0.0", sdkVersion: null, error: null, models: [{ providerId: "codex-acp" as const, modelId: "model-a", resolvedModelId: null, displayName: "Fixture model", reasoning: { state: "values" as const, values: ["high", "low"] }, modes: { state: "unknown" as const }, availability: "advertised" as const }] }] }
        if (config.selectionCatalog) snapshot.providers[0]!.models[0]!.modes = { state: "values", values: ["agent-full-access", "read-only"] }
        if (config.selectionCatalog) snapshot.providers[0]!.models.push({ ...snapshot.providers[0]!.models[0]!, modelId: "model-b", displayName: "Model B" })
        if (config.catalogState === "stale") snapshot.providers[0]!.verifiedAt = Date.now() - 600001
        if (config.catalogState === "prior-generation") snapshot.providers[0]!.verifiedHandlerGeneration = randomUUID()
        if (config.catalogState === "failed") snapshot.providers[0]!.error = { code: "PROBE_FAILED", message: "Provider discovery failed" }
        if (config.catalogState !== "missing") { await store.writeSnapshot(snapshot); await store.publishCurrent(snapshot) }
        await service.initialize()
      } }
    },
    agentFactory(input) {
      let writingReceipt = false, ownerForConfiguration: OwnedAgentProcess | undefined
      const base = createAgentStore(config.paths.persistentRoot, { mkdir, rename, rm, async open(path, flags, mode) {
        const handle = await open(path, flags, mode), sync = handle.sync.bind(handle)
        handle.sync = async () => {
          if (config.failReceiptSync && writingReceipt && path === join(config.paths.persistentRoot, "agents/commands")) { await pause("receipt"); throw new Error("fixture receipt directory fsync failure") }
          await sync()
        }
        return handle
      } })
      const service = createAgentService({ ...input, store: { ...base, async writeAgent(next, expected) {
        mutation("agent:" + next.phase)
        if (next.phase === "stopped") failOnce("terminal-publication")
        if (config.pauseAt === "configuration" && next.phase === "ready" && expected?.phase === "ready" && next.version === 3 && next.configurationState.verification.kind === "unknown") {
          void ownerForConfiguration!.cleanup().catch(() => undefined)
          await pause("configuration")
        }
        await base.writeAgent(next, expected)
        if (next.phase === "ready") await pause("ready")
      }, async writeCommand(next, expected) {
        mutation("command:" + next.op + ":" + next.state)
        if (next.op === "stop" && next.state === "completed") { await pause("stop-receipt-before"); failOnce("stop-publication") }
        writingReceipt = next.op === "start" && next.state === "completed"
        try { await base.writeCommand(next, expected) } finally { writingReceipt = false }
        if (next.op === "start") failOnce(next.state === "pending" ? "start-intent" : "start-receipt")
        if (next.op === "start" && next.state === "pending") await pause("intent")
        if (next.op === "start" && next.state === "completed") await pause("receipt")
        if (next.op === "stop" && next.state === "pending") await pause("stop-intent")
        if (next.op === "stop" && next.state === "completed") await pause("stop-receipt-after")
      } } }, { processFactory(options) {
        mutation("process")
        const owner = createAgentProcess(options, { spawn: ((...args: Parameters<typeof spawn>) => {
          const [file, argv, settings] = args
          const child = spawnFixture("agent-provider/" + options.spec.launchAttemptId, file, argv ?? [], settings ?? {})
          return child
        }) as typeof spawn, transitionIO: { read: readLaunchRecordForReconciliation, async publish(path, record) {
          if (record.phase === "cleanup_pending") { await pause("cleanup-publication"); failOnce("cleanup-publication") }
          await writeLaunchRecord(path, record)
          if (record.launchAttempted && record.provider === null) await pause("attempted")
          if (record.provider !== null) await pause("identity")
        } } })
        ownerForConfiguration = owner
        return { ...owner, async initialize(signal) {
          const session = await owner.initialize(signal)
          if (config.providerScenario === "restore-verification-mismatch" && options.session?.kind === "load") session.configuration.configOptions.find(option => option.id === "mode")!.currentValue = "plan"
          return session
        }, async cleanup() { mutation("cleanup"); failOnce("stop-cleanup"); const record = await owner.cleanup(); await pause("stop-verified"); return record } }
      } })
      const witnessed = new Set<string>()
      return { ...service, async observeSession(target, listener, configuration) {
        if (config.witness && !witnessed.has(target.agentId)) {
          witnessed.add(target.agentId)
          await service.observe(target, notification => {
            if (notification.kind === "closed") mutation("conversation-closed")
            else if (notification.event.kind === "turn") mutation("turn:" + notification.event.state)
          })
        }
        return service.observeSession(target, listener, configuration)
      } }
    },
  })
} catch (error) {
  await writeFile(join(root, "failure"), (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 4096), { mode: 0o600 })
  process.exitCode = 1
} finally {
  taskLifetime.abort()
  if (config.tasks === "hold") await writeFile(join(root, "handler-completed"), JSON.stringify({ generation, resources: process.getActiveResourcesInfo() }), { mode: 0o600 })
  await taskInitialization?.catch(() => undefined)
}
await pause("handler-completed")
await pause("source-completion")
await finishFixtureSource()