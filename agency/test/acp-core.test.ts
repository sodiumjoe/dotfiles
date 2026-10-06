import assert from "node:assert/strict"
import test from "node:test"
import { withNativeSession } from "../src/agent/acp.js"
import { normalizeAgentRecord } from "../src/agent/types.js"
import { sampleAgent, sampleContract, scriptedAcp, agentServiceFixture } from "./agent-support.js"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createConversation } from "../src/agent/conversation.js"
import { createTurnCoordinator } from "../src/agent/turns.js"
import { tupleOfRecord } from "../src/agent/types.js"

test("structured admission hashes content and provider metadata while retaining native results past display eviction", async () => {
  const target = tupleOfRecord(normalizeAgentRecord(sampleAgent()))!, conversation = createConversation(target, { events: 1 })
  const answer = Promise.withResolvers<any>(), observed: unknown[] = []
  const turns = createTurnCoordinator({ target, conversation, validate: async () => {}, cancel: async () => {}, invokeAcp: async params => { observed.push(params); return answer.promise } })
  const request = { submissionId: randomUUID(), prompt: [{ type: "image", data: "fixture", mimeType: "image/png" }, { type: "text", text: "question" }], meta: { extension: "kept", agency: { version: 1 } } }
  await turns.submitAcp(request)
  await turns.submitAcp({ ...request, meta: { agency: { version: 1, origin: "other" }, extension: "kept" } })
  await assert.rejects(turns.submitAcp({ ...request, meta: { extension: "changed" } }), { code: "COMMAND_CONFLICT" })
  await assert.rejects(turns.submitAcp({ ...request, submissionId: randomUUID() }), { code: "BUSY" })
  const settled = turns.settledAcp(request.submissionId)
  answer.resolve({ stopReason: "end_turn", _meta: { provider: "preserved" } })
  assert.deepEqual(await settled, { stopReason: "end_turn", _meta: { provider: "preserved" } })
  assert.deepEqual(await turns.settledAcp(request.submissionId), { stopReason: "end_turn", _meta: { provider: "preserved" } })
  assert.deepEqual(observed, [{ prompt: request.prompt, _meta: { extension: "kept" } }])
  turns.close(null); conversation.close()
})

test("routing clones structured content and strips only Agency metadata", () => {
  const input = { sessionId: "agency:logical", prompt: [{ type: "text", text: "question" }, { type: "resource_link", uri: "file:///context", name: "context" }], _meta: { agency: { version: 1 }, fixture: "preserved" } }
  assert.deepEqual(withNativeSession(input, "native-session"), { ...input, sessionId: "native-session", _meta: { fixture: "preserved" } })
  assert.ok(input._meta.agency)
})

test("structured provider requests retain transient MCP and non-Agency metadata", async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) { send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } }) } })
  const record = normalizeAgentRecord(sampleAgent()), signal = new AbortController().signal
  const mcpServers = [{ name: "context", type: "http", url: "https://fixture", headers: [{ name: "Authorization", value: "transient-secret" }] }]
  await peer.connection.initialize(record, sampleContract(), { kind: "new", params: { cwd: record.definition.cwd, mcpServers, _meta: { fixture: "preserved", agency: { version: 1 } } } }, signal)
  const prompt = [{ type: "text", text: "question" }, { type: "resource_link", uri: "file:///context", name: "context" }]
  assert.equal((await peer.connection.request("session/prompt", { sessionId: "fixture-session", prompt, _meta: { fixture: "prompt" } }, signal)).stopReason, "end_turn")
  assert.deepEqual(peer.sent.find(frame => frame.method === "session/new")?.params?.mcpServers, mcpServers)
  assert.deepEqual(peer.sent.find(frame => frame.method === "session/new")?.params?._meta, { fixture: "preserved" })
  assert.deepEqual(peer.sent.find(frame => frame.method === "session/prompt")?.params?.prompt, prompt)
})

