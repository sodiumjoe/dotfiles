import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { TestContext } from "node:test"
import { controlFixture, until } from "./control-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { PROTOCOL } from "../src/control/protocol.js"
import { exchangeLive, REQUEST_PROTOCOL, type LiveOperation, type LiveResult } from "../src/live/protocol.js"
import { RequestError } from "../src/live/errors.js"
import type { RosterRow } from "../src/live/roster.js"
import type { PromptResult } from "../src/live/core.js"
import type { ProviderProfile } from "../src/catalog/types.js"

export type StartInput = Partial<Extract<LiveOperation, { op: "start" }>>

export async function liveHandlerFixture(t: TestContext) {
  const homes = await mkdtemp(join(tmpdir(), "agency-homes-"))
  t.after(() => rm(homes, { recursive: true, force: true }))
  const f = await controlFixture(t, {}, fileURLToPath(new URL("./fixtures/live-handler.js", import.meta.url)), { CODEX_HOME: join(homes, "codex"), CLAUDE_CONFIG_DIR: join(homes, "claude") })
  const workspace = join(f.root, "workspace"), otherWorkspace = join(f.root, "other-workspace")
  await mkdir(workspace, { mode: 0o700 }); await mkdir(otherWorkspace, { mode: 0o700 })
  const profiles: ProviderProfile[] = []
  for (const [backend, adapter, sdk] of [["codex-acp", "@agentclientprotocol/codex-acp", null], ["claude-agent-acp", "@agentclientprotocol/claude-agent-acp", "sdk.json"]] as const) {
    const directory = join(f.root, "profiles", backend)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, "native"), "fixture metadata only", { mode: 0o700 })
    await writeFile(join(directory, "adapter.json"), JSON.stringify({ name: adapter, version: "1.0.0", main: "agent-provider.js" }), { mode: 0o600 })
    await writeFile(join(directory, "agent-provider.js"), await readFile(fileURLToPath(new URL("./fixtures/acp-provider.js", import.meta.url))), { mode: 0o600 })
    await writeFile(join(directory, "declared.json"), "{}", { mode: 0o600 })
    if (sdk) { await writeFile(join(directory, sdk), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.232", main: "sdk.js" }), { mode: 0o600 }); await writeFile(join(directory, "sdk.js"), "", { mode: 0o600 }) }
    profiles.push({ id: backend, enabled: true, executable: join(directory, "native"), adapterPackageJson: join(directory, "adapter.json"), sdkPackageJson: sdk ? join(directory, sdk) : null, configurationFiles: [join(directory, "declared.json")] })
  }
  await mkdir(join(f.paths.persistentRoot, "catalog"), { mode: 0o700 })
  await writeFile(join(f.paths.persistentRoot, "catalog/providers.json"), JSON.stringify({ version: 1, providers: profiles }), { mode: 0o600 })
  await writeFile(join(f.paths.persistentRoot, "catalog/backends.json"), JSON.stringify({ version: 1, defaultBackendId: "codex-acp", backends: profiles.map(value => ({ id: value.id, args: [], environmentDefaults: { FIXTURE_ROOT: f.root, FIXTURE_BACKEND: value.id, FIXTURE_SELECTION: "true" }, initial: {}, compatibilityId: "fixture-v1" })) }), { mode: 0o600 })
  const handler = () => readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
  const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), FIXTURE_ROOT: f.root, FIXTURE_SCENARIO: "normal" })
  const startHandler = async () => {
    try { await f.start(15000) } catch (error) { throw new Error("fixture startup failed: " + await readFile(join(f.root, "failure"), "utf8").catch(() => ""), { cause: error }) }
  }
  await startHandler()
  async function request(operation: LiveOperation): Promise<LiveResult> {
    const reply = await exchangeLive(createConnection(f.paths.handlerSocketPath), { protocol: REQUEST_PROTOCOL, requestId: randomUUID(), ...operation })
    if (!reply.ok) throw new RequestError(reply.error.code, reply.error.message)
    return reply.result
  }
  const agent = async (operation: LiveOperation): Promise<RosterRow> => { const result = await request(operation); assert.equal(result.state, "agent"); return (result as { agent: RosterRow }).agent }
  const proveAbsent = async (pid: number) => until(async () => await f.observe(pid) === null ? true : undefined, 15000)
  async function stopHandler(): Promise<void> {
    const current = await handler().catch(() => null)
    if (!current?.process || await f.observe(current.process.pid) === null) return
    await f.shutdownOwnedHandler({ generation: current.generation, process: current.process }, {
      request: () => f.call({ protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: current.generation, op: "shutdown", commandId: randomUUID(), stopAgents: true }),
      track: async () => {}, signal: () => f.signal(current.process!, "SIGKILL"), absent: async () => { await proveAbsent(current.process!.pid) },
    })
  }
  const providers = () => f.registrations().filter(item => item.role.startsWith("agent-provider/"))
  async function verifyZeroSurvivors(): Promise<void> {
    await writeFile(join(f.root, "release-prompt"), "released", { mode: 0o600 })
    await stopHandler()
    for (const item of providers()) if (item.pid) await proveAbsent(item.pid)
  }
  f.beforeCleanup(verifyZeroSurvivors)
  return { ...f, workspace, otherWorkspace, environment, request, providers,
    start: (input: StartInput = {}) => agent({ op: "start", agentId: randomUUID(), cwd: workspace, backendId: "codex-acp", environment: environment(), ...input }),
    stop: (agentId: string) => agent({ op: "stop", agentId }),
    cancel: (agentId: string) => agent({ op: "cancel", agentId }),
    async prompt(agentId: string, text: string, submissionId?: string): Promise<PromptResult> { const result = await request({ op: "prompt", agentId, text, environment: environment(), ...(submissionId ? { submissionId } : {}) }); assert.equal(result.state, "prompt"); return result as PromptResult },
    async agents(): Promise<RosterRow[]> { const result = await request({ op: "agents" }); assert.equal(result.state, "agents"); return (result as { agents: RosterRow[] }).agents },
    async failure(operation: Promise<unknown>): Promise<{ code: string; message: string }> { try { await operation } catch (error) { if (error instanceof RequestError) return { code: error.code, message: error.message }; throw error } throw new Error("expected the request to fail") },
    async events(): Promise<Array<Record<string, unknown>>> {
      const read = () => readFile(join(f.paths.persistentRoot, "events.jsonl"), "utf8").catch(() => "")
      let text = await read()
      for (let settled = false, attempts = 0; !settled && attempts < 40; attempts++) { await new Promise(resolve => setTimeout(resolve, 25)); const next = await read(); settled = next === text; text = next }
      return text.split("\n").filter(Boolean).map(line => JSON.parse(line))
    },
    async providerRequests(backend = "codex-acp"): Promise<Array<{ method?: string; params?: Record<string, unknown> }>> { return (await readFile(join(f.root, backend + ".jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line)) },
    async pausePrompts() { await writeFile(join(f.root, "pause-prompt"), "pause", { mode: 0o600 }) },
    async waitPrompt() { await until(async () => await readFile(join(f.root, "at-prompt")).then(() => true, () => undefined), 15000) },
    async releasePrompts() { await rm(join(f.root, "pause-prompt"), { force: true }); await writeFile(join(f.root, "release-prompt"), "released", { mode: 0o600 }) },
    async crashHandler() { const current = await handler(); assert.ok(current.process); await f.signal(current.process, "SIGKILL"); await proveAbsent(current.process.pid) },
    stopHandler, restart: startHandler, verifyZeroSurvivors, handler,
  }
}