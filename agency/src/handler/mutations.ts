import type { InventoryEntry, LaunchIssue } from "./inventory.js"

export class MutationQueue {
  private tail: Promise<void> = Promise.resolve()
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

export type HandlerMutations = { queue: MutationQueue; accepted: InventoryEntry[]; issues?: LaunchIssue[]; root?: string }