import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { completeAcceptanceCommand, completeAcceptancePrompt, parseCodexAcceptanceReport, runCodexAcceptance, type AcceptanceLifecycle } from "../scripts/accept-codex.js"
import { AGENT_PROTOCOL, type AgentRequest } from "../src/agent/protocol.js"
import { productionLaunchContracts } from "../src/agent/contracts.js"
import { launchEnvironmentDigest } from "../src/agent/environment.js"
import { AgentError } from "../src/agent/types.js"
import { agentHandlerFixture, sampleCommand, sampleSession, sampleSpec } from "./agent-support.js"

async function fixture(t: Parameters<typeof agentHandlerFixture>[0], failure = "") {
  const handler = await agentHandlerFixture(t), environments: Record<string, string>[] = [], steps: string[] = []
  await writeFile(join(handler.workspace, "package.json"), JSON.stringify({ name: "@moon/agency", engines: { node: "24.13.0" } }))
  let snapshots = 0, prompts = 0, stops = 0
  const lifecycle: AcceptanceLifecycle = {
    cwd: () => handler.workspace,
    snapshot: () => { const value = { ...process.env, ACCEPTANCE_SNAPSHOT: String(++snapshots), SECRET_TOKEN: "must-not-appear" } as Record<string, string>; environments.push(value); return value },
    async start(cwd, _environment) { steps.push("start"); return handler.waitCompleted(await handler.startAt(cwd)) },
    async prompt(target, text) { steps.push("prompt"); prompts++; if (failure === `prompt-${prompts}`) throw new Error(failure); return handler.prompt(target, text) },
    async stop(target) { steps.push("stop"); stops++; if (failure === `stop-${stops}`) throw new Error(failure); return handler.waitCompleted(await handler.stop(target)) },
    async restore(agentId, _environment) { steps.push("restore"); if (failure === "restore") throw new Error(failure); return handler.waitCompleted(await handler.restore(agentId)) },
    list: () => handler.list(),
  }
  return { handler, lifecycle, environments, steps }
}

test("production acceptance retries a timed-out mutation through its exact command identity", async () => {
  const spec = sampleSpec(), pending = sampleCommand(), requests: AgentRequest[] = []
  const completed = { ...pending, state: "completed" as const, result: { outcome: "started" as const, target: pending.target, failure: null, session: sampleSession() } }
  const request = { protocol: AGENT_PROTOCOL, requestId: spec.commandId, handlerGeneration: spec.handlerGeneration, op: "agent_start" as const, input: { commandId: spec.commandId, handlerGeneration: spec.handlerGeneration, cwd: spec.cwd, selection: spec.selection, environment: {} } }
  const result = await completeAcceptanceCommand(request, spec.handlerGeneration, async current => {
    requests.push(current)
    if (requests.length === 1) throw new AgentError("INCOMPLETE")
    return { protocol: AGENT_PROTOCOL, requestId: current.requestId, handlerGeneration: spec.handlerGeneration, commandId: spec.commandId, ok: true, result: { state: "command", command: completed, durability: "verified" } }
  }, { now: () => 0, sleep: async () => undefined })
  assert.deepEqual(result.command, completed)
  assert.deepEqual(requests.map(value => value.op), ["agent_start", "agent_command"])
  assert.equal(requests[1]!.op === "agent_command" && requests[1]!.commandId, spec.commandId)
})

test("production acceptance permits the configured prompt deadline across the socket", async () => {
  const spec = sampleSpec(), request = { protocol: AGENT_PROTOCOL, requestId: spec.commandId, handlerGeneration: spec.handlerGeneration, op: "agent_prompt" as const, input: { agentId: spec.agentId, handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration, text: "fixture" } }
  const expected = { state: "prompt" as const, target: { agentId: spec.agentId, handlerGeneration: spec.handlerGeneration, providerGeneration: spec.providerGeneration }, stopReason: "end_turn" as const, text: "answer" }
  const result = await completeAcceptancePrompt(request, async (current, timeoutMs) => {
    if (timeoutMs < 90000) throw new AgentError("INCOMPLETE")
    return { protocol: AGENT_PROTOCOL, requestId: current.requestId, handlerGeneration: spec.handlerGeneration, ok: true, result: expected }
  })
  assert.deepEqual(result, expected)
})

test("diagnostic acceptance uses the ordinary lifecycle without creating authority", async t => {
  const f = await fixture(t), contracts = JSON.stringify(productionLaunchContracts()), config = await readFile(f.handler.configPath)
  const result = await runCodexAcceptance({ evidenceParent: f.handler.root }, f.lifecycle), report = parseCodexAcceptanceReport(result.report)
  assert.equal(report.success, true)
  assert.equal(report.failure, null)
  assert.deepEqual(report.steps, ["start", "prompt", "stop", "restore", "prompt", "stop"])
  assert.deepEqual(f.steps.slice(0, 6), report.steps)
  assert.equal(report.first!.sessionId, report.restored!.sessionId)
  assert.equal(report.first!.agentId, report.restored!.agentId)
  assert.notEqual(report.first!.providerGeneration, report.restored!.providerGeneration)
  assert.equal(f.environments.length, 2)
  assert.equal(report.startEnvironmentDigest, launchEnvironmentDigest(f.environments[0]!))
  assert.equal(report.restoreEnvironmentDigest, launchEnvironmentDigest(f.environments[1]!))
  assert.equal(JSON.stringify(report).includes("must-not-appear"), false)
  assert.equal(report.cleanup.length, 2)
  assert.ok(report.cleanup.every(entry => entry.cleanup === "verified" && entry.processGroupId > 1))
  for (const key of ["candidate", "manifest", "promotion", "registration", "sourceContract", "transientAuthorization"]) assert.equal(Object.hasOwn(report, key), false)
  assert.equal(JSON.stringify(productionLaunchContracts()), contracts)
  assert.deepEqual(await readFile(f.handler.configPath), config)
  assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")), report)
})

test("diagnostic acceptance rejects restored session discontinuity", async t => {
  const f = await fixture(t), restore = f.lifecycle.restore
  f.lifecycle.restore = async (agentId, environment) => {
    const view = structuredClone(await restore(agentId, environment))
    assert.equal(view.command.state, "completed")
    assert.ok(view.command.result?.session)
    view.command.result.session.sessionId = "different-session"
    return view
  }
  const result = await runCodexAcceptance({ evidenceParent: f.handler.root }, f.lifecycle)
  assert.equal(result.report.success, false)
  assert.notEqual(result.report.failure, null)
  assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")), result.report)
})

for (const failure of ["prompt-1", "stop-1", "restore", "prompt-2", "stop-2"])
  test(`diagnostic acceptance retains failure report for ${failure}`, async t => {
    const f = await fixture(t, failure), contracts = JSON.stringify(productionLaunchContracts()), config = await readFile(f.handler.configPath)
    const result = await runCodexAcceptance({ evidenceParent: f.handler.root }, f.lifecycle)
    assert.equal(result.report.success, false)
    assert.notEqual(result.report.failure, null)
    assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")), result.report)
    assert.equal(JSON.stringify(productionLaunchContracts()), contracts)
    assert.deepEqual(await readFile(f.handler.configPath), config)
    for (const key of ["candidate", "manifest", "promotion", "registration", "sourceContract", "transientAuthorization"]) assert.equal(Object.hasOwn(result.report, key), false)
  })