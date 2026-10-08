import { spawn } from "node:child_process"
import { keys, object } from "../catalog/types.js"
import { snapshotLaunchEnvironment } from "../agent/environment.js"
import type { Invocation } from "../bureau/host.js"
import { parseHostEnrollment, type HostEnrollment } from "../bureau/hosts.js"
import { BRIDGE_FRAME_BYTES, bridgeError } from "./protocol.js"

export type HostCall = { channel: "launch" | "launchRoot" | "restoreRoot"; payload: { command: Record<string, unknown>; nativeParams: Invocation["nativeParams"] } }
export type HostCallHandler = (channel: HostCall["channel"], payload: HostCall["payload"], invocation: Invocation) => Promise<unknown>
export function parseHostCall(raw: unknown): HostCall {
  const v = object(raw); keys(v, ["channel", "payload"])
  if (v.channel !== "launch" && v.channel !== "launchRoot" && v.channel !== "restoreRoot") bridgeError("INVALID_HOST_CALL")
  const payload = object(v.payload); keys(payload, ["command", "nativeParams"])
  return { channel: v.channel, payload: { command: object(payload.command), nativeParams: object(payload.nativeParams) as Invocation["nativeParams"] } }
}
export function sanitizedBootstrapEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "XDG_STATE_HOME"].filter(key => source[key] !== undefined).map(key => [key, source[key]!]))
}
export function destinationEnvironment(source: NodeJS.ProcessEnv) {
  return snapshotLaunchEnvironment(Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("AGENCY_") && !["NVIM", "NVIM_LISTEN_ADDRESS", "VIM", "VIMRUNTIME", "NODE_TEST_CONTEXT"].includes(key))))
}
export async function runHostCall(raw: unknown, deps: { environment: NodeJS.ProcessEnv; call: HostCallHandler }): Promise<unknown> {
  const request = parseHostCall(raw)
  return deps.call(request.channel, request.payload, { environment: destinationEnvironment(deps.environment), nativeParams: request.payload.nativeParams })
}
export function posixQuote(value: string): string {
  if (!value.isWellFormed() || /[\x00-\x1f\x7f-\x9f]/u.test(value)) bridgeError("INVALID_SHELL_ARGUMENT")
  return "'" + value.replaceAll("'", "'\\''") + "'"
}
export function destinationShellCommand(enrollment: HostEnrollment, action: "internal-host-call" | "internal-host-bridge"): string {
  const e = parseHostEnrollment(enrollment), args = action === "internal-host-bridge" ? ` --agy-path ${posixQuote(e.agyPath)} --login-shell ${posixQuote(e.loginShell)}` : "", command = `exec ${posixQuote(e.agyPath)} ${action}${args} >&3 3>&-`
  return `exec 3>&1; exec ${posixQuote(e.loginShell)} -lc ${posixQuote(command)} 1>&2`
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