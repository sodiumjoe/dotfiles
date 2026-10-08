import type { Readable, Writable } from "node:stream"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { object } from "../catalog/types.js"
import { canonicalDigest } from "../orchestration/types.js"
import { BRIDGE_PROTOCOL, BRIDGE_FRAME_BYTES, bridgeError, encodeBridgeFrame, parseAdmission, parseBridgeFrame, type Admission, type BridgeFrame, type BridgeHello, type BridgeEvent, type BridgeAck } from "./protocol.js"

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
export type RequestOptions = { beforeAccepted?: () => Promise<void>; timeoutMs?: number }
export type BridgeRequestHandler = (channel: string, payload: unknown, requestId: string, signal: AbortSignal) => Promise<unknown>
type Pending = { resolve(value: unknown): void; reject(error: Error): void; admission: Admission | null; beforeAccepted?: () => Promise<void>; prepared: boolean; published: boolean; timer?: NodeJS.Timeout }
type Preparing = { admission: Admission; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }
export function createBridgePeer(input: { input: Readable; output: Writable; hello?: BridgeHello; writeQueueBytes?: number; readQueueBytes?: number; inboundWorkLimit?: number; admissionTimeoutMs?: number }) {
  let hello = input.hello, stopped = false, handler: BridgeRequestHandler | undefined, writing = false
  const ready = Promise.withResolvers<BridgeHello>(), closed = Promise.withResolvers<Error>(), pending = new Map<string, Pending>(), preparing = new Map<string, Preparing>(), incoming = new Map<string, AbortController>(), listeners = new Set<(frame: BridgeEvent | BridgeAck) => Promise<void> | void>()
  const writes: Array<{ bytes: Buffer; resolve(): void; reject(error: Error): void }> = []
  let retainedBytes = 0, retainedWork = 0
  let queuedBytes = 0, closure = new Error("BRIDGE_CLOSED")
  void ready.promise.catch(() => {})
  if (hello) { const { type: ignored, ...parsed } = parseBridgeFrame({ ...hello, type: "hello" }) as BridgeHello & { type: "hello" }; hello = parsed; ready.resolve(parsed) }
  function finish(error = new Error("BRIDGE_CLOSED")) {
    if (stopped) return
    stopped = true; closure = error; ready.reject(error); closed.resolve(error)
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error) }; pending.clear()
    for (const value of preparing.values()) { clearTimeout(value.timer); value.reject(error) }; preparing.clear()
    for (const controller of incoming.values()) controller.abort(error); incoming.clear()
    for (const write of writes) write.reject(error); writes.length = 0; queuedBytes = 0
    listeners.clear(); input.input.off("data", data); input.input.off("end", end); input.input.off("close", end)
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
  async function admission(frame: Extract<BridgeFrame, { type: "admission_prepare" }>) {
    const value = pending.get(frame.requestId)
    const binding = { execution: frame.execution, submissionId: frame.submissionId, digest: frame.digest }
    if (!value || value.prepared || !value.beforeAccepted || !isDeepStrictEqual(value.admission, binding)) bridgeError("INVALID_ADMISSION")
    value.prepared = true
    try {
      await value.beforeAccepted()
      value.published = true
      await send({ ...base(), type: "admission_result", requestId: frame.requestId, ...binding, ok: true, error: null })
    } catch (error) {
      await send({ ...base(), type: "admission_result", requestId: frame.requestId, ...binding, ok: false, error: errorText(error) }).catch(() => {})
      value.reject(error instanceof Error ? error : new Error("ADMISSION_FAILED")); clearTimeout(value.timer); pending.delete(frame.requestId)
    }
  }
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
      if (frame.ok && value.beforeAccepted && !value.published) bridgeError("INVALID_ADMISSION")
      pending.delete(frame.requestId); clearTimeout(value.timer)
      if (frame.ok) value.resolve(frame.payload); else value.reject(new Error(frame.error))
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
    } else if (frame.type === "admission_prepare") {
      retain(frame, () => admission(frame))
    } else if (frame.type === "admission_result") {
      const value = preparing.get(frame.requestId)
      if (!value || !isDeepStrictEqual(value.admission, { execution: frame.execution, submissionId: frame.submissionId, digest: frame.digest })) bridgeError("INVALID_ADMISSION")
      preparing.delete(frame.requestId); clearTimeout(value.timer)
      if (frame.ok) value.resolve(); else value.reject(new Error(frame.error!))
    } else {
      const recipients = [...listeners]
      if (recipients.length) retain(frame, async () => Promise.all(recipients.map(listener => listener(frame))), recipients.length)
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
    subscribe(listener: (frame: BridgeEvent | BridgeAck) => Promise<void> | void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    sendEvent(frame: BridgeEvent | BridgeAck) { return send(frame) },
    async request(channel: string, payload: unknown, options: RequestOptions = {}): Promise<unknown> {
      await ready.promise
      if (stopped) throw closure
      const requestId = randomUUID()
      let binding: Admission | null = null
      if (options.beforeAccepted) { const p = object(payload), request = object(p.request); binding = parseAdmission({ execution: p.target, submissionId: request.submissionId, digest: canonicalDigest({ prompt: request.prompt }) }) }
      return new Promise((resolve, reject) => {
        const value: Pending = { resolve, reject, admission: binding, prepared: false, published: false, ...(options.beforeAccepted ? { beforeAccepted: options.beforeAccepted } : {}) }
        if ((options.timeoutMs ?? 60000) > 0) { value.timer = setTimeout(() => { pending.delete(requestId); reject(new Error("BRIDGE_TIMEOUT")); finish(new Error("BRIDGE_TIMEOUT")) }, options.timeoutMs ?? 60000); value.timer.unref() }
        pending.set(requestId, value)
        void send({ ...base(), type: "request", requestId, channel, payload }).catch(error => { clearTimeout(value.timer); pending.delete(requestId); reject(error) })
      })
    },
    async prepareAdmission(requestId: string, raw: Admission): Promise<void> {
      const binding = parseAdmission(raw)
      if (stopped) throw closure
      if (!incoming.has(requestId) || preparing.has(requestId)) bridgeError("INVALID_ADMISSION")
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { preparing.delete(requestId); reject(new Error("ADMISSION_TIMEOUT")); finish(new Error("ADMISSION_TIMEOUT")) }, input.admissionTimeoutMs ?? 30000); timer.unref()
        preparing.set(requestId, { admission: binding, resolve, reject, timer })
        void send({ ...base(), type: "admission_prepare", requestId, ...binding }).catch(error => { clearTimeout(timer); preparing.delete(requestId); reject(error) })
      })
    },
    close: finish
  }
}
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "BRIDGE_REQUEST_FAILED"
  return message.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").slice(0, 512) || "BRIDGE_REQUEST_FAILED"
}