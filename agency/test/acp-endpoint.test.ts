import assert from "node:assert/strict"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import { runAcpEndpoint } from "../src/acp/endpoint.js"
import { acpFixture, createAcpPeer } from "./acp-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"

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