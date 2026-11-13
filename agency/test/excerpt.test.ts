import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acpFixture } from "./acp-support.js"
import { runControl, productionControlDependencies } from "../src/cli/control.js"
import { claudeTurns, codexTurns, historyExcerpt, historySummary, liveExcerpt } from "../src/agent/excerpt.js"
import type { AgentRecordV3 } from "../src/agent/types.js"

const initialize = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true }, terminal: true } }
const codexLine = (role: string, type: string, text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type, text }] } })
const claudeLine = (type: string, content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra })
function record(backendId: string, sessionId: string | null, cwd: string): AgentRecordV3 {
  return { version: 3, definition: { hostId: "a".repeat(64), agentId: "00000000-0000-4000-8000-000000000001", createdCommandId: "00000000-0000-4000-8000-000000000002", cwd, backendId: backendId as never, origin: "new" },
    launch: null, phase: "stopped", session: sessionId ? { sessionId, protocolVersion: 1 } : null, inputRequirements: { mcpServerNames: [] }, settings: {} as never,
    configurationState: { verification: { kind: "unknown" }, nonRestorableOptionIds: [] }, failure: null }
}

test("history parsing keeps conversation text, drops injected blocks and tools, and merges consecutive turns", () => {
  assert.deepEqual(codexTurns([
    codexLine("user", "input_text", "<environment_context>cwd</environment_context>\n# AGENTS.md instructions for /x\nfix the build"),
    codexLine("assistant", "output_text", "Looking."), codexLine("assistant", "output_text", "Fixed it."), "{broken",
  ]), [{ role: "user", text: "fix the build" }, { role: "agent", text: "Looking. Fixed it." }])
  assert.deepEqual(claudeTurns([
    claudeLine("user", "<system-reminder>ignore</system-reminder>add a picker"),
    claudeLine("user", "meta", { isMeta: true }),
    claudeLine("assistant", [{ type: "tool_use", name: "Read" }, { type: "text", text: "Done." }]),
    claudeLine("user", [{ type: "tool_result", content: "x" }]),
  ]), [{ role: "user", text: "add a picker" }, { role: "agent", text: "Done." }])
  const long = codexTurns([codexLine("user", "input_text", "x".repeat(2000))])
  assert.equal([...long[0]!.text].length, 600)
  assert.ok(long[0]!.text.endsWith("…"))
})

test("history excerpts read the last turns of Codex and Claude files, including tails over 1 MiB", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-excerpt-")), codexHome = join(root, "codex"), claudeHome = join(root, "claude"), cwd = "/work/my.repo"
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(codexHome, "sessions", "2026", "11", "13"), { recursive: true })
  const filler = codexLine("user", "input_text", "λ".repeat(700000))
  await writeFile(join(codexHome, "sessions", "2026", "11", "13", "rollout-2026-11-13T10-00-00-codex-1.jsonl"),
    [filler, filler, codexLine("user", "input_text", "first"), codexLine("assistant", "output_text", "one"), codexLine("user", "input_text", "second"), codexLine("assistant", "output_text", "two")].join("\n"))
  const codex = await historyExcerpt({ record: record("codex-acp", "codex-1", cwd), turns: 2, codexHome, claudeHome })
  assert.deepEqual(codex, { state: "excerpt", source: "history", turns: [{ role: "user", text: "second" }, { role: "agent", text: "two" }], reason: null })
  await mkdir(join(claudeHome, "projects", "-work-my-repo"), { recursive: true })
  await writeFile(join(claudeHome, "projects", "-work-my-repo", "claude-1.jsonl"), [claudeLine("user", "hi"), claudeLine("assistant", [{ type: "text", text: "hello" }])].join("\n"))
  assert.deepEqual((await historyExcerpt({ record: record("claude-agent-acp", "claude-1", cwd), turns: 4, codexHome, claudeHome })).turns, [{ role: "user", text: "hi" }, { role: "agent", text: "hello" }])
  const missing = await historyExcerpt({ record: record("claude-agent-acp", "absent", cwd), turns: 4, codexHome, claudeHome })
  assert.equal(missing.source, "none")
  assert.equal(missing.reason, "No conversation history file")
  assert.equal((await historyExcerpt({ record: record("codex-acp", null, cwd), turns: 4, codexHome, claudeHome })).source, "none")
})

