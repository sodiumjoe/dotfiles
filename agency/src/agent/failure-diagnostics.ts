import { invalid, keys, object, timestamp } from "../catalog/types.js"

export const STDERR_TAIL_BYTES = 2048
const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
const PROCESS_EVENTS = ["error", "exit", "close", "stderr_limit", "stdin_error", "stdout_error", "stderr_error"] as const
export type ProcessFailureEvent = typeof PROCESS_EVENTS[number]
export type AcpStartupDiagnostic = { phase: "initialize" | "session/new" | "session/load" | "configuration"; elapsedMs: number; replayUpdates: number }
export type FailureDiagnostic =
  | { boundary: "permission_request" | "provider_initialize"; causeCode: string | null }
  | { boundary: "acp_transport"; causeCode: string | null; startup?: AcpStartupDiagnostic }
  | { boundary: "provider_process"; event: ProcessFailureEvent; causeCode: string | null; exitCode: number | null; signal: string | null; stderrBytes: number; stderrTailBase64: string }

export function failureIdentifier(value: unknown): string | null { return typeof value === "string" && IDENTIFIER.test(value) ? value : null }
export function underlyingFailureCode(error: unknown): string | null {
  try { return failureIdentifier(error instanceof Error ? (error as Error & { code?: unknown }).code : null) }
  catch { return null }
}
function identifier(value: unknown): string | null {
  if (value === null) return null
  const result = failureIdentifier(value)
  if (result === null) invalid()
  return result
}
export function parseFailureDiagnostic(input: unknown): FailureDiagnostic {
  const v = object(input), causeCode = identifier(v.causeCode)
  if (v.boundary === "permission_request" || v.boundary === "acp_transport" || v.boundary === "provider_initialize") {
    keys(v, ["boundary", "causeCode", ...(v.boundary === "acp_transport" && Object.hasOwn(v, "startup") ? ["startup"] : [])])
    if (v.boundary === "acp_transport") {
      let startup: AcpStartupDiagnostic | undefined
      if (Object.hasOwn(v, "startup")) {
        const value = object(v.startup)
        keys(value, ["phase", "elapsedMs", "replayUpdates"])
        if (typeof value.phase !== "string" || !["initialize", "session/new", "session/load", "configuration"].includes(value.phase)) invalid()
        startup = { phase: value.phase as AcpStartupDiagnostic["phase"], elapsedMs: timestamp(value.elapsedMs), replayUpdates: timestamp(value.replayUpdates) }
      }
      return { boundary: v.boundary, causeCode, ...(startup ? { startup } : {}) }
    }
    return { boundary: v.boundary, causeCode }
  }
  keys(v, ["boundary", "event", "causeCode", "exitCode", "signal", "stderrBytes", "stderrTailBase64"])
  if (v.boundary !== "provider_process" || !PROCESS_EVENTS.some(event => event === v.event) || v.exitCode !== null && (typeof v.exitCode !== "number" || !Number.isSafeInteger(v.exitCode))) invalid()
  if (typeof v.stderrTailBase64 !== "string" || v.stderrTailBase64.length > 2732) invalid()
  const tail = Buffer.from(v.stderrTailBase64, "base64"), stderrBytes = timestamp(v.stderrBytes)
  if (tail.length > STDERR_TAIL_BYTES || tail.length > stderrBytes || tail.toString("base64") !== v.stderrTailBase64) invalid()
  return { boundary: "provider_process", event: v.event as ProcessFailureEvent, causeCode, exitCode: v.exitCode as number | null, signal: identifier(v.signal), stderrBytes, stderrTailBase64: v.stderrTailBase64 }
}