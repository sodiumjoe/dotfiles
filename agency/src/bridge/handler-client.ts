import { createConnection } from "node:net"
import { assertPrivateSocket } from "../platform/private-socket.js"
import { inspectHandlerGeneration } from "../platform/singleton.js"
import { productionEnvironment } from "../handler/environment.js"
import { createBridgePeer } from "./codec.js"
import { bridgeError } from "./protocol.js"

export async function connectHandlerBridge(input: { root: string; hostId: string; handlerGeneration: string }) {
  const socket = createConnection(await assertPrivateSocket(input.root, "bridge.sock")), peer = createBridgePeer({ input: socket, output: socket })
  const timer = setTimeout(() => peer.close(new Error("BRIDGE_HELLO_TIMEOUT")), 5000)
  void peer.closed.then(() => socket.destroy())
  try {
    const hello = await peer.ready
    if (hello.hostId !== input.hostId) bridgeError("HOST_IDENTITY_CHANGED")
    if (hello.handlerGeneration !== input.handlerGeneration) bridgeError("STALE_HANDLER")
    if (hello.nodeVersion !== "v24.13.0") bridgeError("UNSUPPORTED_RUNTIME")
    return peer
  } catch (error) { peer.close(); socket.destroy(); throw error }
  finally { clearTimeout(timer) }
}
export async function productionHandlerBridge() {
  const environment = await productionEnvironment(), inspection = await inspectHandlerGeneration(environment.paths.runtimeRoot, environment.adapter)
  if (!inspection || inspection.disposition !== "live" || inspection.record.phase !== "ready") bridgeError("HANDLER_UNAVAILABLE")
  return connectHandlerBridge({ root: environment.paths.runtimeRoot, hostId: environment.paths.hostKey, handlerGeneration: inspection.record.generation })
}