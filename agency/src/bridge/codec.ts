import type { Readable, Writable } from "node:stream"
import { randomUUID } from "node:crypto"
import { BRIDGE_PROTOCOL, BRIDGE_FRAME_BYTES, bridgeError, encodeBridgeFrame, parseBridgeFrame, type BridgeFrame, type BridgeHello } from "./protocol.js"

export function decodeBridgeFrames(accept: (frame: BridgeFrame) => void) {
  let bytes = Buffer.alloc(0)
  return {
    push(chunk: Buffer) {
      let offset = 0
      while (offset < chunk.length) {
        const lf = chunk.indexOf(10, offset), end = lf < 0 ? chunk.length : lf
        if (bytes.length + end - offset > BRIDGE_FRAME_BYTES) bridgeError("FRAME_TOO_LARGE")
        bytes = Buffer.concat([bytes, chunk.subarray(offset, end)])
        offset = end + 1
        if (lf >= 0) {
          let value: unknown
          try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { bridgeError("INVALID_BRIDGE_JSON") }
          bytes = Buffer.alloc(0); accept(parseBridgeFrame(value))
        }
      }
    },
    end() { if (bytes.length) bridgeError("TRUNCATED_BRIDGE_FRAME") }
  }
}
export type RequestOptions = { signal?: AbortSignal; timeoutMs?: number }
export type BridgeRequestHandler = (channel: string, payload: unknown, requestId: string, signal: AbortSignal) => Promise<unknown>
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer?: NodeJS.Timeout }
export function createBridgePeer(input: { input: Readable; output: Writable; hello?: BridgeHello; writeQueueBytes?: number; readQueueBytes?: number; inboundWorkLimit?: number }) {
  let hello = input.hello, stopped = false, handler: BridgeRequestHandler | undefined, writing = false
  const ready = Promise.withResolvers<BridgeHello>(), closed = Promise.withResolvers<Error>(), pending = new Map<string, Pending>(), incoming = new Map<string, AbortController>()
  const writes: Array<{ bytes: Buffer; resolve(): void; reject(error: Error): void }> = []
  let retainedBytes = 0, retainedWork = 0
  let queuedBytes = 0, closure = new Error("BRIDGE_CLOSED")
  void ready.promise.catch(() => {})
  if (hello) { const { type: ignored, ...parsed } = parseBridgeFrame({ ...hello, type: "hello" }) as BridgeHello & { type: "hello" }; hello = parsed; ready.resolve(parsed) }
  function finish(error = new Error("BRIDGE_CLOSED")) {
    if (stopped) return
    stopped = true; closure = error; ready.reject(error); closed.resolve(error)
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error) }; pending.clear()
    for (const controller of incoming.values()) controller.abort(error); incoming.clear()
    for (const write of writes) write.reject(error); writes.length = 0; queuedBytes = 0
    input.input.off("data", data); input.input.off("end", end); input.input.off("close", end)
    if (!input.output.destroyed) input.output.end()
  }
  function pump() {
    if (stopped || writing || !writes.length) return
    writing = true
    const entry = writes[0]!
    input.output.write(entry.bytes, error => {
      writing = false
      if (stopped) return
      if (error) { finish(error); return }
      writes.shift(); queuedBytes -= entry.bytes.length; entry.resolve(); pump()
    })
  }
  function send(frame: BridgeFrame): Promise<void> {
    if (stopped) return Promise.reject(new Error("BRIDGE_CLOSED"))
    const bytes = encodeBridgeFrame(frame)
    if (queuedBytes + bytes.length > (input.writeQueueBytes ?? 2 * BRIDGE_FRAME_BYTES)) { const error = new Error("BRIDGE_BACKPRESSURE"); finish(error); return Promise.reject(error) }
    return new Promise((resolve, reject) => { writes.push({ bytes, resolve, reject }); queuedBytes += bytes.length; pump() })
  }
  const base = () => { if (!hello) bridgeError("BRIDGE_NOT_READY"); return { protocol: BRIDGE_PROTOCOL as typeof BRIDGE_PROTOCOL, connectionId: hello.connectionId } }
  function retain(frame: BridgeFrame, action: () => Promise<unknown>, units = 1) {
    const bytes = encodeBridgeFrame(frame).length * units
    if (retainedBytes + bytes > (input.readQueueBytes ?? 2 * BRIDGE_FRAME_BYTES) || retainedWork + units > (input.inboundWorkLimit ?? 64)) bridgeError("BRIDGE_BACKPRESSURE")
    retainedBytes += bytes; retainedWork += units
    void Promise.resolve().then(() => stopped ? undefined : action()).catch(error => finish(error)).finally(() => { retainedBytes -= bytes; retainedWork -= units })
  }
  function receive(frame: BridgeFrame) {
    if (frame.type === "hello") {
      if (hello || incoming.size || pending.size) bridgeError("INVALID_BRIDGE_HELLO")
      const { type: ignored, ...identity } = frame; hello = identity; ready.resolve(identity); return
    }
    if (!hello) bridgeError("BRIDGE_NOT_READY")
    if (frame.connectionId !== hello.connectionId) bridgeError("STALE_CONNECTION")
    if (frame.type === "reply") {
      const value = pending.get(frame.requestId)
      if (!value) return
      pending.delete(frame.requestId); clearTimeout(value.timer)
      if (frame.ok) value.resolve(frame.payload); else value.reject(new Error(frame.error))
    } else if (frame.type === "request_cancel") {
      incoming.get(frame.requestId)?.abort(new Error("TRANSPORT_DETACHED"))
    } else if (frame.type === "request") {
      if (!handler || incoming.has(frame.requestId)) bridgeError("INVALID_BRIDGE_REQUEST")
      const controller = new AbortController(); incoming.set(frame.requestId, controller)
      retain(frame, async () => {
        try {
          const payload = await handler!(frame.channel, frame.payload, frame.requestId, controller.signal)
          await send({ ...base(), type: "reply", requestId: frame.requestId, ok: true, payload })
        } catch (error) {
          await send({ ...base(), type: "reply", requestId: frame.requestId, ok: false, error: errorText(error) })
        } finally { incoming.delete(frame.requestId) }
      })
    }
  }
  const decoder = decodeBridgeFrames(receive)
  function data(chunk: Buffer) { try { decoder.push(chunk) } catch (error) { finish(error as Error) } }
  function end() { try { decoder.end(); finish(new Error("BRIDGE_EOF")) } catch (error) { finish(error as Error) } }
  const error = (error: Error) => finish(error)
  input.input.on("data", data); input.input.once("end", end); input.input.once("close", end); input.input.on("error", error); input.output.on("error", error)
  if (input.input.readableEnded || input.input.destroyed) end()
  return {
    ready: ready.promise, closed: closed.promise,
    sendHello() { if (!hello) bridgeError("BRIDGE_NOT_READY"); void send({ ...hello, type: "hello" }).catch(error => finish(error)) },
    onRequest(listener: BridgeRequestHandler) { handler = listener },
    async request(channel: string, payload: unknown, options: RequestOptions = {}): Promise<unknown> {
      await ready.promise
      if (stopped) throw closure
      if (options.signal?.aborted) throw options.signal.reason
      const requestId = randomUUID()
      return new Promise((resolve, reject) => {
        const cleanup = () => options.signal?.removeEventListener("abort", abort)
        const resolved = (value: unknown) => { cleanup(); resolve(value) }, rejected = (error: unknown) => { cleanup(); reject(error) }
        const abort = () => {
          if (!pending.has(requestId)) return
          pending.delete(requestId); clearTimeout(value.timer); rejected(options.signal!.reason)
          void send({ ...base(), type: "request_cancel", requestId }).catch(error => finish(error))
        }
        const value: Pending = { resolve: resolved, reject: rejected }
        if ((options.timeoutMs ?? 60000) > 0) { value.timer = setTimeout(() => { pending.delete(requestId); rejected(new Error("BRIDGE_TIMEOUT")); finish(new Error("BRIDGE_TIMEOUT")) }, options.timeoutMs ?? 60000); value.timer.unref() }
        pending.set(requestId, value)
        options.signal?.addEventListener("abort", abort, { once: true })
        void send({ ...base(), type: "request", requestId, channel, payload }).catch(error => { clearTimeout(value.timer); pending.delete(requestId); rejected(error) })
      })
    },
    close: finish
  }
}
function errorText(error: unknown): string {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
  const message = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : error instanceof Error ? error.message : "BRIDGE_REQUEST_FAILED"
  return message.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").slice(0, 512) || "BRIDGE_REQUEST_FAILED"
}