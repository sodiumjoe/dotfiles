import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentIndex, type IndexEntry } from "../src/agent/agent-index.js"

const entry = (agentId: string): IndexEntry => ({ version: 1, agentId, backendId: "codex-acp", nativeSessionId: "s-" + agentId, cwd: "/work", createdAt: "2026-11-14T00:00:00.000Z", origin: "new" })

test("the index writes each agent once and lists valid entries", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-index-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const index = createAgentIndex(root)
  assert.equal(await index.exists(), false)
  assert.equal(await index.ensure(entry("11111111-1111-4111-8111-111111111111")), true)
  assert.equal(await index.ensure({ ...entry("11111111-1111-4111-8111-111111111111"), cwd: "/changed" }), false)
  await writeFile(join(root, "agents", "index", "broken.json"), "{not json")
  assert.deepEqual((await index.list()).map(value => [value.agentId, value.cwd]), [["11111111-1111-4111-8111-111111111111", "/work"]])
  await index.remove("11111111-1111-4111-8111-111111111111")
  assert.deepEqual(await index.list(), [])
  assert.equal(await index.exists(), true)
})