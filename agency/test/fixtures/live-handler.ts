import { fixtureSpawner, finishFixtureSource } from "./fixture-spawn.js"
import type { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Socket } from "node:net"
import { runHandler } from "../../src/handler/daemon.js"
import { createAgentProcess } from "../../src/agent/process.js"
import { AgentError } from "../../src/agent/types.js"
import type { LaunchContract } from "../../src/agent/contracts.js"
import { createCatalogService } from "../../src/catalog/service.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import type { PlatformPaths } from "../../src/platform/paths.js"

const spawnFixture = await fixtureSpawner()
process.umask(0o077)
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as { paths: PlatformPaths }
const root = dirname(config.paths.runtimeRoot)
const contract: LaunchContract = {
  id: "fixture-v1", sessionLoad: true, providerId: "codex-acp", adapterPackage: "@agentclientprotocol/codex-acp", adapterVersion: "1.0.0",
  modes: { state: "values", values: ["agent-full-access", "read-only"] }, reasoning: { state: "values", values: ["high", "low"] }, effectiveMode: null, permissionProfiles: ["fixture-deny-v1"], modelOption: "model", reasoningOption: "reasoning_effort", modeOption: "mode",
  permissionEvidence: "fixture-contract-v1", deadlines: { commandMs: 5000, spawnMs: 5000, initializeMs: 15000, sessionMs: 15000, optionMs: 5000, promptMs: 90000, transportCloseMs: 1000, processTerminateMs: 5000, absenceMs: 2000, overallMs: 150000 },
}
const unverifiedCleanup = (owner: ReturnType<typeof createAgentProcess>): ReturnType<typeof createAgentProcess> => new Proxy(owner, { get: (target, key) => key === "cleanup" ? async () => { await target.cleanup(); if (await readFile(join(root, "unverified-cleanup")).then(() => true, () => false)) throw new AgentError("CLEANUP_UNVERIFIED") } : Reflect.get(target, key) })
try {
  await runHandler({ paths: config.paths, adapter: process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter(), recordPath: process.env.AGENCY_HANDLER_RECORD!, generation: process.env.AGENCY_HANDLER_GENERATION!,
    status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }),
    launchContracts: [{ ...contract, promptCapabilities: { image: true, audio: false, embeddedContext: true } }, { ...contract, providerId: "claude-agent-acp", adapterPackage: "@agentclientprotocol/claude-agent-acp", sdkVersion: "0.3.232", promptCapabilities: { image: false, audio: false, embeddedContext: true } }],
    catalogFactory: context => {
      const service = createCatalogService({ ...context, queue: context.mutations.queue, probes: { verifyDischarged: async () => undefined, run: async () => { throw new Error("fixture catalog cannot spawn discovery") } } })
      return { ...service, async freezeAndDrain() { if (await readFile(join(root, "fail-catalog-drain")).then(() => true, () => false)) throw new Error("fixture catalog drain failure"); await service.freezeAndDrain() } }
    },
    liveDependencies: { processFactory: options => unverifiedCleanup(createAgentProcess(options, { spawn: ((file, argv, settings) => spawnFixture("agent-provider/" + options.spec.launchAttemptId, file, argv ?? [], settings ?? {})) as typeof spawn })),
      modelSource: async profile => [{ providerId: profile.id, modelId: "model-a", resolvedModelId: null, displayName: "Model A", reasoning: { state: "values", values: ["high", "low"] }, modes: { state: "unknown" }, availability: "advertised" }] } })
} catch (error) {
  await writeFile(join(root, "failure"), (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 4096), { mode: 0o600 })
  process.exitCode = 1
}
await finishFixtureSource()