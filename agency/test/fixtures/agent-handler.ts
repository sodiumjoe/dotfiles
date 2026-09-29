import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir, open, rename, rm } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Socket } from "node:net"
import { fileURLToPath } from "node:url"
import { runHandler } from "../../src/handler/daemon.js"
import { createAgentService } from "../../src/agent/service.js"
import { createAgentProcess } from "../../src/agent/process.js"
import { AgentError } from "../../src/agent/types.js"
import { createAgentStore } from "../../src/agent/store.js"
import { observeLaunchContract, type LaunchContract } from "../../src/agent/contracts.js"
import { createCatalogService } from "../../src/catalog/service.js"
import { createCatalogStore } from "../../src/catalog/store.js"
import { observeConfig } from "../../src/catalog/config.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../../src/platform/private-state.js"
import { assertGitChildrenClosed, CheckoutResolutionError, resolveCheckout } from "../../src/checkout/identity.js"
import { createAdmissionController } from "../../src/checkout/admission.js"
import { writeAdmission } from "../../src/checkout/records.js"
import { reconcileRecord } from "../../src/platform/reconcile.js"
import type { PlatformPaths } from "../../src/platform/paths.js"
import type { ProviderProfile } from "../../src/catalog/types.js"
import type { AgentHandlerOptions } from "../agent-support.js"

process.umask(0o077)
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as AgentHandlerOptions & { paths: PlatformPaths; profile: ProviderProfile }
const root = dirname(config.paths.runtimeRoot), generation = process.env.AGENCY_HANDLER_GENERATION!
const platform = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
const adapter = { ...platform, async signalGroup(group: number, signal: NodeJS.Signals) { await pause("stop-cleanup"); await platform.signalGroup(group, signal) } }
let paused = false
async function pause(name: string): Promise<void> {
  if (paused || config.pauseAt !== name) return
  paused = true
  try { assertGitChildrenClosed() } catch (error) {
    await writeFile(join(root, "git-cleanup-failure.json"), JSON.stringify({ handlerPid: process.pid, child: error instanceof CheckoutResolutionError ? error.child : null }), { mode: 0o600 })
    throw error
  }
  await writeFile(join(root, "barrier.json"), JSON.stringify({ name, generation }), { mode: 0o600 })
  while (true) {
    try { await readFile(join(root, "release-barrier")); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const contract: LaunchContract = {
  id: "fixture-v1", providerId: "codex-acp", adapterVersion: "1.0.0", entrypoint: fileURLToPath(new URL("./agent-provider.js", import.meta.url)), fingerprint: "0".repeat(64),
  modes: { state: "values", values: ["plan", "review"] }, reasoning: { state: "values", values: ["high", "low"] }, effectiveMode: null, permissionProfiles: ["fixture-deny-v1"], modelOption: "model", reasoningOption: "reasoning", modeOption: "mode",
  environment: { fixed: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home"), TMPDIR: root, FIXTURE_ROOT: root }, private: {} }, permissionEvidence: "fixture-contract-v1", qualification: null,
}
contract.fingerprint = await observeLaunchContract(contract)
try {
  await runHandler({ paths: config.paths, adapter, recordPath: process.env.AGENCY_HANDLER_RECORD!, generation,
    status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }), launchContracts: [contract],
    async onAdmissionReady() {
      if (!config.fatalClose) return
      while (true) {
        try { await readFile(join(root, "fatal-close")); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assertGitChildrenClosed()
      throw new Error("fixture fatal Handler failure")
    },
    catalogFactory(context) {
      const store = createCatalogStore(config.paths.persistentRoot)
      const service = createCatalogService({ ...context, queue: context.mutations.queue, store, probes: { recover: async () => undefined, verifyDischarged: async () => undefined, run: async () => { throw new Error("fixture catalog cannot spawn discovery") } } })
      return { ...service, async initialize() {
        const evidence = await observeConfig(config.profile)
        const snapshot = { version: 1 as const, hostId: config.paths.hostKey, handlerGeneration: generation, snapshotId: randomUUID(), createdAt: Date.now(), providers: [{ providerId: "codex-acp" as const, fingerprint: evidence.fingerprint, verifiedAt: Date.now(), verifiedHandlerGeneration: generation, providerVersion: null, providerVersionSource: "unknown" as const, adapterVersion: "1.0.0", sdkVersion: null, error: null, models: [{ providerId: "codex-acp" as const, modelId: "model-a", resolvedModelId: null, displayName: "Fixture model", reasoning: { state: "values" as const, values: ["high", "low"] }, modes: { state: "unknown" as const }, availability: "advertised" as const }] }] }
        await store.writeSnapshot(snapshot); await store.publishCurrent(snapshot); await service.initialize()
      } }
    },
    agentFactory(input) {
      let writingReceipt = false
      const hang = async (boundary: AgentHandlerOptions["reservationHang"]): Promise<void> => {
        if (config.reservationHang === boundary) await new Promise<void>(() => undefined)
      }
      const admission = config.reservationHang ? createAdmissionController(input.context, {
        resolve: resolveCheckout, reconcile: reconcileRecord,
        async publishLaunch(path, record) { await hang("before"); await writeLaunchRecord(path, record); await hang("launch") },
        async publishAdmission(path, record) { await writeAdmission(path, record); await hang("admission") },
      }) : input.admission
      const base = createAgentStore(config.paths.persistentRoot, { mkdir, rename, rm, async open(path, flags, mode) {
        const handle = await open(path, flags, mode), sync = handle.sync.bind(handle)
        handle.sync = async () => {
          if (config.failReceiptSync && writingReceipt && path === join(config.paths.persistentRoot, "agents/commands")) { await pause("receipt"); throw new Error("fixture receipt directory fsync failure") }
          await sync()
        }
        return handle
      } })
      return createAgentService({ ...input, store: { ...base, async writeAgent(next, expected) {
        await base.writeAgent(next, expected)
        if (next.phase === "ready") await pause("ready")
      }, async writeCommand(next, expected) {
        if (next.op === "stop" && next.state === "completed") await pause("stop-receipt-before")
        writingReceipt = next.op === "start" && next.state === "completed"
        try { await base.writeCommand(next, expected) } finally { writingReceipt = false }
        if (next.op === "start" && next.state === "pending") await pause("intent")
        if (next.op === "start" && next.state === "completed") await pause("receipt")
        if (next.op === "stop" && next.state === "pending") await pause("stop-intent")
        if (next.op === "stop" && next.state === "completed") await pause("stop-receipt-after")
      } }, admission: { ...admission, async reserve(request) { const reservation = await admission.reserve(request); await pause("reservation"); return reservation } } }, { processFactory(options) {
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
        const current = await createCatalogStore(config.paths.persistentRoot).readCurrent()
        if (!current || current.snapshotId !== spec.catalogSnapshotId || !isDeepStrictEqual(current.providers[0], spec.catalogEvidence) || !isDeepStrictEqual(config.profile, expected.profile) || !isDeepStrictEqual(await observeConfig(config.profile), spec.configuration)) throw new AgentError("CONFIG_CHANGED")
      }, fatalReservationTimeout(spec): never {
        if (!config.reservationHang || spec.handlerGeneration !== generation) throw new Error("unexpected fixture reservation timeout")
        const handlerPid = process.pid
        writeFileSync(join(root, "reservation-timeout.json"), JSON.stringify({ pid: handlerPid, signal: "SIGKILL", attempt: spec.launchAttemptId }), { mode: 0o600 })
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