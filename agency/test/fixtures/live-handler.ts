import { fixtureSpawner, finishFixtureSource } from "./fixture-spawn.js"
import type { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { Socket } from "node:net"
import { runHandler } from "../../src/handler/daemon.js"
import { createAgentProcess } from "../../src/agent/process.js"
import { AgentError } from "../../src/agent/types.js"
import type { LaunchContract } from "../../src/agent/contracts.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import type { PlatformPaths } from "../../src/platform/paths.js"

const spawnFixture = await fixtureSpawner()
process.umask(0o077)
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as { paths: PlatformPaths; delegationRoots?: string[] }
const root = dirname(config.paths.runtimeRoot)
const contract: LaunchContract = {
  id: "fixture-v1", sessionLoad: true, providerId: "codex-acp", adapterPackage: "@agentclientprotocol/codex-acp", adapterVersion: "1.0.0",
  modes: { state: "values", values: ["agent-full-access", "read-only"] }, reasoning: { state: "values", values: ["high", "low"] }, effectiveMode: null, permissionProfiles: ["fixture-deny-v1"], modelOption: "model", reasoningOption: "reasoning_effort", modeOption: "mode",
  permissionEvidence: "fixture-contract-v1", deadlines: { commandMs: 5000, spawnMs: 5000, initializeMs: 15000, sessionMs: 15000, optionMs: 5000, promptMs: 90000, transportCloseMs: 1000, processTerminateMs: 5000, absenceMs: 2000, overallMs: 150000 },
}
const unverifiedCleanup = (owner: ReturnType<typeof createAgentProcess>): ReturnType<typeof createAgentProcess> => new Proxy(owner, { get: (target, key) => key === "cleanup" ? async () => { await target.cleanup(); if (await readFile(join(root, "unverified-cleanup")).then(() => true, () => false)) throw new AgentError("CLEANUP_UNVERIFIED") } : Reflect.get(target, key) })
try {
  await runHandler({ paths: config.paths, ...(config.delegationRoots ? { delegationRoots: config.delegationRoots } : {}), adapter: process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter(), recordPath: process.env.AGENCY_HANDLER_RECORD!, generation: process.env.AGENCY_HANDLER_GENERATION!,
    status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }),
    entryDriver: (() => { const opened = new Set<string>(), editor = { editorId: randomUUID(), session: "fixture", pane: "%1", tmuxSocketPath: join(root, "tmux.sock") }; return { ensure: async (ref: { target: { agentId: string } }) => { opened.add(ref.target.agentId); return editor }, activate: async () => {}, inspect: async (ref: { target: { agentId: string } }) => opened.has(ref.target.agentId) ? editor : null } })(),
    onPhase: async () => { if (await readFile(join(root, "fail-startup"), "utf8").then(() => true, () => false)) throw new Error("fixture startup failure") },
    launchContracts: [{ ...contract, promptCapabilities: { image: true, audio: false, embeddedContext: true } }, { ...contract, providerId: "claude-agent-acp", adapterPackage: "@agentclientprotocol/claude-agent-acp", sdkVersion: "0.3.232", promptCapabilities: { image: false, audio: false, embeddedContext: true } }],
    liveDependencies: { processFactory: options => unverifiedCleanup(createAgentProcess(options, { spawn: ((file, argv, settings) => spawnFixture("agent-provider/" + options.spec.launchAttemptId, file, argv ?? [], settings ?? {})) as typeof spawn })),
      modelSource: async profile => [{ providerId: profile.id, modelId: "model-a", resolvedModelId: null, displayName: "Model A", reasoning: { state: "values", values: ["high", "low"] }, modes: { state: "unknown" }, availability: "advertised" }, ...(profile.id === "claude-agent-acp" ? [{ providerId: profile.id, modelId: "legacy-b", resolvedModelId: "claude-fixture-legacy-b", displayName: "Legacy B", reasoning: { state: "unknown" as const }, modes: { state: "unknown" as const }, availability: "advertised" as const }] : [])] } })
} catch (error) {
  await writeFile(join(root, "failure"), (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 4096), { mode: 0o600 })
  process.exitCode = 1
}
await finishFixtureSource()