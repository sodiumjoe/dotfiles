import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codexSessionFiles, sessionFile, sessionSummary } from "../src/agent/excerpt.js"

test("sessions are found and summarized from backend, directory and session ID", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-sessions-")), homes = { codexHome: join(root, "codex"), claudeHome: join(root, "claude") }
  t.after(() => rm(root, { recursive: true, force: true }))
  const codexDir = join(homes.codexHome, "sessions", "2026", "11", "14")
  await mkdir(codexDir, { recursive: true })
  await writeFile(join(codexDir, "rollout-2026-11-14T10-00-00-codex-1.jsonl"), JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex title" }] } }))
  const cwd = "/work/repo", claudeDir = join(homes.claudeHome, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"))
  await mkdir(claudeDir, { recursive: true })
  await writeFile(join(claudeDir, "claude-1.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "claude title" } }))
  const files = await codexSessionFiles(homes.codexHome)
  assert.equal(files.size, 1)
  assert.equal((await sessionSummary({ backendId: "codex-acp", cwd, sessionId: "codex-1" }, homes, files)).title, "codex title")
  assert.equal((await sessionSummary({ backendId: "claude-agent-acp", cwd, sessionId: "claude-1" }, homes)).title, "claude title")
  assert.equal(await sessionFile({ backendId: "codex-acp", cwd, sessionId: "missing" }, homes, files), null)
  assert.equal(await sessionFile({ backendId: "claude-agent-acp", cwd, sessionId: "missing" }, homes), null)
  assert.deepEqual(await sessionSummary({ backendId: "codex-acp", cwd, sessionId: "missing" }, homes, files), { title: null, modifiedAt: null })
})

test("a Claude session in a symlinked directory is found under its resolved path", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-sessions-")), homes = { codexHome: join(root, "codex"), claudeHome: join(root, "claude") }
  t.after(() => rm(root, { recursive: true, force: true }))
  const real = await realpath(root), linked = join(root, "linked")
  await mkdir(join(root, "target"))
  await symlink(join(real, "target"), linked)
  const dir = join(homes.claudeHome, "projects", join(real, "target").replace(/[^A-Za-z0-9]/g, "-"))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "linked-1.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "resolved title" } }))
  assert.equal((await sessionSummary({ backendId: "claude-agent-acp", cwd: linked, sessionId: "linked-1" }, homes)).title, "resolved title")
})