test("provider update envelope metadata survives observation and retained replay", async t => {
  const target = tupleOfRecord(normalizeAgentRecord(sampleAgent()))!, conversation = createConversation(target)
  const peer = scriptedAcp(t, "exact", { onUpdate(event) { conversation.append({ kind: "update", ...event }) } })
  await peer.connection.initialize(normalizeAgentRecord(sampleAgent()), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" }, _meta: { content: "preserved" } }
  peer.send({ jsonrpc: "2.0", method: "session/update", _meta: { envelope: "preserved" }, params: { sessionId: "fixture-session", update, _meta: { provider: "preserved" }, extension: { value: 1 } } })
  const observed = conversation.observe(() => {})
  const { encodedBytes, ...event } = observed.snapshot.events[0]!
  assert.ok(encodedBytes > 0)
  assert.deepEqual(event, { kind: "update", update, replay: false, params: { _meta: { provider: "preserved" }, extension: { value: 1 } }, meta: { envelope: "preserved" }, seq: 1 })
  observed.close(); conversation.close()
})

for (const scenario of ["selected", "unadvertised-mode", "clamped-model"] as const) test("initial legacy selection is authoritative: " + scenario, async t => {
  const peer = scriptedAcp(t), requests: any[] = []
  peer.writable.removeAllListeners("data")
  const models = { currentModelId: "model-a", availableModels: [{ modelId: "model-a", name: "A" }, { modelId: "model-b", name: "B" }] }
  const modes = { currentModeId: "review", availableModes: [{ id: "review", name: "Review" }, { id: "agent-full-access", name: "Full" }] }
  peer.writable.on("data", bytes => {
    const request = JSON.parse(bytes.toString()); requests.push(request)
    let result: Record<string, unknown> = {}
    if (request.method === "initialize") result = { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    if (request.method === "session/new") result = { sessionId: "fixture-session", models, modes }
    if (request.method === "session/set_mode" && scenario === "clamped-model") result = { models }
    peer.send({ jsonrpc: "2.0", id: request.id, result })
  })
  const record = normalizeAgentRecord(sampleAgent())
  const pending = peer.connection.initialize({ ...record, settings: { modelId: "model-b", modeId: scenario === "unadvertised-mode" ? "missing" : "agent-full-access" } }, sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  if (scenario === "selected") {
    const session = await pending
    assert.equal(session.configuration.models?.currentModelId, "model-b")
    assert.equal(session.configuration.modes?.currentModeId, "agent-full-access")
  } else await assert.rejects(pending, { code: "SELECTION_UNSUPPORTED" })
  if (scenario === "unadvertised-mode") assert.equal(requests.some(request => request.method.startsWith("session/set_")), false)
})

test("legacy setters update the authoritative snapshot from empty acknowledgments", async t => {
  const peer = scriptedAcp(t, "exact", { response(request, reply) {
    if (request.method === "session/new") reply.result = { sessionId: "fixture-session", models: { currentModelId: "model-a", availableModels: [{ modelId: "model-a", name: "A" }, { modelId: "model-b", name: "B" }] }, modes: { currentModeId: "review", availableModes: [{ id: "review", name: "Review" }, { id: "agent-full-access", name: "Full access" }] } }
    return reply
  } })
  const record = normalizeAgentRecord(sampleAgent())
  await peer.connection.initialize({ ...record, settings: {} }, sampleContract(), { kind: "new", params: { cwd: record.definition.cwd, mcpServers: [] } }, new AbortController().signal)
  peer.writable.removeAllListeners("data")
  peer.writable.on("data", bytes => { const request = JSON.parse(bytes.toString()); peer.send({ jsonrpc: "2.0", id: request.id, result: {} }) })
  await peer.connection.request("session/set_model", { sessionId: "fixture-session", modelId: "model-b" })
  await peer.connection.request("session/set_mode", { sessionId: "fixture-session", modeId: "agent-full-access" })
  assert.equal(peer.connection.snapshot().models?.currentModelId, "model-b")
  assert.equal(peer.connection.snapshot().modes?.currentModeId, "agent-full-access")
})

test("all initial settings must be advertised before any setter is dispatched", async t => {
  const peer = scriptedAcp(t, "exact", { response(request, reply) {
    if (request.method === "session/new") reply.result.configOptions = reply.result.configOptions.filter((option: { id: string }) => option.id !== "model")
    return reply
  } })
  await assert.rejects(peer.connection.initialize(normalizeAgentRecord(sampleAgent()), sampleContract(), { kind: "new", params: {} }, new AbortController().signal), { code: "SELECTION_UNSUPPORTED" })
  assert.equal(peer.sent.some(request => request.method.startsWith("session/set_")), false)
})

for (const update of [
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer", annotations: { audience: ["invalid"] } } },
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer", annotations: { priority: "high" } } },
  { sessionUpdate: "tool_call_update", toolCallId: "tool", title: 12 },
  { sessionUpdate: "session_info_update", title: false },
  { sessionUpdate: "session_info_update", updatedAt: "not-a-date" },
  { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: -1, currency: "USD" } },
  { sessionUpdate: "available_commands_update", availableCommands: [{ name: "run", description: "Run", input: { hint: false } }] },
]) test("essential native update fields reject malformed values: " + JSON.stringify(update), async t => {
  const peer = scriptedAcp(t, "exact", { prompt(request, send) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update } })
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  } })
  await peer.connection.initialize(normalizeAgentRecord(sampleAgent()), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  await assert.rejects(peer.connection.request("session/prompt", { sessionId: "fixture-session", prompt: [{ type: "text", text: "question" }] }), { code: "INVALID_PROTOCOL" })
})

