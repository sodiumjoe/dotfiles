import type { Socket } from "node:net"
import { ControlError, MAX_FRAME_BYTES, errorReply, parseRequest, parseReply, validateReplyForRequest, type ControlRequest, type ControlReply } from "./protocol.js"

export function encodeFrame(value: unknown): Buffer {
  const json = JSON.stringify(value)
  if (json === undefined || Buffer.byteLength(json) > MAX_FRAME_BYTES) throw new ControlError("INCOMPLETE", "response exceeds frame limit")
  return Buffer.from(json + "\n")
}

export function receiveFrame(socket: Socket, timeoutMs = 5000): Promise<unknown> {
  if (socket.destroyed || socket.readableEnded) return Promise.reject(new ControlError("UNAVAILABLE", "socket closed"))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0, lines = 0, settled = false
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off("data", data); socket.off("end", end); socket.off("error", failed); socket.off("close", closed)
      if (error) reject(error); else resolve(value)
    }
    const data = (chunk: Buffer): void => {
      size += chunk.length
      if (size > MAX_FRAME_BYTES + 1) { finish(new ControlError("INVALID_PROTOCOL", "frame exceeds limit")); return }
      for (const byte of chunk) if (byte === 10) lines++
      if (lines > 1) { finish(new ControlError("INVALID_PROTOCOL", "multiple frames")); return }
      chunks.push(chunk)
    }
    const end = (): void => {
      try {
        const bytes = Buffer.concat(chunks, size)
        if (lines !== 1 || bytes.at(-1) !== 10) throw new Error("missing final LF")
        finish(undefined, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1))))
      } catch { finish(new ControlError("INVALID_PROTOCOL", "malformed frame")) }
    }
    const failed = (): void => finish(new ControlError("UNAVAILABLE", "socket failed"))
    const closed = (): void => finish(new ControlError("UNAVAILABLE", "socket closed before complete frame"))
    const timer = setTimeout(() => finish(new ControlError("INCOMPLETE", "exchange timed out")), timeoutMs)
    socket.on("data", data); socket.once("end", end); socket.once("error", failed); socket.once("close", closed)
  })
}

export async function exchange(socket: Socket, request: ControlRequest, timeoutMs = 5000): Promise<ControlReply> {
  try {
    const frame = encodeFrame(parseRequest(request))
    const incoming = receiveFrame(socket, timeoutMs)
    socket.end(frame)
    const reply = parseReply(await incoming)
    validateReplyForRequest(reply, request)
    return reply
  } finally { socket.destroy() }
}

export function sendReply(socket: Socket, reply: ControlReply, timeoutMs = 1000): Promise<void> {
  let bytes: Buffer
  try { bytes = encodeFrame(reply) } catch { bytes = encodeFrame(errorReply(reply, new ControlError("INCOMPLETE", "response exceeds frame limit"))) }
  return new Promise(resolve => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off("error", done); socket.off("close", done)
      socket.destroy()
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    socket.once("error", done); socket.once("close", done)
    if (socket.destroyed) done(); else socket.end(bytes, done)
  })
}

export async function serveControl(socket: Socket, handler: (request: ControlRequest) => Promise<ControlReply>, timeoutMs = 5000): Promise<void> {
  socket.allowHalfOpen = true
  try {
    const request = parseRequest(await receiveFrame(socket, timeoutMs))
    let reply: ControlReply
    try { reply = await handler(request) } catch (error) { reply = errorReply(request, error) }
    await sendReply(socket, reply)
  } catch { socket.destroy() }
}