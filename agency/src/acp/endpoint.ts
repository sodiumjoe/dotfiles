import { createConnection } from "node:net"
import type { Readable, Writable } from "node:stream"
import { productionEnvironment } from "../handler/environment.js"
import type { LaunchEnvironment } from "../agent/environment.js"
import { parseLaunchEnvironment } from "../agent/environment.js"
import { assertPrivateSocket } from "../platform/private-socket.js"
import { inspectHandlerGeneration } from "../platform/singleton.js"

export type AcpEndpointDependencies = { stdin: Readable; stdout: Writable; stderr: Writable; environment: LaunchEnvironment; discover?(): Promise<{ socketPath: string; generation: string }> }

async function discover(): Promise<{ socketPath: string; generation: string }> {
  const env = await productionEnvironment(), inspection = await inspectHandlerGeneration(env.paths.runtimeRoot, env.adapter)
  if (!inspection || inspection.disposition !== "live" || inspection.record.phase !== "ready") throw new Error("Agency Handler unavailable; start it explicitly with agy up")
  return { socketPath: await assertPrivateSocket(env.paths.runtimeRoot, "acp.sock"), generation: inspection.record.generation }
}

export async function runAcpEndpoint(argv: string[], dependencies: AcpEndpointDependencies): Promise<number> {
  const { stdin, stdout, stderr } = dependencies
  try {
    if (argv.length) throw new Error("Usage: agy acp")
    const environment = parseLaunchEnvironment(dependencies.environment), target = await (dependencies.discover ?? discover)()
    const socket = createConnection(target.socketPath)
    return await new Promise<number>(resolve => {
      let finished = false
      const finish = (code: number, error?: unknown): void => {
        if (finished) return
        finished = true; clearTimeout(timer); stdin.unpipe(socket); socket.unpipe(stdout)
        stdin.off("end", end); stdin.off("error", failed)
        stdin.off("close", end)
        stdout.off("error", failed); socket.destroy()
        if (error) stderr.write(String(error).slice(0, 2048) + "\n")
        resolve(code)
      }
      const failed = (error: unknown) => finish(70, error)
      const timer = setTimeout(() => failed(new Error("ACP Handler connection timed out")), 5000)
      const end = () => finish(0)
      socket.once("connect", () => {
        clearTimeout(timer)
        socket.write(JSON.stringify({ jsonrpc: "2.0", method: "agency/connect", params: { handlerGeneration: target.generation, environment: environment as Record<string, string> } }) + "\n")
        socket.pipe(stdout, { end: false })
        stdin.pipe(socket, { end: false })
        stdin.once("end", end); stdin.once("error", failed)
        stdin.once("close", end)
        if (stdin.readableEnded || stdin.destroyed) end()
      })
      socket.once("error", failed)
      socket.once("end", () => failed(new Error("Agency Handler connection ended")))
      socket.once("close", () => { if (!finished) failed(new Error("Agency Handler connection closed")) })
      stdout.once("error", failed)
    })
  } catch (error) { stderr.write(String(error).slice(0, 2048) + "\n"); return 70 }
}