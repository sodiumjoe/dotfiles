import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir, open, rename, rm } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Socket } from "node:net"
import { runHandler } from "../../src/handler/daemon.js"
import { createAgentService } from "../../src/agent/service.js"
import { createAgentProcess } from "../../src/agent/process.js"
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
import { fixtureRetention } from "../retention-support.js"

process.umask(0o077)
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as AgentHandlerOptions & { paths: PlatformPaths; profile: ProviderProfile; profiles?: ProviderProfile[] }
const root = dirname(config.paths.runtimeRoot), generation = process.env.AGENCY_HANDLER_GENERATION!
const platform = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
const adapter = { ...platform, async signalGroup(group: number, signal: NodeJS.Signals) { await pause("stop-cleanup"); await platform.signalGroup(group, signal) } }
let paused = false
async function pause(name: string): Promise<void> {
  if (paused || config.pauseAt !== name) return
  paused = true
  await writeFile(join(root, "barrier.json"), JSON.stringify({ name, generation }), { mode: 0o600 })
  while (true) {
    try { await readFile(join(root, "release-barrier")); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const contract: LaunchContract = {
  id: "fixture-v1", sessionLoad: true, providerId: "codex-acp", adapterPackage: "@agentclientprotocol/codex-acp", adapterVersion: "1.0.0",
  modes: { state: "values", values: ["plan", "review"] }, reasoning: { state: "values", values: ["high", "low"] }, effectiveMode: null, permissionProfiles: ["fixture-deny-v1"], modelOption: "model", reasoningOption: "reasoning", modeOption: "mode",
  permissionEvidence: "fixture-contract-v1", deadlines: { commandMs: 5000, spawnMs: 5000, initializeMs: 15000, sessionMs: 15000, optionMs: 5000, promptMs: 90000, transportCloseMs: 1000, processTerminateMs: 5000, absenceMs: 2000, overallMs: 150000 },
}
try {
  await runHandler({ paths: config.paths, adapter, recordPath: process.env.AGENCY_HANDLER_RECORD!, generation, retention: fixtureRetention(root, config.paths.persistentRoot, config),
    status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }), launchContracts: config.nativeAcp ? [{ ...contract, promptCapabilities: { image: true, audio: false, embeddedContext: true } }, { ...contract, providerId: "claude-agent-acp", adapterPackage: "@agentclientprotocol/claude-agent-acp", sdkVersion: "0.3.232", promptCapabilities: { image: false, audio: false, embeddedContext: true } }] : [contract],
    catalogFactory(context) {
      const store = context.store
      const service = createCatalogService({ ...context, queue: context.mutations.queue, store, probes: { retentionPins: () => ({ paths: [] }), forgetRemoved() {}, recover: async () => undefined, verifyDischarged: async () => undefined, run: async () => { throw new Error("fixture catalog cannot spawn discovery") } } })
      return { ...service, ...(config.selectionCatalog ? { startScheduling() {} } : {}), async initialize() {
        const evidence = await observeConfig(config.profile)
        const snapshot: CatalogSnapshot = { version: 1 as const, hostId: config.paths.hostKey, handlerGeneration: generation, snapshotId: randomUUID(), createdAt: Date.now(), providers: [{ providerId: "codex-acp" as const, fingerprint: evidence.fingerprint, verifiedAt: Date.now(), verifiedHandlerGeneration: generation, providerVersion: null, providerVersionSource: "unknown" as const, adapterVersion: "1.0.0", sdkVersion: null, error: null, models: [{ providerId: "codex-acp" as const, modelId: "model-a", resolvedModelId: null, displayName: "Fixture model", reasoning: { state: "values" as const, values: ["high", "low"] }, modes: { state: "unknown" as const }, availability: "advertised" as const }] }] }
        if (config.selectionCatalog) snapshot.providers[0]!.models[0]!.modes = { state: "values", values: ["agent-full-access", "read-only"] }
        if (config.selectionCatalog) snapshot.providers[0]!.models.push({ ...snapshot.providers[0]!.models[0]!, modelId: "model-c", displayName: "Model C", reasoning: { state: "values", values: ["medium", "minimal"] } })
        if (config.catalogState === "stale") snapshot.providers[0]!.verifiedAt = Date.now() - 600001
        if (config.catalogState === "prior-generation") snapshot.providers[0]!.verifiedHandlerGeneration = randomUUID()
        if (config.catalogState === "failed") snapshot.providers[0]!.error = { code: "PROBE_FAILED", message: "Provider discovery failed" }
        if (config.catalogState !== "missing") { await store.writeSnapshot(snapshot); await store.publishCurrent(snapshot) }
        await service.initialize()
      } }
    },
    agentFactory(input) {
      let writingReceipt = false, evidenceCalls = 0
      const startupHang = async (boundary: AgentHandlerOptions["startupHang"]): Promise<void> => {
        if (config.startupHang === boundary) await new Promise<void>(() => undefined)
      }
      const base = createAgentStore(config.paths.persistentRoot, { mkdir, rename, rm, async open(path, flags, mode) {
        const handle = await open(path, flags, mode), sync = handle.sync.bind(handle)
        handle.sync = async () => {
          if (config.failReceiptSync && writingReceipt && path === join(config.paths.persistentRoot, "agents/commands")) { await pause("receipt"); throw new Error("fixture receipt directory fsync failure") }
          await sync()
        }
        return handle
      } }, input.retirement)
      return createAgentService({ ...input, store: { ...base, async writeAgent(next, expected) {
        await base.writeAgent(next, expected)
        if (next.phase === "ready") await startupHang("publication")
        if (next.phase === "ready") await pause("ready")
      }, async writeCommand(next, expected) {
        if (next.op === "stop" && next.state === "completed") await pause("stop-receipt-before")
        writingReceipt = next.op === "start" && next.state === "completed"
        try { await base.writeCommand(next, expected) } finally { writingReceipt = false }
        if (next.op === "start" && next.state === "pending") await pause("intent")
        if (next.op === "start" && next.state === "completed") await pause("receipt")
        if (next.op === "stop" && next.state === "pending") await pause("stop-intent")
        if (next.op === "stop" && next.state === "completed") await pause("stop-receipt-after")
      } } }, { processFactory(options) {
        const owner = createAgentProcess(options, { spawn: ((...args: Parameters<typeof spawn>) => {
          const child = spawn(...args)
          writeFileSync(join(root, `spawn-${options.spec.launchAttemptId}.json`), JSON.stringify({ pid: child.pid ?? null, agentId: options.spec.agentId, attempt: options.spec.launchAttemptId }), { mode: 0o600 })
          return child
        }) as typeof spawn, transitionIO: { read: readLaunchRecordForReconciliation, async publish(path, record) {
          await writeLaunchRecord(path, record)
          if (record.launchAttempted && record.provider === null) await pause("attempted")
          if (record.provider !== null) await pause("identity")
        } } })
        return { ...owner, async cleanup() { const record = await owner.cleanup(); await pause("stop-verified"); return record } }
      }, async observeLaunchEvidence(spec, expected) {
        if (++evidenceCalls === 5) await startupHang("evidence")
        const profile = (config.profiles ?? [config.profile]).find(value => value.id === spec.backendId)
        if (!profile || !isDeepStrictEqual(profile, expected.profile) || !isDeepStrictEqual(await observeConfig(profile), spec.configuration)) throw new AgentError("CONFIG_CHANGED")
      }, fatalStartupTimeout(spec): never {
        if (!config.startupHang || spec.handlerGeneration !== generation) throw new Error("unexpected fixture startup timeout")
        const handlerPid = process.pid
        writeFileSync(join(root, "startup-timeout.json"), JSON.stringify({ pid: handlerPid, signal: "SIGKILL", attempt: spec.launchAttemptId }), { mode: 0o600 })
        if (handlerPid !== process.pid) throw new Error("fixture Handler identity changed")
        process.kill(handlerPid, "SIGKILL")
        throw new Error("fixture Handler survived SIGKILL")
      } })
    },
  })
} catch (error) {
  await writeFile(join(root, "failure"), String(error).slice(0, 2048), { mode: 0o600 })
  process.exitCode = 1
}