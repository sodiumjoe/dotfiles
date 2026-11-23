import assert from "node:assert/strict"
import { lstat, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import { runAcpEndpoint } from "../src/acp/endpoint.js"
import { createAcpPeer } from "./acp-peer.js"
import { liveHandlerFixture } from "./live-support.js"

test("endpoint stdin EOF detaches while a shared prompt remains live", async t => {
  const f = await liveHandlerFixture(t), stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  const endpoint = runAcpEndpoint([], { stdin, stdout, stderr, environment: f.environment(), discover: async () => ({ socketPath: join(f.paths.runtimeRoot, "acp.sock"), generation: (await f.handler()).generation }) })
  const a = createAcpPeer(stdout, stdin), b = await f.connect()
  await a.request("initialize", { protocolVersion: 1, clientCapabilities: {} }); await b.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const s = await a.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const pending = a.request("session/prompt", { sessionId: s.sessionId!, prompt: [{ type: "text", text: "held" }] }).catch(() => null)
  await a.nextState("running"); stdin.end(); assert.equal(await endpoint, 0)
  a.close(); await pending
  await b.request("session/load", { sessionId: s.sessionId!, cwd: f.workspace, mcpServers: [] })
  await b.nextState("running"); await f.releasePrompts(); await b.nextState("idle")
  assert.equal((await f.providerRequests("codex-acp")).filter(value => value.method === "session/cancel").length, 0)
  assert.equal((await lstat(join(f.paths.runtimeRoot, "acp.sock"))).mode & 0o777, 0o600)
  await f.verifyZeroSurvivors()
})

async function endpointAgainst(t: { after(fn: () => Promise<void>): void }, onConnection: (socket: import("node:net").Socket) => void, socketName = "acp.sock") {
  const dir = await mkdtemp(join(tmpdir(), "agy-acp-")), socketPath = join(dir, socketName)
  const server = createServer(onConnection)
  await new Promise<void>(resolve => server.listen(join(dir, "acp.sock"), resolve))
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) })
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  let errors = ""
  stderr.on("data", chunk => { errors += chunk })
  const code = await runAcpEndpoint([], { stdin, stdout, stderr, environment: {}, discover: async () => ({ socketPath, generation: "g" }) })
  return { code, errors }
}

test("endpoint exits cleanly without a message when the Handler ends the connection", async t => {
  const { code, errors } = await endpointAgainst(t, socket => socket.once("data", () => socket.end()))
  assert.equal(code, 0)
  assert.equal(errors, "")
})

test("endpoint still fails when the Handler socket cannot be reached", async t => {
  const { code, errors } = await endpointAgainst(t, () => {}, "missing.sock")
  assert.equal(code, 70)
  assert.match(errors, /ENOENT/)
})