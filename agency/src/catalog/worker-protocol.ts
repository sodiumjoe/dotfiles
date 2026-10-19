import { id, invalid, keys, object } from "./types.js"
import { parseProbeTerminal } from "./diagnostics.js"

export type WorkerBinding = { attemptId: string; generation: string }
export type NativeSettlement =
  | { kind: "not-spawned" }
  | { kind: "spawn-error" }
  | { kind: "exit"; pid: number; code: number | null; signal: NodeJS.Signals | null }
export type NativeSettledMessage = WorkerBinding & { type: "native-settled"; native: NativeSettlement }
export type WorkerStopMessage = WorkerBinding & { type: "stop" }
export function parseWorkerEnvelope(raw: unknown, binding?: WorkerBinding): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(raw)) > 1048576) invalid()
  const value = object(raw)
  id(value.attemptId); id(value.generation)
  if (binding && (value.attemptId !== binding.attemptId || value.generation !== binding.generation)) invalid()
  return value
}
export function parseNativeSettlement(raw: unknown): NativeSettlement {
  const value = object(raw)
  if (value.kind === "not-spawned" || value.kind === "spawn-error") { keys(value, ["kind"]); return { kind: value.kind } }
  if (value.kind !== "exit") invalid()
  keys(value, ["kind", "pid", "code", "signal"])
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) invalid()
  const terminal = parseProbeTerminal({ code: value.code, signal: value.signal })
  return { kind: "exit", pid: value.pid, code: terminal.code, signal: terminal.signal as NodeJS.Signals | null }
}