import type { Server, Socket } from "node:net"
import type { AgentService } from "../agent/service.js"
import type { PlatformPaths } from "../platform/paths.js"
import { bindPrivateSocket } from "../platform/private-socket.js"
import { createHostCoordination } from "./host-coordination.js"
import { createHandlerBridge } from "../bridge/server.js"
import { serveToolSocket } from "../orchestration/tool-client.js"
import { dispatchBureau } from "../bureau/client.js"
import { parseBureauRequest } from "../bureau/protocol.js"
import { encodeFrame, receiveFrame } from "../control/wire.js"

export type TaskServices = { close(): Promise<void> }
export type CoordinationFactory = typeof createHostCoordination

export function startTaskServices(input: {
  root: string
  paths: PlatformPaths
  generation: string
  agents: AgentService
  coordinationFactory?: CoordinationFactory
  issue(error: unknown): void
}): TaskServices {
  const controller = new AbortController(), sockets = new Set<Socket>()
  const factory = input.coordinationFactory ?? createHostCoordination
  let coordination: Awaited<ReturnType<CoordinationFactory>> | undefined
  let bridge: Awaited<ReturnType<typeof createHandlerBridge>> | undefined
  let toolsServer: Server | undefined, bureauServer: Server | undefined
  let closing = false, cleanup: Promise<void> | undefined
  const closeListener = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()))
  const close = (): Promise<void> => {
    if (cleanup) return cleanup
    closing = true
    controller.abort()
    for (const socket of sockets) socket.destroy()
    void coordination?.close().catch(input.issue)
    cleanup = Promise.all([
      ...(bridge ? [bridge.close()] : []),
      ...[toolsServer, bureauServer].filter((server): server is Server => server !== undefined).map(closeListener)
    ]).then(() => undefined)
    return cleanup
  }
  const track = (socket: Socket) => {
    if (closing) { socket.destroy(); return false }
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    return true
  }
  const failed = (error: unknown) => { input.issue(error); void close().catch(input.issue) }
  const startup = (async () => {
    const value = await factory({ root: input.root, runtimeRoot: input.paths.runtimeRoot, hostId: input.paths.hostKey, agents: input.agents, signal: controller.signal, issue: input.issue,
      coordinator: (payload, signal) => { if (!bridge) throw new Error("BUREAU_UNAVAILABLE"); return bridge.coordinatorRequest(payload, signal) } })
    if (closing) { void value.close().catch(input.issue); return }
    coordination = value
    const tools = await bindPrivateSocket(input.paths.runtimeRoot, "orchestration.sock", socket => {
      if (track(socket)) void serveToolSocket(socket, value.tools).catch(() => socket.destroy())
    })
    if (closing) { await closeListener(tools); return }
    toolsServer = tools
    tools.on("error", failed)
    const bureau = await bindPrivateSocket(input.paths.runtimeRoot, "bureau.sock", socket => {
      if (!track(socket)) return
      socket.allowHalfOpen = true
      socket.on("error", () => undefined)
      void (async () => {
        try {
          const request = parseBureauRequest(await receiveFrame(socket)), reply = await dispatchBureau(value.bureau, input.generation, request, value.human)
          await new Promise<void>(resolve => socket.end(encodeFrame(reply), resolve))
        } catch { socket.destroy() } finally { socket.destroy() }
      })()
    })
    if (closing) { await closeListener(bureau); return }
    bureauServer = bureau
    bureau.on("error", failed)
    const connected = await createHandlerBridge({ root: input.paths.runtimeRoot, host: value.origin, journals: value.origins, replay: value.replay, identity: { hostId: input.paths.hostKey, handlerGeneration: input.generation } })
    if (closing) { await connected.close(); return }
    bridge = connected
  })()
  void startup.catch(error => { if (!closing) failed(error) })
  return { close }
}