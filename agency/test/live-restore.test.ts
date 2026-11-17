import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { liveHandlerFixture } from "./live-support.js"
import { until } from "./control-support.js"
import { createAgentIndex } from "../src/agent/agent-index.js"
import { createAgentStore } from "../src/agent/store.js"
import { parseAgentRecordV3 } from "../src/agent/types.js"

test("an agent restored after the Handler is killed continues its session, and an unprompted agent is gone", async t => {
  const f = await liveHandlerFixture(t), used = await f.start()
  await f.prompt(used.agentId, "hello")
  const unused = await f.start()
  await f.crashHandler()
  for (const item of f.providers()) if (item.pid) await until(async () => await f.observe(item.pid!) === null ? true : undefined, 10000)
  await f.restart()
  const rows = await f.agents()
  assert.deepEqual(rows.map(row => [row.agentId, row.title, row.live]), [[used.agentId, "hello", null]])
  assert.ok(rows[0]!.lastActivityAt)
  assert.deepEqual(await f.failure(f.restore(unused.agentId)), { code: "NOT_FOUND", message: "agent " + unused.agentId + " is not known on this host" })
  const restored = await f.restore(used.agentId)
  assert.equal(restored.live?.activity, "idle")
  assert.deepEqual(await f.restore(used.agentId), restored)
  const [entry] = await createAgentIndex(f.paths.persistentRoot).list()
  assert.deepEqual((await f.providerRequests()).filter(frame => frame.method === "session/load").map(frame => frame.params?.sessionId), [entry!.nativeSessionId])
  assert.equal((await f.prompt(used.agentId, "again")).text, "answer:again")
  await f.verifyZeroSurvivors()
})

test("prompting a stopped agent restores it first, and its history stays readable once it is stopped again", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start({ backendId: "claude-agent-acp" })
  await f.prompt(agentId, "first")
  const stopped = await f.stop(agentId)
  assert.deepEqual([stopped.live, stopped.title], [null, "first"])
  assert.deepEqual(await f.stop(agentId), stopped)
  assert.equal((await f.prompt(agentId, "second")).text, "answer:second")
  assert.deepEqual((await f.providerRequests("claude-agent-acp")).filter(frame => frame.method === "session/new" || frame.method === "session/load").map(frame => frame.method), ["session/new", "session/load"])
  assert.deepEqual(await f.excerpt(agentId), { state: "excerpt", source: "live", turns: [{ role: "user", text: "second" }, { role: "agent", text: "answer:second" }], reason: null })
  await f.stop(agentId)
  const turns = [{ role: "user", text: "first" }, { role: "agent", text: "answer:first" }, { role: "user", text: "second" }, { role: "agent", text: "answer:second" }]
  assert.deepEqual(await f.excerpt(agentId), { state: "excerpt", source: "history", turns, reason: null })
  assert.deepEqual(await f.transcript(agentId), { state: "transcript", agentId, turns, truncated: false, reason: null })
  await f.verifyZeroSurvivors()
})

test("a prompt and a restore of one stopped agent arriving together restore it once", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  await f.prompt(agentId, "first")
  await f.stop(agentId)
  const [restored, answer] = await Promise.all([f.restore(agentId), f.prompt(agentId, "second")])
  assert.deepEqual([restored.agentId, answer.text], [agentId, "answer:second"])
  assert.equal((await f.providerRequests()).filter(frame => frame.method === "session/load").length, 1)
  assert.equal(f.providers().length, 2)
  await f.verifyZeroSurvivors()
})

test("the roster shows a live agent's model and mode, and starting a known agent restores it unless its backend or directory differ", async t => {
  const f = await liveHandlerFixture(t), first = await f.start({ mode: "read-only" })
  assert.deepEqual([first.live?.model, first.live?.mode], ["model-a", "read-only"])
  await f.prompt(first.agentId, "hello")
  await f.stop(first.agentId)
  assert.equal((await f.failure(f.start({ agentId: first.agentId, cwd: f.otherWorkspace }))).code, "INVALID")
  assert.equal((await f.failure(f.start({ agentId: first.agentId, backendId: "claude-agent-acp" }))).code, "INVALID")
  const again = await f.start({ agentId: first.agentId })
  assert.deepEqual([again.live?.activity, again.live?.mode, again.title], ["idle", "read-only", "hello"])
  assert.equal((await f.providerRequests()).filter(frame => frame.method === "session/load").length, 1)
  await f.verifyZeroSurvivors()
})

