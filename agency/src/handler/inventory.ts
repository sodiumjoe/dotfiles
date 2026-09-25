import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { UUID, type LaunchSummary } from "../control/protocol.js"
import { assertPrivateDirectory, readLaunchRecordForReconciliation } from "../platform/private-state.js"
import type { LaunchRecord } from "../platform/types.js"

export type InventoryEntry = { path: string; record: LaunchRecord }

export async function inventoryLaunches(directory: string): Promise<InventoryEntry[]> {
  await assertPrivateDirectory(directory)
  const entries: InventoryEntry[] = [], ids = new Set<string>()
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid!() || (metadata.mode & 0o077) !== 0) throw new Error("unsafe retained inventory entry")
    const remnant = /^\.(.+)\.json\.(.+)\.tmp$/.exec(name)
    if (remnant && UUID.test(remnant[1]!) && UUID.test(remnant[2]!)) continue
    const id = name.endsWith(".json") ? name.slice(0, -5) : ""
    if (!UUID.test(id)) throw new Error("unknown retained inventory entry")
    const record = await readLaunchRecordForReconciliation(path)
    if (record.launchAttemptId !== id || ids.has(id)) throw new Error("retained inventory identity mismatch")
    ids.add(id)
    entries.push({ path, record })
  }
  return entries
}

export async function verifyInventory(directory: string, expected: InventoryEntry[]): Promise<void> {
  const current = await inventoryLaunches(directory)
  if (!isDeepStrictEqual(current, expected)) throw new Error("RETAINED_INVENTORY_CHANGED")
}

export function summarizeLaunches(records: LaunchRecord[]): LaunchSummary[] {
  return records.map(({ launchAttemptId, agentId, checkoutId, phase, reason }) => ({ launchAttemptId, agentId, checkoutId, phase, reason }))
}