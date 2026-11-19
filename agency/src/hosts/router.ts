import { hash, keys, object, text } from "../config/validate.js"
import { bridgeError } from "../bridge/protocol.js"
import { createPagedReads, requestBridgeRead } from "../bridge/paging.js"
import type { BridgeTransport } from "../bridge/ssh.js"
import type { HandlerBridge } from "../bridge/server.js"
import type { HostEnrollment } from "./inventory.js"

export type HostRoute = { hostId: string; channel: string; payload: unknown }
export type HostRouter = {
  request(route: HostRoute, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>
  forget(hostId: string): void
  fromRelay(route: HostRoute, signal?: AbortSignal): Promise<unknown>
  setRelay(send: (route: HostRoute, signal?: AbortSignal) => Promise<unknown>): () => void
  close(): void
}
export function isRoutedRead(channel: string): boolean { return channel === "runtime-entry-inspect" || channel === "live-read" || channel === "live-wait" }
export function parseHostRoute(raw: unknown): HostRoute {
  const value = object(raw); keys(value, ["hostId", "channel", "payload"])
  const channel = text(value.channel)
  if (!["entry-open", "runtime-entry-inspect", "live-read", "live-wait", "live-request"].includes(channel)) bridgeError("UNSUPPORTED_CAPABILITY")
  return { hostId: hash(value.hostId), channel, payload: value.payload }
}
export function parsePeerRoute(raw: unknown): HostRoute {
  const route = parseHostRoute(raw)
  if (!isRoutedRead(route.channel)) bridgeError("UNSUPPORTED_CAPABILITY")
  return route
}
export function createHostRouter(input: { hostId: string; inventory: { list(): Promise<HostEnrollment[]> }; local(channel: string, payload: unknown, signal?: AbortSignal): Promise<unknown>; connect(enrollment: HostEnrollment): Promise<BridgeTransport>; upward?(payload: unknown, signal: AbortSignal, sourceHostId: string): Promise<unknown> }): HostRouter {
  const connections = new Map<string, Promise<BridgeTransport>>()
  let relay: ((route: HostRoute, signal?: AbortSignal) => Promise<unknown>) | undefined, closed = false
  function connected(enrollment: HostEnrollment): Promise<BridgeTransport> {
    const prior = connections.get(enrollment.hostId)
    if (prior) return prior
    if (closed) bridgeError("BRIDGE_CLOSED")
    const flight = input.connect(enrollment).then(transport => {
      if (closed) { transport.close(); bridgeError("BRIDGE_CLOSED") }
      const reads = createPagedReads((channel, payload, signal) => reverse(channel, payload, signal))
      const reverse = async (channel: string, payload: unknown, signal: AbortSignal) => {
        if (channel === "delegate") { if (!input.upward) bridgeError("UNSUPPORTED_CAPABILITY"); return input.upward(payload, signal, enrollment.hostId) }
        if (channel !== "host-route" && channel !== "host-route-read") bridgeError("UNSUPPORTED_CAPABILITY")
        const route = parsePeerRoute(payload)
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
  function forget(hostId: string): void {
    const flight = connections.get(hostId)
    connections.delete(hostId)
    void flight?.then(transport => transport.close(), () => undefined)
  }
  async function routeTo(raw: HostRoute, allowRelay: boolean, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    if (closed || signal?.aborted) bridgeError("BRIDGE_CLOSED")
    const route = parseHostRoute(raw)
    if (route.hostId === input.hostId) return input.local(route.channel, route.payload, signal)
    const enrollment = (await input.inventory.list()).find(host => host.hostId === route.hostId)
    if (enrollment) {
      const transport = await connected(enrollment)
      return await transport.request(route.channel, route.payload, { ...(timeoutMs !== undefined ? { timeoutMs } : isRoutedRead(route.channel) ? { timeoutMs: 10000 } : {}), ...(signal ? { signal } : {}) })
    }
    forget(route.hostId)
    if (allowRelay && relay) return relay(route, signal)
    return bridgeError("HOST_UNAVAILABLE")
  }
  return {
    request: (route, signal, timeoutMs) => routeTo(route, true, signal, timeoutMs), fromRelay: (route, signal) => routeTo(route, false, signal),
    forget,
    setRelay(send) { if (relay || closed) bridgeError("RELAY_EXISTS"); relay = send; return () => { if (relay === send) relay = undefined } },
    close() { if (closed) return; closed = true; relay = undefined; for (const flight of connections.values()) void flight.then(transport => transport.close(), () => undefined); connections.clear() }
  }
}
export function registerHostRouter(input: { bridge: HandlerBridge; router: HostRouter }): { unregister(): void; owners(): number; upward(payload: unknown, signal?: AbortSignal): Promise<unknown> } {
  const owners: Array<{ peer: object; send(route: HostRoute, signal?: AbortSignal): Promise<unknown> }> = []
  let remove: (() => void) | undefined
  const relay = (route: HostRoute, signal?: AbortSignal) => {
    const owner = owners.at(-1)
    return owner ? owner.send(route, signal) : bridgeError("HOST_UNAVAILABLE")
  }
  const unregister = input.bridge.register(["host-route", "host-route-read", "relay-register"], async ({ context, channel, payload, signal }) => {
    if (channel === "relay-register") {
      keys(object(payload), [])
      if (context.source !== "peer") bridgeError("UNSUPPORTED_CAPABILITY")
      const peer = context.peer
      if (owners.some(owner => owner.peer === peer)) return { registered: true }
      const owner = { peer, send: (route: HostRoute, signal?: AbortSignal) => requestBridgeRead(peer, isRoutedRead(route.channel) ? "host-route-read" : "host-route", route, { ...(signal ? { signal } : {}) }) }
      owners.push(owner)
      remove ??= input.router.setRelay(relay)
      void peer.closed.then(() => {
        owners.splice(owners.indexOf(owner), 1)
        if (!owners.length) { remove?.(); remove = undefined }
      })
      return { registered: true }
    }
    const route = parsePeerRoute(payload)
    if (channel === "host-route-read" && !isRoutedRead(route.channel)) bridgeError("UNSUPPORTED_CAPABILITY")
    return input.router.request(route, signal)
  })
  return {
    unregister: () => { unregister() },
    owners: () => owners.length,
    upward: async (payload, signal) => {
      const owner = owners.at(-1)
      if (!owner) bridgeError("HOST_UNAVAILABLE")
      return (owner.peer as Parameters<typeof requestBridgeRead>[0]).request("delegate", payload, { ...(signal ? { signal } : {}) })
    }
  }
}