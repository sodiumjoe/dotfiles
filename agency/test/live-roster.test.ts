import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentIndex } from "../src/agent/agent-index.js"
import { createRoster, parseRosterRow } from "../src/live/roster.js"
import { createLiveTable } from "../src/live/state.js"

test("a missing Codex rollout is looked for again only after its agent stops or when another agent is indexed", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-live-roster-")), homes = { codexHome: join(root, "codex"), claudeHome: join(root, "claude") }
  t.after(() => rm(root, { recursive: true, force: true }))
  const day = join(homes.codexHome, "sessions/2026/11/14"), index = createAgentIndex(join(root, "state")), roster = createRoster({ index, homes }), table = createLiveTable()
  await mkdir(day, { recursive: true })
  const rollout = (sessionId: string, text: string) => writeFile(join(day, "rollout-2026-11-14T10-00-00-" + sessionId + ".jsonl"), JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }) + "\n")
  const indexed = (agentId: string, nativeSessionId: string) => index.ensure({ version: 1, agentId, backendId: "codex-acp", nativeSessionId, cwd: "/work", createdAt: "2026-11-14T00:00:00.000Z", origin: "new" })
  const titles = async () => Object.fromEntries((await roster.rows(table)).map(row => [row.agentId, row.title]))
  const first = randomUUID(), second = randomUUID()
  await indexed(first, "first-session")
  assert.deepEqual(await titles(), { [first]: null })
  await rollout("first-session", "late")
  assert.deepEqual(await titles(), { [first]: null })
  roster.changed("first-session")
  assert.deepEqual(await titles(), { [first]: "late" })
  await indexed(second, "second-session")
  await rollout("second-session", "second")
  assert.deepEqual(await titles(), { [first]: "late", [second]: "second" })
})
test("the roster shows titles, sorts by activity, and tolerates a missing session file", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-live-roster-")), homes = { codexHome: join(root, "codex"), claudeHome: join(root, "claude") }
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(homes.claudeHome, "projects", "-work")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "older.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "older title" } }))
  await writeFile(join(dir, "newer.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "newer title" } }))
  await utimes(join(dir, "older.jsonl"), new Date("2026-11-01"), new Date("2026-11-01"))
  const index = createAgentIndex(join(root, "state")), roster = createRoster({ index, homes })
  const base = { version: 1 as const, cwd: "/work", createdAt: "2026-11-14T00:00:00.000Z", origin: "new" as const }
  await index.ensure({ ...base, agentId: "11111111-1111-4111-8111-111111111111", backendId: "claude-agent-acp", nativeSessionId: "older" })
  await index.ensure({ ...base, agentId: "22222222-2222-4222-8222-222222222222", backendId: "claude-agent-acp", nativeSessionId: "newer" })
  await index.ensure({ ...base, agentId: "33333333-3333-4333-8333-333333333333", backendId: "codex-acp", nativeSessionId: "gone" })
  const rows = await roster.rows(createLiveTable())
  assert.deepEqual(rows.map(row => [row.title, row.backendId]), [["newer title", "claude-agent-acp"], ["older title", "claude-agent-acp"], [null, "codex-acp"]])
})

test("a remote row keeps attention counts and treats rows from older devboxes as zero", () => {
  const base = { agentId: "00000000-0000-4000-8000-000000000002", backendId: "codex-acp", cwd: "/w", createdAt: "2026-11-18T00:00:00.000Z", title: null, lastActivityAt: null }
  const live = { activity: "working", handlerGeneration: "00000000-0000-4000-8000-000000000001", providerGeneration: "00000000-0000-4000-8000-000000000003", model: null, mode: null }
  const current = parseRosterRow({ ...base, live: { ...live, pendingApprovals: 2, editors: 1 } }).live!
  const older = parseRosterRow({ ...base, live }).live!
  assert.deepEqual([current.pendingApprovals, current.editors, older.pendingApprovals, older.editors], [2, 1, 0, 0])
  for (const bad of [-1, 1.5, "1"]) assert.throws(() => parseRosterRow({ ...base, live: { ...live, pendingApprovals: bad } }), /INVALID_HOST_REPLY/)
})