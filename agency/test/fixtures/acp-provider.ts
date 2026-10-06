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
let modelId = "legacy-a", modeId = "normal", promptId: string | number | null = null
let permission: (() => void) | undefined, release: (() => void) | undefined
const send = (frame: unknown) => { process.stdout.write(JSON.stringify(frame) + "\n") }
const reply = (id: string | number, result: unknown) => send({ jsonrpc: "2.0", id, result })
const update = (value: unknown) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-session", update: value } })
const exists = async (name: string) => { try { await readFile(join(root!, name)); return true } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false } }
async function barrier(name: string) {
  if (!await exists("pause-" + name)) return
  await writeFile(join(root!, "at-" + name), "ready", { mode: 0o600 })
  while (!await exists("release-" + name)) await new Promise(resolve => setTimeout(resolve, 10))
}
const snapshot = () => backend === "codex-acp" ? { configOptions: options } : {
  models: { currentModelId: modelId, availableModels: [{ modelId: "legacy-a", name: "A" }, { modelId: "legacy-b", name: "B" }] },
  modes: { currentModeId: modeId, availableModes: [{ id: "normal", name: "Normal" }, { id: "review", name: "Review" }] },
}
await appendFile(log, JSON.stringify({ method: "fixture/environment", params: { AGENCY_TEST_EDITOR_MARKER: process.env.AGENCY_TEST_EDITOR_MARKER ?? null, NVIM: process.env.NVIM ?? null } }) + "\n", { mode: 0o600 })
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
      try {
        const state = JSON.parse(await readFile(statePath, "utf8"))
        if (state.configOptions) for (const option of options) option.currentValue = state.configOptions.find((value: { id: string }) => value.id === option.id)?.currentValue ?? option.currentValue
        if (state.models) modelId = state.models.currentModelId
        if (state.modes) modeId = state.modes.currentModeId
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    await barrier("session")
    reply(request.id, { sessionId: "native-session", ...snapshot(), _meta: { fixture: backend } })
  } else if (request.method === "session/set_config_option") {
    const option = options.find(value => value.id === params.configId)
    if (!option || !option.options.some(value => value.value === params.value)) throw new Error("unoffered selection")
    await barrier("setter-before")
    option.currentValue = params.value
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
    if (params.sessionId !== "native-session" || !Array.isArray(params.prompt)) throw new Error("wrong prompt")
    const text = params.prompt.filter((value: { type: string }) => value.type === "text").map((value: { text: string }) => value.text).join("\n")
    if (text === "auth-required") { send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "AUTH_REQUIRED" } }); return }
    if (text === "fail") { process.exit(2) }
    promptId = request.id
    if (text === "permission") {
      const wait = new Promise<void>(resolve => { permission = resolve })
      const failure = setInterval(() => { void exists("fail-permission").then(ready => { if (ready) process.exit(2) }) }, 10)
      failure.unref()
      send({ jsonrpc: "2.0", id: 1, method: "session/request_permission", params: { sessionId: "native-session", toolCall: { toolCallId: "fixture-tool", title: "Fixture write", kind: "edit" }, options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }] } })
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
    if (text === "history") for (let index = 0; index < 8300; index++) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: String(index) } })
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer:${text}` } })
    promptId = null
    reply(request.id, { stopReason: "end_turn" })
  } else if (request.method === "authenticate") throw new Error("interactive fixture auth forbidden")
  else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported fixture method" } })
}