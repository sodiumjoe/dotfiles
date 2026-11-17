import { spawn } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { createAgentIndex } from "../src/agent/agent-index.js"
import { mergeBackendEnvironment, readBackendConfig } from "../src/agent/backend-config.js"
import { snapshotLaunchEnvironment } from "../src/agent/environment.js"
import { defaultHomes } from "../src/agent/excerpt.js"
import { migrateIndex } from "../src/agent/index-migration.js"
import { adapterEntry, readProfiles } from "../src/catalog/config.js"
import { productionEnvironment } from "../src/handler/environment.js"

const env = await productionEnvironment(), root = env.paths.persistentRoot
const copy = await mkdtemp(join(tmpdir(), "agency-index-check-")), index = createAgentIndex(copy)
console.log(JSON.stringify({ migration: await migrateIndex({ root, index, homes: defaultHomes() }), index: copy }))
const entries = await index.list(), profiles = await readProfiles(root), backends = (await readBackendConfig(root)).backends
const watch = new URL("../src/agent/parent-watch.js", import.meta.url).href
async function check(agentId: string): Promise<Record<string, unknown>> {
  const entry = entries.find(value => value.agentId === agentId)
  if (!entry) return { agentId, ok: false, error: "not in the migrated index" }
  const profile = profiles.find(value => value.id === entry.backendId), backend = backends.find(value => value.id === entry.backendId)
  if (!profile || !backend) return { agentId, ok: false, error: "no profile or backend for " + entry.backendId }
  const environment = { ...mergeBackendEnvironment(snapshotLaunchEnvironment(process.env), backend.environmentDefaults), ...(entry.backendId === "codex-acp" ? { CODEX_PATH: profile.executable } : { CLAUDE_CODE_EXECUTABLE: profile.executable }) }
  const child = spawn(process.execPath, ["--import", watch, await adapterEntry(profile), ...backend.args], { cwd: entry.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: environment })
  let stderr = "", updates = 0, next = 1
  child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-2000) })
  const waiting = new Map<number, (value: { result?: unknown; error?: { message?: string } }) => void>()
  createInterface({ input: child.stdout! }).on("line", line => { try { const message = JSON.parse(line); if (message.method === "session/update") updates++; else if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id) } } catch {} })
  const call = (method: string, params: unknown, ms: number) => new Promise<{ result?: unknown; error?: { message?: string } }>(resolve => {
    const id = next++, timer = setTimeout(() => { waiting.delete(id); resolve({ error: { message: method + " timed out after " + ms + " ms" } }) }, ms)
    waiting.set(id, value => { clearTimeout(timer); resolve(value) })
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
  try {
    const initialized = await call("initialize", { protocolVersion: 1, clientCapabilities: {} }, 30000)
    if (initialized.error) return { agentId, backendId: entry.backendId, ok: false, updates, error: initialized.error.message ?? "initialize failed", stderr }
    const loaded = await call("session/load", { sessionId: entry.nativeSessionId, cwd: entry.cwd, mcpServers: [] }, 90000)
    await new Promise(resolve => setTimeout(resolve, 1000))
    return { agentId, backendId: entry.backendId, ok: !loaded.error, updates, error: loaded.error?.message ?? null, ...(loaded.error ? { stderr } : {}) }
  } finally { try { process.kill(-child.pid!, "SIGTERM") } catch {} }
}
for (const agentId of process.argv.slice(2)) console.log(JSON.stringify(await check(agentId)))
process.exit(0)