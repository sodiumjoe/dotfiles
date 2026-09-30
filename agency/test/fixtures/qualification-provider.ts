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
  const update = (value: unknown, sessionId = "fixture-session"): void => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } })
  const audit = (value: unknown): void => writeFileSync(join(process.argv[4] ?? process.argv[3]!, "provider-audit.json"), JSON.stringify(value), { mode: 0o600 })
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
      } else if (request.method === "session/prompt") {
        if (scenario === "prompt-exit") { process.exit(2) }
        if (request.params.sessionId !== "fixture-session" || !Array.isArray(request.params.prompt) || request.params.prompt.length !== 1 || request.params.prompt[0]?.type !== "text") process.exit(5)
        const match = /^Return exactly this token and no other text:\n(AGENCY_CODEX_SMOKE_[0-9a-f]{32})\n\nDo not inspect files or use tools\.$/.exec(request.params.prompt[0].text)
        if (!match) process.exit(5)
        const token = match[1]!
        const answer = scenario === "prompt-whitespace" ? ` \n${token}\n ` : token
        if (scenario === "handler-death") { process.kill(process.ppid, "SIGKILL"); continue }
        if (scenario === "prompt-child-death") { audit({ scenario, childKilled: true }); child!.kill("SIGKILL"); continue }
        if (scenario === "prompt-abort" || scenario === "prompt-deadline") continue
        if (scenario === "prompt-non-text") { update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "x", mimeType: "image/png" } }); continue }
        if (scenario === "prompt-tool-call" || scenario === "prompt-tool-call-update") {
          const updateKind = scenario === "prompt-tool-call" ? "tool_call" : "tool_call_update"
          audit({ scenario, updateKind }); update({ sessionUpdate: updateKind, toolCallId: "tool", title: "fixture" }); continue
        }
        if (scenario === "prompt-permission" || scenario === "prompt-permission-malformed") {
          const options = scenario.endsWith("malformed") ? [{ optionId: "same", name: "One", kind: "allow_once" }, { optionId: "same", name: "Two", kind: "reject_once" }] : [{ optionId: "cancel", name: "Cancel", kind: "reject_once" }]
          send({ jsonrpc: "2.0", id: "prompt-permission", method: "session/request_permission", params: { sessionId: "fixture-session", toolCall: { toolCallId: "tool", title: "fixture" }, options } }); continue
        }
        const clientMethod = new Map([
          ["prompt-fs-read", "fs/read_text_file"], ["prompt-fs-write", "fs/write_text_file"],
          ["prompt-terminal-create", "terminal/create"], ["prompt-terminal-output", "terminal/output"], ["prompt-terminal-release", "terminal/release"], ["prompt-terminal-wait-for-exit", "terminal/wait_for_exit"], ["prompt-terminal-kill", "terminal/kill"],
          ["prompt-unknown-request", "unexpected/method"],
        ]).get(scenario)
        if (clientMethod) { send({ jsonrpc: "2.0", id: "prompt-client-request", method: clientMethod, params: { sessionId: "fixture-session" } }); continue }
        if (scenario === "prompt-answer-overflow") { update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(4097) } }); continue }
        if (scenario === "prompt-frame-overflow") { process.stdout.write("x".repeat(65537) + "\n"); continue }
        if (scenario === "prompt-config-drift") {
          update({ sessionUpdate: "config_option_update", configOptions: options.map(option => option.id === "model" ? { ...option, currentValue: "substituted", options: [{ value: "substituted" }] } : option) }); continue
        }
        const chunks = scenario === "prompt-fragmented" ? [answer.slice(0, 1), answer.slice(1)] : scenario === "prompt-multiple" ? [answer.slice(0, 7), answer.slice(7, 23), answer.slice(23)] : [scenario === "prompt-extra-content" ? answer + "extra" : answer]
        if (scenario === "prompt-late-result") {
          const values = [
            { jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } },
            { jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } },
            { jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } } } },
          ]
          audit({ scenario, events: ["answer", "result", "late-update"], childAlive: child!.exitCode === null })
          process.stdout.write(values.map(value => JSON.stringify(value)).join("\n") + "\n")
          continue
        }
        for (const text of chunks) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, scenario === "prompt-wrong-session-id" ? "wrong-session" : "fixture-session")
        if (scenario === "prompt-wrong-session-id") continue
        if (scenario === "prompt-wrong-request-id") { send({ jsonrpc: "2.0", id: request.id + 100, result: { stopReason: "end_turn" } }); continue }
        if (scenario === "prompt-malformed-result") { send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn", extra: true } }); continue }
        if (scenario === "prompt-duplicate-result") {
          send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
          send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
          continue
        }
        const stopReason = new Map([["prompt-max-tokens", "max_tokens"], ["prompt-max-turn-requests", "max_turn_requests"], ["prompt-refusal", "refusal"], ["prompt-cancelled", "cancelled"]]).get(scenario) ?? "end_turn"
        if (scenario === "prompt-forward-success") audit({ scenario, promptRequests: 1 })
        if (scenario === "prompt-fragmented" || scenario === "prompt-multiple" || scenario === "prompt-whitespace") audit({ scenario, chunks: chunks.length })
        result = { stopReason }
      } else process.exit(5)
      send({ jsonrpc: "2.0", id: request.id, result })
    }
  })
  process.stdin.on("error", () => undefined); process.stdout.on("error", () => undefined)
  if (scenario !== "survivor") process.stdin.on("end", () => process.exit(0))
}