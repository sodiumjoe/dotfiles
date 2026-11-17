import { launchContractFingerprint, type ConfiguredLaunchContract, type LaunchContract } from "../src/agent/contracts.js"
import type { AgentRecordV3, LaunchSpec } from "../src/agent/types.js"
import { digest } from "../src/config/providers.js"
import { canonicalJson } from "../src/agent/session-config.js"

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

export function sampleRecord(spec: LaunchSpec = sampleSpec()): AgentRecordV3 {
  const configValues = spec.selection.reasoning.kind === "value" ? { [["codex-acp-1.7", "codex-acp-2.6"].includes(spec.contractId) ? "reasoning_effort" : "reasoning"]: spec.selection.reasoning.value } : undefined
  return { version: 3, definition: { hostId: spec.hostId, agentId: spec.agentId, createdCommandId: spec.createdCommandId, cwd: spec.cwd, backendId: spec.selection.providerId, origin: "new" },
    launch: { handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration, launchAttemptId: spec.launchAttemptId, commandId: spec.commandId, configuration: spec.configuration, backendFingerprint: digest(canonicalJson([spec.configuration, spec.contractFingerprint])), compatibilityId: spec.contractId, containment: spec.containment, authority: spec.authority, limits: spec.limits },
    phase: "starting", session: null, failure: null, settings: { modelId: spec.selection.modelId, modeId: spec.selection.mode, ...(configValues ? { configValues } : {}) }, inputRequirements: { mcpServerNames: [] }, configurationState: { verification: { kind: "verified" }, nonRestorableOptionIds: [] } }
}