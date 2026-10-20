import { spawn } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import type { EventEmitter } from "node:events"
import { parseHostEnrollment, type HostEnrollment } from "../hosts/inventory.js"
import { createBridgePeer, type RequestOptions } from "./codec.js"
import { bridgeError, type BridgeHello } from "./protocol.js"
import { destinationShellCommand, sanitizedBootstrapEnvironment } from "./bootstrap.js"
import { requestBridgeRead } from "./paging.js"

export type BridgeProcess = EventEmitter & { stdin: Writable; stdout: Readable; stderr: Readable; kill(): boolean }
export type BridgeProcessFactory = (file: string, argv: string[], options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => BridgeProcess
export type BridgeTransport = { hello: BridgeHello; peer: ReturnType<typeof createBridgePeer>; readonly diagnostics: string; request(channel: string, payload: unknown, options?: RequestOptions): Promise<unknown>; closed: Promise<Error>; close(): void }
export function buildSshCommand(raw: HostEnrollment, action: "internal-runtime-bridge" = "internal-runtime-bridge") {
  const enrollment = parseHostEnrollment(raw)
  return { file: "ssh", argv: ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "--", enrollment.hostname, destinationShellCommand(enrollment, action)] }
}
export async function connectBridge(raw: HostEnrollment, options: { action: "internal-runtime-bridge"; requiredCapabilities: readonly string[]; processFactory?: BridgeProcessFactory }): Promise<BridgeTransport> {
  const enrollment = parseHostEnrollment(raw), command = buildSshCommand(enrollment, options.action)
  const child = (options.processFactory ?? ((file, argv, settings) => spawn(file, argv, settings)))(command.file, command.argv, { env: { ...sanitizedBootstrapEnvironment(process.env), ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}) }, stdio: ["pipe", "pipe", "pipe"] })
  const peer = createBridgePeer({ input: child.stdout, output: child.stdin }), timer = setTimeout(() => peer.close(new Error("BRIDGE_HELLO_TIMEOUT")), 15000)
  let stderr = Buffer.alloc(0)
  child.stderr.on("data", (bytes: Buffer) => { if (stderr.length < 8192) stderr = Buffer.concat([stderr, bytes.subarray(0, 8192 - stderr.length)]) })
  child.on("error", (error: Error) => peer.close(error)); child.on("close", () => peer.close(new Error("BRIDGE_EOF")))
  const close = () => { peer.close(); child.kill() }
  void peer.closed.then(() => child.kill())
  try {
    const hello = await peer.ready
    if (hello.hostId !== enrollment.hostId) bridgeError("HOST_IDENTITY_CHANGED")
    if (hello.nodeVersion !== "v24.13.0") bridgeError("UNSUPPORTED_RUNTIME")
    if (options.requiredCapabilities.some(channel => !hello.capabilities.includes(channel))) bridgeError("UNSUPPORTED_CAPABILITY")
    return { hello, peer, get diagnostics() { return stderr.toString("utf8") }, request(channel, payload, requestOptions) {
      if (!hello.capabilities.includes(channel)) bridgeError("UNSUPPORTED_CAPABILITY")
      return requestBridgeRead(peer, channel, payload, requestOptions)
    }, closed: peer.closed, close }
  } catch (error) { close(); throw error }
  finally { clearTimeout(timer) }
}