test("forget removes a stopped agent and refuses a live one, and an agent whose session file is gone cannot be restored", async t => {
  const f = await liveHandlerFixture(t), kept = await f.start(), lost = await f.start()
  await f.prompt(kept.agentId, "hello"); await f.prompt(lost.agentId, "hello")
  assert.equal((await f.failure(f.forget(kept.agentId))).code, "INVALID")
  await f.stop(kept.agentId); await f.stop(lost.agentId)
  assert.deepEqual(await f.forget(kept.agentId), { state: "forgotten", agentId: kept.agentId })
  assert.deepEqual((await f.agents()).map(row => row.agentId), [lost.agentId])
  assert.equal((await f.failure(f.restore(kept.agentId))).code, "NOT_FOUND")
  const [entry] = await createAgentIndex(f.paths.persistentRoot).list()
  await rm(join(f.homes, "codex/sessions/2026/11/14", "rollout-2026-11-14T10-00-00-" + entry!.nativeSessionId + ".jsonl"))
  assert.deepEqual(await f.failure(f.restore(lost.agentId)), { code: "NOT_FOUND", message: "agent " + lost.agentId + " cannot be restored: its codex-acp session file is missing" })
  assert.ok((await f.events()).some(event => event.type === "agent_forgotten" && event.agentId === kept.agentId))
  await f.verifyZeroSurvivors()
})

test("a Handler whose index has not been migrated lists every migrated agent as soon as it is ready", async t => {
  const f = await liveHandlerFixture(t), store = createAgentStore(f.paths.persistentRoot), day = join(f.homes, "codex/sessions/2026/11/14"), ids: string[] = []
  await f.stopHandler()
  await mkdir(day, { recursive: true })
  for (let count = 0; count < 200; count++) {
    const agentId = randomUUID(), sessionId = "native-" + randomUUID()
    ids.push(agentId)
    await store.writeAgent(parseAgentRecordV3({ version: 3, definition: { hostId: f.paths.hostKey, agentId, createdCommandId: randomUUID(), cwd: f.workspace, backendId: "codex-acp", origin: "import" }, launch: null, phase: "stopped", session: { sessionId, protocolVersion: 1 }, inputRequirements: { mcpServerNames: [] }, settings: {}, configurationState: { verification: { kind: "unknown" }, nonRestorableOptionIds: [] }, failure: null }), null)
    await writeFile(join(day, "rollout-2026-11-14T10-00-00-" + sessionId + ".jsonl"), JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "imported" }] } }) + "\n")
  }
  await rm(join(f.paths.persistentRoot, "agents/index"), { recursive: true, force: true })
  await f.restart()
  const rows = await f.agents()
  assert.deepEqual(rows.map(row => row.agentId).sort(), ids.sort())
  assert.ok(rows.every(row => row.title === "imported" && row.live === null))
  await f.verifyZeroSurvivors()
})

test("a live agent's title and last activity come from memory, so its session file is not read while it is live", async t => {
  const f = await liveHandlerFixture(t), { agentId } = await f.start()
  await f.prompt(agentId, "hello")
  await f.stop(agentId)
  const stopped = (await f.agents()).find(row => row.agentId === agentId)!
  const restored = await f.restore(agentId)
  assert.deepEqual([restored.title, restored.lastActivityAt], ["hello", stopped.lastActivityAt])
  const [entry] = await createAgentIndex(f.paths.persistentRoot).list()
  await rm(join(f.homes, "codex/sessions/2026/11/14", "rollout-2026-11-14T10-00-00-" + entry!.nativeSessionId + ".jsonl"))
  const live = (await f.agents()).find(row => row.agentId === agentId)!
  assert.deepEqual([live.title, live.lastActivityAt, live.live?.activity], ["hello", stopped.lastActivityAt, "idle"])
  await f.verifyZeroSurvivors()
})