import { access, appendFile, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const root = process.env.FIXTURE_ROOT
if (!root || !root.startsWith("/")) throw new Error("fixture root required")
const scenario = process.env.FIXTURE_SCENARIO ?? "normal"
const options = [
  { id: "model", name: "Model", type: "select", currentValue: "model-a", options: [{ value: "model-a", name: "Model A" }] },
  { id: "reasoning", name: "Reasoning", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  { id: "mode", name: "Mode", type: "select", currentValue: "plan", options: [{ value: "plan", name: "Plan" }, { value: "review", name: "Review" }] },
]
const exists = async (path: string): Promise<boolean> => { try { await access(path); return true } catch { return false } }
const barrier = async (name: string): Promise<void> => {
  if (!await exists(join(root, `pause-${name}`))) return
  await writeFile(join(root, `at-${name}`), "ready", { mode: 0o600 })
  while (!await exists(join(root, `release-${name}`))) await new Promise(resolve => setTimeout(resolve, 20))
}
const send = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + "\n") }
if (scenario === "ignore-term") process.on("SIGTERM", () => undefined)
let buffer = "", serial = Promise.resolve()
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8")
  if (Buffer.byteLength(buffer) > 1048576) process.exit(2)
  let index: number
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
    serial = serial.then(async () => {
      const request = JSON.parse(line)
      if (request.method === undefined) return
      await appendFile(join(root, "requests.jsonl"), JSON.stringify(request) + "\n", { mode: 0o600 })
      let result: unknown
      if (request.method === "initialize") result = { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      else if (request.method === "session/new" || request.method === "session/load") {
        await barrier("session")
        result = { sessionId: "fixture-session", configOptions: options }
      } else if (request.method === "session/set_config_option") {
        if (request.params.sessionId !== "fixture-session") throw new Error("wrong session")
        const option = options.find(option => option.id === request.params.configId)
        if (!option || !option.options.some(value => value.value === request.params.value)) throw new Error("unsupported selection")
        option.currentValue = request.params.value
        if (scenario === "alias" && option.id === "model") option.currentValue = "model-b"
        if (scenario === "permission") {
          send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: { sessionId: "fixture-session", toolCall: { toolCallId: "fixture-tool" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } })
          return
        }
        if (option.id === "mode") await barrier("configured")
        result = { configOptions: options }
      } else if (request.method === "session/prompt") {
        if (request.params.sessionId !== "fixture-session" || request.params.prompt?.length !== 1 || request.params.prompt[0]?.type !== "text") throw new Error("wrong prompt")
        await barrier("prompt")
        const prompt = request.params.prompt[0].text as string
        let answer = `answer:${prompt}`
        if (prompt.startsWith("AGENCY_ACCEPTANCE_READ ")) {
          if (!prompt.includes("read package.json in the current working directory")) throw new Error("wrong acceptance path")
          const challenge = prompt.slice("AGENCY_ACCEPTANCE_READ ".length).split(":", 1)[0]!
          const metadata = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"))
          if (metadata.name !== "@moon/agency" || metadata.engines?.node !== "24.13.0") throw new Error("wrong acceptance package")
          await writeFile(join(root, "acceptance-session"), challenge, { mode: 0o600 })
          answer = `${challenge} @moon/agency 24.13.0`
        } else if (prompt.startsWith("AGENCY_ACCEPTANCE_RECALL:")) answer = await readFile(join(root, "acceptance-session"), "utf8")
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } })
        result = { stopReason: "end_turn" }
      } else throw new Error("unexpected fixture request")
      send({ jsonrpc: "2.0", id: request.id, result })
    }).catch(() => { process.exitCode = 2; process.stdin.destroy(); process.stdout.destroy(); clearInterval(idle) })
  }
})
process.stdin.on("error", () => undefined)
process.stdout.on("error", () => undefined)
const idle = setInterval(() => undefined, 1000)