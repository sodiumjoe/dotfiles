import assert from "node:assert/strict"
import test from "node:test"
import { appleScriptString, createAttentionNotifier, type AttentionHost } from "../src/hosts/attention.js"
import type { RosterRow } from "../src/live/roster.js"

const agent = "00000000-0000-4000-8000-000000000002"
const row = (pendingApprovals: number, editors: number, providerGeneration = "00000000-0000-4000-8000-000000000003", title: string | null = "Investigate jest"): RosterRow => ({ agentId: agent, backendId: "codex-acp", cwd: "/w", createdAt: "2026-11-18T00:00:00.000Z", title, lastActivityAt: null,
  live: { activity: "working", handlerGeneration: "00000000-0000-4000-8000-000000000001", providerGeneration, model: null, mode: null, pendingApprovals, editors } })
const host = (...agents: RosterRow[]): AttentionHost[] => [{ hostId: "b".repeat(64), label: "agency-pool-2", agents }]

test("an approval on an agent nobody has open notifies once, and a second approval notifies again", () => {
  const sent: string[] = [], notifier = createAttentionNotifier({ notify: (title, message) => { sent.push(title + ": " + message) } })
  notifier.observe(host(row(0, 0)))
  notifier.observe(host(row(1, 0))); notifier.observe(host(row(1, 0)))
  notifier.observe(host(row(2, 0)))
  notifier.observe(host(row(0, 0))); notifier.observe(host(row(1, 0)))
  assert.deepEqual(sent, ["Agency: Investigate jest on agency-pool-2 needs approval", "Agency: Investigate jest on agency-pool-2 needs approval", "Agency: Investigate jest on agency-pool-2 needs approval"])
})

test("an agent with an editor attached never notifies, even after the editor detaches", () => {
  const sent: string[] = [], notifier = createAttentionNotifier({ notify: (_title, message) => { sent.push(message) } })
  notifier.observe(host(row(1, 1)))
  notifier.observe(host(row(1, 0)))
  assert.deepEqual(sent, [])
  notifier.observe(host(row(2, 0)))
  assert.equal(sent.length, 1)
})

test("a fresh notifier announces each agent's pending approvals once, and a new provider generation is a new agent", () => {
  const sent: string[] = [], notifier = createAttentionNotifier({ notify: (_title, message) => { sent.push(message) } })
  notifier.observe(host(row(3, 0))); notifier.observe(host(row(3, 0)))
  notifier.observe(host(row(1, 0, "00000000-0000-4000-8000-000000000004", null)))
  assert.deepEqual(sent, ["Investigate jest on agency-pool-2 needs approval", "Agent 00000000 on agency-pool-2 needs approval"])
})

test("rows without live state or from older devboxes never notify", () => {
  const sent: string[] = [], notifier = createAttentionNotifier({ notify: (_title, message) => { sent.push(message) } })
  notifier.observe(host({ ...row(0, 0), live: null }, row(0, 0)))
  assert.deepEqual(sent, [])
})

test("AppleScript strings escape quotes and backslashes and drop control characters", () => {
  assert.equal(appleScriptString('say "hi" \\ now\n'), '"say \\"hi\\" \\\\ now "')
})