test("initial selection must be advertised and acknowledged without substitution", async t => {
  for (const scenario of ["unadvertised", "substituted"]) {
    const peer = scriptedAcp(t, "exact", { response(request, reply) {
      if (request.method === "session/new" && scenario === "substituted") reply.result.configOptions[0].options.push({ value: "model-b", name: "B" })
      if (request.method === "session/set_config_option") reply.result.configOptions[0].currentValue = "model-a"
      return reply
    } })
    const record = normalizeAgentRecord(sampleAgent())
    await assert.rejects(peer.connection.initialize({ ...record, settings: { modelId: "model-b" } }, sampleContract(), { kind: "new", params: {} }, new AbortController().signal))
  }
})

test("native turns and permission deliberation remain pending beyond ninety seconds", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let prompt: any
  const permissions: any[] = []
  const peer = scriptedAcp(t, "exact", { onRequest: request => permissions.push(request), prompt(request, send) {
    prompt = request
    send({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId: "fixture-session", toolCall: { toolCallId: "tool", title: "Run" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } })
  } })
  const record = normalizeAgentRecord(sampleAgent())
  await peer.connection.initialize(record, sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  let settled = false
  const turn = peer.connection.request("session/prompt", { sessionId: "fixture-session", prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "question" }] }).finally(() => { settled = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  t.mock.timers.tick(100000)
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(permissions.length, 1)
  assert.deepEqual(peer.permissionReplies, [])
  peer.connection.respond("permission-1", { outcome: { outcome: "selected", optionId: "allow" } })
  peer.send({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } })
  assert.equal((await turn).stopReason, "end_turn")
  await new Promise<void>(resolve => setImmediate(resolve))
  peer.connection.close()
  t.mock.timers.reset()
})

for (const update of [{ sessionUpdate: "agent_message_chunk", content: { type: "text" } }, { sessionUpdate: "tool_call", toolCallId: [] }, { sessionUpdate: "plan", entries: [{ content: "step", priority: {}, status: "pending" }] }, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer", _meta: [] } }]) test("malformed known provider update fails before observation: " + JSON.stringify(update), async t => {
  const seen: any[] = []
  const peer = scriptedAcp(t, "exact", { onUpdate: event => seen.push(event), prompt(_request, send) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update } }) } })
  await peer.connection.initialize(normalizeAgentRecord(sampleAgent()), sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  await assert.rejects(peer.connection.request("session/prompt", { sessionId: "fixture-session", prompt: [{ type: "text", text: "question" }] }), { code: "INVALID_PROTOCOL" })
  assert.deepEqual(seen, [])
})

test("each cancelled turn arms its own cooperative cancellation bound", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let turn = 0, held: any
  const peer = scriptedAcp(t, "exact", { prompt(request) { held = request }, notification(request, send) {
    if (request.method === "session/cancel" && turn++ === 0) send({ jsonrpc: "2.0", id: held.id, result: { stopReason: "cancelled" } })
  } })
  const record = normalizeAgentRecord(sampleAgent())
  await peer.connection.initialize(record, sampleContract(), { kind: "new", params: {} }, new AbortController().signal)
  const first = peer.connection.request("session/prompt", { sessionId: "fixture-session", prompt: [{ type: "text", text: "first" }] })
  await peer.connection.cancelPrompt(); await first
  const second = peer.connection.request("session/prompt", { sessionId: "fixture-session", prompt: [{ type: "text", text: "second" }] })
  const failure = assert.rejects(second, { code: "STARTUP_TIMEOUT" })
  await peer.connection.cancelPrompt()
  t.mock.timers.tick(5001)
  await failure
})

