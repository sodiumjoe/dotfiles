import { readFile } from "node:fs/promises"
import type { Readable, Writable } from "node:stream"
import type { JsonObject } from "../src/agent/session-config.js"

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
                call.reject(Object.assign(new Error(String(error.message)), { code: agency?.code ?? error.code, data: error.data }))
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