import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
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