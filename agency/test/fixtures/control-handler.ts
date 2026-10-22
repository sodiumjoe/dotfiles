import { fixtureSpawner, fixtureRuntime, finishFixtureSource, prepareFixtureExit } from "./fixture-spawn.js"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Socket, Server } from "node:net"
import { appendFileSync, existsSync } from "node:fs"
import { createAgentService } from "../../src/agent/service.js"
import { createTaskService } from "../../src/tasks/service.js"
import { runHandler } from "../../src/handler/daemon.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import type { ControlFixtureConfig } from "../control-support.js"
import { createCatalogStore } from "../../src/catalog/store.js"
import { createProbeRuntime } from "../../src/catalog/probes.js"
import { createCatalogService } from "../../src/catalog/service.js"
import { observeConfig } from "../../src/catalog/config.js"
import { writeLaunchRecord } from "../../src/platform/private-state.js"

const spawnFixture = await fixtureSpawner()
process.umask(0o077)
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as ControlFixtureConfig
const root = dirname(config.paths.runtimeRoot)
const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
const signalGroup = adapter.signalGroup.bind(adapter)
adapter.signalGroup = async (group, signal) => {
  if ((await fixtureRuntime()).scope.snapshot().launches.some(value => value.pid === group && value.role === "catalog-worker")) await prepareFixtureExit(group)
  await signalGroup(group, signal)
}
if (config.failBootIdOnce) {
  const bootId = adapter.bootId.bind(adapter)
  adapter.bootId = async () => { adapter.bootId = bootId; throw new Error("injected retained boot observation failure") }
}
if (config.failSignalGroup !== undefined) {
  const signalGroup = adapter.signalGroup.bind(adapter)
  adapter.signalGroup = async (group, signal) => { if (group === config.failSignalGroup) throw new Error(config.failSignalMessage ?? "injected retained cleanup failure"); await signalGroup(group, signal) }
}
const note = (event: string): void => appendFileSync(join(root, "termination-events"), event + "\n")
const waitFor = async (file: string): Promise<void> => { while (!existsSync(join(root, file))) await new Promise(resolve => setTimeout(resolve, 20)) }
if (config.terminationFixture?.endpointCloseReject) {
  const close = Server.prototype.close
  Server.prototype.close = function (...args: Parameters<typeof close>) {
    const address = this.address()
    const result = close.apply(this, args)
    if (typeof address === "string") note("endpoint:" + address.split("/").pop())
    if (typeof address === "string" && address.endsWith("attachment.sock")) throw new Error("fixture endpoint close rejected")
    return result
  }
}
try {
  await runHandler({ paths: config.paths, adapter, recordPath: process.env.AGENCY_HANDLER_RECORD!, generation: process.env.AGENCY_HANDLER_GENERATION!, status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }), ...(config.catalog || config.terminationFixture ? { catalogFactory: (context: Parameters<NonNullable<import("../../src/handler/daemon.js").HandlerOptions["catalogFactory"]>>[0]) => {
    const store = context.store
    const probes = createProbeRuntime({ ...context, queue: context.mutations.queue, store, canStart: () => context.isReady() && !context.shutdownPending(), workerFile: new URL("./catalog-driver-worker.js", import.meta.url).pathname, dependencies: { spawn: ((file, args, options) => spawnFixture("catalog-worker", file, args ?? [], options ?? {}, { source: true })) as typeof import("node:child_process").spawn, env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), CLAUDE_CONFIG_DIR: join(root, "config"), CODEX_HOME: join(root, "config"), PATH: "/usr/bin:/bin" } } })
    const service = createCatalogService({ ...context, queue: context.mutations.queue, store, probes })
    return { ...service,
      async freezeAndDrain() { note("catalog-drain"); if (config.terminationFixture?.drain === "fail") throw new Error("fixture catalog drain failed"); if (config.terminationFixture?.drain === "hold") await waitFor("release-drain"); await service.freezeAndDrain() },
      close() { note("catalog-close"); service.close(); if (config.terminationFixture?.catalogCloseHold) return waitFor("release-close") },
      async initialize() {
      if (config.terminationFixture?.initializeHold) { note("catalog-initialize"); await waitFor("release-initialize") }
      if (config.catalog?.scenario === "uncertain") {
        const profile = config.catalog!.profiles[0]!, evidence = await observeConfig(profile), attemptId = randomUUID(), commandId = randomUUID()
        const meta = { version: 2 as const, hostId: context.paths.hostKey, handlerGeneration: context.generation, commandId, providerId: profile.id, attemptId, fingerprint: evidence.fingerprint, workPath: join(context.paths.persistentRoot, "catalog/work", attemptId) }
        await store.writeCommand({ version: 1, commandId, hostId: meta.hostId, handlerGeneration: context.generation, batchId: randomUUID(), fingerprints: [{ providerId: profile.id, fingerprint: evidence.fingerprint }], attempts: [{ providerId: profile.id, attemptId }], state: "pending", snapshotId: null }, null)
        await store.writeProbeMeta(meta)
        await mkdir(join(context.paths.persistentRoot, "catalog/probe-launches"), { mode: 0o700 })
        await writeLaunchRecord(join(context.paths.persistentRoot, "catalog/probe-launches", attemptId + ".json"), { version: 2, owner: { kind: "catalog-probe", providerId: profile.id, commandId }, handlerGeneration: context.generation, launchAttemptId: attemptId, launchBootId: await adapter.bootId(), launchAttempted: true, phase: "launch_pending", provider: null, reason: null })
        await service.initialize()
        const view = await service.list()
        if (view.discovery.state !== "idle" || view.providers.find(provider => provider.providerId === profile.id)?.refreshIssue !== undefined) throw new Error("historical probe issue affected current discovery")
        return
      }
      await service.initialize()
    } }
  } } : {}), ...(config.terminationFixture ? {
    agentFactory: (input: Parameters<typeof createAgentService>[0]) => { note("agents-created"); const service = createAgentService(input); return { ...service, close() { note("agents-close"); service.close() } } },
    taskFactory: async (input: Parameters<typeof createTaskService>[0]) => {
      note("tasks-created")
      if (config.terminationFixture?.lateTask) { await waitFor("release-task"); if (config.terminationFixture.lateTask === "reject") { note("task-initialize-rejected"); throw new Error("fixture late task failed") } }
      await input.store.initialize()
      const service = createTaskService(input)
      note("tasks-ready")
      return { ...service, close() { note("tasks-close"); if (config.terminationFixture?.taskClose === "sync") throw new Error("fixture task close threw"); if (config.terminationFixture?.taskClose === "reject") return Promise.reject(new Error("fixture task close rejected")); if (config.terminationFixture?.taskClose === "hold") return waitFor("release-task-close"); return service.close() } }
    },
  } : {}), onPhase: async phase => {
    if (config.delayMs !== undefined && phase === "ready") await new Promise(resolve => setTimeout(resolve, config.delayMs))
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
  } })
} catch (error) {
  await writeFile(join(root, "failure"), String(error), { mode: 0o600 })
  process.exitCode = 1
}
if (config.pauseAt === "handler-completed") {
  await writeFile(join(root, "handler-completed"), process.env.AGENCY_HANDLER_GENERATION!, { mode: 0o600 })
  const deadline = Date.now() + 10000
  while (true) {
    try { await readFile(join(root, "release-completion")); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if (Date.now() >= deadline) throw new Error("fixture completion pause timed out")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
await finishFixtureSource()