import { randomUUID } from "node:crypto"
import type { Writable } from "node:stream"
import { canonicalJson } from "../agent/session-config.js"

export type WatchFrame = { protocol: "agency-bureau-watch-v1"; generation: string; seq: number } & ({ kind: "snapshot"; result: unknown } | { kind: "unavailable"; error: { code: string } })
export function createSnapshotWatch(input: { read(): Promise<unknown>; write(frame: WatchFrame): Promise<void>; signal: AbortSignal; pause(): Promise<void>; generation?: string }) {
  const generation = input.generation ?? randomUUID()
  let seq = 0, previous: string | null = null, disconnected = false
  return {
    async run(): Promise<void> {
      while (!input.signal.aborted) {
        let result: unknown, failure: unknown
        try { result = await input.read() } catch (error) { failure = error }
        if (input.signal.aborted) return
        if (failure) {
          if (!disconnected) await input.write({ protocol: "agency-bureau-watch-v1", generation, seq: ++seq, kind: "unavailable", error: { code: "BUREAU_UNAVAILABLE" } })
          disconnected = true; previous = null
        } else {
          const serialized = canonicalJson(result)
          if (serialized !== previous) {
            await input.write({ protocol: "agency-bureau-watch-v1", generation, seq: ++seq, kind: "snapshot", result })
            previous = serialized
          }
          disconnected = false
        }
        if (!input.signal.aborted) await input.pause()
      }
    }
  }
}
export function writeWatchFrame(output: Writable, frame: WatchFrame, signal: AbortSignal, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(frame) + "\n")
    if (bytes.length > 8388608 || signal.aborted) { reject(new Error(signal.aborted ? "CANCELLED" : "FRAME_TOO_LARGE")); return }
    let settled = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); output.removeListener("error", failed); output.removeListener("close", closed)
      if (error) reject(error); else resolve()
    }
    const abort = () => { finish(new Error("CANCELLED")); output.destroy() }, failed = (error: Error) => finish(error), closed = () => finish(new Error("OUTPUT_CLOSED"))
    const timer = setTimeout(() => { finish(new Error("OUTPUT_TIMEOUT")); output.destroy() }, timeoutMs)
    signal.addEventListener("abort", abort, { once: true }); output.once("error", failed); output.once("close", closed)
    try { output.write(bytes, finish) } catch (error) { finish(error as Error) }
  })
}