import { randomUUID } from "node:crypto"
import { basename, dirname } from "node:path"
import type { Writable } from "node:stream"
import { parseLaunchEnvironment, type LaunchEnvironment } from "../agent/environment.js"
import type { JsonObject } from "../agent/session-config.js"
import { bindPrivateSocket } from "../platform/private-socket.js"
import { createAcpDecoder } from "./protocol.js"
import { encodeWireJson } from "./wire-json.js"

export function createAcpWriter(stream: Writable, fail: (error: unknown) => void): { send(frame: JsonObject): void; close(): void } {
  const timers = new Set<NodeJS.Timeout>()
  let closed = false
  return {
    send(frame) {
      if (closed) return
      try {
        const bytes = Buffer.from(encodeWireJson(frame) + "\n")
        if (!stream.writable || stream.destroyed) throw new Error("ACP client connection closed")
        const timer = setTimeout(() => { timers.delete(timer); fail(new Error("ACP client write timed out")) }, 5000)
        timers.add(timer)
        stream.write(bytes, error => { clearTimeout(timer); timers.delete(timer); if (error) fail(error) })
      } catch (error) { fail(error) }
    },
    close() { closed = true; for (const timer of timers) clearTimeout(timer); timers.clear() },
  }
}

export type AcpConnectionRouter = { receive(frame: JsonObject): Promise<void>; close(): void }
export async function startAcpServer(input: { socketPath: string; handlerGeneration: string; router(connection: { connectionId: string; send(frame: JsonObject): void; environment: LaunchEnvironment }): AcpConnectionRouter; onError?(error: Error): void }): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<import("node:net").Socket>()
  let closing = false
  const server = await bindPrivateSocket(dirname(input.socketPath), basename(input.socketPath), socket => {
    sockets.add(socket)
    let router: AcpConnectionRouter | undefined
    const fail = () => { router?.close(); socket.destroy() }
    const writer = createAcpWriter(socket, fail), timer = setTimeout(fail, 5000)
    const decoder = createAcpDecoder(frame => {
      if (!router) {
        try {
          const params = frame.params as JsonObject | undefined
          if (frame.method !== "agency/connect" || Object.hasOwn(frame, "id") || params?.handlerGeneration !== input.handlerGeneration) throw new Error("invalid ACP connection")
          const environment = parseLaunchEnvironment(params.environment)
          router = input.router({ connectionId: randomUUID(), send: frame => writer.send(frame), environment })
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