import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentIndex } from "../src/agent/agent-index.js"
import { migrateIndex } from "../src/agent/index-migration.js"

const record = (agentId: string, backendId: string, sessionId: string | null) => ({ version: 3, definition: { hostId: "h", agentId, createdCommandId: agentId, cwd: "/work/repo", backendId, origin: "new" }, phase: "stopped", session: sessionId ? { sessionId, protocolVersion: 1 } : null })

test("migration indexes records whose session file exists, once", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-migrate-")), homes = { codexHome: join(root, "codex"), claudeHome: join(root, "claude") }
  t.after(() => rm(root, { recursive: true, force: true }))
  const claudeDir = join(homes.claudeHome, "projects", "-work-repo")
  await mkdir(claudeDir, { recursive: true })
  await writeFile(join(claudeDir, "kept.jsonl"), "{}")
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"]
  const agents = [record(ids[0]!, "claude-agent-acp", "kept"), record(ids[1]!, "claude-agent-acp", "missing"), record(ids[2]!, "codex-acp", null)]
  const store = { inventory: async () => ({ agents, legacyAgents: [], commands: [], issues: [] }) } as never
  const index = createAgentIndex(join(root, "state"))
  assert.deepEqual(await migrateIndex({ store, index, homes }), { migrated: 1, skipped: 2, failed: 0 })
  assert.deepEqual((await index.list()).map(value => [value.agentId, value.nativeSessionId]), [[ids[0], "kept"]])
  assert.equal(await migrateIndex({ store, index, homes }), null)
})

test("migration of no records still marks the index as migrated", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-migrate-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = { inventory: async () => ({ agents: [], legacyAgents: [], commands: [], issues: [] }) } as never
  const index = createAgentIndex(join(root, "state"))
  assert.deepEqual(await migrateIndex({ store, index, homes: { codexHome: root, claudeHome: root } }), { migrated: 0, skipped: 0, failed: 0 })
  assert.equal(await index.migrated(), true)
})

test("a migration with a failed write is retried at the next start", async t => {
  const root = await mkdtemp(join(tmpdir(), "agency-migrate-")), homes = { codexHome: join(root, "codex"), claudeHome: join(root, "claude") }
  t.after(() => rm(root, { recursive: true, force: true }))
  const claudeDir = join(homes.claudeHome, "projects", "-work-repo")
  await mkdir(claudeDir, { recursive: true })
  await writeFile(join(claudeDir, "one.jsonl"), "{}")
  await writeFile(join(claudeDir, "two.jsonl"), "{}")
  const ids = ["55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"]
  const store = { inventory: async () => ({ agents: [record(ids[0]!, "claude-agent-acp", "one"), record(ids[1]!, "claude-agent-acp", "two")], legacyAgents: [], commands: [], issues: [] }) } as never
  const real = createAgentIndex(join(root, "state"))
  let failOnce = true
  const flaky = { ...real, ensure: async (value: Parameters<typeof real.ensure>[0]) => { if (value.agentId === ids[1] && failOnce) { failOnce = false; throw new Error("disk full") } return real.ensure(value) } }
  assert.deepEqual(await migrateIndex({ store, index: flaky, homes }), { migrated: 1, skipped: 0, failed: 1 })
  assert.equal(await real.migrated(), false)
  assert.deepEqual(await migrateIndex({ store, index: flaky, homes }), { migrated: 1, skipped: 0, failed: 0 })
  assert.equal(await real.migrated(), true)
  assert.deepEqual((await real.list()).map(value => value.agentId).sort(), ids)
})