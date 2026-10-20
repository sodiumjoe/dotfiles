import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { text } from "../catalog/types.js"
import { bindPrivateSocket } from "../platform/private-socket.js"
import { createBridgePeer } from "./codec.js"
import { BRIDGE_PROTOCOL, bridgeError, type BridgeHello } from "./protocol.js"
import { createPagedReads } from "./paging.js"

export type BridgePeer = ReturnType<typeof createBridgePeer>
export type BridgeContext = { source: "local" } | { source: "peer"; peer: BridgePeer }
export type BridgeEndpoint = (input: { context: BridgeContext; channel: string; payload: unknown; requestId: string; signal: AbortSignal }) => Promise<unknown>
export type HandlerBridge = {
  register(channels: readonly string[], handle: BridgeEndpoint): () => void
  dispatch(channel: string, payload: unknown, signal: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

export async function createHandlerBridge(input: { root: string; identity: { hostId: string; handlerGeneration: string }; sourceRevision?: string }): Promise<HandlerBridge> {
  const revision = input.sourceRevision ?? text(JSON.parse(await readFile(new URL("../../build-manifest.json", import.meta.url), "utf8")).sourceRevision)
  const handlers = new Map<string, BridgeEndpoint>(), peers = new Set<BridgePeer>()
  let closing: Promise<void> | undefined
  const invoke = async (context: BridgeContext, channel: string, payload: unknown, requestId: string, signal: AbortSignal) => {
    if (closing || signal.aborted) bridgeError("BRIDGE_CLOSED")
    const handler = handlers.get(channel)
    if (!handler) bridgeError("UNSUPPORTED_CAPABILITY")
    return handler({ context, channel, payload, requestId, signal })
  }
  const server = await bindPrivateSocket(input.root, "bridge.sock", socket => {
    const hello: BridgeHello = { protocol: BRIDGE_PROTOCOL, ...input.identity, connectionId: randomUUID(), sourceRevision: revision, nodeVersion: process.version,
      capabilities: [...handlers.keys(), "read-pages", "read-open", "read-page", "read-close"] }
    const peer = createBridgePeer({ input: socket, output: socket, hello })
    peers.add(peer)
    const context: BridgeContext = { source: "peer", peer }
    const reads = createPagedReads((channel, payload, signal) => invoke(context, channel, payload, randomUUID(), signal))
    void peer.closed.then(() => { peers.delete(peer); reads.close(); socket.destroy() })
    peer.onRequest((channel, payload, requestId, signal) => ["read-open", "read-page", "read-close"].includes(channel)
      ? reads.request(channel, payload, signal) : invoke(context, channel, payload, requestId, signal))
    peer.sendHello()
  })
  return {
    register(channels, handle) {
      if (closing) bridgeError("BRIDGE_CLOSED")
      if (new Set(channels).size !== channels.length || channels.some(channel => handlers.has(channel) || ["read-pages", "read-open", "read-page", "read-close"].includes(channel))) bridgeError("BRIDGE_CHANNEL_EXISTS")
      for (const channel of channels) handlers.set(channel, handle)
      return () => { for (const channel of channels) if (handlers.get(channel) === handle) handlers.delete(channel) }
    },
    dispatch: (channel, payload, signal) => invoke({ source: "local" }, channel, payload, randomUUID(), signal),
    close() {
      if (closing) return closing
      for (const peer of peers) peer.close()
      handlers.clear()
      closing = new Promise<void>(resolve => server.close(() => resolve()))
      return closing
    }
  }
}