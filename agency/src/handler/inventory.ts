import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { UUID, type LaunchSummary } from "../control/protocol.js"
import { assertPrivateDirectory, readLaunchRecordForReconciliation } from "../platform/private-state.js"
import { launchOwner, type LaunchRecord } from "../platform/types.js"

export type InventoryEntry = { path: string; record: LaunchRecord }
export type LaunchIssue = { path: string; launchAttemptId: string | null; message: string }
export type LaunchInventory = { records: InventoryEntry[]; issues: LaunchIssue[] }

export async function inventoryLaunchState(directory: string): Promise<LaunchInventory> {
  await assertPrivateDirectory(directory)
  const records: InventoryEntry[] = [], issues: LaunchIssue[] = [], ids = new Set<string>()
  for (const name of (await readdir(directory)).sort()) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : ""
    const path = join(directory, name)
    try {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid!() || (metadata.mode & 0o077) !== 0) throw new Error("unsafe retained inventory entry")
      const remnant = /^\.(.+)\.json\.(.+)\.tmp$/.exec(name)
      if (remnant && UUID.test(remnant[1]!) && UUID.test(remnant[2]!)) continue
      if (!UUID.test(id)) throw new Error("unknown retained inventory entry")
      const record = await readLaunchRecordForReconciliation(path)
      if (record.launchAttemptId !== id || ids.has(id)) throw new Error("retained inventory identity mismatch")
      ids.add(id)
      records.push({ path, record })
    } catch (error) { issues.push({ path, launchAttemptId: UUID.test(id) ? id : null, message: String(error) }) }
  }
  return { records, issues }
}

export async function inventoryLaunches(directory: string): Promise<InventoryEntry[]> {
  const inventory = await inventoryLaunchState(directory)
  if (inventory.issues.length) throw new Error(inventory.issues.map(issue => issue.message).join("; "))
  return inventory.records
}

export async function verifyInventory(directory: string, expected: InventoryEntry[]): Promise<void> {
  const current = await inventoryLaunches(directory)
  if (!isDeepStrictEqual(current, expected)) throw new Error("RETAINED_INVENTORY_CHANGED")
}

export function summarizeLaunches(records: LaunchRecord[]): LaunchSummary[] {
  return records.map(record => ({ launchAttemptId: record.launchAttemptId, owner: launchOwner(record), phase: record.phase, reason: record.reason }))
}