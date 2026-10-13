import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { isAbsolute, join } from "node:path"
import { PROTOCOL, parseReply } from "../src/control/protocol.js"
import { productionControlDependencies, runControl } from "../src/cli/control.js"
import { inspectHandlerGeneration } from "../src/platform/singleton.js"
import { acpFixture } from "./acp-support.js"
import { fileExists, until } from "./control-support.js"

for (const coordination of ["reject", "hold"] as const) test(`local runtime remains usable with ${coordination} task startup`, { timeout: 60000 }, async t => {
  const f = await acpFixture(t, { coordination }), peer = await f.connect()
  if (coordination === "hold") await until(async () => await fileExists(join(f.root, "coordination-entered")) ? true : undefined)
  assert.equal((await f.choices()).state, "choices")
  await peer.request("initialize", { protocolVersion: 1 })
  const session = await peer.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const roster = await f.human({ op: "agent_roster", input: { limit: 100 } })
  assert.equal(roster.state, "page")
  assert.ok(roster.state === "page" && roster.agents.length === 1)
  const prompt = peer.request("session/prompt", { sessionId: session.sessionId!, prompt: [{ type: "text", text: "permission" }] })
  await peer.next("session/request_permission")
  const pending = await f.human({ op: "agent_permissions" })
  assert.ok(pending.state === "permissions")
  const offer = pending.snapshot.pending[0]!
  const answer = await f.human({ op: "agent_permission_decide", commandId: randomUUID(), ref: offer.ref, optionId: String(offer.options[0]!.optionId) })
  assert.ok(answer.state === "permission" && answer.receipt?.state === "applied")
  assert.equal((await prompt).stopReason, "end_turn")
  assert.equal((await f.requests("codex-acp")).filter(frame => frame.result?.outcome).length, 1)
  if (coordination === "reject") for (const op of ["status"] as const) {
    const reply = parseReply(await f.control({ protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: offer.ref.target.handlerGeneration, op }))
    assert.ok(reply.ok && reply.result && "phase" in reply.result)
    const issue = reply.result.issues?.find(issue => issue.message.includes("fixture coordination unavailable"))
    assert.ok(issue && isAbsolute(issue.path))
    assert.equal(reply.result.phase, "ready")
    const output: string[] = []
    assert.equal(await runControl(["doctor", "--json"], { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), inspect: env => inspectHandlerGeneration(env.paths.runtimeRoot, env.adapter), call: (_env, request) => f.control(request), stdout: text => output.push(text) }), 0)
    const diagnostic = JSON.parse(output.join(""))
    assert.ok(diagnostic.result.runtimeIssues.some((issue: { path: string; message: string }) => isAbsolute(issue.path) && issue.message.includes("fixture coordination unavailable")))
  }
  await f.stopSession(String(session.sessionId))
  peer.close()
  await f.verifyZeroSurvivors()
})