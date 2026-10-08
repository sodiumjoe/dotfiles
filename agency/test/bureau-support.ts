import { createJournalPool } from "../src/orchestration/journal.js"
import { randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import type { TestContext } from "node:test"
import { createBureauService } from "../src/bureau/service.js"
import type { HostAgent, OrchestrationHost, LaunchAssignment, RootLaunch, LaunchReceipt, Invocation } from "../src/bureau/host.js"
import type { AcpSubmissionRequest, SubmissionReceipt } from "../src/agent/turns.js"
import type { ExecutionRef } from "../src/orchestration/types.js"
import { coreFixture } from "./orchestration-support.js"

export async function bureauFixture(t: TestContext) {
  const f = await coreFixture(t), hostId = f.input.agent.hostId, journals = createJournalPool(f.root, f.filesystem, f.clock.now)
  let generation = randomUUID(), launchCalls = 0, stopCalls = 0, submissionCalls = 0, lostReply = false
  const agents = new Map<string, HostAgent>(), launches = new Map<string, LaunchReceipt>(), submissions = new Map<string, SubmissionReceipt>()
  const invocation: Invocation = { environment: { HOME: f.root, TOKEN: "transient-secret" }, nativeParams: { mcpServers: [] } }
  let defaults = { modeId: "full-access", configValues: { effort: "medium" } }
  const start = async (command: LaunchAssignment | RootLaunch): Promise<LaunchReceipt> => {
    const run = await f.store.readRun(command.runId)
    assert.ok(run, "run publication must precede launch")
    if ("ref" in command) assert.ok(await f.store.readAttempt(command.ref.attemptId), "attempt publication must precede launch")
    if (command.handlerGeneration !== generation) throw new Error("STALE_HANDLER")
    launchCalls++
    const execution: ExecutionRef = { ...command.agent, handlerGeneration: generation, providerGeneration: randomUUID() }
    const settings = "spec" in command && command.retryMode === "restore" ? command.savedSettings! : "spec" in command ? { modelId: command.spec.modelId, ...defaults, ...command.spec.overrides } : { modelId: command.modelId, ...defaults, ...command.overrides }
    const receipt: LaunchReceipt = { commandId: command.commandId, execution, effective: settings, state: "started" }
    launches.set(command.commandId, receipt)
    agents.set(command.agent.agentId, { agent: command.agent, execution, phase: "ready", toolsEnabled: true, lineage: "lineage" in command ? command.lineage : null, membership: { runId: command.runId, bindingEpoch: command.bindingEpoch }, cwd: "spec" in command ? command.spec.cwd : command.cwd, settings })
    if (lostReply) { lostReply = false; throw new Error("lost reply") }
    return receipt
  }
  const host: OrchestrationHost = {
    async snapshot() { return { hostId, handlerGeneration: generation, backendChoices: ["codex-acp"], agents: structuredClone([...agents.values()]), receipts: structuredClone([...launches.values()]), replayFences: [...new Set([...agents.values()].map(agent => agent.membership?.runId).filter((runId): runId is string => !!runId))].map(runId => ({ streamId: runId, runId, throughSeq: 0, checkpoint: 0 })) } },
    launch: start, launchRoot: start,
    async inspectCommand(commandId, expectedGeneration) { const receipt = launches.get(commandId); return receipt?.execution?.handlerGeneration === expectedGeneration ? structuredClone(receipt) : null },
    async submission(target, submissionId) { const receipt = submissions.get(submissionId); return target.handlerGeneration === generation ? structuredClone(receipt ?? null) : null },
    async submit(target, request: AcpSubmissionRequest) {
      if (target.handlerGeneration !== generation) throw new Error("STALE_HANDLER")
      submissionCalls++
      const receipt: SubmissionReceipt = { submissionId: request.submissionId, digest: "a".repeat(64), state: "accepted", stopReason: null, failure: null, acceptedSeq: 1, completedSeq: null }
      submissions.set(request.submissionId, receipt)
      return structuredClone(receipt)
    },
    async stop(commandId, execution) { stopCalls++; agents.get(execution.agentId)!.phase = "stopped"; return { commandId, execution, state: "stopped" } }
  }
  let core = createBureauService({ store: f.store, journals, hosts: [host] })
  await core.initialize(); await core.enable()
  const rootInput = { objective: "Review the local implementation", hostId, cwd: f.root, backendId: "codex-acp" as const, modelId: "model-a", overrides: {} }
  const run = await core.startRun(randomUUID(), rootInput, invocation)
  const assignment = { parent: run.root, description: "Inspect storage", hostId, cwd: f.root, backendId: "codex-acp" as const, modelId: "model-a", overrides: {}, git: null }
  return {
    ...f, input: { ...f.input, runId: run.runId, commandId: randomUUID(), assignment, rootInput, bindingEpoch: run.bindingEpoch }, invocation,
    get core() { return core },
    host: {
      raw: host, agents,
      get launchCalls() { return launchCalls }, get stopCalls() { return stopCalls }, get promptCount() { return submissionCalls },
      defaults(value: typeof defaults) { defaults = value },
      loseReply() { lostReply = true },
      endTurn(submissionId: string) { const receipt = submissions.get(submissionId)!; receipt.state = "completed"; receipt.stopReason = "end_turn"; receipt.completedSeq = 2 },
      retire() { generation = randomUUID(); for (const agent of agents.values()) agent.phase = "recoverable" },
      addRoot(toolsEnabled: boolean) { const agent = { hostId, agentId: randomUUID() }; agents.set(agent.agentId, { agent, execution: { ...agent, handlerGeneration: generation, providerGeneration: randomUUID() }, phase: "ready", toolsEnabled, lineage: null, membership: null, cwd: f.root, settings: { modelId: "model-a" } }); return agent }
    },
    async delegate(commandId = randomUUID(), spec = assignment) { return core.delegate(commandId, run.runId, spec, invocation) },
    snapshot() { return core.inspect(run.runId) },
    async restartBureau() { core = createBureauService({ store: f.store, journals, hosts: [host] }); await core.initialize() }
  }
}