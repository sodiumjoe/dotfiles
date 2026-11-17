import type { Readable } from "node:stream"
import { AgentError } from "../agent/types.js"

export type InputJsonOptions = { stdin?: Readable & { isTTY?: boolean }; signal?: AbortSignal; timeoutMs?: number }

export function readStdin(options: InputJsonOptions, maxBytes = 1048576): Promise<Buffer> {
  const { stdin, signal } = options
  if (!stdin || stdin.isTTY || stdin.destroyed || stdin.readableEnded || signal?.aborted) return Promise.reject(new AgentError("USAGE"))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0, settled = false
    const finish = (error?: Error, result?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdin.pause()
      stdin.off("data", data); stdin.off("end", end); stdin.off("error", failure); stdin.off("close", closed)
      signal?.removeEventListener("abort", aborted)
      if (error) reject(error); else resolve(result!)
    }
    const failure = () => finish(new AgentError("USAGE"))
    const closed = () => finish(new AgentError("USAGE"))
    const aborted = () => finish(new AgentError("USAGE"))
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxBytes) finish(new AgentError("INPUT_TOO_LARGE"))
      else chunks.push(buffer)
    }
    const end = () => finish(undefined, Buffer.concat(chunks, bytes))
    const timer = setTimeout(() => finish(new AgentError("USAGE")), options.timeoutMs ?? 5000)
    stdin.on("data", data); stdin.once("end", end); stdin.once("error", failure); stdin.once("close", closed)
    signal?.addEventListener("abort", aborted, { once: true })
  })
}

export async function readInputJson(value: string | undefined, options: InputJsonOptions): Promise<unknown> {
  if (value !== "-") return JSON.parse(value ?? "null")
  const bytes = await readStdin(options)
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { throw new AgentError("USAGE") }
}