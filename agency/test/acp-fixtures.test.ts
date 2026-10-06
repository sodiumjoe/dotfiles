import assert from "node:assert/strict"
import test from "node:test"
import { providerFixture } from "./acp-support.js"

for (const backend of ["codex-acp", "claude-agent-acp"] as const) test(`isolated ${backend} fixture preserves structured payload and colliding native IDs`, async t => {
  const f = await providerFixture(t, backend)
  const init = await f.peer.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  assert.equal(init.protocolVersion, 1)
  const session = await f.peer.request("session/new", { cwd: f.workspace, mcpServers: [], _meta: { test: "preserved" } })
  assert.equal(session.sessionId, "native-session")
  if (backend === "codex-acp") assert.ok(session.configOptions)
  else assert.ok(session.models)
  const prompt = [{ type: "text", text: "question" }, { type: "resource_link", uri: "file:///context", name: "context" }]
  assert.deepEqual(await f.peer.request("session/prompt", { sessionId: "native-session", prompt }), { stopReason: "end_turn" })
  const frames = await f.requests()
  assert.deepEqual(frames.find(frame => frame.method === "session/new")?.params?._meta, { test: "preserved" })
  assert.deepEqual(frames.find(frame => frame.method === "session/prompt")?.params?.prompt, prompt)
})

test("fixture permission barrier completes only after a decision", async t => {
  const f = await providerFixture(t), peer = f.peer
  await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  await peer.request("session/new", { cwd: f.workspace, mcpServers: [] })
  let settled = false
  const prompt = peer.request("session/prompt", { sessionId: "native-session", prompt: [{ type: "text", text: "permission" }] }).then(result => { settled = true; return result })
  const permission = await peer.next("session/request_permission")
  assert.equal(permission.id, 1)
  assert.equal(settled, false)
  peer.respond(permission.id, { outcome: { outcome: "selected", optionId: "allow-once" } })
  assert.deepEqual(await prompt, { stopReason: "end_turn" })
  assert.equal((await f.requests()).filter(frame => frame.result?.outcome).length, 1)
})
