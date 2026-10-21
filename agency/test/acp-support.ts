import { nativeFixtureAccess } from "./fixtures/run-scope.js"
import { fixtureRuntime, fixtureLeafSpawner, fixtureSpawner, signalFixturePid } from "./fixtures/fixture-spawn.js"
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { ProviderId } from "../src/catalog/types.js"
import type { JsonObject, JsonValue } from "../src/agent/session-config.js"
import { privateRoot } from "./control-support.js"
import { type AgentHandlerOptions, agentHandlerFixture } from "./agent-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { createAgentStore } from "../src/agent/store.js"
import { agentTuple } from "../src/agent/recovery.js"
import { until } from "./control-support.js"

export type ObservedFrame = { id?: string | number; method?: string; params?: JsonObject; result?: JsonObject }
export type AcpPeer = {
  delayResponse(method: string): Promise<void>
  releaseResponse(method: string): Promise<void>
  request(method: string, params: JsonObject): Promise<JsonObject>
  notify(method: string, params: JsonObject): void
  next(method: "session/request_permission"): Promise<{ id: string | number; params: JsonObject }>
  next(method: string): Promise<JsonObject>
  nextState(state: "idle" | "running" | "unavailable"): Promise<JsonObject>
  respond(id: string | number, result: JsonObject): void
  drain(method: string): JsonObject[]
  close(): void
}

export function createAcpPeer(readable: Readable, writable: Writable): AcpPeer {
  let id = 0, buffer = "", closed = false
  const decoder = new TextDecoder("utf-8", { fatal: true }), frames: JsonObject[] = []
  const pending = new Map<number, { method: string; resolve(value: JsonObject): void; reject(error: Error): void }>()
  const delayed = new Set<string>(), held = new Map<string, Array<() => void>>()
  const waits = new Set<() => void>()
  const fail = (error: Error) => { closed = true; for (const call of pending.values()) call.reject(error); pending.clear(); for (const wake of waits) wake() }
  const send = (frame: JsonObject) => { if (closed) throw new Error("ACP peer closed"); writable.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n") }
  readable.on("data", (bytes: Buffer) => {
    try {
      buffer += decoder.decode(bytes, { stream: true })
      let index: number
      while ((index = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, index)) as JsonObject
        buffer = buffer.slice(index + 1)
        if (frame.jsonrpc !== "2.0") throw new Error("invalid ACP fixture frame")
        if (typeof frame.method === "string") frames.push(frame)
        else {
          const call = pending.get(Number(frame.id))
          if (call) {
            const complete = () => {
              pending.delete(Number(frame.id))
              if (frame.error) {
                const error = frame.error as JsonObject, agency = (error.data as JsonObject | undefined)?.agency as JsonObject | undefined
                call.reject(Object.assign(new Error(String(error.message)), { code: agency?.code ?? error.code }))
              } else call.resolve(frame.result as JsonObject)
            }
            if (delayed.has(call.method)) { const callbacks = held.get(call.method) ?? []; callbacks.push(complete); held.set(call.method, callbacks) }
            else complete()
          }
        }
        for (const wake of waits) wake()
      }
    } catch (error) { fail(error as Error) }
  })
  readable.on("error", fail); readable.on("end", () => fail(new Error("ACP peer EOF")))
  writable.on("error", fail)
  async function take(predicate: (frame: JsonObject) => boolean): Promise<JsonObject> {
    const deadline = Date.now() + 15000
    while (true) {
      const index = frames.findIndex(predicate)
      if (index >= 0) return frames.splice(index, 1)[0]!
      if (closed) throw new Error("ACP peer closed before notification")
      if (Date.now() > deadline) throw new Error("ACP fixture notification timeout")
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); waits.delete(wake); resolve() }
        const timer = setTimeout(wake, 100)
        waits.add(wake)
      })
    }
  }
  return {
    async delayResponse(method: string) { delayed.add(method) },
    async releaseResponse(method: string) { delayed.delete(method); const callbacks = held.get(method) ?? []; held.delete(method); for (const complete of callbacks) complete() },
    request(method, params) {
      const requestId = ++id
      return new Promise((resolve, reject) => { pending.set(requestId, { method, resolve, reject }); try { send({ id: requestId, method, params }) } catch (error) { pending.delete(requestId); reject(error) } })
    },
    notify: (method, params) => send({ method, params }),
    async next(method: string) {
      const frame = await take(frame => frame.method === method)
      return method === "session/request_permission" ? { id: frame.id, params: frame.params } as JsonObject : frame.params as JsonObject
    },
    async nextState(state) { const frame = await take(frame => frame.method === "agency/session_state" && (frame.params as JsonObject)?.state === state); return frame.params as JsonObject },
    respond: (requestId, result) => send({ id: requestId, result }),
    drain(method) { const matching = frames.filter(frame => frame.method === method); for (const frame of matching) frames.splice(frames.indexOf(frame), 1); return matching.map(frame => frame.params as JsonObject) },
    close() { fail(new Error("ACP peer closed")); readable.destroy(); writable.destroy() },
  } as AcpPeer
}

