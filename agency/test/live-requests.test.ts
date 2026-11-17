import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { liveHandlerFixture } from "./live-support.js"
import { until } from "./control-support.js"
import { PROTOCOL } from "../src/control/protocol.js"

test("start, prompt and stop reply once their state is reached, and repeating them changes nothing", async t => {
  const f = await liveHandlerFixture(t), agentId = randomUUID(), submissionId = randomUUID()
  const started = await f.start({ agentId })
  assert.deepEqual([started.agentId, started.backendId, started.cwd, started.live?.activity, started.live?.model], [agentId, "codex-acp", f.workspace, "idle", "model-a"])
  assert.deepEqual(await f.start({ agentId }), started)
  const answer = await f.prompt(agentId, "hello", submissionId)
  assert.deepEqual([answer.stopReason, answer.text], ["end_turn", "answer:hello"])
  assert.deepEqual(await f.prompt(agentId, "hello", submissionId), answer)
  const requests = await f.providerRequests()
  assert.equal(requests.filter(frame => frame.method === "session/new").length, 1)
  assert.equal(requests.filter(frame => frame.method === "session/prompt").length, 1)
  const unprompted = await f.start()
  assert.equal((await f.stop(unprompted.agentId)).live, null)
  assert.deepEqual(await f.failure(f.stop(unprompted.agentId)), { code: "NOT_FOUND", message: "agent " + unprompted.agentId + " is not known on this host" })
  assert.equal((await f.failure(f.prompt(unprompted.agentId, "hello"))).code, "NOT_FOUND")
  await f.verifyZeroSurvivors()
})

test("concurrent starts of one agent share one launch, and a conflicting start fails INVALID", async t => {
  const f = await liveHandlerFixture(t), agentId = randomUUID()
  const [first, second] = await Promise.all([f.start({ agentId }), f.start({ agentId })])
  assert.deepEqual(first, second)
  assert.deepEqual(await f.failure(f.start({ agentId, cwd: f.otherWorkspace })), { code: "INVALID", message: "agent " + agentId + " already exists with backend codex-acp in " + f.workspace })
  assert.equal((await f.failure(f.start({ agentId, backendId: "claude-agent-acp" }))).code, "INVALID")
  assert.equal(f.providers().length, 1)
  assert.equal((await f.providerRequests()).filter(frame => frame.method === "session/new").length, 1)
  await f.verifyZeroSurvivors()
})

test("a provider that dies during a turn fails the prompt with its exit status, and both reach the log", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  const failure = await f.failure(f.prompt(agentId, "fail"))
  assert.equal(failure.code, "FAILED")
  assert.match(failure.message, /^agent [0-9a-f-]+ failed: provider process ended \(exit code 2\)/)
  await until(async () => (await f.agents()).every(row => row.live === null) ? true : undefined)
  const logged = (await f.events()).filter(event => event.agentId === agentId)
  assert.ok(logged.some(event => event.type === "agent_failed" && /exit code 2/.test(String(event.message))))
  assert.ok(logged.some(event => event.type === "request_failed" && event.op === "prompt" && event.code === "FAILED" && event.message === failure.message))
  await f.verifyZeroSurvivors()
})

test("a malformed provider update is dropped and logged while the agent and its turn carry on", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  const answer = await f.prompt(agentId, "malformed-update")
  assert.equal(answer.text, "answer:malformed-update")
  assert.equal((await f.agents()).find(row => row.agentId === agentId)?.live?.activity, "idle")
  const dropped = await until(async () => (await f.events()).find(event => event.agentId === agentId && event.type === "provider_update_dropped"))
  assert.deepEqual([dropped.method, dropped.sessionUpdate, dropped.reason], ["session/update", "tool_call_update", "invalid update"])
  assert.match(String(dropped.excerpt), /stalled/)
  assert.ok(!(await f.events()).some(event => event.agentId === agentId && event.type === "agent_failed"))
  assert.equal((await f.prompt(agentId, "hello")).text, "answer:hello")
})

test("an idle-required shutdown refuses while a turn runs and leaves the agent usable", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  const held = f.prompt(agentId, "held")
  await until(async () => (await f.providerRequests()).some(frame => frame.method === "session/prompt") ? true : undefined)
  const current = await f.handler()
  const refused = await f.call({ protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: current.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true, requireIdle: true })
  assert.ok(!refused.ok && refused.error.code === "BUSY")
  assert.equal((await f.agents())[0]?.live?.activity, "working")
  await f.releasePrompts()
  assert.equal((await held).stopReason, "end_turn")
  assert.equal((await f.prompt(agentId, "again")).text, "answer:again")
  await f.verifyZeroSurvivors()
})

test("a prompt the provider refuses fails FAILED with the provider's own message", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  assert.deepEqual(await f.failure(f.prompt(agentId, "provider-busy")), { code: "FAILED", message: "Provider busy" })
  assert.equal((await f.prompt(agentId, "again")).text, "answer:again")
  await f.verifyZeroSurvivors()
})

test("an agent whose stop could not be verified is not started again by a later prompt", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  await f.failCleanup()
  assert.equal((await f.failure(f.stop(agentId))).code, "FAILED")
  assert.equal((await f.failure(f.prompt(agentId, "again"))).code, "UNAVAILABLE")
  assert.equal(f.providers().length, 1)
  await f.verifyZeroSurvivors()
})
test("a provider learns the Agency agent it runs as from its environment", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start({ backendId: "claude-agent-acp" })
  const environment = await until(async () => (await f.providerRequests("claude-agent-acp")).find(value => value.method === "fixture/environment"))
  assert.equal(environment.params?.AGENCY_AGENT_ID, agentId)
  await f.verifyZeroSurvivors()
})

test("an idle-required shutdown refuses while an agent is starting and does not abort it", async t => {
  const f = await liveHandlerFixture(t)
  await f.pauseSessions()
  const starting = f.start()
  await f.waitSession()
  const refused = await f.handoff()
  assert.equal(refused.ok ? null : refused.error.code, "BUSY")
  await f.releaseSessions()
  assert.equal((await starting).live?.activity, "idle")
  await f.verifyZeroSurvivors()
})
test("a malformed backends.json fails a start with a message naming the file", async t => {
  const f = await liveHandlerFixture(t)
  await writeFile(join(f.paths.persistentRoot, "catalog/backends.json"), "{not json", { mode: 0o600 })
  const failure = await f.failure(f.start())
  assert.equal(failure.code, "UNAVAILABLE")
  assert.match(failure.message, /backends\.json/)
  assert.match(failure.message, /JSON/)
})

test("an adapter at the wrong version fails a start naming both versions", async t => {
  const f = await liveHandlerFixture(t)
  await writeFile(join(f.root, "profiles/codex-acp/adapter.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "9.9.9", main: "agent-provider.js" }), { mode: 0o600 })
  const failure = await f.failure(f.start())
  assert.match(failure.message, /9\.9\.9/)
  assert.match(failure.message, /1\.0\.0/)
})