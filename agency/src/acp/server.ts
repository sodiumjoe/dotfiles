import { randomUUID } from "node:crypto"
import { basename, dirname } from "node:path"
import type { Writable } from "node:stream"
import { parseLaunchEnvironment } from "../agent/environment.js"
import type { AgentService } from "../agent/service.js"
import type { JsonObject } from "../agent/session-config.js"
import { bindPrivateSocket } from "../platform/private-socket.js"
import { createAcpDecoder, ACP_FRAME_BYTES, ACP_QUEUE_BYTES } from "./protocol.js"
import { createAcpRouter } from "./router.js"

export function createAcpWriter(stream: Writable, fail: (error: unknown) => void): { send(frame: JsonObject): void; close(): void } {
  const timers = new Set<NodeJS.Timeout>()
  let closed = false
  return {
    send(frame) {
      if (closed) return
      try {
        const bytes = Buffer.from(JSON.stringify(frame) + "\n")
        if (bytes.length > ACP_FRAME_BYTES || bytes.length + stream.writableLength > ACP_QUEUE_BYTES || stream.destroyed) throw new Error("ACP client write limit")
        const timer = setTimeout(() => { timers.delete(timer); fail(new Error("ACP client write timed out")) }, 5000)
        timers.add(timer)
        stream.write(bytes, error => { clearTimeout(timer); timers.delete(timer); if (error) fail(error) })
      } catch (error) { fail(error) }
    },
    close() { closed = true; for (const timer of timers) clearTimeout(timer); timers.clear() },
  }
}

export async function startAcpServer(input: { socketPath: string; service: AgentService; onError?(error: Error): void }): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<import("node:net").Socket>()
  let closing = false
  const server = await bindPrivateSocket(dirname(input.socketPath), basename(input.socketPath), socket => {
    sockets.add(socket)
    let router: ReturnType<typeof createAcpRouter> | undefined
    const fail = () => { router?.close(); socket.destroy() }
    const writer = createAcpWriter(socket, fail), timer = setTimeout(fail, 5000)
    const decoder = createAcpDecoder(frame => {
      if (!router) {
        try {
          const params = frame.params as JsonObject | undefined
          if (frame.method !== "agency/connect" || Object.hasOwn(frame, "id") || params?.handlerGeneration !== input.service.handlerGeneration) throw new Error("invalid ACP connection")
          const environment = parseLaunchEnvironment(params.environment)
          router = createAcpRouter({ service: input.service, connectionId: randomUUID(), send: frame => writer.send(frame), environment })
          clearTimeout(timer)
        } catch { fail() }
      } else void router.receive(frame).catch(fail)
    }, fail)
    socket.on("data", bytes => decoder.feed(bytes))
    socket.on("end", () => { decoder.end(); fail() })
    socket.on("error", fail)
    socket.once("close", () => { clearTimeout(timer); writer.close(); router?.close(); sockets.delete(socket) })
  })
  server.on("error", error => input.onError?.(error))
  server.on("close", () => { if (!closing) input.onError?.(new Error("ACP listener closed unexpectedly")) })
  return { async close() { if (closing) return; closing = true; for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}