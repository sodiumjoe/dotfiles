import { randomUUID } from "node:crypto"
import type { TaskRecord, TaskRef } from "../src/tasks/types.js"

export const taskHost = "a".repeat(64)
export function sampleTaskRecord(ref: TaskRef = { hostId: taskHost, taskId: randomUUID() }): TaskRecord {
  return { version: 1, ref, description: "fixture task", parent: null, status: "starting", stage: "launch",
    launch: { commandId: randomUUID(), handlerGeneration: randomUUID() }, submissionId: randomUUID(),
    session: null, resultPath: `tasks/${ref.taskId}/report.json`, issue: null }
}