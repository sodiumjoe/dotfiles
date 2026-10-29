import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { TestContext } from "node:test"
import { privateRoot } from "./control-support.js"
import { createHandlerBridge } from "../src/bridge/server.js"
import { connectHandlerBridge } from "../src/bridge/handler-client.js"
import { connectBridge, type BridgeProcessFactory } from "../src/bridge/ssh.js"
import { runRuntimeBridgeCli } from "../src/bridge/runtime-remote.js"
import { createHostRouter, registerHostRouter } from "../src/hosts/router.js"
import type { HostEnrollment } from "../src/hosts/inventory.js"

export async function runtimeNetwork(t: TestContext) {
  const root = await privateRoot(t)
  const nodes = new Map<string, Awaited<ReturnType<typeof add>>>()
  const connections: string[] = [], registrations: boolean[] = [], requests: string[] = []
  const processFactory: BridgeProcessFactory = (_file, argv) => {
    const hostname = argv[argv.length - 2]!, node = nodes.get(hostname)
    if (!node) throw new Error("HOST_UNAVAILABLE")
    connections.push(hostname)
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    let killed = false
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill() { if (killed) return false; killed = true; stdin.end(); stdout.end(); child.emit("close", 0); return true } })
    void runRuntimeBridgeCli([], { input: stdin, output: stdout, async connect() {
      const local = await connectHandlerBridge({ root: node.root, hostId: node.enrollment.hostId, handlerGeneration: node.generation })
      return { ...local, async request(channel, payload, options) { requests.push(channel); const result = await local.request(channel, payload, options); if (channel === "relay-register") registrations.push((result as { registered: boolean }).registered); return result } }
    } }).then(() => child.kill(), error => { child.emit("error", error); child.kill() })
    t.after(() => child.kill())
    return child
  }
  async function add(hostname: string, digit: string, handlerGeneration?: string) {
    const path = join(root, hostname); await mkdir(path, { mode: 0o700 })
    const enrollment: HostEnrollment = { hostId: digit.repeat(64), hostname }, generation = handlerGeneration ?? randomUUID(), hosts: HostEnrollment[] = []
    const bridge = await createHandlerBridge({ root: path, identity: { hostId: enrollment.hostId, handlerGeneration: generation }, sourceRevision: "a".repeat(40) })
    const connect = (host: HostEnrollment) => connectBridge(host, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read"], processFactory })
    const router = createHostRouter({ hostId: enrollment.hostId, inventory: { list: async () => hosts }, local: (channel, payload, signal) => bridge.dispatch(channel, payload, signal ?? new AbortController().signal), connect })
    registerHostRouter({ bridge, router, hostId: enrollment.hostId, handlerGeneration: generation })
    t.after(async () => { router.close(); await bridge.close() })
    const node = { root: path, enrollment, generation, hosts, bridge, router, connect }
    nodes.set(hostname, node)
    return node
  }
  return { add, processFactory, connections, registrations, requests }
}