test("ordinary native creation needs no fresh catalog and persists MCP names but no credentials", async t => {
  const f = await agentServiceFixture(t)
  await writeFile(join(f.root, "catalog/backends.json"), JSON.stringify({ version: 1, defaultBackendId: "codex-acp", backends: [{ id: "codex-acp", args: [], environmentDefaults: {}, initial: {}, compatibilityId: "fixture-v1" }] }), { mode: 0o600 })
  await f.changeCatalog("stale")
  const nativeParams = { cwd: f.workspace, mcpServers: [{ name: "context", type: "http", url: "https://fixture", headers: [{ name: "Authorization", value: "transient-secret" }] }], _meta: { fixture: "kept" } }
  const record = await f.service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: { NVIM: "/fixture-editor" }, nativeParams })
  assert.equal(record.version, 3)
  assert.equal(record.phase, "ready")
  assert.deepEqual(record.inputRequirements, { mcpServerNames: ["context"] })
  assert.equal((await readFile(join(f.root, "agents/records", record.definition.agentId + ".json"), "utf8")).includes("transient-secret"), false)
  assert.equal(f.catalogReads(), 0)
  const target = tupleOfRecord(record)!
  const submissionId = randomUUID()
  await f.service.submitAcp(target, { submissionId, prompt: [{ type: "text", text: "native question" }, { type: "resource_link", uri: "file:///fixture", name: "context" }], meta: { fixture: "prompt" } })
  assert.equal((await f.service.settledAcp(target, submissionId)).stopReason, "end_turn")
  const stop = { ...target, commandId: randomUUID() }
  await f.service.stop(stop)
  await f.service.stop(stop)
})

test("rejected initial configuration persists only its identity digest", async t => {
  const f = await agentServiceFixture(t), commandId = randomUUID()
  await assert.rejects(f.service.createSession({ commandId, cwd: f.workspace, environment: {},
    selection: { configValues: { credential: "transient-secret" } }, nativeParams: { cwd: f.workspace, mcpServers: [] } }), { code: "SELECTION_UNSUPPORTED" })
  const inventory = await f.store.inventory(), command = inventory.commands.find(value => value.commandId === commandId)
  assert.ok(command?.version === 3 && command.op === "start")
  assert.equal(typeof command.input.selectionDigest, "string")
  assert.equal(Object.hasOwn(command.input, "selection"), false)
  assert.equal(JSON.stringify(inventory).includes("transient-secret"), false)
})

test("restore requires fresh complete MCP descriptors before native dispatch", async t => {
  const f = await agentServiceFixture(t)
  const descriptors = [{ type: "http", name: "context", url: "https://fixture", headers: [{ name: "Authorization", value: "first-secret" }] }]
  const record = await f.service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: { mcpServers: descriptors } }), target = tupleOfRecord(record)!
  const stop = await f.service.stop({ ...target, commandId: randomUUID() })
  const { until } = await import("./control-support.js")
  await until(async () => (await f.service.command(stop.command.commandId, target.handlerGeneration)).command.state === "completed" ? true : undefined)
  const restore = { commandId: randomUUID(), handlerGeneration: target.handlerGeneration, agentId: target.agentId, environment: {} }
  for (const mcpServers of [[], [{ name: "context" }], [{ name: "context", type: "http", url: 1, headers: [] }]]) {
    await assert.rejects(f.service.restore({ ...restore, nativeParams: { mcpServers } }), { code: "SESSION_INPUT_REQUIRED" })
    assert.equal(f.spawns(), 1)
  }
  await f.service.restore({ ...restore, nativeParams: { mcpServers: [{ ...descriptors[0]!, headers: [{ name: "Authorization", value: "fresh-secret" }] }] } })
  await until(async () => (await f.service.command(restore.commandId, target.handlerGeneration)).command.state === "completed" ? true : undefined)
  assert.equal((await f.store.readAgent(target.agentId))!.phase, "ready")
  assert.equal(f.spawns(), 2)
  assert.equal(JSON.stringify(await f.store.inventory()).includes("secret"), false)
})