test("live excerpts come from retained events, and the CLI serves them locally", async t => {
  const f = await acpFixture(t), c = await f.connect()
  await c.request("initialize", initialize)
  const session = await c.request("session/new", { cwd: f.workspace, mcpServers: [] })
  const sessionId = String(session.sessionId), agentId = sessionId.slice(7)
  await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })
  const live = await f.human({ op: "agent_excerpt", input: { agentId, turns: 4 } })
  assert.deepEqual(live, { state: "excerpt", source: "live", turns: [{ role: "user", text: "hello" }, { role: "agent", text: "answer:hello" }], reason: null })
  const production = productionControlDependencies()
  let output = ""
  const code = await runControl(["roster", "excerpt", agentId, "--local", "--json"], { ...production, environment: async () => ({ paths: f.paths, adapter: f.adapter }),
    cwd: () => f.workspace, start: async () => { throw new Error("automatic startup forbidden") }, stdout: value => { output += value }, stderr: () => {} })
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(output).result, live)
  c.close()
  await f.stopSession(sessionId)
  const stopped = await f.human({ op: "agent_excerpt", input: { agentId, turns: 4 } })
  assert.equal(stopped.state, "excerpt")
  assert.equal((stopped as { source: string }).source, "none")
  await f.verifyZeroSurvivors()
})

test("live excerpts include replayed history and ignore echoed prompt chunks", () => {
  const event = (value: Record<string, unknown>, seq: number) => ({ ...value, seq, encodedBytes: 1 }) as never
  assert.deepEqual(liveExcerpt([
    event({ kind: "update", replay: true, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier" } } }, 1),
    event({ kind: "update", replay: true, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply" } } }, 2),
    event({ kind: "submitted", submissionId: "s", text: "now" }, 3),
    event({ kind: "update", replay: false, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "now" } } }, 4),
    event({ kind: "update", replay: false, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } }, 5),
  ], 4), [{ role: "user", text: "earlier" }, { role: "agent", text: "reply" }, { role: "user", text: "now" }, { role: "agent", text: "ok" }])
})

test("history excerpts read further back when the last 1 MiB has no user turn", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-excerpt-")), codexHome = join(root, "codex"), claudeHome = join(root, "claude")
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(codexHome, "sessions", "2026", "11", "13"), { recursive: true })
  const tool = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(200000) } })
  await writeFile(join(codexHome, "sessions", "2026", "11", "13", "rollout-2026-11-13T10-00-00-long-1.jsonl"),
    [codexLine("user", "input_text", "earlier"), codexLine("assistant", "output_text", "ok"), codexLine("user", "input_text", "the real question"), ...Array(8).fill(tool), codexLine("assistant", "output_text", "done")].join("\n"))
  const excerpt = await historyExcerpt({ record: record("codex-acp", "long-1", "/work/x"), turns: 2, codexHome, claudeHome })
  assert.deepEqual(excerpt.turns, [{ role: "user", text: "the real question" }, { role: "agent", text: "done" }])
})

test("history summaries take the first real prompt as the title and the file time as activity", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-excerpt-")), codexHome = join(root, "codex"), claudeHome = join(root, "claude")
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(claudeHome, "projects", "-work-x"), { recursive: true })
  const path = join(claudeHome, "projects", "-work-x", "claude-2.jsonl")
  await writeFile(path, [claudeLine("user", "<system-reminder>ignore</system-reminder>"), claudeLine("user", "rename the picker " + "y".repeat(400)), claudeLine("assistant", [{ type: "text", text: "ok" }])].join("\n"))
  const summary = await historySummary({ record: record("claude-agent-acp", "claude-2", "/work/x"), codexHome, claudeHome })
  assert.equal(summary.modifiedAt, (await stat(path)).mtime.toISOString())
  assert.ok(summary.title?.startsWith("rename the picker y"))
  assert.equal([...summary.title!].length, 200)
  assert.deepEqual(await historySummary({ record: record("claude-agent-acp", "absent", "/work/x"), codexHome, claudeHome }), { title: null, modifiedAt: null })
})