import { id } from "../catalog/types.js"
import { createStorage, storageQueue, defaultFileSystem } from "../orchestration/storage.js"
import { parseRunRecord, type RunRecord } from "./types.js"

export function createBureauStore(root: string, filesystem = defaultFileSystem) {
  const storage = createStorage(root, "bureau", filesystem), queue = storageQueue(root)
  return {
    async readRun(runId: string): Promise<RunRecord | null> {
      const raw = await storage.read(`runs/${id(runId)}.json`)
      if (raw === null) return null
      const value = parseRunRecord(raw)
      if (value.runId !== runId) throw new Error("INVALID_RUN")
      return value
    },
    async writeRun(value: RunRecord, expected: RunRecord | null): Promise<void> {
      const record = parseRunRecord(value)
      await queue.run(() => storage.publish(`runs/${record.runId}.json`, record, expected))
    }
  }
}
export type BureauStore = ReturnType<typeof createBureauStore>