import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentIndex } from "../src/agent/agent-index.js"
import { createRoster } from "../src/live/roster.js"
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