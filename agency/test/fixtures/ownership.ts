import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, openSync, writeSync, constants } from "node:fs"
import { writeFile } from "node:fs/promises"
import { createJournalPool } from "../../src/orchestration/journal.js"
import { journalEntries } from "../../src/orchestration/reports.js"
import { canonicalDigest } from "../../src/orchestration/types.js"
import { join } from "node:path"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import type { ProcessIdentity } from "../../src/platform/types.js"

export type FixtureLaunch = { launchId: string; role: string }
function record(value: unknown): void {
  const root = process.env.AGENCY_TEST_EVIDENCE_ROOT
  if (!root) return
  const fd = openSync(join(root, "ownership.jsonl"), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd) } finally { closeSync(fd) }
}
export function fixtureLaunch(role: string): FixtureLaunch {
  const value = { launchId: randomUUID(), role }
  record({ type: "intent", ...value })
  return value
}
export async function fixtureSpawn(launch: FixtureLaunch, pid: number | undefined): Promise<ProcessIdentity | null> {
  if (!process.env.AGENCY_TEST_EVIDENCE_ROOT) return null
  record({ type: "spawn", ...launch, pid: pid ?? null })
  if (pid === undefined) { record({ type: "no-process", ...launch }); return null }
  const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  const identity = await adapter.readProcess(pid)
  if (identity === null) throw new Error("fixture exited before ownership observation")
  record({ type: "identity", ...launch, identity })
  return identity
}
export function fixtureIdentity(role: string, identity: ProcessIdentity): void {
  record({ type: "observed", role, identity })
}
export async function fixtureNotification(root: string, runId: string, agentId: string, prompt: unknown): Promise<void> {
  const entries = await journalEntries(createJournalPool(join(root, "state"), undefined, Date.now, "origin").forRun(runId))
  const receipt = entries.findLast(entry => entry.kind === "notification-receipt" && (entry.payload as { state?: string; digest?: string }).state === "accepted" && (entry.payload as { digest?: string }).digest === canonicalDigest({ prompt }))
  if (!receipt) throw new Error("notification dispatched without a durable accepted receipt")
  const value = { receiptBeforeDispatch: true, submissionId: (receipt.payload as { submissionId: string }).submissionId }
  await writeFile(join(root, "notification-admission-" + agentId + ".json"), JSON.stringify(value), { mode: 0o600 })
}