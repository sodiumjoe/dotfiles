import { isDeepStrictEqual } from "node:util"
import type { HandlerStatus } from "../control/protocol.js"
import { inventoryLaunches, summarizeLaunches, type InventoryEntry } from "./inventory.js"

export class MutationQueue {
  private tail: Promise<void> = Promise.resolve()
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

export type HandlerMutations = { queue: MutationQueue; accepted: InventoryEntry[]; unavailable: string | null }

export async function refreshLaunchState(state: HandlerStatus, mutations: HandlerMutations, directory: string): Promise<void> {
  try {
    const current = await inventoryLaunches(directory)
    if (!isDeepStrictEqual(current, mutations.accepted)) throw new Error("RETAINED_INVENTORY_CHANGED")
    state.launches = summarizeLaunches(current.map(entry => entry.record))
    state.reconciliation = { classified: current.length, total: current.length, quarantined: current.filter(entry => entry.record.phase === "quarantined").length }
  } catch (error) { mutations.unavailable ??= String(error).slice(0, 512) }
}