export async function providerFixture(t: TestContext, backendId: ProviderId = "codex-acp") {
  const root = await privateRoot(t, { retainRoot: true }), workspace = join(root, "workspace")
  await mkdir(workspace, { mode: 0o700 })
  ;(await fixtureRuntime()).scope.artifact(root)
  const child = (await fixtureLeafSpawner("acp-provider"))(process.execPath, [fileURLToPath(new URL("./fixtures/acp-provider.js", import.meta.url))], { cwd: workspace, env: { FIXTURE_ROOT: root, FIXTURE_BACKEND: backendId }, stdio: ["pipe", "pipe", "pipe"] })
  const terminal = new Promise<void>(resolve => child.once("exit", () => resolve()))
  let exit: number | null | undefined
  child.once("exit", code => { exit = code })
  const peer = createAcpPeer(child.stdout, child.stdin)
  t.after(async () => {
    peer.close()
    if (exit === undefined) await signalFixturePid(child.pid!, "SIGTERM")
    await terminal
    assert.equal(child.killed || exit !== undefined, true)
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" })
    t.diagnostic(`fixture provider cleanup verified: pid ${child.pid}`)
  })
  return { root, workspace, peer,
    async requests(): Promise<ObservedFrame[]> { return (await readFile(join(root, backendId + ".jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as ObservedFrame) },
  }
}

export async function acpFixture(t: TestContext, options: AgentHandlerOptions = {}) {
  const cleanup: Array<{ close: () => unknown; ownerBounded: boolean }> = [], context = Object.create(t) as TestContext
  context.diagnostic = t.diagnostic.bind(t)
  context.after = fn => { cleanup.push({ close: () => fn?.(t, error => { if (error) throw error }), ownerBounded: false }) }
  t.after(async () => {
    const failures: unknown[] = []
    for (const { close, ownerBounded } of cleanup.reverse()) {
      let timer: NodeJS.Timeout | undefined
      try { if (ownerBounded) await close(); else await Promise.race([Promise.resolve().then(close), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("ACP owner cleanup deadline")), 15000) })]) }
      catch (error) { failures.push(error) } finally { clearTimeout(timer) }
    }
    if (failures.length) throw new AggregateError(failures, "ACP fixture cleanup incomplete")
  })
  const f = await agentHandlerFixture(context, { ...options, nativeAcp: true }), peers = new Set<AcpPeer>()
  context.after(() => { for (const peer of peers) peer.close() })
  const environment = { PATH: process.env.PATH!, HOME: join(f.root, "home"), ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith("AGENCY_TEST_") && value !== undefined)) }
  const tuple = async (sessionId: string) => {
    assert.ok(sessionId.startsWith("agency:"))
    const record = await createAgentStore(f.paths.persistentRoot).readAgent(sessionId.slice(7))
    assert.ok(record)
    const target = agentTuple(record)
    assert.ok(target)
    return target
  }
  return { ...f, environment, tuple, onCleanup: (close: () => Promise<void>) => { cleanup.push({ close, ownerBounded: true }) }, diagnostic: (message: string) => t.diagnostic(message),
    async connect() {
      const socket = createConnection(join(f.paths.runtimeRoot, "acp.sock"))
      socket.write(JSON.stringify({ jsonrpc: "2.0", method: "agency/connect", params: { handlerGeneration: (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation, environment } }) + "\n")
      const peer = createAcpPeer(socket, socket); peers.add(peer); return peer
    },
    async stopSession(sessionId: string) { return f.waitCompleted(await f.stop(await tuple(sessionId))) },
    async restoreSession(sessionId: string, fresh: Record<string, string> = {}) {
      const record = await createAgentStore(f.paths.persistentRoot).readAgent(sessionId.slice(7)), current = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
      assert.ok(record)
      const { exchangeAgent, AGENT_PROTOCOL } = await import("../src/agent/protocol.js")
      const reply = await exchangeAgent(createConnection(f.paths.handlerSocketPath), { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: current.generation, op: "agent_restore", input: { agentId: record.definition.agentId, commandId: randomUUID(), handlerGeneration: current.generation, environment: { ...environment, ...fresh }, nativeParams: { cwd: record.definition.cwd, mcpServers: [] } } })
      assert.ok(reply.ok && reply.result.state === "command")
      return f.waitCompleted(reply.result)
    },
    async requests(backend: ProviderId): Promise<ObservedFrame[]> { try { return (await readFile(join(f.root, backend + ".jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error } },
    async release(_backend: ProviderId) { await writeFile(join(f.root, "release-prompt"), "released", { mode: 0o600 }) },
  }
}

export type AcpFixture = Awaited<ReturnType<typeof acpFixture>>
export type EditorFixture = { lua(expression: string): Promise<JsonValue>; closeTab(): Promise<void>; exit(): Promise<void>; pid: number }
const exec = promisify(execFile)

export async function editorFixture(f: AcpFixture): Promise<EditorFixture> {
  const repo = fileURLToPath(new URL("../../../", import.meta.url)), root = join(f.root, "editor-" + randomUUID().slice(0, 8))
  await mkdir(root, { mode: 0o700 })
  const config = join(root, "endpoint.json"), socket = join(root, "nvim.sock")
  await writeFile(config, JSON.stringify({ paths: f.paths, environment: f.environment }), { mode: 0o600 })
  const executable = process.env.NVIM_TEST_EXECUTABLE ?? "/opt/homebrew/bin/nvim"
  const runtime = await fixtureRuntime(), spawnFixture = await fixtureSpawner()
  runtime.scope.artifact(root)
  const child = spawnFixture("editor", executable, ["--headless", "-i", "NONE", "--listen", socket, "-u", join(repo, "tests/neovim/acp_minimal_init.lua")], {
    detached: true, cwd: f.workspace, env: { ...process.env, HOME: f.environment.HOME, XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), DOTFILES_TEST_ROOT: repo,
      AGENCY_FIXTURE_PLUGIN_ROOT: process.env.AGENCY_FIXTURE_PLUGIN_ROOT ?? join(process.env.HOME!, ".local/share/nvim/lazy/agentic.nvim"), AGENCY_FIXTURE_NODE: process.execPath,
      AGENCY_FIXTURE_ENDPOINT: fileURLToPath(new URL("./fixtures/acp-endpoint.js", import.meta.url)),
      AGENCY_FIXTURE_PROCESS: fileURLToPath(new URL("./fixtures/editor-process.js", import.meta.url)),
      AGENCY_FIXTURE_CONTROL: fileURLToPath(new URL("./fixtures/acp-control.js", import.meta.url)), AGENCY_FIXTURE_CONFIG: config }, stdio: ["ignore", "ignore", "pipe"],
  }, { source: true })
  const editorRef = runtime.scope.snapshot().launches.find(value => value.pid === child.pid)!.ref
  const terminal = new Promise<void>(resolve => child.once("close", () => resolve()))
  let cleanup: Promise<void> | undefined, exited = false, stderr = ""
  const endpoints = new Set<number>()
  child.once("exit", () => { exited = true })
  child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8192) })
  const lua = async (expression: string, timeoutMs = 15000): Promise<JsonValue> => {
    const source = `(function() local value = ${expression}; local endpoints = {}; for _,client in pairs(require('agentic.acp.agent_instance')._instances) do if client.transport and client.transport.pid then endpoints[#endpoints+1]=client.transport.pid end end; return vim.json.encode({value=value == nil and vim.NIL or value,endpoints=endpoints,registry=AgencyFixture.registry()}) end)()`
    const result = await exec(executable, ["--server", socket, "--remote-expr", `luaeval(${JSON.stringify(source)})`], { timeout: timeoutMs, maxBuffer: 1048576 })
    const envelope = JSON.parse(result.stdout.trim()) as { value: JsonValue; endpoints: number[]; registry: { launches: Array<{pid: number | null; reporting: string}> } }
    for (const pid of envelope.endpoints) endpoints.add(pid)
    for (const launch of envelope.registry.launches) if (launch.reporting === "editor-endpoint" && launch.pid) endpoints.add(launch.pid)
    await writeFile(join(root, "registry.json"), JSON.stringify(envelope.registry), { mode: 0o600 })
    return envelope.value
  }
  function exit(): Promise<void> {
    cleanup ??= cleanupEditor()
    return cleanup
  }
  async function cleanupEditor(): Promise<void> {
    const deadline = Date.now() + 15000, reportingUntil = Date.now() + 5000, failures: unknown[] = []
    const remaining = (limitMs: number, reserveMs = 0) => Math.max(1, Math.min(limitMs, deadline - Date.now() - reserveMs))
    let reportingFailure: unknown
    if (!exited) {
      for (const expression of ["AgencyFixture.close_all()", "AgencyFixture.registry()", "AgencyFixture.complete()", "AgencyFixture.registry()"] ) {
        const timeoutMs = reportingUntil - Date.now()
        if (timeoutMs <= 0) { reportingFailure ??= new Error("editor reporting deadline"); break }
        try {
          const value = await lua(expression, timeoutMs)
          if (expression === "AgencyFixture.registry()") await writeFile(join(root, "registry.json"), JSON.stringify(value), { mode: 0o600 })
        } catch (error) { reportingFailure ??= error }
      }
      try { await exec(executable, ["--server", socket, "--remote-expr", 'luaeval("(function() vim.schedule(function() vim.cmd(\'qa!\') end); return true end)()")'], { timeout: remaining(2000, 7000) }) } catch {}
      try { await until(async () => exited ? true : undefined, remaining(1000, 7000)) }
      catch {
        try { await nativeFixtureAccess(runtime.scope).signalPid(editorRef, "SIGKILL", remaining(4000, 3000)) }
        catch (error) { failures.push(error) }
      }
    }
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([terminal, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("editor close deadline")), remaining(3000)) })])
      assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" })
      f.diagnostic(`fixture editor cleanup verified: pid ${child.pid}`)
    } catch (error) { failures.push(error) } finally { clearTimeout(timer) }
    for (const pid of endpoints) {
      try {
        await until(async () => { try { process.kill(pid, 0); return undefined } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; return true } }, remaining(3000))
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
        f.diagnostic(`fixture endpoint cleanup verified: pid ${pid}`)
      } catch (error) { failures.push(error) }
    }
    if (reportingFailure) {
      nativeFixtureAccess(runtime.scope).fault(new Error("Editor reporting incomplete: " + String(reportingFailure)), editorRef)
      try { await writeFile(join(root, "editor-failure.txt"), String(reportingFailure)) } catch (error) { failures.push(error) }
      failures.unshift(reportingFailure)
    }
    if (failures.length) throw new AggregateError(failures, "Editor cleanup incomplete: " + failures.map(String).join("; "))
  }
  f.onCleanup(exit)
  await until(async () => {
    if (exited) throw new Error("fixture editor failed: " + stderr)
    try { return await lua("true") === true ? true : undefined } catch { return undefined }
  }, 15000)
  return { pid: child.pid!, lua, closeTab: async () => { await lua("AgencyFixture.close_tab()") }, exit }
}