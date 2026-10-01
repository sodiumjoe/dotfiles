import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = process.env.QUALIFICATION_FIXTURE_ROOT!, scenario = process.env.QUALIFICATION_SCENARIO
if (!root) throw new Error("fixture root missing")
if (process.argv[2] === "helper") {
  const timer = setInterval(() => {
    if (existsSync(join(root, "finish-helper"))) { writeFileSync(join(root, "helper-survived"), "yes"); clearInterval(timer) }
  }, 20)
  setTimeout(() => process.exit(0), 30000).unref()
} else {
  const options = [
    { id: "model", type: "select", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol" }] },
    { id: "reasoning_effort", type: "select", currentValue: "high", options: [{ value: "high" }] },
    { id: "mode", type: "select", currentValue: "read-only", options: [{ value: "read-only" }] },
  ]
  let buffer = "", restored = false
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
  process.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString()
    let at: number
    while ((at = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1)
      appendFileSync(join(root, "requests.jsonl"), JSON.stringify(request) + "\n", { mode: 0o600 })
      let result: unknown
      if (request.method === "initialize") result = { protocolVersion: 1, agentCapabilities: { loadSession: scenario !== "unsupported-load" } }
      else if (request.method === "session/new") {
        result = { sessionId: "fixture-session", configOptions: options }
        if (scenario === "ambient-helper") {
          const helper = spawn(process.execPath, [fileURLToPath(import.meta.url), "helper"], { env: process.env, detached: true, stdio: "ignore" }); helper.unref()
        }
      } else if (request.method === "session/load") {
        if (scenario === "missing-session") { send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Session not found" } }); continue }
        if (request.params.sessionId !== "fixture-session" || !existsSync(join(root, "session.json"))) process.exit(2)
        restored = true
        result = { sessionId: scenario === "wrong-session" ? "wrong" : "fixture-session", configOptions: options }
      } else if (request.method === "session/set_config_option") result = { configOptions: options }
      else if (request.method === "session/prompt") {
        if (restored && scenario === "interrupted-second-prompt") process.exit(2)
        const text = request.params.prompt[0].text
        let answer: string
        if (restored) {
          if (text !== "Return the nonce from the previous turn without reading files.") process.exit(3)
          answer = JSON.parse(readFileSync(join(root, "session.json"), "utf8")).nonce
          if (scenario === "wrong-restored-answer") answer = "wrong"
          if (scenario === "ambient-helper") writeFileSync(join(root, "finish-helper"), "yes")
        } else {
          const nonce = /AGENCY_CODEX_RESTORE_[0-9a-f]{32}/.exec(text)?.[0]
          if (!nonce) process.exit(4)
          const packageJson = JSON.parse(readFileSync(join(process.cwd(), "agency/package.json"), "utf8"))
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "tool_call", toolCallId: "read-package", title: "Read package", kind: "read", status: "in_progress" } } })
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "tool_call_update", toolCallId: "read-package", status: "completed" } } })
          writeFileSync(join(root, "session.json"), JSON.stringify({ nonce }), { mode: 0o600 })
          answer = scenario === "wrong-first-answer" ? "wrong" : `${nonce} ${packageJson.name} ${packageJson.engines.node}`
        }
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } })
        result = { stopReason: "end_turn" }
      } else process.exit(5)
      send({ jsonrpc: "2.0", id: request.id, result })
    }
  })
  process.stdin.on("end", () => process.exit(0))
}