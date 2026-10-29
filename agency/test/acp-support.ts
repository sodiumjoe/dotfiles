import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import type { TestContext } from "node:test"
import type { ProviderId } from "../src/catalog/types.js"
import type { JsonObject } from "../src/agent/session-config.js"
import { type AgentHandlerOptions, agentHandlerFixture } from "./agent-support.js"
import { readHandlerRecord } from "../src/platform/private-state.js"
import { createAgentStore } from "../src/agent/store.js"
import { agentTuple } from "../src/agent/recovery.js"

export type ObservedFrame = { id?: string | number; method?: string; params?: JsonObject; result?: JsonObject }
export async function readAcpRequestLog(path: string): Promise<ObservedFrame[]> {
  try {
    const lines = (await readFile(path, "utf8")).split("\n")
    lines.pop()
    return lines.map(line => JSON.parse(line))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

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
    async requests(backend: ProviderId): Promise<ObservedFrame[]> { return readAcpRequestLog(join(f.root, backend + ".jsonl")) },
    async release(_backend: ProviderId) { await writeFile(join(f.root, "release-prompt"), "released", { mode: 0o600 }) },
  }
}