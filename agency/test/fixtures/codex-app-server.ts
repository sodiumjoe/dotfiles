import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const log = process.env.FIXTURE_MODEL_LOG
if (log) appendFileSync(log, "listing\n")
if (process.env.FIXTURE_MODEL_SCENARIO === "hang") setInterval(() => {}, 1000)
else for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id?: number; method: string }
  if (request.id === undefined) continue
  const result = request.method === "initialize" ? { serverInfo: { version: "0.1.0" } }
    : { data: [{ id: "model-a", displayName: "Model A", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "low" }] }, { id: "model-b", displayName: "Model B" }], nextCursor: null }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n")
}