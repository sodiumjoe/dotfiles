import { isAbsolute, normalize } from "node:path"

export const PROVIDERS = ["claude-agent-acp", "codex-acp"] as const
export type ProviderId = typeof PROVIDERS[number]
export const catalogMessages = {
  INVALID_CATALOG: "Invalid catalog evidence",
  UNSUPPORTED_PROVIDER_VERSION: "Unsupported discovery dependency version",
  CONFIG_CHANGED: "Declared provider configuration changed",
  PROBE_FAILED: "Provider discovery failed",
} as const
export type CatalogErrorCode = keyof typeof catalogMessages
export class CatalogError extends Error {
  constructor(readonly code: CatalogErrorCode) { super(catalogMessages[code]) }
}
export function invalid(): never { throw new CatalogError("INVALID_CATALOG") }
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid()
}
export function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f-\x9f]/u.test(value) || !value.isWellFormed()) invalid()
  return value
}
export function id(value: unknown): string {
  const result = text(value)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result)) invalid()
  return result
}
export function hash(value: unknown): string {
  const result = text(value)
  if (!/^[0-9a-f]{64}$/.test(result)) invalid()
  return result
}
export function providerId(value: unknown): ProviderId {
  if (value !== "claude-agent-acp" && value !== "codex-acp") invalid()
  return value
}
export function absolutePath(value: unknown): string {
  const result = text(value, 4096)
  if (!isAbsolute(result) || normalize(result) !== result || (result !== "/" && result.endsWith("/"))) invalid()
  return result
}
export function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid()
  return value
}