test("successful native setters publish public settings and receipts before returning", async t => {
  const f = await agentServiceFixture(t), record = await f.service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: { cwd: f.workspace, mcpServers: [] } }), target = tupleOfRecord(record)!
  await f.service.setSession(target, "session/set_config_option", { configId: "reasoning", value: "high", _meta: { fixture: "preserved" } })
  const stored = (await f.store.readAgent(target.agentId))!
  assert.equal(stored.settings.configValues?.reasoning, "high")
  assert.equal(stored.configurationState.verification.kind, "verified")
  const commands = (await f.store.inventory()).commands.filter(command => command.op === "configure")
  assert.equal(commands.length, 1)
  assert.equal(commands[0]!.state, "completed")
  assert.equal(commands[0]!.result?.outcome, "configured")
  assert.equal(JSON.stringify(commands).includes("preserved"), false)
  const listed = (await f.service.list()).agents[0]!
  assert.equal("unavailable" in listed ? listed.unavailable : undefined, null)
})

test("provider configuration changes publish public values independently of display history", async t => {
  const f = await agentServiceFixture(t)
  const record = await f.service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: {} }), target = tupleOfRecord(record)!
  const snapshot = await f.service.sessionSnapshot(target)
  snapshot.configOptions.find(option => option.id === "reasoning")!.currentValue = "high"
  snapshot.configOptions.push({ id: "credential", type: "text", name: "Credential", currentValue: "transient-secret" })
  f.updateConfiguration(target.agentId, snapshot.configOptions)
  await f.context.mutations.queue.run(async () => {})
  const stored = (await f.store.readAgent(target.agentId))!
  assert.equal(stored.settings.configValues?.reasoning, "high")
  assert.deepEqual(stored.configurationState, { verification: { kind: "verified" }, nonRestorableOptionIds: ["credential"] })
  assert.equal(JSON.stringify(await f.store.inventory()).includes("transient-secret"), false)
})

for (const boundary of ["unknown-marker", "settings"] as const) test("uncertain provider configuration at " + boundary + " reconciles native state on explicit restore", async t => {
  const f = await agentServiceFixture(t)
  const record = await f.service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: {} }), target = tupleOfRecord(record)!
  const writeAgent = f.store.writeAgent.bind(f.store)
  f.store.writeAgent = async (next, expected) => {
    if (next.version === 3 && (boundary === "unknown-marker" ? next.configurationState.verification.kind === "unknown" : next.settings.configValues?.reasoning === "high")) throw new Error("injected publication failure")
    await writeAgent(next, expected)
  }
  const snapshot = await f.service.sessionSnapshot(target)
  snapshot.configOptions.find(option => option.id === "reasoning")!.currentValue = "high"
  f.updateConfiguration(target.agentId, snapshot.configOptions)
  await f.context.mutations.queue.run(async () => {})
  assert.equal((await f.store.readAgent(target.agentId))!.configurationState.verification.kind, boundary === "unknown-marker" ? "verified" : "unknown")
  await assert.rejects(f.service.submitAcp(target, { submissionId: randomUUID(), prompt: [{ type: "text", text: "blocked" }] }), { code: "NOT_READY" })
  f.store.writeAgent = writeAgent
  const setterCount = f.methodHistory.filter(method => method === "session/set_config_option").length
  const service = await f.restart(), restore = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, agentId: target.agentId, environment: {} }
  await service.restore(restore)
  const { until } = await import("./control-support.js")
  await until(async () => (await service.command(restore.commandId, restore.handlerGeneration)).command.state === "completed" ? true : undefined)
  const restored = (await f.store.readAgent(target.agentId))!
  assert.equal(restored.phase, "ready")
  assert.equal(restored.settings.configValues?.reasoning, "high")
  assert.equal(f.methodHistory.filter(method => method === "session/set_config_option").length, setterCount)
})

test("configuration setters cannot dispatch during an accepted native turn", async t => {
  const f = await agentServiceFixture(t, { prompt: "hang" }), record = await f.service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: {} }), target = tupleOfRecord(record)!
  const submissionId = randomUUID(), count = f.methodHistory.filter(method => method === "session/set_config_option").length
  await f.service.submitAcp(target, { submissionId, prompt: [{ type: "text", text: "active" }] })
  await f.promptEntered
  await assert.rejects(f.service.setSession(target, "session/set_config_option", { configId: "reasoning", value: "high" }), { code: "BUSY" })
  assert.equal(f.methodHistory.filter(method => method === "session/set_config_option").length, count)
  f.completePrompt(target.agentId)
  await f.service.settledAcp(target, submissionId)
  await f.service.setSession(target, "session/set_config_option", { configId: "reasoning", value: "high" })
  assert.equal((await f.store.readAgent(target.agentId))!.settings.configValues?.reasoning, "high")
})

