import { isDeepStrictEqual } from "node:util"
import type { HandlerStatus } from "../control/protocol.js"
import { inventoryLaunchState, summarizeLaunches, type InventoryEntry, type LaunchIssue } from "./inventory.js"

export class MutationQueue {
  private tail: Promise<void> = Promise.resolve()
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

export type HandlerMutations = { queue: MutationQueue; accepted: InventoryEntry[]; unavailable: string | null; issues?: LaunchIssue[] }

export async function refreshLaunchState(state: HandlerStatus, mutations: HandlerMutations, directory: string): Promise<void> {
  try {
    const current = await inventoryLaunchState(directory)
    const expected = new Map(mutations.accepted.map(entry => [entry.path, entry.record]))
    const observed = new Map(current.records.map(entry => [entry.path, entry.record]))
    mutations.issues = [...current.issues]
    for (const [path, record] of observed) if (!isDeepStrictEqual(record, expected.get(path))) mutations.issues.push({ path, launchAttemptId: record.launchAttemptId, message: "RETAINED_INVENTORY_CHANGED" })
    for (const [path, record] of expected) if (!observed.has(path)) mutations.issues.push({ path, launchAttemptId: record.launchAttemptId, message: "RETAINED_INVENTORY_CHANGED" })
    const accepted = current.records.filter(entry => isDeepStrictEqual(expected.get(entry.path), entry.record))
    state.launches = summarizeLaunches(accepted.map(entry => entry.record))
    state.reconciliation = { classified: accepted.length, total: accepted.length, uncertain: accepted.filter(entry => entry.record.phase === "quarantined").length }
  } catch (error) { mutations.unavailable ??= String(error).slice(0, 512) }
}