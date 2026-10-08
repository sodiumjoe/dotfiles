import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { randomUUID } from "node:crypto"
import type { TestContext } from "node:test"
import { createBridgePeer } from "../src/bridge/codec.js"
import { BRIDGE_PROTOCOL, type BridgeHello } from "../src/bridge/protocol.js"
import type { HostEnrollment } from "../src/bureau/hosts.js"
import type { BridgeProcessFactory } from "../src/bridge/ssh.js"

export function bridgeFixture(t: TestContext) {
  const enrollment: HostEnrollment = { inventoryId: randomUUID(), hostId: "a".repeat(64), hostname: "devbox-a", agyPath: "/opt/agency/bin/agy", loginShell: "/bin/bash" }
  const second = { ...enrollment, inventoryId: randomUUID(), hostId: "b".repeat(64), hostname: "devbox-b" }
  const calls: Array<{ file: string; argv: string[]; env: NodeJS.ProcessEnv }> = [], processes: Array<ReturnType<typeof make>> = []
  let generation = randomUUID(), starts = 0, runtime = "v24.13.0", observedHost = enrollment.hostId
  const agentId = randomUUID()
  function make() {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
    const hello: BridgeHello = { protocol: BRIDGE_PROTOCOL, hostId: observedHost, handlerGeneration: generation, connectionId: randomUUID(), sourceRevision: "c".repeat(40), nodeVersion: runtime, capabilities: ["snapshot", "launch", "submit"], outboxCursor: 0 }
    const peer = createBridgePeer({ input: stdin, output: stdout, hello })
    peer.onRequest(async channel => {
      if (channel === "snapshot") return { hostId: observedHost, handlerGeneration: generation, backendChoices: ["codex-acp"], agents: [{ agent: { hostId: observedHost, agentId }, execution: null, phase: "stopped", toolsEnabled: false, lineage: null, membership: null, cwd: "/workspace", settings: { modelId: "model-a" } }], receipts: [], replayFences: [] }
      starts++; return { accepted: true }
    })
    queueMicrotask(() => peer.sendHello())
    return Object.assign(child, { stdin, stdout, stderr, peer, kill() { peer.close(); child.emit("close", 0); return true } })
  }
  const spawn: BridgeProcessFactory = (file, argv, options) => { calls.push({ file, argv: [...argv], env: options.env }); const child = make(); processes.push(child); return child }
  t.after(() => { for (const child of processes) child.kill() })
  return { enrollment, second, spawn, calls, processes, agentId, get startCount() { return starts }, retire() { generation = randomUUID() }, setHost(value: string) { observedHost = value }, setRuntime(value: string) { runtime = value } }
}