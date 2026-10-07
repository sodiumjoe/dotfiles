import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstat, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { runAcpEndpoint } from "../src/acp/endpoint.js"
import { createAcpWriter } from "../src/acp/server.js"
import { acpFixture, createAcpPeer } from "./acp-support.js"
import { until } from "./control-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"

test("endpoint reports discovery failures on stderr without emitting non-ACP stdout", async () => {
  const stdout = new PassThrough(), stderr = new PassThrough()
  let output = "", diagnostics = ""
  stdout.on("data", bytes => { output += bytes }); stderr.on("data", bytes => { diagnostics += bytes })
  const code = await runAcpEndpoint([], { stdin: new PassThrough(), stdout, stderr, environment: {}, discover: async () => { throw new Error("fixture Handler absent") } })
  assert.equal(code, 70); assert.equal(output, ""); assert.match(diagnostics, /fixture Handler absent/)
})

test("endpoint stdin EOF detaches while a shared prompt remains live", async t => {
  const f = await acpFixture(t), stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  const endpoint = runAcpEndpoint([], { stdin, stdout, stderr, environment: f.environment, discover: async () => ({ socketPath: join(f.paths.runtimeRoot, "acp.sock"), generation: (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation }) })
  const a = createAcpPeer(stdout, stdin), b = await f.connect()
  await a.request("initialize", { protocolVersion: 1, clientCapabilities: {} }); await b.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "held" }] }).catch(() => null)
  await a.nextState("running"); stdin.end(); assert.equal(await endpoint, 0)
  a.close(); await pending
  await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  await b.nextState("running"); await f.release("codex-acp"); await b.nextState("idle")
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/cancel").length, 0)
  assert.equal((await lstat(join(f.paths.runtimeRoot, "acp.sock"))).mode & 0o777, 0o600)
})

test("terminating a fresh endpoint process does not cancel or stop its provider", async t => {
  const f = await acpFixture(t), configPath = join(f.root, "endpoint-" + randomUUID() + ".json")
  await writeFile(configPath, JSON.stringify({ paths: f.paths, environment: f.environment }), { mode: 0o600 })
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/acp-endpoint.js", import.meta.url)), configPath], { cwd: f.workspace, stdio: ["pipe", "pipe", "pipe"] })
  child.stderr.on("data", () => undefined)
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await until(async () => child.exitCode !== null || child.signalCode !== null ? true : undefined); assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" }); t.diagnostic(`endpoint cleanup verified: pid ${child.pid}`) })
  const a = createAcpPeer(child.stdout, child.stdin), b = await f.connect()
  await a.request("initialize", { protocolVersion: 1, clientCapabilities: {} }); await b.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "held" }] }).catch(() => null)
  await a.nextState("running"); child.kill("SIGTERM"); await pending
  await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  await b.nextState("running"); await f.release("codex-acp"); await b.nextState("idle")
  assert.equal((await f.requests("codex-acp")).filter(value => value.method === "session/cancel").length, 0)
})

test("blocked clients time out independently without a queued-byte quota", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const slow = new Writable({ write(_chunk, _encoding, _callback) {} }), healthy = new PassThrough()
  let failures = 0, received = ""
  healthy.on("data", bytes => { received += bytes })
  const a = createAcpWriter(slow, () => { failures++; a.close() }), b = createAcpWriter(healthy, () => assert.fail("healthy client failed"))
  for (let i = 0; i < 40; i++) a.send({ jsonrpc: "2.0", method: "session/update", params: { text: "x".repeat(900000) } })
  assert.equal(failures, 0)
  assert.ok(slow.writableLength > 33554432)
  t.mock.timers.tick(5000)
  assert.equal(failures, 1)
  b.send({ jsonrpc: "2.0", method: "test", params: {} })
  assert.equal(JSON.parse(received).method, "test")
  a.close(); b.close(); slow.destroy(); healthy.destroy()
})

test("large prompts and tool results cross the byte relay and replay to another editor", async t => {
  const f = await acpFixture(t), stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  const endpoint = runAcpEndpoint([], { stdin, stdout, stderr, environment: f.environment, discover: async () => ({ socketPath: join(f.paths.runtimeRoot, "acp.sock"), generation: (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation }) })
  const a = createAcpPeer(stdout, stdin), b = await f.connect()
  await a.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  await b.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const session = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  await b.request("session/load", { sessionId: session.sessionId!, cwd: f.workspace, mcpServers: [] })
  b.drain("agency/session_state")
  assert.equal((await a.request("session/prompt", { sessionId: session.sessionId!, prompt: [{ type: "text", text: "large-tool" }] })).stopReason, "end_turn")
  await b.nextState("running")
  await b.nextState("idle")
  const tool = (updates: any[]) => updates.find(params => params.update.sessionUpdate === "tool_call_update").update
  const first = tool(a.drain("session/update")), second = tool(b.drain("session/update"))
  assert.deepEqual(second, first)
  assert.equal(first.rawOutput.stdout, "fixture-large-tool:" + "λ".repeat(1048577))
  const c = await f.connect()
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  await c.request("session/load", { sessionId: session.sessionId!, cwd: f.workspace, mcpServers: [] })
  assert.deepEqual(tool(c.drain("session/update")), first)
  const text = "λ".repeat(1048577)
  assert.equal((await a.request("session/prompt", { sessionId: session.sessionId!, prompt: [{ type: "text", text }] })).stopReason, "end_turn")
  assert.ok(a.drain("session/update").some((params: any) => params.update.content?.text === "answer:" + text))
  stdin.end()
  assert.equal(await endpoint, 0)
  a.close()
})