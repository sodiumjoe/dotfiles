import assert from "node:assert/strict"
import test from "node:test"
import { readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import type { AgentRequest } from "../src/agent/protocol.js"
import { isImplicitDisabledCodexFastMode } from "../src/agent/session-config.js"
import { createAgentStore } from "../src/agent/store.js"
import { acpFixture } from "./acp-support.js"
import { agentHandlerFixture } from "./agent-support.js"
import { until } from "./control-support.js"

for (const scenario of ["normal", "large-replay"] as const) test("returned text prompt uses native ACP with bounded output: " + scenario, async t => {
  const f = await agentHandlerFixture(t, { providerScenario: scenario })
  const ready = await f.waitCompleted(await f.start()), target = ready.command.target!
  const result = await f.prompt(target, "hello 🙂")
  assert.equal(result.text, scenario === "normal" ? "answer:hello 🙂" : "a".repeat(4096))
  const requests = (await f.providerRequests()).filter(value => value.method === "session/prompt")
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]!.params, { sessionId: "fixture-session", prompt: [{ type: "text", text: "hello 🙂" }] })
  await f.waitCompleted(await f.stop(target)); await f.verifyZeroSurvivors()
})

for (const stage of ["start-intent", "start-receipt", "stop-cleanup"] as const) test("CLI explicitly retries saved commands after " + stage + " failure", async t => {
  const f = await agentHandlerFixture(t, { failOnceAt: stage })
  for (const [key, value] of Object.entries({ FIXTURE_ROOT: f.root, FIXTURE_SCENARIO: "normal" })) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  const production = productionControlDependencies(), generation = (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation
  const requests: AgentRequest["op"][] = []
  const invoke = async (args: string[]) => {
    let output = ""
    requests.length = 0
    const code = await runControl(["agent", ...args, "--json"], {
      ...production, environment: async () => ({ paths: f.paths, adapter: f.adapter }), cwd: () => f.workspace,
      start: async () => { throw new Error("automatic startup forbidden") }, now: () => performance.now() * 5,
      callAgent: async (env, request, timeout) => { requests.push(request.op); return production.callAgent!(env, request, timeout) },
      stdout: value => { output += value }, stderr: () => {},
    })
    return { code, reply: JSON.parse(output) }
  }
  const commandId = randomUUID(), selection = ["--provider", "codex-acp", "--model", "model-a", "--reasoning", "high", "--mode", "review", "--permission-profile", "fixture-deny-v1"]
  const startArgs = ["start", ...selection, "--command-id", commandId, "--expected-handler-generation", generation]
  const initial = await invoke(startArgs)
  assert.equal(initial.code, stage === "stop-cleanup" ? 0 : 75)
  const start = (await f.inventory()).commands.find(value => value.commandId === commandId)!
  const stopId = randomUUID()
  const args = stage === "stop-cleanup" ? ["stop", start.target!.agentId, "--provider-generation", start.target!.providerGeneration, "--command-id", stopId, "--handler-generation", generation] : ["start", ...selection, "--command-id", commandId, "--handler-generation", generation]
  if (stage === "stop-cleanup") assert.equal((await invoke(args)).code, 75)
  const events = async (): Promise<string[]> => (await readFile(join(f.root, "mutations.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  await until(async () => (await events()).includes("failed:" + stage) ? true : undefined)
  const retried = await invoke(args)
  assert.equal(retried.code, 0)
  assert.equal(retried.reply.result.command.result.outcome, stage === "stop-cleanup" ? "stopped" : "started")
  assert.equal(retried.reply.result.durability, "verified")
  assert.equal(requests[0], "agent_command")
  assert.equal(requests[1], stage === "stop-cleanup" ? "agent_stop" : "agent_start")
  assert.ok(requests.slice(2).every(op => op === "agent_command"))
  assert.equal((await events()).filter(event => event === "process").length, 1)
  const before = await events()
  assert.equal((await invoke(args)).code, 0)
  assert.deepEqual(requests, ["agent_command"])
  assert.deepEqual(await events(), before)
  if (stage !== "stop-cleanup") await f.waitCompleted(await f.stop(retried.reply.result.command.target))
  await f.verifyZeroSurvivors()
})

for (const stage of ["start-intent", "start-receipt", "stop-cleanup"] as const) test("command inspection is observational after " + stage + " failure", async t => {
  const f = await agentHandlerFixture(t, { failOnceAt: stage })
  const events = async (): Promise<string[]> => (await readFile(join(f.root, "mutations.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  let value
  if (stage === "start-intent") {
    await assert.rejects(f.start(), { code: "INCOMPLETE" })
    value = (await f.inventory()).commands.find(command => command.op === "start")!
  } else {
    const start = await f.start()
    if (stage === "start-receipt") value = start.command
    else {
      const ready = await f.waitCompleted(start)
      value = (await f.stop(ready.command.target!)).command
    }
  }
  await until(async () => (await events()).includes("failed:" + stage) ? true : undefined)
  const before = await events()
  const observed = await f.receipt(value.commandId, value.handlerGeneration)
  assert.ok(observed)
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(await f.command(value.commandId, value.handlerGeneration), observed)
    assert.deepEqual(await f.receipt(value.commandId, value.handlerGeneration), observed)
  }
  assert.deepEqual(await events(), before)
  assert.equal(observed.durability, stage === "stop-cleanup" ? "verified" : "unverified")
  assert.equal(observed.command.state, stage === "start-receipt" ? "completed" : "pending")
  const missing = randomUUID()
  assert.equal(await f.receipt(missing, value.handlerGeneration), null)
  await assert.rejects(f.command(missing, value.handlerGeneration), { code: "UNAVAILABLE" })
  await assert.rejects(f.receipt(value.commandId, randomUUID()), { code: "COMMAND_CONFLICT" })
  await assert.rejects(f.command(value.commandId, randomUUID()), { code: "COMMAND_CONFLICT" })
  await f.retryOperation(value)
  const completed = await f.waitCompleted(observed)
  assert.equal(completed.durability, "verified")
  assert.equal(completed.command.result?.outcome, stage === "stop-cleanup" ? "stopped" : "started")
  if (stage !== "stop-cleanup") {
    assert.equal((await events()).filter(event => event === "process").length, 1)
    await f.waitCompleted(await f.stop(completed.command.target!))
  }
  await f.verifyZeroSurvivors()
})

test("Handler editor queries preserve active directory scope and historical stop receipts", async t => {
  const f = await agentHandlerFixture(t)
  const choices = await f.choices()
  assert.ok(choices.choices.length > 0)
  assert.equal(choices.choices[0]!.selection.permissionProfile, "fixture-deny-v1")
  const ready = await f.waitCompleted(await f.start())
  const page = await f.page({ limit: 100, cwd: f.workspace, activeOnly: true })
  assert.equal(page.agents.length, 1)
  assert.equal(page.agents[0]!.record.phase, "ready")
  assert.deepEqual((await f.page({ limit: 100, cwd: f.otherWorkspace, activeOnly: true })).agents, [])
  const stopped = await f.waitCompleted(await f.stop(ready.command.target!))
  assert.equal(stopped.command.result?.outcome, "stopped")
  assert.equal((await f.list()).agents[0]!.launch?.phase, "cleanup_verified")
  assert.deepEqual((await f.page({ limit: 100, activeOnly: true })).agents, [])
  const restored = await f.waitCompleted(await f.restore(ready.command.target!.agentId))
  assert.notEqual(restored.command.target!.providerGeneration, ready.command.target!.providerGeneration)
  const historical = await f.command(stopped.command.commandId, stopped.command.handlerGeneration)
  assert.deepEqual(historical.command.target, ready.command.target)
  assert.equal(historical.command.result?.outcome, "stopped")
  await f.waitCompleted(await f.stop(restored.command.target!))
  await f.verifyZeroSurvivors()
})

test("Restore preserves native identity when disabled Codex fast mode disappears", async t => {
  const f = await agentHandlerFixture(t, { providerScenario: "restore-fast-mode" })
  await writeFile(join(f.root, "fast-mode.json"), JSON.stringify({ savedValue: "off" }), { mode: 0o600 })
  const ready = await f.waitCompleted(await f.start())
  assert.equal(ready.command.result?.outcome, "started")
  assert.equal((await f.current()).agents[0]!.record.settings.configValues?.["fast-mode"], "off")
  await f.waitCompleted(await f.stop(ready.command.target!))
  const restored = await f.waitCompleted(await f.restore(ready.command.target!.agentId))
  assert.equal(restored.command.result?.outcome, "restored")
  assert.equal(restored.command.target!.agentId, ready.command.target!.agentId)
  assert.notEqual(restored.command.target!.providerGeneration, ready.command.target!.providerGeneration)
  assert.equal(restored.command.result?.session?.sessionId, ready.command.result?.session?.sessionId)
  assert.equal((await f.current()).agents[0]!.record.settings.configValues?.["fast-mode"], undefined)
  await f.waitCompleted(await f.stop(restored.command.target!))
  assert.ok((await f.list()).agents.every(agent => agent.launch?.phase === "cleanup_verified"))
  await f.verifyZeroSurvivors()
})

for (const [name, fast, outcome] of [
  ["boolean disabled fast mode", { savedValue: false }, "restored"],
  ["enabled fast mode", { savedValue: "on" }, "failed"],
  ["missing permission mode", { savedValue: "off", drop: ["mode"] }, "failed"],
  ["missing model", { savedValue: "off", drop: ["model"] }, "failed"],
  ["missing effort", { savedValue: "off", drop: ["reasoning"] }, "failed"],
  ["unknown loaded configuration", { savedValue: "off", omitConfiguration: true }, "failed"],
  ["still exposed native fast mode", { savedValue: "off", loadedValue: "on" }, "restored"],
] as const) test("Restore handles " + name + " without discarding required settings", async t => {
  const f = await agentHandlerFixture(t, { providerScenario: "restore-fast-mode" })
  await writeFile(join(f.root, "fast-mode.json"), JSON.stringify(fast), { mode: 0o600 })
  const ready = await f.waitCompleted(await f.start())
  assert.equal(ready.command.result?.outcome, "started")
  await f.waitCompleted(await f.stop(ready.command.target!))
  const restored = await f.waitCompleted(await f.restore(ready.command.target!.agentId))
  assert.equal(restored.command.result?.outcome, outcome)
  if (outcome === "failed") assert.equal(restored.command.result?.failure?.code, "SESSION_INPUT_REQUIRED")
  else {
    assert.equal(restored.command.result?.session?.sessionId, ready.command.result?.session?.sessionId)
    const settings = (await f.current()).agents[0]!.record.settings
    assert.equal(settings.configValues?.["fast-mode"], "loadedValue" in fast ? fast.loadedValue : undefined)
    await f.waitCompleted(await f.stop(restored.command.target!))
  }
  assert.ok((await f.list()).agents.every(agent => agent.launch?.phase === "cleanup_verified"))
  await f.verifyZeroSurvivors()
})

test("disabled-fast omission requires known Codex absence and no unresolved setting obligation", () => {
  const empty = new Set<string>(), blocked = new Set(["fast-mode"])
  const result = { configOptions: [] }
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", "off", result, empty, empty), true)
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", false, result, empty, empty), true)
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", "off", result, blocked, empty), false)
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", "off", result, empty, blocked), false)
  assert.equal(isImplicitDisabledCodexFastMode("claude-agent-acp", "fast-mode", "off", result, empty, empty), false)
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", "off", {}, empty, empty), false)
  assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", "off", { configOptions: [{ id: "fast-mode", type: "unknown" }] }, empty, empty), false)
  for (const value of ["on", true, undefined]) assert.equal(isImplicitDisabledCodexFastMode("codex-acp", "fast-mode", value, result, empty, empty), false)
  for (const key of ["model", "mode", "reasoning_effort", "another-option"]) assert.equal(isImplicitDisabledCodexFastMode("codex-acp", key, "off", result, empty, empty), false)
})

for (const stage of ["cleanup-publication", "terminal-publication", "stop-publication", "stop-cleanup"] as const) test("discharged streams release before failed " + stage, async t => {
  const f = await acpFixture(t, { failOnceAt: stage, witness: true }), c = await f.connect()
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [] }), target = await f.tuple(String(session.sessionId))
  const launchId = (await createAgentStore(f.paths.persistentRoot).readAgent(target.agentId))!.launch!.launchAttemptId
  const identity = (await f.inventory()).launches.find(entry => entry.record.launchAttemptId === launchId)!.record.provider!.group.leader
  const stop = await f.stop(target)
  const events = async (): Promise<string[]> => (await readFile(join(f.root, "mutations.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  await until(async () => (await events()).includes("failed:" + stage) ? true : undefined)
  const pending = await f.command(stop.command.commandId, stop.command.handlerGeneration)
  assert.equal(pending.command.state, "pending")
  const before = await events()
  assert.equal(before.includes("conversation-closed"), stage !== "stop-cleanup")
  if (stage !== "stop-cleanup") {
    assert.equal(await f.observe(identity.pid), null)
    assert.deepEqual(await f.adapter.readGroup(identity.processGroupId), [])
  }
  for (let n = 0; n < 3; n++) assert.deepEqual(await f.command(stop.command.commandId, stop.command.handlerGeneration), pending)
  assert.deepEqual(await events(), before)
  await f.retryOperation(stop.command)
  assert.equal((await f.waitCompleted(stop)).command.result?.outcome, "stopped")
  const after = await events()
  assert.equal(after.filter(event => event === "conversation-closed").length, 1)
  if (stage !== "stop-cleanup") assert.deepEqual(after.filter(event => event.startsWith("signal:")), before.filter(event => event.startsWith("signal:")))
  c.close(); await f.verifyZeroSurvivors()
})

for (const stage of ["cleanup-publication", "stop-receipt-before"] as const) test("discharged streams release during paused " + stage, async t => {
  const f = await acpFixture(t, { pauseAt: stage, witness: true }), c = await f.connect()
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [] }), target = await f.tuple(String(session.sessionId))
  const stop = await f.stop(target)
  await f.waitBarrier()
  const events = (await readFile(join(f.root, "mutations.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  assert.ok(events.includes("conversation-closed"))
  const receipt = await createAgentStore(f.paths.persistentRoot).readCommand(stop.command.commandId)
  assert.equal(receipt?.state, "pending")
  const provider = (await f.inventory()).launches.find(entry => entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === target.agentId)!.record.provider!.group.leader
  assert.equal(await f.observe(provider.pid), null)
  assert.deepEqual(await f.adapter.readGroup(provider.processGroupId), [])
  await f.releaseBarrier()
  assert.equal((await f.waitCompleted(stop)).command.result?.outcome, "stopped")
  c.close(); await f.verifyZeroSurvivors()
})