test("stop during a pending setter cannot publish ready settings over a retired generation", async t => {
  const f = await agentServiceFixture(t), record = await f.service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: {} }), target = tupleOfRecord(record)!
  f.holdSetter(true)
  const pending = f.service.setSession(target, "session/set_config_option", { configId: "reasoning", value: "high" })
  void pending.catch(() => undefined)
  const { until } = await import("./control-support.js")
  await until(async () => f.methodHistory.includes("session/set_config_option") ? true : undefined)
  const stop = await f.service.stop({ ...target, commandId: randomUUID() })
  await assert.rejects(pending)
  await until(async () => (await f.service.command(stop.command.commandId, target.handlerGeneration)).command.state === "completed" ? true : undefined)
  assert.equal((await f.store.readAgent(target.agentId))!.phase, "stopped")
  f.releaseSetter()
  f.holdSetter(false)
  const service = await f.restart(), restore = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, agentId: target.agentId, environment: {} }
  await service.restore(restore)
  await until(async () => (await service.command(restore.commandId, restore.handlerGeneration)).command.state === "completed" ? true : undefined)
  assert.equal((await f.store.readAgent(target.agentId))!.settings.configValues?.reasoning, "high")
  await assert.rejects(service.setSession(target, "session/set_config_option", { configId: "reasoning", value: "low" }), { code: "STALE_HANDLER" })
})

test("setter intent and pending marker precede dispatch and exclude simultaneous mutations", async t => {
  const f = await agentServiceFixture(t), record = await f.service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: {} }), target = tupleOfRecord(record)!
  f.holdSetter(true)
  const pending = f.service.setSession(target, "session/set_config_option", { configId: "reasoning", value: "high" })
  const { until } = await import("./control-support.js")
  await until(async () => f.methodHistory.includes("session/set_config_option") ? true : undefined)
  assert.equal((await f.store.readAgent(target.agentId))!.configurationState.verification.kind, "pending")
  assert.equal((await f.store.inventory()).commands.find(command => command.op === "configure")!.state, "pending")
  await assert.rejects(f.service.submitAcp(target, { submissionId: randomUUID(), prompt: [{ type: "text", text: "blocked" }] }), { code: "BUSY" })
  await assert.rejects(f.service.setSession(target, "session/set_config_option", { configId: "reasoning", value: "low" }), { code: "BUSY" })
  f.releaseSetter(); await pending
  assert.equal((await f.store.readAgent(target.agentId))!.configurationState.verification.kind, "verified")
})

for (const providerCode of [-32602, -32603]) test("configuration rejection " + providerCode + " clears intent only with no-mutation evidence", async t => {
  const f = await agentServiceFixture(t), record = await f.service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: {} }), target = tupleOfRecord(record)!
  f.setterError({ code: providerCode, message: "fixture rejection" })
  await assert.rejects(f.service.setSession(target, "session/set_config_option", { configId: "reasoning", value: "high" }), { code: "STARTUP_FAILED" })
  const stored = (await f.store.readAgent(target.agentId))!, receipt = (await f.store.inventory()).commands.find(command => command.op === "configure")!
  assert.equal(stored.settings.configValues?.reasoning, "low")
  assert.equal(stored.configurationState.verification.kind, providerCode === -32602 ? "verified" : "pending")
  assert.equal(receipt.state, providerCode === -32602 ? "completed" : "pending")
  f.setterError()
  if (providerCode === -32602) await f.service.submitAcp(target, { submissionId: randomUUID(), prompt: [{ type: "text", text: "allowed" }] })
  else await assert.rejects(f.service.submitAcp(target, { submissionId: randomUUID(), prompt: [{ type: "text", text: "blocked" }] }), { code: "NOT_READY" })
})

