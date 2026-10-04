import assert from "node:assert/strict"
import test from "node:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { neovimAttachmentFixture } from "./agent-support.js"

test("two editors observe one provider across a busy detach", { timeout: 90000 }, async t => {
  const f = await neovimAttachmentFixture(t, { pauseAt: "prompt" })
  const ready = await f.waitCompleted(await f.start()), target = ready.command.target!
  const first = await f.editor(target)
  const submitted = await first.call({ op: "submit", text: "streamed λ🙂 fixture" })
  await f.waitPrompt()
  await first.exit()
  const second = await f.editor(target)
  await f.releaseBarrier()
  const complete = await second.call({ op: "wait", submissionId: submitted.submissionId })
  assert.equal(complete.state, "completed")
  assert.match(complete.transcript, /answer:streamed λ🙂 fixture/)
  assert.deepEqual(complete.target, target)
  await second.exit()
  assert.equal((await f.current()).agents[0]!.record.phase, "ready")
  const requests = await f.providerRequests()
  assert.equal(requests.filter(row => row.method === "session/prompt").length, 1)
  assert.equal(requests.filter(row => row.method === "session/cancel").length, 0)
  await f.stopAndVerify(target)
})

test("editor cancellation targets the observed turn and leaves the provider usable", { timeout: 90000 }, async t => {
  const f = await neovimAttachmentFixture(t, { providerScenario: "cancel" })
  const target = (await f.waitCompleted(await f.start())).command.target!
  const editor = await f.editor(target)
  const first = await editor.call({ op: "submit", text: "cancel this" })
  const cancel = await editor.call({ op: "request", body: { op: "cancel", submissionId: first.submissionId } })
  assert.equal(cancel.failure, undefined)
  const cancelled = await editor.call({ op: "wait", submissionId: first.submissionId })
  assert.equal(cancelled.state, "completed")
  const receipt = await editor.call({ op: "request", body: { op: "inspect-submission", submissionId: first.submissionId } })
  assert.equal(receipt.receipt.stopReason, "cancelled")
  const second = await editor.call({ op: "submit", text: "usable again" })
  assert.equal((await editor.call({ op: "wait", submissionId: second.submissionId })).state, "completed")
  const requests = await f.providerRequests()
  assert.equal(requests.filter(row => row.method === "session/cancel").length, 1)
  assert.equal(requests.filter(row => row.method === "session/new").length, 1)
  await editor.exit()
  await f.stopAndVerify(target)
})

test("the editor reads all agents in a nongit cwd without changing its attached tuple", { timeout: 90000 }, async t => {
  const f = await neovimAttachmentFixture(t)
  const a = (await f.waitCompleted(await f.start())).command.target!
  const b = (await f.waitCompleted(await f.start())).command.target!
  const editor = await f.editor(a)
  const current = await editor.call({ op: "command", argv: ["agent", "page", "--limit", "100", "--cwd", f.workspace, "--active"], cwd: f.workspace })
  assert.equal(current.failure, undefined)
  assert.deepEqual(current.result.result.agents.map((row: any) => row.record.definition.agentId).sort(), [a.agentId, b.agentId].sort())
  assert.deepEqual((await editor.call({ op: "snapshot" })).target, a)
  const other = await editor.call({ op: "command", argv: ["agent", "page", "--limit", "100", "--cwd", f.otherWorkspace, "--active"], cwd: f.otherWorkspace })
  assert.deepEqual(other.result.result.agents, [])
  await editor.exit()
  await f.stopAndVerify(a)
  await f.stopAndVerify(b)
})

