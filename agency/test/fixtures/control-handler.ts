import { randomUUID } from "node:crypto"
import { ChildProcess } from "node:child_process"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Socket } from "node:net"
import { runHandler } from "../../src/handler/daemon.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import { resolveCheckout, observeGitChild, verifyGitExit, assertGitChildrenClosed, CheckoutResolutionError } from "../../src/checkout/identity.js"
import type { ControlFixtureConfig } from "../control-support.js"
import type { AdmissionController } from "../../src/checkout/admission.js"
import { createCatalogStore } from "../../src/catalog/store.js"
import { createProbeRuntime } from "../../src/catalog/probes.js"
import { createCatalogService } from "../../src/catalog/service.js"
import { observeConfig } from "../../src/catalog/config.js"
import { writeLaunchRecord } from "../../src/platform/private-state.js"

process.umask(0o077)
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as ControlFixtureConfig
const root = dirname(config.paths.runtimeRoot)
const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
if (config.failBootIdOnce) {
  const bootId = adapter.bootId.bind(adapter)
  adapter.bootId = async () => { adapter.bootId = bootId; throw new Error("injected retained boot observation failure") }
}
if (config.failSignalGroup !== undefined) {
  const signalGroup = adapter.signalGroup.bind(adapter)
  adapter.signalGroup = async (group, signal) => { if (group === config.failSignalGroup) throw new Error("injected retained cleanup failure"); await signalGroup(group, signal) }
}
let admission: AdmissionController | undefined, admissionDone = false
const admit = async (controller: AdmissionController): Promise<void> => {
  if (admissionDone || config.admissionOperations === undefined) return
  admissionDone = true
  if (config.admissionOperations.length < 1 || config.admissionOperations.length > 3) throw new Error("invalid fixture operation count")
  const results: unknown[] = []
  for (const operation of config.admissionOperations) {
    try {
      if (config.syntheticGitCleanup) await verifyGitExit(observeGitChild(new ChildProcess()), 5)
      const checkout = await resolveCheckout(operation.checkoutPath, config.paths.hostKey)
      const request = { checkout, agentId: operation.agentId, leaseId: operation.leaseId, launchAttemptId: operation.launchAttemptId, handlerGeneration: process.env.AGENCY_HANDLER_GENERATION! }
      const reservation = await controller.reserve(request)
      const launch = operation.action === "reserve_cancel" ? await controller.cancel(request) : reservation.launch
      results.push({ ok: true, admission: reservation.admission, launch })
    } catch (error) {
      try { assertGitChildrenClosed() } catch (cleanup) {
        await writeFile(join(root, "git-cleanup-failure.json"), JSON.stringify({ handlerPid: process.pid, handlerGeneration: process.env.AGENCY_HANDLER_GENERATION, checkoutPath: operation.checkoutPath, launchAttemptId: operation.launchAttemptId, child: cleanup instanceof CheckoutResolutionError ? cleanup.child : null, completedOperations: results }), { mode: 0o600 })
        throw cleanup
      }
      results.push({ ok: false, code: error instanceof Error && "code" in error ? error.code : "FIXTURE_ERROR", message: String(error).slice(0, 512) })
    }
  }
  await writeFile(join(root, "admission-result.json"), JSON.stringify(results), { mode: 0o600 })
}
try {
  await runHandler({ paths: config.paths, adapter, recordPath: process.env.AGENCY_HANDLER_RECORD!, generation: process.env.AGENCY_HANDLER_GENERATION!, status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }), ...(config.catalog ? { catalogFactory: (context: Parameters<NonNullable<import("../../src/handler/daemon.js").HandlerOptions["catalogFactory"]>>[0]) => {
    const store = createCatalogStore(config.paths.persistentRoot)
    const probes = createProbeRuntime({ ...context, queue: context.mutations.queue, store, canStart: () => context.isReady() && !context.shutdownPending(), dependencies: { env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), CLAUDE_CONFIG_DIR: join(root, "config"), CODEX_HOME: join(root, "config"), PATH: "/usr/bin:/bin" } } })
    const service = createCatalogService({ ...context, queue: context.mutations.queue, store, probes })
    return { ...service, async list() { if (config.catalog!.admissionOnList && admission) await admit(admission); return service.list() }, async initialize() {
      if (config.catalog!.scenario === "uncertain") {
        const profile = config.catalog!.profiles[0]!, evidence = await observeConfig(profile), attemptId = randomUUID(), commandId = randomUUID()
        const meta = { version: 2 as const, hostId: context.paths.hostKey, handlerGeneration: context.generation, commandId, providerId: profile.id, attemptId, fingerprint: evidence.fingerprint, workPath: join(context.paths.persistentRoot, "catalog/work", attemptId) }
        await store.writeCommand({ version: 1, commandId, hostId: meta.hostId, handlerGeneration: context.generation, batchId: randomUUID(), fingerprints: [{ providerId: profile.id, fingerprint: evidence.fingerprint }], attempts: [{ providerId: profile.id, attemptId }], state: "pending", snapshotId: null }, null)
        await store.writeProbeMeta(meta)
        await mkdir(join(context.paths.persistentRoot, "catalog/probe-launches"), { mode: 0o700 })
        await writeLaunchRecord(join(context.paths.persistentRoot, "catalog/probe-launches", attemptId + ".json"), { version: 2, owner: { kind: "catalog-probe", providerId: profile.id, commandId }, handlerGeneration: context.generation, launchAttemptId: attemptId, launchBootId: await adapter.bootId(), launchAttempted: true, phase: "launch_pending", provider: null, reason: null })
        await service.initialize()
        const view = await service.list()
        if (view.discovery.state !== "idle" || view.providers.find(provider => provider.providerId === profile.id)?.refreshIssue?.code !== "PROBE_CLEANUP_UNVERIFIED") throw new Error("synthetic probe issue was not scoped")
        return
      }
      await service.initialize()
    } }
  } } : {}), onPhase: async phase => {
    if (config.delayMs !== undefined && phase === "reconciling") await new Promise(resolve => setTimeout(resolve, config.delayMs))
    if (config.pauseAt === phase) {
      await writeFile(join(root, "paused"), phase, { mode: 0o600 })
      const deadline = Date.now() + 10000
      while (true) {
        try { await readFile(join(root, "release")); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
        if (Date.now() >= deadline) throw new Error("fixture pause timed out")
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    if (config.mutateAt === phase) {
      const directory = join(config.paths.persistentRoot, "launches")
      const names = await readdir(directory)
      const path = join(directory, names.find(name => name.endsWith(".json"))!)
      const record = JSON.parse(await readFile(path, "utf8"))
      if (config.mutate === "add") { record.launchAttemptId = randomUUID(); await writeFile(join(directory, record.launchAttemptId + ".json"), JSON.stringify(record), { mode: 0o600 }) }
      else { record.checkoutId = "replaced"; await writeFile(path, JSON.stringify(record), { mode: 0o600 }) }
    }
  }, onAdmissionReady: async controller => {
    admission = controller
    if (!config.catalog?.admissionOnList) await admit(controller)
  } })
} catch (error) {
  await writeFile(join(root, "failure"), String(error), { mode: 0o600 })
  process.exitCode = 1
}