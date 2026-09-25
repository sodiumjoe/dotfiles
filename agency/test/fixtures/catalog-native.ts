import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const directory = dirname(process.argv[1]!)
let scenario: { fail?: boolean; models?: string[]; wait?: boolean } = {}
try { scenario = JSON.parse(await readFile(join(directory, "scenario.json"), "utf8")) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
if (process.argv.includes("app-server") || process.argv.includes("--agency-fixture-sdk")) {
  let buffer = ""
  const methods: string[] = []
  const models = scenario.models ?? ["fixture-model"]
  process.stdin.on("data", (bytes: Buffer) => {
    buffer += bytes.toString()
    let index: number
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      void (async () => {
        if (line === "sdk-models") {
          if (scenario.wait) return
          process.stdout.write(JSON.stringify(scenario.fail ? { error: "SECRET" } : { models: models.map(value => ({ value, displayName: value, supportsEffort: true, supportedEffortLevels: ["high", "low"] })) }) + "\n")
          return
        }
        const message = JSON.parse(line)
        methods.push(message.method)
        await writeFile(join(process.cwd(), "native-methods.json"), JSON.stringify(methods), { mode: 0o600 })
        if (!["initialize", "initialized", "model/list"].includes(message.method)) process.exit(1)
        if (message.method === "initialized") return
        if (scenario.wait && message.method === "model/list") return
        const result = message.method === "initialize" ? { serverInfo: { version: "fixture-native-1" } } : { data: models.map(id => ({ id, displayName: id, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "More" }] })), nextCursor: null }
        process.stdout.write(JSON.stringify(scenario.fail && message.method === "model/list" ? { id: message.id, error: { message: "SECRET" } } : { id: message.id, result }) + "\n")
      })().catch(() => process.exit(1))
    }
  })
} else process.stdin.once("data", () => process.stdout.write("registered\n"))
if (process.argv.includes("--ignore-term")) process.on("SIGTERM", () => undefined)
setInterval(() => undefined, 1000)