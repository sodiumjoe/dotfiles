import { hash, keys, object, text } from "../catalog/types.js"
import { bridgeError } from "../bridge/protocol.js"
import { createPagedReads, requestBridgeRead } from "../bridge/paging.js"
import type { BridgeTransport } from "../bridge/ssh.js"
import type { HandlerBridge } from "../bridge/server.js"
import type { HostEnrollment } from "./inventory.js"

export type HostRoute = { hostId: string; channel: string; payload: unknown }
export type HostRouter = {
  request(route: HostRoute, signal?: AbortSignal): Promise<unknown>
  fromRelay(route: HostRoute, signal?: AbortSignal): Promise<unknown>
  setRelay(send: (route: HostRoute, signal?: AbortSignal) => Promise<unknown>): () => void
  close(): void
}
export function isRoutedRead(channel: string): boolean { return channel === "runtime-read" || channel === "host-identity" }
export function parseHostRoute(raw: unknown): HostRoute {
  const value = object(raw); keys(value, ["hostId", "channel", "payload"])
  const channel = text(value.channel)
  if (!["runtime-read", "runtime-write", "host-identity", "entry-open", "runtime-entry-inspect"].includes(channel)) bridgeError("UNSUPPORTED_CAPABILITY")
  return { hostId: hash(value.hostId), channel, payload: value.payload }
}
export function createHostRouter(input: { hostId: string; inventory: { list(): Promise<HostEnrollment[]> }; local(channel: string, payload: unknown, signal?: AbortSignal): Promise<unknown>; connect(enrollment: HostEnrollment): Promise<BridgeTransport> }): HostRouter {
  const connections = new Map<string, Promise<BridgeTransport>>()
  let relay: ((route: HostRoute, signal?: AbortSignal) => Promise<unknown>) | undefined, closed = false
  function connected(enrollment: HostEnrollment): Promise<BridgeTransport> {
    const prior = connections.get(enrollment.hostId)
    if (prior) return prior
    const flight = input.connect(enrollment).then(transport => {
      if (closed) { transport.close(); bridgeError("BRIDGE_CLOSED") }
      const reads = createPagedReads((channel, payload, signal) => reverse(channel, payload, signal))
      const reverse = async (channel: string, payload: unknown, signal: AbortSignal) => {
        if (channel !== "host-route" && channel !== "host-route-read") bridgeError("UNSUPPORTED_CAPABILITY")
        const route = parseHostRoute(payload)
        if (channel === "host-route-read" && !isRoutedRead(route.channel)) bridgeError("UNSUPPORTED_CAPABILITY")
        return routeTo(route, false, signal)
      }
      transport.peer.onRequest((channel, payload, _requestId, signal) => ["read-open", "read-page", "read-close"].includes(channel) ? reads.request(channel, payload, signal) : reverse(channel, payload, signal))
      void transport.closed.then(() => { reads.close(); if (connections.get(enrollment.hostId) === flight) connections.delete(enrollment.hostId) })
      return transport
    }).catch(error => { if (connections.get(enrollment.hostId) === flight) connections.delete(enrollment.hostId); throw error })
    connections.set(enrollment.hostId, flight)
    return flight
  }
  async function routeTo(raw: HostRoute, allowRelay: boolean, signal?: AbortSignal): Promise<unknown> {
    if (closed || signal?.aborted) bridgeError("BRIDGE_CLOSED")
    const route = parseHostRoute(raw)
    if (route.hostId === input.hostId) return input.local(route.channel, route.payload, signal)
    const enrollment = (await input.inventory.list()).find(host => host.hostId === route.hostId)
    if (enrollment) {
      const transport = await connected(enrollment)
      try { return await transport.request(route.channel, route.payload, { ...(signal ? { signal } : {}) }) }
      catch (error) { transport.close(); throw error }
    }
    if (allowRelay && relay) return relay(route, signal)
    return bridgeError("HOST_UNAVAILABLE")
  }
  return {
    request: (route, signal) => routeTo(route, true, signal), fromRelay: (route, signal) => routeTo(route, false, signal),
    setRelay(send) { if (relay || closed) bridgeError("RELAY_EXISTS"); relay = send; return () => { if (relay === send) relay = undefined } },
    close() { if (closed) return; closed = true; relay = undefined; for (const flight of connections.values()) void flight.then(transport => transport.close(), () => undefined); connections.clear() }
  }
}
export function registerHostRouter(input: { bridge: HandlerBridge; router: HostRouter; hostId: string; handlerGeneration: string }): () => void {
  let owner: object | undefined
  return input.bridge.register(["host-route", "host-route-read", "host-identity", "relay-register"], async ({ context, channel, payload, signal }) => {
    if (channel === "host-identity") { keys(object(payload), []); return { hostId: input.hostId, handlerGeneration: input.handlerGeneration } }
    if (channel === "relay-register") {
      keys(object(payload), [])
      if (context.source !== "peer") bridgeError("UNSUPPORTED_CAPABILITY")
      if (owner) return { registered: false }
      const peer = context.peer
      const remove = input.router.setRelay((route, signal) => requestBridgeRead(peer, isRoutedRead(route.channel) ? "host-route-read" : "host-route", route, { ...(signal ? { signal } : {}) }))
      owner = peer
      void peer.closed.then(() => { if (owner === peer) { owner = undefined; remove() } })
      return { registered: true }
    }
    const route = parseHostRoute(payload)
    if (channel === "host-route-read" && !isRoutedRead(route.channel)) bridgeError("UNSUPPORTED_CAPABILITY")
    return input.router.request(route, signal)
  })
}