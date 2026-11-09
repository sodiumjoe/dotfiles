import assert from "node:assert/strict"
import test from "node:test"
import { readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import type { AgentReply, AgentRequest } from "../src/agent/protocol.js"
import { isImplicitDisabledCodexFastMode } from "../src/agent/session-config.js"
import { createAgentStore } from "../src/agent/store.js"
import { acpFixture } from "./acp-support.js"
import { agentHandlerFixture } from "./agent-support.js"
import { until } from "./control-support.js"

async function fixtureCli(f: Awaited<ReturnType<typeof agentHandlerFixture>>, args: string[]) {
  const production = productionControlDependencies()
  let output = ""
  const code = await runControl(["agent", ...args, "--json"], {
    ...production, environment: async () => ({ paths: f.paths, adapter: f.adapter }), cwd: () => f.workspace,
    start: async () => { throw new Error("automatic startup forbidden") },
    stdout: value => { output += value }, stderr: () => {},
  })
  return { code, reply: JSON.parse(output) as AgentReply }
}

for (const [model, effort, defaults] of [["model-a", "low", false], ["model-b", "high", true]] as const) test("CLI advertised Codex choices start and restore " + model + "/" + effort, async t => {
  const f = await acpFixture(t, { selectionCatalog: true })
  if (defaults) {
    const path = join(f.paths.persistentRoot, "catalog/backends.json"), backends = JSON.parse(await readFile(path, "utf8"))
    backends.backends[0].initial = { modelId: "model-a[low]", modeId: "agent-full-access", configValues: { model: "model-a", reasoning_effort: "low", mode: "agent-full-access" } }
    await writeFile(path, JSON.stringify(backends), { mode: 0o600 })
  }
  const choices = await fixtureCli(f, ["choices"])
  assert.equal(choices.code, 0)
  assert.ok(choices.reply.ok && choices.reply.result.state === "choices")
  const choice = choices.reply.result.choices.find(value => value.selection.modelId === model && value.selection.reasoning.kind === "value" && value.selection.reasoning.value === effort && value.selection.mode === "read-only")
  assert.ok(choice)
  const selection = choice.selection
  assert.equal(selection.providerId, "codex-acp")
  assert.ok(selection.reasoning.kind === "value" && selection.mode)
  const generation = (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation, commandId = randomUUID()
  const args = ["start", "--provider", selection.providerId, "--model", selection.modelId, "--reasoning", selection.reasoning.value, "--mode", selection.mode, "--permission-profile", selection.permissionProfile, "--command-id", commandId]
  const started = await fixtureCli(f, [...args, "--expected-handler-generation", generation])
  assert.ok(started.reply.ok && started.reply.result.state === "command")
  assert.equal(started.reply.result.command.result?.outcome, "started")
  assert.equal(started.code, 0)
  assert.equal(started.reply.result.durability, "verified")
  const target = started.reply.result.command.target!, store = createAgentStore(f.paths.persistentRoot)
  const record = await store.readAgent(target.agentId)
  assert.ok(record)
  assert.deepEqual(record.settings, { modelId: model + "[" + effort + "]", configValues: { model, reasoning_effort: effort, mode: "read-only" } })
  const setters = (await f.requests("codex-acp")).filter(value => value.method?.startsWith("session/set_"))
  assert.deepEqual(setters.map(value => ({ method: value.method, configId: value.params?.configId, value: value.params?.value })), [
    ...(model === "model-b" ? [{ method: "session/set_config_option", configId: "model", value: "model-b" }] : []),
    { method: "session/set_config_option", configId: "reasoning_effort", value: effort },
    { method: "session/set_config_option", configId: "mode", value: "read-only" },
  ])
  const beforeRetry = await f.requests("codex-acp")
  const retried = await fixtureCli(f, [...args, "--handler-generation", generation])
  assert.equal(retried.code, 0)
  assert.deepEqual(retried.reply, { ...started.reply, requestId: retried.reply.requestId })
  assert.deepEqual(await f.requests("codex-acp"), beforeRetry)
  const stopped = await f.waitCompleted(await f.stop(target))
  assert.equal(stopped.command.result?.outcome, "stopped")
  const restored = await f.waitCompleted(await f.restore(target.agentId))
  assert.equal(restored.command.result?.outcome, "restored")
  assert.equal(restored.command.target?.agentId, target.agentId)
  assert.notEqual(restored.command.target?.providerGeneration, target.providerGeneration)
  assert.deepEqual(restored.command.result?.session, started.reply.result.command.result?.session)
  assert.deepEqual((await store.readAgent(target.agentId))?.settings, record.settings)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/new").length, 1)
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/load").length, 1)
  await f.waitCompleted(await f.stop(restored.command.target!))
  assert.ok((await f.list()).agents.every(value => value.launch?.phase === "cleanup_verified"))
  await f.verifyZeroSurvivors()
})

for (const [model, effort, mode] of [["missing", "high", "read-only"], ["model-a", "missing", "read-only"], ["model-a", "high", "missing"], ["model-c", "high", "read-only"]] as const) test("CLI unsupported Codex settings fail with verified cleanup: " + [model, effort, mode].join("/"), async t => {
  const f = await acpFixture(t, { selectionCatalog: true })
  const generation = (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation
  const failed = await fixtureCli(f, ["start", "--provider", "codex-acp", "--model", model, "--reasoning", effort, "--mode", mode, "--permission-profile", "fixture-deny-v1", "--command-id", randomUUID(), "--expected-handler-generation", generation])
  assert.equal(failed.code, 75)
  assert.ok(failed.reply.ok && failed.reply.result.state === "command")
  assert.equal(failed.reply.result.command.result?.outcome, "failed")
  assert.equal(failed.reply.result.command.result?.failure?.code, "SELECTION_UNSUPPORTED")
  assert.equal(failed.reply.result.durability, "verified")
  assert.equal((await f.list()).agents[0]?.launch?.phase, "cleanup_verified")
  if (model === "model-c") assert.deepEqual((await f.requests("codex-acp")).filter(value => value.method?.startsWith("session/set_")).map(value => value.params), [{ sessionId: "native-session", configId: "model", value: "model-c" }])
  await f.verifyZeroSurvivors()
})

test("legacy-only native selection remains available through Claude CLI Start", async t => {
  const f = await acpFixture(t)
  const generation = (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation
  const started = await fixtureCli(f, ["start", "--provider", "claude-agent-acp", "--model", "legacy-b", "--reasoning", "none", "--mode", "review", "--permission-profile", "fixture-deny-v1", "--command-id", randomUUID(), "--expected-handler-generation", generation])
  assert.equal(started.code, 0)
  assert.ok(started.reply.ok && started.reply.result.state === "command")
  assert.equal(started.reply.result.command.result?.outcome, "started")
  const target = started.reply.result.command.target!
  assert.deepEqual((await createAgentStore(f.paths.persistentRoot).readAgent(target.agentId))?.settings, { modelId: "legacy-b", modeId: "review" })
  assert.deepEqual((await f.requests("claude-agent-acp")).filter(value => value.method?.startsWith("session/set_")).map(value => ({ method: value.method, params: value.params })), [
    { method: "session/set_model", params: { sessionId: "native-session", modelId: "legacy-b" } },
    { method: "session/set_mode", params: { sessionId: "native-session", modeId: "review" } },
  ])
  await f.waitCompleted(await f.stop(target)); await f.verifyZeroSurvivors()
})

test("legacy-only native selection preserves explicit combined Codex model IDs", async t => {
  const f = await acpFixture(t, { selectionCatalog: true }), peer = await f.connect()
  await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const created = await peer.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, commandId: randomUUID(), backendId: "codex-acp", selection: { modelId: "model-a[high]", modeId: "read-only" } } } })
  assert.deepEqual((await createAgentStore(f.paths.persistentRoot).readAgent(String(created.sessionId).slice(7)))?.settings, { modelId: "model-a[high]", configValues: { model: "model-a", reasoning_effort: "high", mode: "read-only" } })
  assert.ok((await f.requests("codex-acp")).some(value => value.method === "session/set_model" && value.params?.modelId === "model-a[high]"))
  await f.stopSession(String(created.sessionId)); peer.close(); await f.verifyZeroSurvivors()
})

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