import assert from "node:assert/strict"
import test from "node:test"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentHandlerFixture } from "./agent-support.js"
import { privateRoot } from "./control-support.js"
import { until } from "./control-support.js"
import { createConnection } from "node:net"
import { randomUUID } from "node:crypto"
import { createNdjsonDecoder, parseAttachmentFrame } from "../src/agent/attachment-protocol.js"
import { exchange } from "../src/control/wire.js"

test("attachment peers do not delay verified forced Handler shutdown", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t), ready = await f.waitCompleted(await f.start()), target = ready.command.target!
  const socket = createConnection(join(f.paths.runtimeRoot, "attachment.sock")), frames: any[] = []
  t.after(() => socket.destroy())
  socket.on("error", () => undefined)
  const decoder = createNdjsonDecoder(value => frames.push(parseAttachmentFrame(value)), error => { throw error })
  socket.on("data", bytes => decoder.feed(bytes))
  socket.write(JSON.stringify({ protocol: "agency-attachment/1", target, requestId: randomUUID(), op: "attach" }) + "\n")
  await until(async () => frames.some(frame => frame.type === "snapshot_end") ? true : undefined)
  const ordinary = await exchange(createConnection(f.paths.handlerSocketPath), { protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: target.handlerGeneration, op: "shutdown", commandId: randomUUID(), stopAgents: false })
  assert.ok(!ordinary.ok && ordinary.error.code === "ACTIVE_AGENTS")
  assert.equal(socket.destroyed, false)
  const forced = await exchange(createConnection(f.paths.handlerSocketPath), { protocol: "agency-control/2", requestId: randomUUID(), handlerGeneration: target.handlerGeneration, op: "shutdown", commandId: randomUUID(), stopAgents: true })
  assert.equal(forced.ok, true)
  await until(async () => socket.destroyed ? true : undefined)
  await f.waitHandlerExit()
  await f.assertProviderAbsent(target)
  await f.verifyZeroSurvivors()
})

test("agent lifecycle does not execute Git or inspect historical admissions", { timeout: 60000 }, async t => {
  const trap = await privateRoot(t), marker = join(trap, "git-invoked"), admissionMarker = join(trap, "admissions-accessed"), preload = join(trap, "forbid-git.cjs")
  await writeFile(preload, `const cp = require("node:child_process")\nconst fs = require("node:fs")\nconst fsp = require("node:fs/promises")\nfor (const name of ["execFile", "spawn"]) { const original = cp[name]; cp[name] = function(file, ...args) { if (String(file).includes("git")) { fs.writeFileSync(${JSON.stringify(marker)}, String(file)); throw new Error("Git subprocess forbidden") }; return original.call(this, file, ...args) } }\nfor (const name of ["lstat", "stat", "readdir", "opendir", "readFile", "open", "mkdir", "rm", "rename", "writeFile"]) { const original = fsp[name]; fsp[name] = function(path, ...args) { if (String(path).includes("/admissions")) { fs.writeFileSync(${JSON.stringify(admissionMarker)}, String(path)); throw new Error("admissions access forbidden") }; return original.call(this, path, ...args) } }\nrequire("node:module").syncBuiltinESMExports()`, { mode: 0o600 })
  const f = await agentHandlerFixture(t, {}, { NODE_OPTIONS: `--require=${preload}` })
  assert.equal(Object.hasOwn(f, "git"), false)
  const admissions = join(f.paths.persistentRoot, "admissions")
  await mkdir(admissions, { mode: 0o700 })
  await writeFile(join(admissions, "historical.json"), "{", { mode: 0o600 })
  const started = await f.waitCompleted(await f.startAt(f.workspace))
  assert.equal(started.command.result?.outcome, "started")
  assert.equal((await f.currentAt(f.workspace)).agents.length, 1)
  await f.waitCompleted(await f.stop(started.command.target!))
  const restored = await f.waitCompleted(await f.restore(started.command.target!.agentId))
  assert.equal(restored.command.result?.outcome, "restored")
  await f.waitCompleted(await f.stop(restored.command.target!))
  assert.equal(await readFile(join(admissions, "historical.json"), "utf8"), "{")
  await assert.rejects(lstat(marker), { code: "ENOENT" })
  await assert.rejects(lstat(admissionMarker), { code: "ENOENT" })
})

