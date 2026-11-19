import { RequestError } from "../live/errors.js"
import type { JsonObject } from "../agent/session-config.js"

export function unwrapReply(reply: unknown): JsonObject {
  const value = reply as { ok?: boolean; result?: JsonObject; error?: { code?: string; message?: string } } | null
  if (value?.ok === true && value.result) return value.result
  if (value?.ok === false && value.error) throw new RequestError((value.error.code ?? "FAILED") as never, value.error.message ?? "request failed")
  throw new RequestError("FAILED", "invalid reply")
}