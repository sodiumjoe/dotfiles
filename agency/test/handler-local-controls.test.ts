import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { assertPrivateSocket } from "../src/platform/private-socket.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { AGENT_PROTOCOL, parseAgentReply } from "../src/agent/protocol.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import type { RuntimeHumanResult } from "../src/agent/human-controls.js"
import { productionControlDependencies, runControl } from "../src/cli/control.js"
import { inspectHandlerGeneration } from "../src/platform/singleton.js"
import { acpFixture } from "./acp-support.js"

test("local runtime ignores legacy files and exposes only current controls", { timeout: 60000 }, async t => {
  const f = await acpFixture(t)
  await f.crashHandler()
  const legacy = ["bureau/settings.json", "bureau/runs/legacy.json", "orchestration/history.json"]
  for (const name of legacy) {
    await mkdir(join(f.paths.persistentRoot, name, ".."), { recursive: true, mode: 0o700 })
    await writeFile(join(f.paths.persistentRoot, name), "malformed legacy bytes", { mode: 0o600 })
  }
  await f.restart({ nativeAcp: true })
  const peer = await f.connect()
  const dependencies = { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), inspect: env => inspectHandlerGeneration(env.paths.runtimeRoot, env.adapter) } satisfies ReturnType<typeof productionControlDependencies>
  const local = async (argv: readonly string[], codes = [0]): Promise<RuntimeHumanResult> => {
    const output: string[] = []
    assert.ok(codes.includes(await runControl([...argv, "--local", "--json"], { ...dependencies, stdout: text => output.push(text) })))
    const reply = JSON.parse(output.join(""))
    assert.equal(reply.ok, true)
    return reply.result as RuntimeHumanResult
  }
  assert.equal(await assertPrivateSocket(f.paths.runtimeRoot, "bridge.sock"), join(f.paths.runtimeRoot, "bridge.sock"))
  const identity = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  const bridge = await connectHandlerBridge({ root: f.paths.runtimeRoot, hostId: f.paths.hostKey, handlerGeneration: identity.generation })
  t.after(() => bridge.close())
  const remoteRoster = parseAgentReply(await bridge.request("runtime-read", { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: identity.generation, op: "agent_roster", input: { limit: 100 } }))
  assert.ok(remoteRoster.ok && remoteRoster.result.state === "page")
  assert.equal((await f.choices()).state, "choices")
  await peer.request("initialize", { protocolVersion: 1 })
  const session = await peer.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const roster = await local(["roster", "list"])
  assert.equal(roster.state, "page")
  assert.ok(roster.state === "page" && roster.agents.length === 1)
  const prompt = peer.request("session/prompt", { sessionId: session.sessionId!, prompt: [{ type: "text", text: "permission" }] })
  const editorOffer = await peer.next("session/request_permission")
  const pending = await local(["permission", "list"])
  assert.ok(pending.state === "permissions")
  const offer = pending.snapshot.pending[0]!
  const commandId = randomUUID()
  const deciding = local(["permission", "decide", "--input-json", JSON.stringify({ commandId, ref: offer.ref, optionId: String(offer.options[0]!.optionId) })], [0, 75])
  const routed = bridge.request("runtime-write", { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: identity.generation, op: "agent_permission_decide", commandId: randomUUID(), ref: offer.ref, optionId: String(offer.options[1]!.optionId) })
  peer.respond(editorOffer.id, { outcome: { outcome: "selected", optionId: String(offer.options[0]!.optionId) } })
  const answer = await deciding
  assert.ok(parseAgentReply(await routed).ok)
  const inspected = await local(["permission", "inspect", commandId])
  assert.deepEqual(inspected, answer)
  assert.ok(answer.state === "permission" && ["applied", "withdrawn", "stale"].includes(answer.receipt!.state))
  assert.equal((await prompt).stopReason, "end_turn")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 1)
  for (const name of ["bureau.sock", "orchestration.sock"]) await assert.rejects(lstat(join(f.paths.runtimeRoot, name)), { code: "ENOENT" })
  for (const capability of ["snapshot", "launch", "invoke", "coordinate", "origin-read", "permission-read", "replay"]) assert.equal((await bridge.ready).capabilities.includes(capability), false)
  for (const name of legacy) assert.equal(await readFile(join(f.paths.persistentRoot, name), "utf8"), "malformed legacy bytes")
  peer.close()
  const reattached = await f.connect()
  await reattached.request("initialize", { protocolVersion: 1 })
  const loaded = await reattached.request("session/load", { sessionId: session.sessionId!, cwd: f.workspace, mcpServers: [] })
  assert.ok(Array.isArray(loaded.configOptions))
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.method === "session/load").length, 0)
  reattached.close()
  await f.stopSession(String(session.sessionId))
  await f.verifyZeroSurvivors()
})