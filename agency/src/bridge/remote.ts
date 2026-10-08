import type { Readable, Writable } from "node:stream"
import { randomUUID } from "node:crypto"
import { absolutePath, object } from "../catalog/types.js"
import { canonicalDigest } from "../orchestration/types.js"
import { createBridgePeer, type BridgeRequestHandler } from "./codec.js"
import { BRIDGE_FRAME_BYTES, bridgeError, parseAdmission, type BridgeHello } from "./protocol.js"
import { invokeDestination, parseHostCall, runHostCall } from "./invocation.js"
import { productionHandlerBridge } from "./handler-client.js"

export async function serveHostBridge(input: { input: Readable; output: Writable; hello: BridgeHello; call: BridgeRequestHandler; configure?(peer: ReturnType<typeof createBridgePeer>): void }): Promise<void> {
  const peer = createBridgePeer(input)
  peer.onRequest(input.call); input.configure?.(peer); peer.sendHello()
  await peer.closed
}
export function parseHostBridgeArguments(argv: readonly string[]): { agyPath: string; loginShell: string } {
  if (argv.length !== 4 || argv[0] !== "--agy-path" || argv[2] !== "--login-shell") bridgeError("INVALID_HOST_BRIDGE_ARGUMENTS")
  return { agyPath: absolutePath(argv[1]), loginShell: absolutePath(argv[3]) }
}
export type HostBridgeDependencies = { input: Readable; output: Writable; environment: NodeJS.ProcessEnv; connect(): Promise<ReturnType<typeof createBridgePeer>> }
export function productionHostBridgeDependencies(): HostBridgeDependencies { return { input: process.stdin, output: process.stdout, environment: process.env, connect: productionHandlerBridge } }
export async function runHostBridgeCli(argv: readonly string[], deps: HostBridgeDependencies): Promise<void> {
  const config = parseHostBridgeArguments(argv), local = await deps.connect()
  try {
    const localHello = await local.ready, hello = { ...localHello, connectionId: randomUUID(), capabilities: localHello.capabilities.filter(value => value !== "invoke" && value !== "coordinate") }, enrollment = { ...config, hostId: hello.hostId, hostname: "localhost", inventoryId: randomUUID() }
    if (localHello.capabilities.includes("coordinate")) await local.request("coordinate", {})
    let publicPeer: ReturnType<typeof createBridgePeer>
    await serveHostBridge({ input: deps.input, output: deps.output, hello,
      configure(peer) {
        publicPeer = peer
        local.onRequest(async (channel, payload, _requestId, signal) => { if (channel !== "tool" && channel !== "settled") bridgeError("UNSUPPORTED_CAPABILITY"); return peer.request(channel, payload, { timeoutMs: 0, signal }) })
        local.subscribe(frame => peer.sendEvent({ ...frame, connectionId: hello.connectionId }))
        peer.subscribe(frame => local.sendEvent({ ...frame, connectionId: localHello.connectionId }))
        void local.closed.then(error => peer.close(error))
      },
      async call(channel, payload, requestId) {
        if (!hello.capabilities.includes(channel)) bridgeError("UNSUPPORTED_CAPABILITY")
        if (channel === "launch" || channel === "launchRoot" || channel === "restoreRoot") return invokeDestination(enrollment, parseHostCall({ channel, payload }), { environment: deps.environment })
        if (channel === "submit") {
          const p = object(payload)
          if (p.admissionRequired === true) {
            const request = object(p.request), admission = parseAdmission({ execution: p.target, submissionId: request.submissionId, digest: canonicalDigest({ prompt: request.prompt }) })
            return local.request(channel, payload, { beforeAccepted: () => publicPeer.prepareAdmission(requestId, admission) })
          }
        }
        return local.request(channel, payload, { timeoutMs: 0 })
      }
    })
  } finally { local.close() }
}
async function readHostCall(input: Readable): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of input) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > BRIDGE_FRAME_BYTES) bridgeError("FRAME_TOO_LARGE"); chunks.push(bytes) }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  if (!source.endsWith("\n") || source.slice(0, -1).includes("\n")) bridgeError("INVALID_HOST_CALL")
  return JSON.parse(source)
}
export async function runHostCallCli(argv: readonly string[], deps: HostBridgeDependencies): Promise<void> {
  if (argv.length) bridgeError("INVALID_HOST_CALL_ARGUMENTS")
  const request = parseHostCall(await readHostCall(deps.input)), local = await deps.connect()
  try {
    const result = await runHostCall(request, { environment: deps.environment, call: (channel, payload, invocation) => local.request("invoke", { channel, payload, invocation }, { timeoutMs: 150000 }) })
    const bytes = Buffer.from(JSON.stringify({ ok: true, result }) + "\n")
    if (bytes.length > BRIDGE_FRAME_BYTES) bridgeError("FRAME_TOO_LARGE")
    await new Promise<void>((resolve, reject) => deps.output.write(bytes, error => error ? reject(error) : resolve()))
  } finally { local.close() }
}