import { isDeepStrictEqual } from "node:util"
import type { InventoryEntry } from "../handler/inventory.js"
import { readLaunchRecordForReconciliation } from "../platform/private-state.js"
import { reconcileRecord } from "../platform/reconcile.js"
import { sameProcessGeneration, type LaunchRecord, type PlatformAdapter } from "../platform/types.js"
import { CatalogError } from "./types.js"

export class ProbeRecoveryError extends CatalogError {
  readonly record: LaunchRecord
  constructor(record: LaunchRecord) { super("PROBE_CLEANUP_UNVERIFIED"); this.record = structuredClone(record) }
}

export async function recoverProbeEntry(entry: InventoryEntry, adapter: PlatformAdapter): Promise<LaunchRecord> {
  const result = await reconcileRecord(entry.path, adapter, entry.record)
  const unavailable = (): never => { throw new CatalogError("PROBE_CLEANUP_UNVERIFIED") }
  if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(entry.path), result.record)) unavailable()
  try {
    if (result.record.phase !== "cleanup_verified") unavailable()
    if (result.record.provider !== null && result.record.launchBootId === await adapter.bootId()) {
      for (let n = 0; n < 2; n++) {
        for (const retained of result.record.provider.group.observed) {
          const current = await adapter.readProcess(retained.pid)
          if (current !== null && current.processGroupId === result.record.provider.group.leader.pid && sameProcessGeneration(retained, current)) unavailable()
        }
        if ((await adapter.readGroup(result.record.provider.group.leader.pid)).some(p => p.bootId === result.record.launchBootId)) unavailable()
      }
    }
  } catch { throw new ProbeRecoveryError(result.record) }
  return result.record
}