test("a public model change preserves non-restorable requirements across explicit native restore", async t => {
  const f = await agentServiceFixture(t), record = await f.service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: {} }), target = tupleOfRecord(record)!
  const snapshot = await f.service.sessionSnapshot(target)
  ;(snapshot.configOptions.find(option => option.id === "model")!.options as any[]).push({ value: "model-b", name: "B" })
  snapshot.configOptions.push({ id: "credential", type: "text", name: "Credential", currentValue: "" })
  f.updateConfiguration(target.agentId, snapshot.configOptions)
  await f.context.mutations.queue.run(async () => {})
  await f.service.setSession(target, "session/set_config_option", { configId: "credential", value: "transient-secret" })
  await f.service.setSession(target, "session/set_config_option", { configId: "model", value: "model-b" })
  const inventory = await f.store.inventory()
  assert.deepEqual(inventory.agents[0]!.configurationState.nonRestorableOptionIds, ["credential"])
  const receipts = inventory.commands.filter(command => command.op === "configure")
  assert.equal(receipts.length, 2)
  assert.deepEqual(receipts.map(command => command.version === 3 ? command.input.priorNonRestorableOptionIds : null), [["credential"], ["credential"]])
  assert.equal(JSON.stringify(inventory).includes("transient-secret"), false)
  const service = await f.restart(), restore = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, agentId: target.agentId, environment: {} }
  await service.restore(restore)
  const { until } = await import("./control-support.js")
  await until(async () => (await service.command(restore.commandId, restore.handlerGeneration)).command.state === "completed" ? true : undefined)
  assert.equal((await service.command(restore.commandId, restore.handlerGeneration)).command.result?.failure?.code, "SESSION_INPUT_REQUIRED")
  assert.notEqual((await f.store.readAgent(target.agentId))!.phase, "ready")
  const publicOptions = snapshot.configOptions.filter(option => option.id !== "credential")
  publicOptions.find(option => option.id === "model")!.currentValue = "model-b"
  f.updateConfiguration(target.agentId, publicOptions)
  const retry = { ...restore, commandId: randomUUID() }
  await service.restore(retry)
  await until(async () => (await service.command(retry.commandId, retry.handlerGeneration)).command.state === "completed" ? true : undefined)
  const restored = (await f.store.readAgent(target.agentId))!
  assert.equal(restored.phase, "ready")
  assert.equal(restored.settings.configValues?.model, "model-b")
  assert.deepEqual(restored.configurationState.nonRestorableOptionIds, [])
})

for (const boundary of ["intent", "marker", "settings", "receipt"] as const) test("setter publication failure at " + boundary + " does not report success or replay stale settings", async t => {
  const f = await agentServiceFixture(t), record = await f.service.createSession({ commandId: randomUUID(), cwd: f.workspace, environment: {}, nativeParams: { cwd: f.workspace, mcpServers: [] } }), target = tupleOfRecord(record)!
  const writeAgent = f.store.writeAgent.bind(f.store), writeCommand = f.store.writeCommand.bind(f.store)
  f.store.writeAgent = async (value, expected) => {
    if (value.version === 3 && (boundary === "marker" && value.configurationState.verification.kind === "pending" || boundary === "settings" && expected?.version === 3 && expected.configurationState.verification.kind === "pending" && value.configurationState.verification.kind === "verified")) throw new Error("injected " + boundary)
    await writeAgent(value, expected)
  }
  f.store.writeCommand = async (value, expected) => {
    if (value.op === "configure" && (boundary === "intent" && value.state === "pending" || boundary === "receipt" && value.state === "completed")) throw new Error("injected " + boundary)
    await writeCommand(value, expected)
  }
  const count = f.methodHistory.filter(method => method === "session/set_config_option").length
  await assert.rejects(f.service.setSession(target, "session/set_config_option", { configId: "reasoning", value: "high" }), { code: "INCOMPLETE" })
  assert.equal(f.methodHistory.filter(method => method === "session/set_config_option").length, count + (boundary === "settings" || boundary === "receipt" ? 1 : 0))
  if (boundary !== "intent") await assert.rejects(f.service.submitAcp(target, { submissionId: randomUUID(), prompt: [{ type: "text", text: "blocked" }] }), { code: "NOT_READY" })
  f.store.writeAgent = writeAgent; f.store.writeCommand = writeCommand
  const service = await f.restart()
  const restore = { agentId: target.agentId, commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, environment: {} }
  await service.restore(restore)
  const { until } = await import("./control-support.js")
  await until(async () => (await service.command(restore.commandId, restore.handlerGeneration)).command.state !== "pending" ? true : undefined)
  const restored = (await f.store.readAgent(target.agentId))!
  assert.equal(restored.phase, "ready")
  assert.equal(restored.configurationState.verification.kind, "verified")
  assert.equal(restored.settings.configValues?.reasoning, boundary === "settings" || boundary === "receipt" ? "high" : "low")
  assert.equal(f.methodHistory.filter(method => method === "session/set_config_option").length, count + (boundary === "settings" || boundary === "receipt" ? 1 : 0))
})