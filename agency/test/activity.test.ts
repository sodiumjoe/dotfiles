import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { acpFixture } from "./acp-support.js"
import { agentHandlerFixture } from "./agent-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { until } from "./control-support.js"
import { createAgentStore } from "../src/agent/store.js"

const initialize = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true }, terminal: true } }

test("the Handler records activity and the title, keeps them across stop and restore, and lists them", async t => {
  const f = await acpFixture(t), c = await f.connect(), store = createAgentStore(f.paths.persistentRoot)
  await c.request("initialize", initialize)
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const sessionId = String(session.sessionId), agentId = sessionId.slice(7)
  assert.equal((await store.readAgent(agentId))?.lastActivityAt, undefined)
  const before = new Date().toISOString()
  assert.equal((await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })).stopReason, "end_turn")
  const settled = await until(async () => {
    const record = await store.readAgent(agentId)
    return record?.title === "hello" && record.lastActivityAt && record.lastActivityAt >= before ? record : undefined
  })
  assert.ok(Number.isFinite(Date.parse(settled.lastActivityAt!)))
  c.close()
  await f.stopSession(sessionId)
  const stopped = await store.readAgent(agentId)
  assert.equal(stopped?.phase, "stopped")
  assert.ok(stopped?.lastActivityAt && stopped.lastActivityAt >= settled.lastActivityAt!)
  assert.equal(stopped?.title, "hello")
  const listing = await f.connect()
  await listing.request("initialize", initialize)
  const listed = ((await listing.request("session/list", {})).sessions as Array<Record<string, any>>).find(value => value.sessionId === sessionId)
  assert.ok(listed)
  assert.equal(listed.updatedAt, stopped?.lastActivityAt)
  assert.equal(listed.title, "hello")
  assert.equal(listed._meta.agency.model, (stopped?.settings.configValues?.model as string | undefined) ?? stopped?.settings.modelId ?? null)
  listing.close()
  await f.restoreSession(sessionId)
  const restored = await store.readAgent(agentId)
  assert.equal(restored?.title, "hello")
  assert.equal(restored?.lastActivityAt, stopped?.lastActivityAt)
  await f.stopSession(sessionId)
  await f.verifyZeroSurvivors()
})

test("an activity write does not break a configure that overlaps the end of a turn", async t => {
  const f = await acpFixture(t), c = await f.connect(), store = createAgentStore(f.paths.persistentRoot)
  await c.request("initialize", initialize)
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, commandId: randomUUID(), backendId: "claude-agent-acp" } } })
  const sessionId = String(session.sessionId), agentId = sessionId.slice(7)
  await writeFile(join(f.root, "pause-set-mode"), "pause", { mode: 0o600 })
  const turn = c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "held" }] })
  await until(async () => (await f.requests("claude-agent-acp")).some(value => value.method === "session/prompt") ? true : undefined)
  const submitted = await until(async () => (await store.readAgent(agentId))?.lastActivityAt)
  const mode = c.request("session/set_mode", { sessionId, modeId: "review" })
  await until(async () => await readFile(join(f.root, "at-set-mode"), "utf8").catch(() => undefined))
  await f.release("claude-agent-acp")
  assert.equal((await turn).stopReason, "end_turn")
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal((await store.readAgent(agentId))?.lastActivityAt, submitted)
  await writeFile(join(f.root, "release-set-mode"), "released", { mode: 0o600 })
  await mode
  assert.equal((await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })).stopReason, "end_turn")
  c.close()
  await f.stopSession(sessionId)
  await f.verifyZeroSurvivors()
})

test("the Handler backfills the title and activity time of older stopped sessions from their history", async t => {
  const homes = await mkdtemp(join(tmpdir(), "agency-backfill-")), codexHome = join(homes, "codex")
  t.after(() => rm(homes, { recursive: true, force: true }))
  const f = await agentHandlerFixture(t, { selectionCatalog: true, nativeAcp: true }, { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: join(homes, "claude") })
  const store = createAgentStore(f.paths.persistentRoot)
  const started = await f.waitCompleted(await f.start({ mode: "read-only" }))
  const target = started.command.target!
  await f.waitCompleted(await f.stop(target))
  const before = await store.readAgent(target.agentId)
  assert.equal(before?.phase, "stopped")
  assert.equal(before?.title, undefined)
  const sessionId = before!.session!.sessionId
  await mkdir(join(codexHome, "sessions", "2026", "11", "13"), { recursive: true })
  const path = join(codexHome, "sessions", "2026", "11", "13", "rollout-2026-11-13T10-00-00-" + sessionId + ".jsonl")
  await writeFile(path, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "backfilled title" }] } }))
  const handler = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  await f.control({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: handler.generation, op: "shutdown", commandId: randomUUID(), stopAgents: false })
  await f.waitHandlerExit()
  await f.restart({ selectionCatalog: true, nativeAcp: true })
  const after = await until(async () => { const value = await store.readAgent(target.agentId); return value?.title ? value : undefined })
  assert.equal(after.title, "backfilled title")
  assert.equal(after.lastActivityAt, (await stat(path)).mtime.toISOString())
  assert.equal(after.phase, "stopped")
  await f.verifyZeroSurvivors()
})

test("a restore issued while the history backfill is reading completes instead of leaving its command pending", async t => {
  const homes = await mkdtemp(join(tmpdir(), "agency-backfill-race-")), codexHome = join(homes, "codex")
  t.after(() => rm(homes, { recursive: true, force: true }))
  const f = await agentHandlerFixture(t, { selectionCatalog: true, nativeAcp: true }, { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: join(homes, "claude") })
  const store = createAgentStore(f.paths.persistentRoot)
  const started = await f.waitCompleted(await f.start({ mode: "read-only" }))
  const target = started.command.target!
  await f.waitCompleted(await f.stop(target))
  const sessionId = (await store.readAgent(target.agentId))!.session!.sessionId
  await mkdir(join(codexHome, "sessions", "2026", "11", "13"), { recursive: true })
  const path = join(codexHome, "sessions", "2026", "11", "13", "rollout-2026-11-13T10-00-00-" + sessionId + ".jsonl")
  execFileSync("mkfifo", [path])
  const handler = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  await f.control({ protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: handler.generation, op: "shutdown", commandId: randomUUID(), stopAgents: false })
  await f.waitHandlerExit()
  await f.restart({ selectionCatalog: true, nativeAcp: true, pauseAt: "observe-config" })
  await rm(join(f.root, "release-barrier"), { force: true })
  const restoring = f.restore(target.agentId)
  await f.waitBarrier()
  await (await open(path, "w")).close()
  await new Promise(resolve => setTimeout(resolve, 300))
  await writeFile(join(f.root, "release-barrier"), "released", { mode: 0o600 })
  const restored = await f.waitCompleted(await restoring)
  assert.equal(restored.command.result?.outcome, "restored")
  assert.equal((await store.readAgent(target.agentId))?.phase, "ready")
  await f.waitCompleted(await f.stop(restored.command.result!.target!))
  await f.verifyZeroSurvivors()
})

test("a provider learns the Agency agent it runs as from its environment", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { agency: { version: 1, commandId: randomUUID(), backendId: "claude-agent-acp" } } })
  const sessionId = String(session.sessionId)
  const environment = await until(async () => (await f.requests("claude-agent-acp")).find(value => value.method === "fixture/environment"))
  assert.equal(environment.params?.AGENCY_AGENT_ID, sessionId.slice(7))
  c.close()
  await f.stopSession(sessionId)
  await f.verifyZeroSurvivors()
})