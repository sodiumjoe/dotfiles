import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import { closeSync, fstatSync, openSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const scenario = process.argv[2] ?? "normal"
if (scenario === "child") {
  if (process.argv[3] === "child-descriptor-leak") writeFileSync(join(process.argv[4]!, "receipts/child-fd-audit.json"), JSON.stringify({ inheritedDirectory: fstatSync(3).isDirectory() }), { mode: 0o600 })
  process.stdin.resume()
  if (process.argv[3] !== "survivor") process.stdin.on("end", () => process.exit(0))
  setInterval(() => undefined, 1000)
} else {
  if (scenario === "descriptor-leak") writeFileSync(join(process.argv[3]!, "receipts/fd-audit.json"), JSON.stringify({ inheritedDirectory: fstatSync(3).isDirectory() }), { mode: 0o600 })
  let child: ChildProcessWithoutNullStreams | undefined
  const options = [
    { id: "model", type: "select", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol" }] },
    { id: "reasoning_effort", type: "select", currentValue: "high", options: [{ value: "high" }] },
    { id: "mode", type: "select", currentValue: "read-only", options: [{ value: "read-only" }] },
  ]
  const send = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + "\n") }
  let buffer = ""
  process.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    let at: number
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      const request = JSON.parse(line)
      if (!request.method) continue
      if (scenario === "adapter-exit") { process.exit(2) }
      if (!child) {
        const fd = scenario === "child-descriptor-leak" ? openSync(join(process.argv[3]!, "receipts"), "r") : undefined
        try {
          for (let i = 0; i < (scenario === "two-children" ? 2 : 1); i++) {
            child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child", scenario, process.argv[3]!], { stdio: ["pipe", "pipe", "pipe", ...(fd === undefined ? [] : [fd])], env: {} }) as ChildProcessWithoutNullStreams
            child.stdout.resume(); child.stderr.resume(); child.on("exit", () => { process.exit(3) })
          }
        } finally { if (fd !== undefined) closeSync(fd) }
      }
      if (scenario === "codex-exit") { child!.kill("SIGKILL"); return }
      let result: unknown
      if (request.method === "initialize") {
        if (scenario === "auth-wrong-method") { send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Authentication required" } }); continue }
        result = { protocolVersion: scenario === "protocol-version" ? 2 : 1 }
      } else if (request.method === "session/new") {
        if (scenario === "slow-session") { setTimeout(() => send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "fixture-session", configOptions: options } }), 5500); continue }
        if (scenario.startsWith("auth-")) {
          send({ jsonrpc: "2.0", id: request.id, ...(scenario === "auth-spoofed" ? { method: "session/new" } : {}), error: { code: scenario === "auth-malformed" ? "-32000" : -32000, message: "Authentication required" } }); continue
        }
        if (scenario === "missing-option") options.splice(1, 1)
        if (scenario === "duplicate-option") options.push({ ...options[0]! })
        result = { sessionId: "fixture-session", configOptions: options }
      } else if (request.method === "session/set_config_option") {
        if (request.params.sessionId !== "fixture-session") process.exit(4)
        const phase = request.params.configId === "reasoning_effort" ? "reasoning" : request.params.configId
        const option = options.find(o => o.id === request.params.configId)!
        option.currentValue = request.params.value
        if (scenario === "permission" || scenario === "unexpected-rpc" || scenario.startsWith("fs/") || scenario === "terminal/create") {
          send({ jsonrpc: "2.0", id: "callback", method: scenario === "permission" ? "session/request_permission" : scenario === "unexpected-rpc" ? "unexpected/method" : scenario, params: { sessionId: "fixture-session", toolCall: { toolCallId: "tool" }, options: [] } }); continue
        }
        if (scenario.startsWith(`substitute-${phase}-`)) {
          const field = scenario.split("-")[2]!, id = field === "reasoning" ? "reasoning_effort" : field === "alias" ? "model" : field
          const changed = options.find(o => o.id === id)!
          changed.currentValue = "substituted"; changed.options = [{ value: "substituted" }]
        }
        result = { configOptions: options }
      } else process.exit(5)
      send({ jsonrpc: "2.0", id: request.id, result })
    }
  })
  process.stdin.on("error", () => undefined); process.stdout.on("error", () => undefined)
  if (scenario !== "survivor") process.stdin.on("end", () => process.exit(0))
}