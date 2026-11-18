import assert from "node:assert/strict"
import test from "node:test"
import { createHostRouter, registerHostRouter } from "../src/hosts/router.js"
import type { BridgeTransport } from "../src/bridge/ssh.js"
import type { HandlerBridge } from "../src/bridge/server.js"

const local = "a".repeat(64), remote = "b".repeat(64), unknown = "c".repeat(64)

function fakeTransport(behaviour: (channel: string, payload: unknown, options: { timeoutMs?: number }) => Promise<unknown>) {
  let close!: () => void
  const state = { closes: 0, closed: new Promise<void>(resolve => { close = resolve }), end: () => close() }
  const transport = { hello: { capabilities: [] }, diagnostics: "", peer: { onRequest() {} }, request: (channel: string, payload: unknown, options: { timeoutMs?: number } = {}) => behaviour(channel, payload, options), close() { state.closes++ }, closed: state.closed } as unknown as BridgeTransport
  return { transport, state }
}

function router(connect: () => Promise<BridgeTransport>, list = async () => [{ hostId: remote, hostname: "devbox" }]) {
  return createHostRouter({ hostId: local, inventory: { list }, local: async () => null, connect })
}

test("a failed request keeps the host connection", async () => {
  let connects = 0
  const { transport, state } = fakeTransport(async () => { throw new Error("UNSUPPORTED_CAPABILITY") })
  const hosts = router(async () => { connects++; return transport })
  await assert.rejects(hosts.request({ hostId: remote, channel: "live-read", payload: {} }), /UNSUPPORTED_CAPABILITY/)
  await assert.rejects(hosts.request({ hostId: remote, channel: "live-read", payload: {} }), /UNSUPPORTED_CAPABILITY/)
  assert.deepEqual([connects, state.closes], [1, 0])
  hosts.close()
})

test("a host whose transport closed is connected again", async () => {
  const transports = [fakeTransport(async () => "first"), fakeTransport(async () => "second")]
  let index = 0
  const hosts = router(async () => transports[index++]!.transport)
  assert.equal(await hosts.request({ hostId: remote, channel: "live-read", payload: {} }), "first")
  transports[0]!.state.end()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await hosts.request({ hostId: remote, channel: "live-read", payload: {} }), "second")
  hosts.close()
})

test("a request can set its own timeout", async () => {
  const seen: Array<number | undefined> = []
  const { transport } = fakeTransport(async (_channel, _payload, options) => { seen.push(options.timeoutMs); return null })
  const hosts = router(async () => transport)
  await hosts.request({ hostId: remote, channel: "live-read", payload: {} }, undefined, 13000)
  await hosts.request({ hostId: remote, channel: "live-read", payload: {} })
  assert.deepEqual(seen, [13000, 10000])
  hosts.close()
})

test("a closed router does not connect", async () => {
  let connects = 0, release!: () => void
  const listed = new Promise<void>(resolve => { release = resolve })
  const { transport } = fakeTransport(async () => null)
  const hosts = router(async () => { connects++; return transport }, async () => { await listed; return [{ hostId: remote, hostname: "devbox" }] })
  const pending = hosts.request({ hostId: remote, channel: "live-read", payload: {} })
  hosts.close()
  release()
  await assert.rejects(pending, /BRIDGE_CLOSED/)
  assert.equal(connects, 0)
})

test("the newest bridge owns the relay and the previous one takes over when it closes", async () => {
  let handle!: (input: { context: unknown; channel: string; payload: unknown; signal: AbortSignal }) => Promise<unknown>
  const bridge = { register: (_channels: readonly string[], endpoint: typeof handle) => { handle = endpoint; return () => {} } } as unknown as HandlerBridge
  const hosts = router(async () => { throw new Error("unused") }, async () => [])
  registerHostRouter({ bridge, router: hosts })
  const peer = (name: string) => {
    let close!: () => void
    const closed = new Promise<void>(resolve => { close = resolve })
    return { value: { ready: Promise.resolve({ capabilities: [] }), request: async () => name, closed }, close }
  }
  const first = peer("first"), second = peer("second"), signal = new AbortController().signal
  assert.deepEqual(await handle({ context: { source: "peer", peer: first.value }, channel: "relay-register", payload: {}, signal }), { registered: true })
  assert.deepEqual(await handle({ context: { source: "peer", peer: second.value }, channel: "relay-register", payload: {}, signal }), { registered: true })
  const route = { hostId: unknown, channel: "live-read", payload: {} }
  assert.equal(await hosts.request(route), "second")
  second.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await hosts.request(route), "first")
  first.close()
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(hosts.request(route), /HOST_UNAVAILABLE/)
  hosts.close()
})

test("a forgotten host's connection is closed", async () => {
  const { transport, state } = fakeTransport(async () => "ok")
  const hosts = router(async () => transport)
  assert.equal(await hosts.request({ hostId: remote, channel: "live-read", payload: {} }), "ok")
  hosts.forget(remote)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.closes, 1)
  hosts.forget(unknown)
  hosts.close()
})

test("a host that leaves the inventory loses its cached connection", async () => {
  let enrolled = [{ hostId: remote, hostname: "devbox" }]
  const { transport, state } = fakeTransport(async () => "ok")
  const hosts = router(async () => transport, async () => enrolled)
  assert.equal(await hosts.request({ hostId: remote, channel: "live-read", payload: {} }), "ok")
  enrolled = []
  await assert.rejects(hosts.request({ hostId: remote, channel: "live-read", payload: {} }), /HOST_UNAVAILABLE/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.closes, 1)
  hosts.close()
})

test("a devbox can route only reads through the laptop, while the laptop itself can route anything", async () => {
  let reverse!: (channel: string, payload: unknown, requestId: string, signal: AbortSignal) => Promise<unknown>
  const { transport } = fakeTransport(async () => "ok")
  ;(transport.peer as unknown as { onRequest: (handler: typeof reverse) => void }).onRequest = handler => { reverse = handler }
  const hosts = router(async () => transport)
  await hosts.request({ hostId: remote, channel: "live-read", payload: {} })
  const signal = new AbortController().signal
  await assert.rejects(reverse("host-route", { hostId: local, channel: "live-request", payload: { op: "permissions" } }, "r", signal), /UNSUPPORTED_CAPABILITY/)
  await assert.rejects(reverse("host-route", { hostId: local, channel: "entry-open", payload: {} }, "r", signal), /UNSUPPORTED_CAPABILITY/)
  assert.equal(await reverse("host-route", { hostId: local, channel: "live-read", payload: {} }, "r", signal), null)
  assert.equal(await hosts.request({ hostId: local, channel: "live-request", payload: { op: "permissions" } }), null)
  let handle!: (input: { context: unknown; channel: string; payload: unknown; signal: AbortSignal }) => Promise<unknown>
  registerHostRouter({ bridge: { register: (_channels: readonly string[], endpoint: typeof handle) => { handle = endpoint; return () => {} } } as unknown as HandlerBridge, router: hosts })
  await assert.rejects(handle({ context: { source: "peer", peer: {} }, channel: "host-route", payload: { hostId: local, channel: "live-request", payload: {} }, signal }), /UNSUPPORTED_CAPABILITY/)
  hosts.close()
})