import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { agentServiceFixture } from "./agent-support.js"
import { acpFixture } from "./acp-support.js"
import type { AgentStore } from "../src/agent/store.js"
import { until } from "./control-support.js"

test("recovery completes an interrupted identity-reuse import without replacing the existing record", async t => {
  const f = await agentServiceFixture(t), input = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, backendId: "codex-acp" as const, nativeSessionId: "saved-native", cwd: f.workspace }
  await f.service.importSession(input)
  const original = (await f.store.inventory()).agents[0]!, commandId = randomUUID()
  let interrupted = false
  const store: AgentStore = { ...f.store, async writeCommand(command, expected) { await f.store.writeCommand(command, expected); if (!interrupted && command.commandId === commandId && command.state === "pending") { interrupted = true; throw new Error("reuse receipt barrier") } } }
  const service = await f.restart(undefined, store)
  await assert.rejects(service.importSession({ ...input, commandId, handlerGeneration: f.context.state.handlerGeneration }))
  const restarted = await f.restart()
  const receipt = await restarted.command(commandId, (await f.store.readCommand(commandId))!.handlerGeneration)
  assert.equal(receipt.command.state, "completed")
  assert.equal(receipt.durability, "verified")
  assert.deepEqual((await f.store.inventory()).agents[0], original)
})

test("a prepublication import retry retains its logical identity", async t => {
  const f = await agentServiceFixture(t), base = f.store
  let intent: any, fail = true
  const store: AgentStore = { ...base, async writeCommand(value, expected) { if (fail && value.op === "import") { intent = value; fail = false; throw new Error("before publication") }; await base.writeCommand(value, expected) } }
  const service = await f.restart(undefined, store), input = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, backendId: "codex-acp" as const, nativeSessionId: "saved-native", cwd: f.workspace }
  await assert.rejects(service.importSession(input))
  const receipt = await service.importSession(input)
  assert.equal((receipt.command as any).agentId, intent.agentId)
  assert.equal(receipt.durability, "verified")
})

test("unsupported or disabled native import does not spawn or publish an agent", async t => {
  for (const options of [{ contract: false }, { sessionLoad: false }]) {
    const f = await agentServiceFixture(t, options)
    await assert.rejects(f.service.importSession({ commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, backendId: "codex-acp", nativeSessionId: "saved-native", cwd: f.workspace }), { code: "UNAVAILABLE" })
    assert.equal(f.spawns(), 0)
    assert.equal((await f.store.inventory()).agents.length, 0)
  }
})

test("import reuses native identity and creates only stopped records and receipts", async t => {
  const f = await agentServiceFixture(t)
  const input = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, backendId: "codex-acp" as const, nativeSessionId: "saved-native", cwd: f.workspace }
  const first = await f.service.importSession(input)
  const same = await f.service.importSession(input)
  const again = await f.service.importSession({ ...input, commandId: randomUUID() })
  assert.equal(first.command.version, 3)
  assert.deepEqual(same, first)
  assert.equal((again.command as any).agentId, (first.command as any).agentId)
  assert.equal(first.command.target, null)
  assert.equal(first.command.result?.outcome, "imported")
  const inventory = await f.store.inventory()
  assert.equal(inventory.agents.length, 1)
  assert.equal(inventory.agents[0]!.launch, null)
  assert.equal(inventory.agents[0]!.phase, "stopped")
  assert.equal(inventory.agents[0]!.session!.sessionId, "saved-native")
  assert.equal((await f.service.list()).issues.length, 0)
})

test("import rejects cwd conflicts, command reuse, unsupported backends and logical IDs", async t => {
  const f = await agentServiceFixture(t)
  const input = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, backendId: "codex-acp" as const, nativeSessionId: "saved-native", cwd: f.workspace }
  await f.service.importSession(input)
  await assert.rejects(f.service.importSession({ ...input, commandId: randomUUID(), cwd: "/other" }), { code: "COMMAND_CONFLICT" })
  await assert.rejects(f.service.importSession({ ...input, nativeSessionId: "another" }), { code: "COMMAND_CONFLICT" })
  await assert.rejects(f.service.importSession({ ...input, commandId: randomUUID(), backendId: "claude-agent-acp" }), { code: "UNSUPPORTED_SESSION_FEATURE" })
  await assert.rejects(f.service.importSession({ ...input, commandId: randomUUID(), nativeSessionId: "agency:" + randomUUID() }), { code: "INVALID_AGENT_STATE" })
})

