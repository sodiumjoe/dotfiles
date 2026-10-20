import { randomUUID } from "node:crypto"
import type { TaskRecord, TaskRef } from "../src/tasks/types.js"

export const taskHost = "a".repeat(64)
export function sampleTaskRecord(ref: TaskRef = { hostId: taskHost, taskId: randomUUID() }): TaskRecord {
  return { version: 1, ref, description: "fixture task", parent: null, status: "starting", stage: "launch",
    launch: { commandId: randomUUID(), handlerGeneration: randomUUID() }, submissionId: randomUUID(),
    session: null, resultPath: `tasks/${ref.taskId}/report.json`, issue: null }
}
export function taskMcpPeer(input: import("node:stream").Readable, output: import("node:stream").Writable) {
  let nextId = 0, buffer = ""
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>(), decoder = new TextDecoder()
  input.on("data", bytes => {
    buffer += decoder.decode(bytes, { stream: true })
    let at: number
    while ((at = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1)
      const call = pending.get(frame.id)
      if (call) { pending.delete(frame.id); if (frame.error) call.reject(new Error(frame.error.message)); else call.resolve(frame.result) }
    }
  })
  const fail = () => { for (const item of pending.values()) item.reject(new Error("MCP peer closed")); pending.clear() }
  input.on("end", fail); input.on("error", fail); output.on("error", fail)
  const notify = (method: string, params: object = {}) => output.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
  const request = (method: string, params: object = {}) => {
    const id = ++nextId
    const result = new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); output.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n") })
    return { id, result }
  }
  return { notify, request, call: (name: string, args: object) => request("tools/call", { name, arguments: args }).result,
    async initialize() { const result = await request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "task-fixture", version: "1" }, capabilities: {} }).result; notify("notifications/initialized"); return result },
    close() { output.end() },
  }
}