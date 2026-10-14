import type { Readable, Writable } from "node:stream"
import { randomUUID } from "node:crypto"
import { createBridgePeer } from "./codec.js"
import { createPagedReads, requestBridgeRead } from "./paging.js"
import { productionHandlerBridge } from "./handler-client.js"
import { bridgeError } from "./protocol.js"
import { isRoutedRead, parseHostRoute } from "../hosts/router.js"

export type RuntimeBridgeDependencies = { input: Readable; output: Writable; connect(): Promise<ReturnType<typeof createBridgePeer>> }
export function productionRuntimeBridgeDependencies(): RuntimeBridgeDependencies { return { input: process.stdin, output: process.stdout, connect: productionHandlerBridge } }
export async function runRuntimeBridgeCli(argv: readonly string[], deps: RuntimeBridgeDependencies): Promise<void> {
  if (argv.length) bridgeError("INVALID_HOST_BRIDGE_ARGUMENTS")
  const local = await deps.connect()
  let publicPeer: ReturnType<typeof createBridgePeer> | undefined
  const reverse = createPagedReads(async (channel, payload, signal) => {
    if (channel !== "host-route-read" || !isRoutedRead(parseHostRoute(payload).channel) || !publicPeer) bridgeError("UNSUPPORTED_CAPABILITY")
    return requestBridgeRead(publicPeer, channel, payload, { signal })
  })
  const forward = createPagedReads((channel, payload, signal) => local.request(channel, payload, { signal }))
  try {
    const localHello = await local.ready
    const allowed = ["task-read", "task-write", "runtime-read", "runtime-write", "host-route", "host-route-read", "host-identity", "entry-open", "runtime-entry-inspect", "read-pages", "read-open", "read-page", "read-close"]
    const hello = { ...localHello, connectionId: randomUUID(), capabilities: localHello.capabilities.filter(channel => allowed.includes(channel)) }
    publicPeer = createBridgePeer({ input: deps.input, output: deps.output, hello })
    const peer = publicPeer
    local.onRequest((channel, payload, _requestId, signal) => {
      if (["read-open", "read-page", "read-close"].includes(channel)) return reverse.request(channel, payload, signal)
      if (channel !== "host-route" && channel !== "host-route-read") bridgeError("UNSUPPORTED_CAPABILITY")
      const route = parseHostRoute(payload)
      if (channel === "host-route-read" && !isRoutedRead(route.channel)) bridgeError("UNSUPPORTED_CAPABILITY")
      return requestBridgeRead(peer, channel, payload, { signal })
    })
    peer.onRequest((channel, payload, _requestId, signal) => {
      if (!hello.capabilities.includes(channel)) bridgeError("UNSUPPORTED_CAPABILITY")
      return ["read-open", "read-page", "read-close"].includes(channel) ? forward.request(channel, payload, signal) : local.request(channel, payload, { signal })
    })
    void local.closed.then(error => peer.close(error))
    await local.request("relay-register", {})
    peer.sendHello()
    await peer.closed
  } finally { reverse.close(); forward.close(); publicPeer?.close(); local.close() }
}