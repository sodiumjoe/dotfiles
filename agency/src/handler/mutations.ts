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

export type HandlerMutations = { queue: MutationQueue; accepted: InventoryEntry[]; issues?: LaunchIssue[]; reconciliationIssues?: LaunchIssue[] }

export function confirmReconciledLaunch(mutations: HandlerMutations, path: string): void {
  if (mutations.reconciliationIssues) mutations.reconciliationIssues = mutations.reconciliationIssues.filter(issue => issue.path !== path)
}

export async function refreshLaunchState(state: HandlerStatus, mutations: HandlerMutations, directory: string): Promise<void> {
  const current = await inventoryLaunchState(directory)
  const expected = new Map(mutations.accepted.map(entry => [entry.path, entry.record]))
  const observed = new Map(current.records.map(entry => [entry.path, entry.record]))
  mutations.issues = [...current.issues, ...(mutations.reconciliationIssues ?? [])]
  for (const [path, record] of observed) if (!isDeepStrictEqual(record, expected.get(path))) mutations.issues.push({ path, launchAttemptId: record.launchAttemptId, message: "RETAINED_INVENTORY_CHANGED" })
  for (const [path, record] of expected) if (!observed.has(path)) mutations.issues.push({ path, launchAttemptId: record.launchAttemptId, message: "RETAINED_INVENTORY_CHANGED" })
  state.issues = [...mutations.issues]
  state.launches = summarizeLaunches(current.records.map(entry => entry.record))
  state.reconciliation = { classified: current.records.length, total: current.records.length, uncertain: current.records.filter(entry => entry.record.phase === "quarantined").length }
}