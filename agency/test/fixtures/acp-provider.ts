import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"

const root = process.env.FIXTURE_ROOT, backend = process.env.FIXTURE_BACKEND ?? "codex-acp"
if (!root || !root.startsWith("/") || !["codex-acp", "claude-agent-acp"].includes(backend)) throw new Error("isolated fixture configuration required")
const log = join(root, backend + ".jsonl"), statePath = join(root, backend + "-native.json")
const options = [
  { id: "model", name: "Model", type: "select", category: "model", currentValue: "model-a", options: [{ value: "model-a", name: "A" }, { value: "model-b", name: "B" }] },
  { id: "reasoning_effort", name: "Reasoning", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }, { value: "low", name: "Low" }] },
  { id: "mode", name: "Mode", type: "select", category: "mode", currentValue: "agent-full-access", options: [{ value: "agent-full-access", name: "Full access" }, { value: "read-only", name: "Read only" }] },
]
if (process.env.FIXTURE_SELECTION) options[0]!.options.push({ value: "model-c", name: "C" })
let modelId = "legacy-a", modeId = "normal", sessionId = "native-session", promptId: string | number | null = null
let permission: (() => void) | undefined, release: (() => void) | undefined
const send = (frame: unknown) => { process.stdout.write(JSON.stringify(frame) + "\n") }
const reply = (id: string | number, result: unknown) => send({ jsonrpc: "2.0", id, result })
const update = (value: unknown) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } })
const exists = async (name: string) => { try { await readFile(join(root!, name)); return true } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false } }
async function barrier(name: string) {
  if (!await exists("pause-" + name)) return
  await writeFile(join(root!, "at-" + name), "ready", { mode: 0o600 })
  while (!await exists("release-" + name)) await new Promise(resolve => setTimeout(resolve, 10))
}
const snapshot = () => backend === "codex-acp" ? { configOptions: options, ...(process.env.FIXTURE_SELECTION ? {
  models: { currentModelId: options[0]!.currentValue + "[" + options[1]!.currentValue + "]", availableModels: options[0]!.options.flatMap(model => (model.value === "model-c" ? ["medium", "minimal"] : ["high", "low"]).map(effort => ({ modelId: model.value + "[" + effort + "]", name: model.name + effort }))) }
} : {}) } : {
  models: { currentModelId: modelId, availableModels: [{ modelId: "legacy-a", name: "A" }, { modelId: "legacy-b", name: "B" }] },
  modes: { currentModeId: modeId, availableModes: [{ id: "normal", name: "Normal" }, { id: "review", name: "Review" }] },
}
await appendFile(log, JSON.stringify({ method: "fixture/environment", params: { AGENCY_TEST_EDITOR_MARKER: process.env.AGENCY_TEST_EDITOR_MARKER ?? null, NVIM: process.env.NVIM ?? null, NVIM_SOCKET_PATH: process.env.NVIM_SOCKET_PATH ?? null } }) + "\n", { mode: 0o600 })
let helperDefinition: { command: string; args: string[]; env: { name: string; value: string }[] } | undefined
let helper: ChildProcessWithoutNullStreams | undefined, helperId = 0
let executionAgentId = ""
const helperPending = new Map<number, { resolve(value: any): void; reject(error: unknown): void }>()
async function helperCall(method: string, params?: unknown) {
  const id = ++helperId, response = Promise.withResolvers<any>()
  helperPending.set(id, response)
  helper!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n")
  return response.promise
}
async function launchHelper() {
  if (!helperDefinition) throw new Error("missing injected Agency definition")
  const env = { ...process.env, ...Object.fromEntries(helperDefinition.env.map(value => [value.name, value.value])) }
  helper = spawn(helperDefinition.command, helperDefinition.args, { env, stdio: ["pipe", "pipe", "pipe"] })
  await appendFile(join(root!, "tools-helpers.jsonl"), JSON.stringify({ pid: helper.pid }) + "\n", { mode: 0o600 })
  let bytes = ""
  helper.stdout.on("data", chunk => { bytes += chunk.toString(); let newline; while ((newline = bytes.indexOf("\n")) !== -1) { const reply = JSON.parse(bytes.slice(0, newline)); bytes = bytes.slice(newline + 1); helperPending.get(reply.id)?.resolve(reply); helperPending.delete(reply.id) } })
  helper.stderr.resume()
  helper.once("exit", () => { for (const pending of helperPending.values()) pending.reject(new Error("helper exited")); helperPending.clear() })
  const initialize = await helperCall("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture-provider", version: "1" } })
  if (!initialize.result) throw new Error("helper initialization failed")
  helper.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
}
async function closeHelper() { if (helper) { const child = helper; const ended = new Promise(resolve => child.once("exit", resolve)); child.stdin.end(); await ended; helper = undefined } }
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  const request = JSON.parse(line)
  await appendFile(log, JSON.stringify(request) + "\n", { mode: 0o600 })
  void dispatch(request).catch(error => {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: String(error) } })
  })
}
async function dispatch(request: { id: string | number; method?: string; params?: Record<string, any>; result?: unknown }) {
  const params = request.params ?? {}
  if (!request.method) { permission?.(); permission = undefined; return }
  if (request.method === "initialize") {
    reply(request.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: backend === "codex-acp", audio: false, embeddedContext: true } }, authMethods: [{ id: "fixture-login", name: "Fixture login" }] })
  } else if (request.method === "session/new" || request.method === "session/load") {
    if (params.cwd !== process.cwd() || !Array.isArray(params.mcpServers)) throw new Error("wrong transient session input")
    if (request.method === "session/load") {
      sessionId = params.sessionId
      try {
        const state = JSON.parse(await readFile(statePath, "utf8"))
        if (state.configOptions) for (const option of options) option.currentValue = state.configOptions.find((value: { id: string }) => value.id === option.id)?.currentValue ?? option.currentValue
        if (state.models) modelId = state.models.currentModelId
        if (state.modes) modeId = state.modes.currentModeId
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    if (process.env.FIXTURE_AGENCY_TOOLS) {
      helperDefinition = params.mcpServers.find((server: { name: string }) => server.name === "agency")
      await launchHelper()
      const list = await helperCall("tools/list"), context = await helperCall("tools/call", { name: "agency_context", arguments: {} }), identity = JSON.parse(context.result.content[0].text)
      executionAgentId = identity.execution.agentId
      const denied = await helperCall("tools/call", { name: "agency_delegate", arguments: { runId: identity.runId, bindingEpoch: identity.bindingEpoch, commandId: "11111111-1111-4111-8111-111111111111", description: "bootstrap", hostId: identity.execution.hostId, cwd: process.cwd(), backendId: backend, modelId: "model-a", overrides: {}, git: null } })
      await writeFile(join(root!, "tools-bootstrap-" + executionAgentId + ".json"), JSON.stringify({ list, context, denied }), { mode: 0o600 })
    }
    await barrier("session")
    reply(request.id, { sessionId, ...snapshot(), _meta: { fixture: backend } })
  } else if (request.method === "session/set_config_option") {
    const option = options.find(value => value.id === params.configId)
    if (!option || !option.options.some(value => value.value === params.value)) throw new Error("unoffered selection")
    await barrier("setter-before")
    option.currentValue = params.value
    if (process.env.FIXTURE_SELECTION && option.id === "model") {
      options[1]!.options = (params.value === "model-c" ? ["medium", "minimal"] : ["high", "low"]).map(value => ({ value, name: value }))
      options[1]!.currentValue = options[1]!.options[1]!.value
    }
    await writeFile(statePath, JSON.stringify(snapshot()), { mode: 0o600 })
    await barrier("setter-after")
    reply(request.id, snapshot())
  } else if (request.method === "session/set_model" || request.method === "session/set_mode") {
    if (request.method === "session/set_model") modelId = params.modelId
    else modeId = params.modeId
    await writeFile(statePath, JSON.stringify(snapshot()), { mode: 0o600 })
    reply(request.id, snapshot())
  } else if (request.method === "session/cancel") {
    const current = promptId
    promptId = null
    permission?.(); permission = undefined; release?.(); release = undefined
    if (current !== null) reply(current, { stopReason: "cancelled" })
  } else if (request.method === "session/prompt") {
    if (params.sessionId !== sessionId || !Array.isArray(params.prompt)) throw new Error("wrong prompt")
    const text = params.prompt.filter((value: { type: string }) => value.type === "text").map((value: { text: string }) => value.text).join("\n")
    if (text === "fixture-tools") {
      const action = JSON.parse(await readFile(join(root!, "tool-action.json"), "utf8"))
      const first = await helperCall("tools/call", action)
      await closeHelper(); await launchHelper()
      const repeated = await helperCall("tools/call", action)
      await writeFile(join(root!, "tools-action-" + executionAgentId + ".json"), JSON.stringify({ first, repeated }), { mode: 0o600 })
    }
    if (text === "auth-required") { send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "AUTH_REQUIRED" } }); return }
    if (text === "fail") { process.exit(2) }
    promptId = request.id
    if (text === "permission") {
      const wait = new Promise<void>(resolve => { permission = resolve })
      const failure = setInterval(() => { void exists("fail-permission").then(ready => { if (ready) process.exit(2) }) }, 10)
      failure.unref()
      send({ jsonrpc: "2.0", id: 1, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "fixture-tool", title: "Fixture write", kind: "edit" }, options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }] } })
      try { await wait } finally { clearInterval(failure) }
    }
    if (text === "held") await new Promise<void>(resolve => {
      release = resolve
      const timer = setInterval(() => { void exists("release-prompt").then(ready => { if (ready) { clearInterval(timer); resolve() } }) }, 10)
      timer.unref()
    })
    await barrier("prompt")
    if (promptId !== request.id) return
    if (text === "echo") {
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "ec" } })
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "ho" } })
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "provider context" } })
    }
    if (text === "echo-mismatch") {
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo-" } })
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "different" } })
    }
    if (text === "large-tool") {
      const output = "fixture-large-tool:" + "λ".repeat(1048577)
      update({ sessionUpdate: "tool_call_update", toolCallId: "large-tool", status: "completed", rawOutput: { stdout: output }, content: [{ type: "content", content: { type: "text", text: output } }] })
    }
    if (text === "history") for (let index = 0; index < 8300; index++) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: String(index) } })
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer:${text}` } })
    promptId = null
    reply(request.id, { stopReason: "end_turn" })
  } else if (request.method === "authenticate") throw new Error("interactive fixture auth forbidden")
  else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported fixture method" } })
}