test("Handler starts an ambient agent and publishes version-two ownership", async t => {
  const f = await agentHandlerFixture(t)
  const accepted = await f.startAt(f.workspace)
  const ready = await f.waitCompleted(accepted)
  assert.equal(ready.command.result?.outcome, "started")
  await assert.rejects(lstat(join(f.paths.persistentRoot, "admissions")), { code: "ENOENT" })
  const current = await f.currentAt(f.workspace)
  assert.equal(current.agents.length, 1)
  const agent = current.agents[0]!
  assert.equal(agent.record.definition.cwd, f.workspace)
  assert.equal(agent.launch?.version, 2)
  assert.equal(agent.launch?.phase, "active")
  await assert.rejects(lstat(join(f.paths.persistentRoot, "agents/provider-state")), { code: "ENOENT" })
  await f.stop(ready.command.target!)
  assert.deepEqual((await f.currentAt(f.workspace)).agents, [])
})

test("Handler current returns every exact-directory live agent", async t => {
  const f = await agentHandlerFixture(t)
  const first = await f.startAt(f.workspace), second = await f.startAt(f.workspace)
  const results = await Promise.all([f.waitCompleted(first), f.waitCompleted(second)])
  assert.ok(results.every(result => result.command.result?.outcome === "started"))
  assert.deepEqual((await f.currentAt(f.workspace)).agents.map(agent => agent.record.definition.agentId).sort(), results.map(result => result.command.target!.agentId).sort())
  assert.deepEqual((await f.currentAt(f.otherWorkspace)).agents, [])
  await Promise.all(results.map(result => f.stop(result.command.target!)))
})

test("Handler crash during a prompt closes the client and verifies owned cleanup on restart", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t, { pauseAt: "prompt" })
  const ready = await f.waitCompleted(await f.start())
  const pending = f.prompt(ready.command.target!, "challenge")
  void pending.catch(() => undefined)
  await f.waitPrompt()
  await f.crashHandler()
  await assert.rejects(pending)
  await f.restart()
  const listed = await f.list()
  assert.equal(listed.agents[0]!.live, false)
  assert.equal(listed.agents[0]!.cleanup, "verified")
  assert.equal(listed.agents[0]!.record.phase, "recoverable")
  const restored = await f.waitCompleted(await f.restore(ready.command.target!.agentId))
  assert.equal(restored.command.result?.outcome, "restored")
  assert.equal(restored.command.result?.session?.sessionId, ready.command.result?.session?.sessionId)
  assert.notEqual(restored.command.target?.handlerGeneration, ready.command.target?.handlerGeneration)
  assert.equal((await f.providerRequests()).filter(request => request.method === "session/prompt").length, 1)
  assert.equal((await f.prompt(restored.command.target!, "fresh question")).text, "answer:fresh question")
  await f.waitCompleted(await f.stop(restored.command.target!))
  await f.verifyZeroSurvivors()
})

test("Handler restores a normally stopped conversation with a fresh process", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t)
  const ready = await f.waitCompleted(await f.startAt(f.workspace))
  await f.waitCompleted(await f.stop(ready.command.target!))
  const restored = await f.waitCompleted(await f.restore(ready.command.target!.agentId))
  assert.equal(restored.command.result?.outcome, "restored")
  assert.equal(restored.command.target?.agentId, ready.command.target?.agentId)
  assert.notEqual(restored.command.target?.providerGeneration, ready.command.target?.providerGeneration)
  assert.equal((await f.currentAt(f.workspace)).agents[0]!.record.session!.sessionId, ready.command.result!.session!.sessionId)
  const requests = await f.providerRequests()
  assert.equal(requests.filter(request => request.method === "session/new").length, 1)
  assert.deepEqual(requests.find(request => request.method === "session/load")!.params, { sessionId: "fixture-session", cwd: f.workspace, mcpServers: [] })
  await f.waitCompleted(await f.stop(restored.command.target!))
})

test("Handler crash after receipt visibility repairs durability without respawning", { timeout: 60000 }, async t => {
  const f = await agentHandlerFixture(t, { pauseAt: "receipt", failReceiptSync: true })
  const operation = f.start()
  void operation.catch(() => undefined)
  await f.waitBarrier()
  const before = await f.inventory(), retained = before.commands.find(command => command.op === "start")!
  assert.equal(retained.state, "completed")
  await f.crashHandler()
  await operation.catch(() => undefined)
  await f.restart()
  const recovered = await f.command(retained.commandId, retained.handlerGeneration)
  assert.deepEqual(recovered.command, retained)
  assert.equal(recovered.durability, "verified")
  assert.equal((await f.list()).agents[0]!.live, false)
  assert.equal(f.providerCount(), 1)
  await f.verifyZeroSurvivors()
})