import { AgentError, ProviderRequestError, type AgentErrorCode } from "../agent/types.js"
import type { FailureDiagnostic } from "../agent/failure-diagnostics.js"
import { ControlError } from "../control/protocol.js"
import { CatalogError } from "../config/validate.js"

export const REQUEST_CODES = ["NOT_FOUND", "BUSY", "INVALID", "UNAVAILABLE", "FAILED"] as const
export const PRE_LIVE_HANDLER = "the running Agency Handler predates this agy and does not answer its requests; upgrade it once by running :AgencyReload in one Neovim, then restart any other Neovim windows"
export type RequestCode = typeof REQUEST_CODES[number]
export type RequestFailure = { code: RequestCode; message: string }
export class RequestError extends Error {
  constructor(readonly code: RequestCode, message: string) { super(message) }
}

const MESSAGE_BYTES = 2048
const groups: Record<Exclude<RequestCode, "NOT_FOUND">, readonly AgentErrorCode[]> = {
  BUSY: ["BUSY"],
  INVALID: ["USAGE", "INVALID_PROTOCOL", "SELECTION_UNSUPPORTED", "SESSION_INPUT_REQUIRED", "INPUT_TOO_LARGE", "UNSUPPORTED_SESSION_FEATURE", "COMMAND_CONFLICT", "STALE_ATTACHMENT", "PERMISSION_UNSUPPORTED"],
  UNAVAILABLE: ["UNAVAILABLE", "NOT_READY", "STALE_HANDLER", "STALE_PROVIDER", "ADAPTER_UNQUALIFIED", "MODEL_UNAVAILABLE", "RESTORE_UNSUPPORTED", "SESSION_UNAVAILABLE", "CONFIG_CHANGED", "RESYNC_REQUIRED", "INVALID_AGENT_STATE"],
  FAILED: ["STARTUP_FAILED", "STARTUP_TIMEOUT", "AUTH_REQUIRED", "CLEANUP_UNVERIFIED", "INCOMPLETE", "INTERNAL", "OUTPUT_TOO_LARGE", "ACP_FRAME_LIMIT", "ACP_HISTORY_LIMIT"],
}
export function clipMessage(value: string): string {
  const bytes = Buffer.from(value)
  if (bytes.length <= MESSAGE_BYTES) return value
  let end = MESSAGE_BYTES
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString("utf8")
}

function detail(diagnostic: FailureDiagnostic | undefined): string {
  if (!diagnostic) return ""
  if (diagnostic.boundary === "provider_process") {
    const tail = Buffer.from(diagnostic.stderrTailBase64, "base64").toString("utf8").trim().split("\n").slice(-3).join(" | ")
    const exit = diagnostic.exitCode !== null ? "exit code " + diagnostic.exitCode : diagnostic.signal ? "signal " + diagnostic.signal : diagnostic.event
    return ": provider process ended (" + exit + ")" + (tail ? ": " + tail : "")
  }
  if (diagnostic.boundary === "acp_transport" && diagnostic.startup) return ": during " + diagnostic.startup.phase + " after " + diagnostic.startup.elapsedMs + " ms" + (diagnostic.causeCode ? " (" + diagnostic.causeCode + ")" : "")
  return diagnostic.causeCode ? ": " + diagnostic.boundary.replaceAll("_", " ") + " (" + diagnostic.causeCode + ")" : ""
}

export function requestFailure(error: unknown): RequestFailure {
  if (error instanceof RequestError) return { code: error.code, message: clipMessage(error.message) }
  if (error instanceof ProviderRequestError) return { code: "FAILED", message: clipMessage(typeof error.providerError.message === "string" ? error.providerError.message : "the provider refused the request") }
  if (error instanceof AgentError) {
    const code = (Object.keys(groups) as Array<keyof typeof groups>).find(key => groups[key].includes(error.code)) ?? "FAILED"
    return { code, message: clipMessage(error.message + detail(error.diagnostic)) }
  }
  if (error instanceof CatalogError) return { code: "UNAVAILABLE", message: clipMessage(error.message) }
  if (error instanceof ControlError) return { code: error.code === "BUSY" || error.code === "ACTIVE_AGENTS" ? "BUSY" : error.code === "USAGE" || error.code === "INVALID_PROTOCOL" ? "INVALID" : error.code === "UNAVAILABLE" || error.code === "STALE_HANDLER" ? "UNAVAILABLE" : "FAILED", message: clipMessage(error.message) }
  return { code: "FAILED", message: clipMessage(error instanceof Error ? error.message : String(error)) }
}

export function parseRequestFailure(input: unknown): RequestFailure {
  const value = input as Partial<RequestFailure> | null
  if (!value || typeof value !== "object" || !REQUEST_CODES.includes(value.code as RequestCode) || typeof value.message !== "string" || Buffer.byteLength(value.message) > MESSAGE_BYTES) throw new RequestError("INVALID", "malformed failure")
  return { code: value.code as RequestCode, message: value.message }
}