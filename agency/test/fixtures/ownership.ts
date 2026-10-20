import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, openSync, writeSync, constants } from "node:fs"
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