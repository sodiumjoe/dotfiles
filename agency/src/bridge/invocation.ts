import { destinationShellCommand, sanitizedBootstrapEnvironment } from "./bootstrap.js"
export { destinationShellCommand, posixQuote, sanitizedBootstrapEnvironment } from "./bootstrap.js"
import { spawn } from "node:child_process"
import { keys, object } from "../catalog/types.js"
import { destinationEnvironment } from "../agent/environment.js"
import type { Invocation } from "../bureau/host.js"
import { parseHostEnrollment, type HostEnrollment } from "../hosts/inventory.js"
import { BRIDGE_FRAME_BYTES, bridgeError } from "./protocol.js"

export { destinationEnvironment } from "../agent/environment.js"

export type HostCall = { channel: "launch" | "launchRoot" | "restoreRoot"; payload: { command: Record<string, unknown>; nativeParams: Invocation["nativeParams"] } }
export type HostCallHandler = (channel: HostCall["channel"], payload: HostCall["payload"], invocation: Invocation) => Promise<unknown>
export function parseHostCall(raw: unknown): HostCall {
  const v = object(raw); keys(v, ["channel", "payload"])
  if (v.channel !== "launch" && v.channel !== "launchRoot" && v.channel !== "restoreRoot") bridgeError("INVALID_HOST_CALL")
  const payload = object(v.payload); keys(payload, ["command", "nativeParams"])
  return { channel: v.channel, payload: { command: object(payload.command), nativeParams: object(payload.nativeParams) as Invocation["nativeParams"] } }
}
export async function runHostCall(raw: unknown, deps: { environment: NodeJS.ProcessEnv; call: HostCallHandler }): Promise<unknown> {
  const request = parseHostCall(raw)
  return deps.call(request.channel, request.payload, { environment: destinationEnvironment(deps.environment), nativeParams: request.payload.nativeParams })
}
export async function invokeDestination(enrollment: HostEnrollment, raw: HostCall, options: { environment?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<unknown> {
  const request = parseHostCall(raw), bytes = Buffer.from(JSON.stringify(request) + "\n")
  if (bytes.length > BRIDGE_FRAME_BYTES) bridgeError("FRAME_TOO_LARGE")
  const e = parseHostEnrollment(enrollment)
  const child = spawn("/bin/sh", ["-c", destinationShellCommand(e, "internal-host-call")], { env: sanitizedBootstrapEnvironment(options.environment ?? process.env), stdio: ["pipe", "pipe", "pipe"] })
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, failed = false
    const finish = (error: Error) => { if (failed) return; failed = true; clearTimeout(timer); child.kill(); reject(error) }
    const timer = setTimeout(() => finish(new Error("DESTINATION_INVOCATION_TIMEOUT")), options.timeoutMs ?? 150000)
    child.on("error", finish); child.stdin.on("error", finish)
    child.stderr.on("data", () => {})
    child.stdout.on("data", (bytes: Buffer) => { size += bytes.length; if (size > BRIDGE_FRAME_BYTES) finish(new Error("FRAME_TOO_LARGE")); else chunks.push(bytes) })
    child.on("close", code => {
      clearTimeout(timer)
      if (failed) return
      try {
        if (code !== 0) bridgeError("DESTINATION_INVOCATION_FAILED")
        const bytes = Buffer.concat(chunks), source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        if (!source.endsWith("\n") || source.slice(0, -1).includes("\n")) bridgeError("INVALID_HOST_CALL_REPLY")
        const reply = object(JSON.parse(source)); keys(reply, ["ok", reply.ok === true ? "result" : "error"])
        if (reply.ok !== true) bridgeError("DESTINATION_CALL_REJECTED")
        resolve(reply.result)
      } catch (error) { reject(error) }
    })
    child.stdin.end(bytes)
  })
}