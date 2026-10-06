import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import type { ProviderId } from "../src/catalog/types.js"
import type { JsonObject } from "../src/agent/session-config.js"
import { privateRoot } from "./control-support.js"
import { agentHandlerFixture } from "./agent-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { createAgentStore } from "../src/agent/store.js"
import { agentTuple } from "../src/agent/recovery.js"

export type ObservedFrame = { id?: string | number; method?: string; params?: JsonObject; result?: JsonObject }
export type AcpPeer = {
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
  const pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void }>()
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
            pending.delete(Number(frame.id))
            if (frame.error) {
              const error = frame.error as JsonObject, agency = (error.data as JsonObject | undefined)?.agency as JsonObject | undefined
              call.reject(Object.assign(new Error(String(error.message)), { code: agency?.code ?? error.code }))
            } else call.resolve(frame.result as JsonObject)
          }
        }
        for (const wake of waits) wake()
      }
      if (Buffer.byteLength(buffer) > 1048576) throw new Error("oversized fixture frame")
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
    request(method, params) {
      const requestId = ++id
      return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); try { send({ id: requestId, method, params }) } catch (error) { pending.delete(requestId); reject(error) } })
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
  const root = await privateRoot(t), workspace = join(root, "workspace")
  await mkdir(workspace, { mode: 0o700 })
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/acp-provider.js", import.meta.url))], { cwd: workspace, env: { FIXTURE_ROOT: root, FIXTURE_BACKEND: backendId }, stdio: ["pipe", "pipe", "pipe"] })
  let exit: number | null | undefined
  child.once("exit", code => { exit = code })
  const peer = createAcpPeer(child.stdout, child.stdin)
  t.after(async () => {
    peer.close()
    if (exit === undefined) { child.kill("SIGTERM"); await new Promise<void>(resolve => child.once("exit", () => resolve())) }
    assert.equal(child.killed || exit !== undefined, true)
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" })
    t.diagnostic(`fixture provider cleanup verified: pid ${child.pid}`)
  })
  return { root, workspace, peer,
    async requests(): Promise<ObservedFrame[]> { return (await readFile(join(root, backendId + ".jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as ObservedFrame) },
  }
}

export async function acpFixture(t: TestContext) {
  const f = await agentHandlerFixture(t, { nativeAcp: true }), peers = new Set<AcpPeer>()
  t.after(() => { for (const peer of peers) peer.close() })
  const environment = { PATH: process.env.PATH!, HOME: join(f.root, "home") }
  const tuple = async (sessionId: string) => {
    assert.ok(sessionId.startsWith("agency:"))
    const record = await createAgentStore(f.paths.persistentRoot).readAgent(sessionId.slice(7))
    assert.ok(record)
    const target = agentTuple(record)
    assert.ok(target)
    return target
  }
  return { ...f, environment, tuple,
    async connect() {
      const socket = createConnection(join(f.paths.runtimeRoot, "acp.sock"))
      socket.write(JSON.stringify({ jsonrpc: "2.0", method: "agency/connect", params: { handlerGeneration: (await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))).generation, environment } }) + "\n")
      const peer = createAcpPeer(socket, socket); peers.add(peer); return peer
    },
    async stopSession(sessionId: string) { return f.waitCompleted(await f.stop(await tuple(sessionId))) },
    async restoreSession(sessionId: string, fresh: Record<string, string> = {}) {
      const target = await tuple(sessionId), current = await readHandlerRecord(join(f.paths.runtimeRoot, "handler.json"))
      const { exchangeAgent, AGENT_PROTOCOL } = await import("../src/agent/protocol.js")
      const reply = await exchangeAgent(createConnection(f.paths.handlerSocketPath), { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: current.generation, op: "agent_restore", input: { agentId: target.agentId, commandId: randomUUID(), handlerGeneration: current.generation, environment: { ...environment, ...fresh }, nativeParams: { cwd: f.workspace, mcpServers: [] } } })
      assert.ok(reply.ok && reply.result.state === "command")
      return f.waitCompleted(reply.result)
    },
    async requests(backend: ProviderId): Promise<ObservedFrame[]> { try { return (await readFile(join(f.root, backend + ".jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error } },
    async release(_backend: ProviderId) { await writeFile(join(f.root, "release-prompt"), "released", { mode: 0o600 }) },
  }
}