for (const stage of ["receipt", "record"] as const) test("import resumes the same logical identity after a " + stage + " publication interruption", async t => {
  const f = await agentServiceFixture(t), base = f.store
  let interrupted = false
  const store: AgentStore = { ...base,
    async writeCommand(value, expected) { await base.writeCommand(value, expected); if (!interrupted && value.op === "import" && value.state === "pending" && stage === "receipt") { interrupted = true; throw new Error("receipt barrier") } },
    async writeAgent(value, expected) { await base.writeAgent(value, expected); if (!interrupted && value.version === 3 && value.definition.origin === "import" && stage === "record") { interrupted = true; throw new Error("record barrier") } },
  }
  const service = await f.restart(undefined, store)
  const input = { commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, backendId: "codex-acp" as const, nativeSessionId: "saved-native", cwd: f.workspace }
  await assert.rejects(service.importSession(input))
  const pending = (await base.inventory()).commands.find(command => command.commandId === input.commandId)!
  const next = await f.restart()
  const recovered = await next.importSession({ ...input, handlerGeneration: f.context.state.handlerGeneration })
  const repeated = await next.importSession({ ...input, commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration })
  assert.equal((recovered.command as any).agentId, (pending as any).agentId)
  assert.equal((repeated.command as any).agentId, (pending as any).agentId)
  assert.equal((await base.inventory()).agents.length, 1)
  assert.equal((await next.list()).issues.length, 0)
})

test("ACP native inventory and import preserve native history without launching a provider", async t => {
  const f = await acpFixture(t), a = await f.connect(), history = join(f.environment.HOME, ".codex/sessions")
  await mkdir(history, { recursive: true, mode: 0o700 })
  const path = join(history, "rollout.jsonl"), bytes = JSON.stringify({ type: "session_meta", payload: { id: "saved-native", cwd: f.workspace } }) + "\ntranscript that must not be submitted"
  await writeFile(path, bytes)
  await a.request("initialize", { protocolVersion: 1 })
  const native = await a.request("agency/native_sessions", {})
  assert.equal((native.sessions as any[])[0].nativeSessionId, "saved-native")
  const input = { backendId: "codex-acp", nativeSessionId: "saved-native", cwd: f.workspace }
  const first = await a.request("agency/import", input), again = await a.request("agency/import", input)
  assert.equal(first.sessionId, again.sessionId)
  assert.ok(String(first.sessionId).startsWith("agency:"))
  const logical = await a.request("session/list", {})
  assert.equal((logical.sessions as any[])[0].sessionId, first.sessionId)
  assert.equal((logical.sessions as any[])[0]._meta.agency.nativeSessionId, "saved-native")
  await assert.rejects(a.request("session/load", { sessionId: first.sessionId!, cwd: f.workspace, mcpServers: [] }), { code: "NOT_READY" })
  assert.deepEqual(await f.requests("codex-acp"), [])
  assert.equal(await readFile(path, "utf8"), bytes)
})

test("explicit imported restore uses fresh environment and native load without transcript submission or external cleanup", async t => {
  const sentinel = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.stdout.write('signal'));process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe"] })
  let signals = ""
  sentinel.stdout.on("data", chunk => { signals += chunk })
  await new Promise<void>(resolve => sentinel.stdout.once("data", () => resolve()))
  t.after(async () => { sentinel.kill("SIGKILL"); await new Promise<void>(resolve => sentinel.once("exit", () => resolve())) })
  const f = await acpFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const imported = await a.request("agency/import", { backendId: "codex-acp", nativeSessionId: "saved-native", cwd: f.workspace })
  const restored = await f.restoreSession(String(imported.sessionId), { AGENCY_TEST_EDITOR_MARKER: "fresh-import" })
  assert.equal(restored.command.result?.outcome, "restored")
  await a.request("session/load", { sessionId: imported.sessionId!, cwd: f.workspace, mcpServers: [] })
  const requests = await f.requests("codex-acp")
  assert.equal(requests.filter(frame => frame.method === "session/new" || frame.method === "session/prompt").length, 0)
  assert.equal(requests.find(frame => frame.method === "session/load")!.params!.sessionId, "saved-native")
  assert.equal(requests.find(frame => frame.method === "fixture/environment")!.params!.AGENCY_TEST_EDITOR_MARKER, "fresh-import")
  await f.stopSession(String(imported.sessionId))
  assert.doesNotThrow(() => process.kill(sentinel.pid!, 0))
  assert.equal(signals, "ready")
})

test("failed imported native load remains unavailable without a new conversation", async t => {
  const f = await agentServiceFixture(t), receipt = await f.service.importSession({ commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, backendId: "codex-acp", nativeSessionId: "fixture-session", cwd: f.workspace })
  f.loadBehavior("failure")
  const result = await f.service.restore({ agentId: (receipt.command as any).agentId, commandId: randomUUID(), handlerGeneration: f.context.state.handlerGeneration, environment: {} })
  const settled = await until(async () => { const current = await f.service.command(result.command.commandId, result.command.handlerGeneration); return current.command.state !== "pending" ? current : undefined })
  assert.equal(settled.command.result?.outcome, "failed")
  assert.equal(f.methodHistory.some(value => value === "session/new"), false)
})

test("import of a native session already owned by Agency reuses its live record", async t => {
  const f = await acpFixture(t), a = await f.connect()
  await a.request("initialize", { protocolVersion: 1 })
  const created = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const imported = await a.request("agency/import", { backendId: "codex-acp", nativeSessionId: "native-session", cwd: f.workspace })
  assert.equal(imported.sessionId, created.sessionId)
  assert.equal((await f.inventory()).agents.length, 1)
  assert.equal((await f.inventory()).agents[0]!.definition.origin, "new")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/new").length, 1)
  await f.stopSession(String(created.sessionId))
})