test("maximum editor turn and complete native replay retain the native conversation", { timeout: 90000 }, async t => {
  const f = await neovimAttachmentFixture(t, { providerScenario: "large-replay" })
  const target = (await f.waitCompleted(await f.start())).command.target!
  const editor = await f.editor(target)
  const submitted = await editor.call({ op: "submit", bytes: 262144 })
  const completed = await editor.call({ op: "wait", submissionId: submitted.submissionId })
  assert.equal(completed.answerBytes, 786432)
  assert.equal(completed.metadata.title.title.length, 1024)
  assert.equal(completed.metadata.title.titleOriginalBytes, 262144)
  assert.equal(completed.metadata.title.titleTruncated, true)
  await editor.exit()
  await f.stopAndVerify(target)
  const restored = await f.waitCompleted(await f.restore(target.agentId))
  assert.equal(restored.command.result?.outcome, "restored")
  assert.notEqual(restored.command.target!.providerGeneration, target.providerGeneration)
  const replay = await f.editor(restored.command.target!)
  assert.equal(replay.initial.answerBytes, 786432)
  assert.equal(replay.initial.userBytes, 262144)
  assert.equal(replay.initial.replay, 3)
  assert.equal(replay.initial.hooks, 0)
  await replay.exit()
  const requests = await f.providerRequests()
  assert.equal(requests.filter(row => row.method === "session/new").length, 1)
  assert.equal(requests.filter(row => row.method === "session/load").length, 1)
  assert.equal(requests.filter(row => row.method === "session/prompt").length, 1)
  await f.stopAndVerify(restored.command.target!)
})

for (const [kind, code] of [["frame", "ACP_FRAME_LIMIT"], ["history", "ACP_HISTORY_LIMIT"]]) {
  test(`native ${kind} overflow fails restore without creating a replacement session`, { timeout: 90000 }, async t => {
    const f = await neovimAttachmentFixture(t, { providerScenario: "large-replay" })
    const target = (await f.waitCompleted(await f.start())).command.target!
    const editor = await f.editor(target)
    await editor.exit()
    await f.stopAndVerify(target)
    await writeFile(join(f.root, "replay-limit"), kind!, { mode: 0o600 })
    const restored = await f.waitCompleted(await f.restore(target.agentId))
    assert.equal(restored.command.result?.outcome, "failed")
    assert.equal(restored.command.result?.failure?.code, code)
    assert.equal((await f.providerRequests()).filter(row => row.method === "session/new").length, 1)
    assert.equal((await f.providerRequests()).filter(row => row.method === "session/load").length, 1)
    await f.verifyZeroSurvivors()
  })
}

test("fragmented UTF-8 reaches real MessageWriter unchanged", { timeout: 90000 }, async t => {
  const f = await neovimAttachmentFixture(t, { providerScenario: "utf8" })
  const target = (await f.waitCompleted(await f.start())).command.target!
  const editor = await f.editor(target)
  const submitted = await editor.call({ op: "submit", text: "λ🙂" })
  const result = await editor.call({ op: "wait", submissionId: submitted.submissionId })
  assert.match(result.transcript, /answer:λ🙂/)
  assert.equal(result.answerBytes, Buffer.byteLength("answer:λ🙂"))
  await editor.exit()
  await f.stopAndVerify(target)
})

test("live visible and hidden views remain bounded over several retention windows", { timeout: 90000 }, async t => {
  const f = await neovimAttachmentFixture(t, { providerScenario: "tools" })
  const target = (await f.waitCompleted(await f.start())).command.target!
  const editor = await f.editor(target, { projection_limits: { history_bytes: 32768, history_events: 32 }, view_limits: { text_bytes: 8192, lines: 100, tool_count: 8, tool_string_bytes: 8192 } })
  for (let round = 0; round < 4; round++) {
    const submitted = await editor.call({ op: "submit", text: `tools ${round}` })
    const result = await editor.call({ op: "wait", submissionId: submitted.submissionId })
    assert.equal(result.state, "completed")
    assert.equal(result.historyTruncated, true)
    assert.ok(result.retention.events <= 32)
    for (const metrics of result.views) {
      assert.ok(metrics.text_bytes <= 8192)
      assert.ok(metrics.lines <= 100)
      assert.ok(metrics.tool_count <= 8)
      assert.ok(metrics.tool_string_bytes <= 8192)
    }
    assert.deepEqual(result.views[1], { text_bytes: 0, lines: 0, tool_count: 0, tool_string_bytes: 0 })
  }
  await editor.call({ op: "draft", view: 2, text: "retained hidden draft" })
  const shown = await editor.call({ op: "show", view: 2 })
  assert.ok(shown.views[1].text_bytes > 0)
  const hidden = await editor.call({ op: "hide", view: 2 })
  assert.equal(hidden.views[1].text_bytes, 0)
  await editor.exit()
  assert.equal((await f.providerRequests()).filter(row => row.method === "session/prompt").length, 4)
  await f.stopAndVerify(target)
})