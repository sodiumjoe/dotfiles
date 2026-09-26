import { checkoutIdFor } from "../src/checkout/identity.js"
import { PassThrough } from "node:stream"
import type { TestContext } from "node:test"
import { createAcpConnection } from "../src/agent/acp.js"
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

export function scriptedAcp(t: TestContext, scenario = "exact") {
  const readable = new PassThrough(), writable = new PassThrough(), sent: Array<{ method: string; params: any }> = [], permissionReplies: unknown[] = []
  const options = [
    { id: "model", type: "select", name: "Model", currentValue: "model-a", options: [{ value: "model-a", name: "Model α" }] },
    { id: "reasoning", type: "select", name: "Reasoning", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    { id: "mode", type: "select", name: "Mode", currentValue: "plan", options: [{ value: "plan", name: "Plan" }, { value: "review", name: "Review" }] },
  ]
  const send = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value) + "\n")
    if (scenario === "fragmented") for (const byte of bytes) readable.write(Buffer.from([byte]))
    else readable.write(bytes)
  }
  const connection = createAcpConnection({ readable, writable, limits: sampleSpec().limits })
  writable.on("data", (bytes: Buffer) => {
    for (const line of bytes.toString().trim().split("\n")) {
      const request = JSON.parse(line)
      if (!request.method) { permissionReplies.push(request); continue }
      sent.push(request)
      if (scenario === "hang") continue
      if (scenario === "utf8") { readable.write(Buffer.from([255, 10])); continue }
      if (scenario === "oversized") { readable.write(Buffer.alloc(1048577, 32)); continue }
      if (scenario === "empty-eof") { readable.end(); continue }
      if (scenario === "incomplete-eof") { readable.end("{\"jsonrpc\":"); continue }
      if (scenario === "error" || scenario === "auth") { send({ jsonrpc: "2.0", id: request.id, error: { code: scenario === "auth" ? -32000 : -32603, message: "sensitive remote diagnostic" } }); continue }
      if (scenario === "wrong-id") { send({ jsonrpc: "2.0", id: 999, result: {} }); continue }
      let result: unknown
      if (request.method === "initialize") result = { protocolVersion: scenario === "version" ? 2 : 1, agentCapabilities: {} }
      else if (request.method === "session/new") {
        result = { sessionId: "fixture-session", configOptions: scenario === "missing" ? [] : scenario === "duplicate-option" ? [options[0], options[0]] : options }
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
      send(reply)
      if (scenario === "duplicate-id") send(reply)
    }
  })
  t.after(() => { connection.close(); readable.destroy(); writable.destroy() })
  return { connection, sent, permissionReplies, readable, writable, send, triggerDrift() { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } } }) } }
}