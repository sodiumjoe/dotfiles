import assert from "node:assert/strict"
import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { discoverCodexSessions } from "../src/agent/native-sessions.js"
import { runControl, type ControlDependencies } from "../src/cli/control.js"

async function fixture(t: TestContext, records: unknown[], suffix = "\n") {
  const root = await mkdtemp(join(tmpdir(), "agency-native-sessions-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "rollout.jsonl")
  await writeFile(path, records.map(record => typeof record === "string" ? record : JSON.stringify(record)).join("\n") + suffix)
  await utimes(path, new Date("2026-11-06T12:00:00Z"), new Date("2026-11-06T12:00:00Z"))
  return { root, path }
}
const meta = { type: "session_meta", payload: { id: "native-one", cwd: "/tmp/project" } }
const message = (role: string, text: string) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } })

test("native titles use the first user request after large developer records and injected instructions", async t => {
  const f = await fixture(t, [meta, message("developer", "d".repeat(450000)),
    message("user", "# AGENTS.md instructions\n<INSTRUCTIONS>Do not use this as a title</INSTRUCTIONS>\n<environment_context>cwd</environment_context>"),
    message("user", "<environment_context>cwd</environment_context>"),
    message("user", "Fix the restore picker\n<environment_info>\n- Editor: Neovim\n</environment_info>"),
    message("user", "proceed")])
  assert.deepEqual(await discoverCodexSessions(f.root), [{ backendId: "codex-acp", nativeSessionId: "native-one",
    cwd: "/tmp/project", title: "Fix the restore picker", updatedAt: "2026-11-06T12:00:00.000Z" }])
})

test("event-message user requests provide titles without response items", async t => {
  const f = await fixture(t, [meta, { type: "event_msg", payload: { type: "user_message", message: "Review the parser\nplease" } }], "")
  assert.equal((await discoverCodexSessions(f.root))[0]?.title, "Review the parser please")
})

test("declared titles take precedence over user requests", async t => {
  const f = await fixture(t, [{ ...meta, payload: { ...meta.payload, title: "Named conversation" } }, message("user", "first request")])
  assert.equal((await discoverCodexSessions(f.root))[0]?.title, "Named conversation")
})

test("long Unicode prompts are bounded without losing the saved session", async t => {
  const f = await fixture(t, [meta, message("user", "🙂".repeat(400))])
  const sessions = await discoverCodexSessions(f.root)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]?.title, "🙂".repeat(256))
})

test("malformed later records do not hide valid session metadata or later requests", async t => {
  const f = await fixture(t, [meta, "{bad record", { type: "response_item", payload: null }, message("assistant", "not a title"), message("user", "Actual request")])
  assert.equal((await discoverCodexSessions(f.root))[0]?.title, "Actual request")
})

test("the title scan stops at its byte limit and retains untitled sessions", async t => {
  const f = await fixture(t, [meta, message("developer", "d".repeat(1100000)), message("user", "Beyond the scan")])
  const sessions = await discoverCodexSessions(f.root)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]?.title, null)
})

test("symlinks and oversized metadata headers remain excluded", async t => {
  const f = await fixture(t, [{ ...meta, payload: { ...meta.payload, extra: "x".repeat(65536) } }])
  await symlink(f.path, join(f.root, "linked.jsonl"))
  assert.deepEqual(await discoverCodexSessions(f.root), [])
})

test("native-session CLI reads titles without connecting to or restarting Handler", async t => {
  const f = await fixture(t, [meta, message("user", "Recognizable saved request")])
  let stdout = "", stderr = ""
  const deps = new Proxy({ nativeSessionRoot: () => f.root,
    stdout: (text: string) => { stdout += text }, stderr: (text: string) => { stderr += text } }, {
    get(target, key) { if (!(key in target)) throw new Error("Unexpected Handler dependency: " + String(key)); return Reflect.get(target, key) },
  }) as unknown as ControlDependencies
  assert.equal(await runControl(["native-sessions", "--json"], deps), 0)
  const envelope = JSON.parse(stdout)
  assert.equal(envelope.ok, true)
  assert.equal(envelope.handlerGeneration, null)
  assert.equal(envelope.result.sessions[0]?.title, "Recognizable saved request")
  assert.equal(stderr, "")
})

test("native-session CLI rejects unsupported arguments before reading history", async () => {
  let stdout = ""
  const deps = { stdout: (text: string) => { stdout += text }, stderr: () => {},
    nativeSessionRoot: () => { throw new Error("Unexpected history scan") } } as unknown as ControlDependencies
  assert.equal(await runControl(["native-sessions", "--stop-agents", "--json"], deps), 64)
  assert.equal(JSON.parse(stdout).error.code, "USAGE")
})