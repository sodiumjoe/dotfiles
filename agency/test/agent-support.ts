import { checkoutIdFor } from "../src/checkout/identity.js"
import type { LaunchContract } from "../src/agent/contracts.js"
import type { AgentCommand, AgentRecord, LaunchSpec, SessionEvidence } from "../src/agent/types.js"

export const agentId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

export function sampleSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  const hostId = "a".repeat(64), root = { path: "/checkout", device: "1", inode: "2" }, gitDirectory = { path: "/checkout/.git", device: "1", inode: "3" }
  return {
    version: 1, hostId, agentId: agentId(1), handlerGeneration: agentId(2), providerGeneration: agentId(3), leaseId: agentId(4), launchAttemptId: agentId(5), startCommandId: agentId(6),
    selection: { providerId: "codex-acp", modelId: "model-a", reasoning: { kind: "value", value: "high" }, mode: "review", permissionProfile: "fixture-deny-v1" },
    modelIdentity: "advertised", resolvedModelId: null,
    checkout: { version: 1, hostId, checkoutId: checkoutIdFor(hostId, root, gitDirectory), root, gitDirectory, commonDirectory: gitDirectory, ancestors: [{ path: "/", device: "1", inode: "1" }] },
    catalogSnapshotId: agentId(7),
    catalogEvidence: { providerId: "codex-acp", fingerprint: "b".repeat(64), verifiedAt: 1000, verifiedHandlerGeneration: agentId(2), providerVersion: null, providerVersionSource: "unknown", adapterVersion: "1.0.0", sdkVersion: null, error: null, models: [{ providerId: "codex-acp", modelId: "model-a", resolvedModelId: null, displayName: "Model A", reasoning: { state: "values", values: ["high", "low"] }, modes: { state: "unknown" }, availability: "advertised" }] },
    configuration: { fingerprint: "b".repeat(64), scope: "declared-config-v1", providerId: "codex-acp", adapterVersion: "1.0.0", sdkVersion: null },
    contractId: "fixture-v1", contractFingerprint: "c".repeat(64), containment: "direct-process-group-v1", authority: "normal-user",
    limits: { startupMs: 30000, rpcMs: 5000, frameBytes: 1048576, startupBytes: 8388608, writeQueueBytes: 1048576, stderrBytes: 8192 }, ...overrides,
  }
}

export function sampleContract(): LaunchContract {
  return { id: "fixture-v1", providerId: "codex-acp", adapterVersion: "1.0.0", entrypoint: "/fixture.mjs", fingerprint: "c".repeat(64), modes: { state: "values", values: ["plan", "review"] }, reasoning: { state: "values", values: ["high", "low"] }, effectiveMode: null, permissionProfiles: ["fixture-deny-v1"], modelOption: "model", reasoningOption: "reasoning", modeOption: "mode", environment: {}, permissionEvidence: "fixture-contract-v1" }
}

export function sampleAgent(): AgentRecord { return { version: 1, spec: sampleSpec(), phase: "starting", session: null, failure: null } }
export function sampleSession(): SessionEvidence { return { sessionId: "fixture-session", sessionGeneration: agentId(8), protocolVersion: 1, modelId: "model-a", reasoning: { kind: "value", value: "high" }, mode: "review", permissionProfile: "fixture-deny-v1", permissionEvidence: "fixture-contract-v1" } }
export function sampleCommand(): AgentCommand {
  const spec = sampleSpec()
  return { version: 1, hostId: spec.hostId, commandId: spec.startCommandId, handlerGeneration: spec.handlerGeneration, op: "start", input: { commandId: spec.startCommandId, handlerGeneration: spec.handlerGeneration, cwd: spec.checkout.root.path, selection: spec.selection }, target: { agentId: spec.agentId, handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration }, state: "pending", result: null }
}