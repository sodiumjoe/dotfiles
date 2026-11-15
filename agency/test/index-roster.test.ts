import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentIndex } from "../src/agent/agent-index.js"
import { readIndexRoster } from "../src/agent/index-roster.js"

test("the index roster shows titles, sorts by activity, and tolerates missing files", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-roster-")), homes = { codexHome: join(root, "codex"), claudeHome: join(root, "claude") }
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(homes.claudeHome, "projects", "-work")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "older.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "older title" } }))
  await writeFile(join(dir, "newer.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "newer title" } }))
  await utimes(join(dir, "older.jsonl"), new Date("2026-11-01"), new Date("2026-11-01"))
  const index = createAgentIndex(join(root, "state"))
  const base = { version: 1 as const, cwd: "/work", createdAt: "2026-11-14T00:00:00.000Z", origin: "new" as const }
  await index.ensure({ ...base, agentId: "11111111-1111-4111-8111-111111111111", backendId: "claude-agent-acp", nativeSessionId: "older" })
  await index.ensure({ ...base, agentId: "22222222-2222-4222-8222-222222222222", backendId: "claude-agent-acp", nativeSessionId: "newer" })
  await index.ensure({ ...base, agentId: "33333333-3333-4333-8333-333333333333", backendId: "codex-acp", nativeSessionId: "gone" })
  const rows = await readIndexRoster({ index, homes })
  assert.deepEqual(rows.map(row => [row.title, row.backendId]), [["newer title", "claude-agent-acp"], ["older title", "claude-agent-acp"], [null, "codex-acp"]])
})