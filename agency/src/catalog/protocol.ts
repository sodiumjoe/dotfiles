import type { Socket } from "node:net"
import { ControlError, type ControlErrorCode } from "../control/protocol.js"
import { encodeFrame, receiveFrame } from "../control/wire.js"
import { CatalogError, hash, id, invalid, isFresh, keys, object, parseFailure, parseProviderSnapshot, parseSnapshot, text, timestamp } from "./types.js"
import type { CatalogView, ProviderView, RefreshResult, RefreshView } from "./service.js"

export const CATALOG_PROTOCOL = "agency-catalog/1" as const
export type CatalogRequest = { protocol: typeof CATALOG_PROTOCOL; requestId: string; handlerGeneration: string } & ({ op: "model_list" } | { op: "model_refresh"; commandId: string })
export type CatalogReply = { protocol: typeof CATALOG_PROTOCOL; requestId: string; handlerGeneration: string } & ({ ok: true; result: CatalogView | RefreshResult } | { ok: false; error: { code: ControlErrorCode; message: string } })
const codes = ["USAGE", "INVALID_PROTOCOL", "STALE_HANDLER", "UNAVAILABLE", "INTERNAL", "INCOMPLETE", "ACTIVE_AGENTS", "COMMAND_CONFLICT"]
function header(value: Record<string, unknown>) {
  if (value.protocol !== CATALOG_PROTOCOL) invalid()
  return { protocol: CATALOG_PROTOCOL, requestId: id(value.requestId), handlerGeneration: id(value.handlerGeneration) }
}
function refreshView(input: unknown): RefreshView {
  const v = object(input)
  keys(v, ["commandId", "handlerGeneration", "state", "snapshotId"])
  if (v.state !== "pending" && v.state !== "completed" && v.state !== "interrupted") invalid()
  if ((v.state === "completed") !== (v.snapshotId !== null)) invalid()
  return { commandId: id(v.commandId), handlerGeneration: id(v.handlerGeneration), state: v.state, snapshotId: v.snapshotId === null ? null : id(v.snapshotId) }
}
function catalogView(input: unknown): CatalogView {
  const v = object(input)
  keys(v, ["state", "hostId", "handlerGeneration", "observedAt", "launchAuthorized", "providers", "refresh", "discovery"])
  if (v.state !== "catalog" || v.launchAuthorized !== false || !Array.isArray(v.providers) || v.providers.length !== 2) invalid()
  const handlerGeneration = id(v.handlerGeneration), observedAt = timestamp(v.observedAt)
  const providers = v.providers.map((input): ProviderView => {
    const { state, freshness, refreshIssue, ...raw } = object(input), snapshot = parseProviderSnapshot(raw)
    if (state !== "unconfigured" && state !== "ready" && state !== "unavailable" && state !== "blocked") invalid()
    if (freshness !== "fresh" && freshness !== "stale" && freshness !== "unverified") invalid()
    if (freshness === "fresh" && (state !== "ready" || snapshot.error !== null || snapshot.verifiedHandlerGeneration !== handlerGeneration || !isFresh(snapshot.verifiedAt, observedAt))) invalid()
    if ((freshness === "unverified") !== (snapshot.verifiedAt === null)) invalid()
    return { ...snapshot, state, freshness, ...(refreshIssue === undefined ? {} : { refreshIssue: refreshIssue === null ? null : parseFailure(refreshIssue) }) }
  })
  if (new Set(providers.map(p => p.providerId)).size !== 2) invalid()
  const discovery = object(v.discovery), { issues, ...fields } = discovery
  keys(fields, ["state", "error"])
  if (discovery.state !== "idle" && discovery.state !== "refreshing" && discovery.state !== "blocked") invalid()
  if ((discovery.state === "blocked") !== (discovery.error !== null)) invalid()
  if (issues !== undefined && (!Array.isArray(issues) || issues.length > 32)) invalid()
  return { state: "catalog", hostId: hash(v.hostId), handlerGeneration, observedAt, launchAuthorized: false, providers, refresh: v.refresh === null ? null : refreshView(v.refresh), discovery: { state: discovery.state, error: discovery.error === null ? null : parseFailure(discovery.error), ...(issues === undefined ? {} : { issues: issues.map(value => text(value, 512)) }) } }
}
export function parseCatalogRequest(input: unknown): CatalogRequest {
  try {
    const v = object(input), common = header(v)
    if (v.op === "model_list") { keys(v, ["protocol", "requestId", "handlerGeneration", "op"]); return { ...common, op: "model_list" } }
    keys(v, ["protocol", "requestId", "handlerGeneration", "op", "commandId"])
    if (v.op !== "model_refresh") invalid()
    return { ...common, op: "model_refresh", commandId: id(v.commandId) }
  } catch { throw new ControlError("INVALID_PROTOCOL") }
}
export function parseCatalogReply(input: unknown): CatalogReply {
  try {
    const v = object(input), common = header(v)
    if (v.ok === false) {
      keys(v, ["protocol", "requestId", "handlerGeneration", "ok", "error"])
      const error = object(v.error)
      keys(error, ["code", "message"])
      if (!codes.includes(String(error.code))) invalid()
      return { ...common, ok: false, error: { code: error.code as ControlErrorCode, message: text(error.message, 2048) } }
    }
    keys(v, ["protocol", "requestId", "handlerGeneration", "ok", "result"])
    if (v.ok !== true) invalid()
    const raw = object(v.result)
    if (raw.state === "catalog") {
      const result = catalogView(raw)
      if (result.handlerGeneration !== common.handlerGeneration) invalid()
      return { ...common, ok: true, result }
    }
    keys(raw, ["state", "command", "snapshot"])
    if (raw.state !== "refresh") invalid()
    const command = refreshView(raw.command), snapshot = raw.snapshot === null ? null : parseSnapshot(raw.snapshot)
    if (command.handlerGeneration !== common.handlerGeneration || (command.state === "completed") !== (snapshot !== null) || (snapshot && (snapshot.snapshotId !== command.snapshotId || snapshot.handlerGeneration !== command.handlerGeneration))) invalid()
    return { ...common, ok: true, result: { state: "refresh", command, snapshot } }
  } catch { throw new ControlError("INVALID_PROTOCOL") }
}
export function validateCatalogReply(reply: CatalogReply, request: CatalogRequest): void {
  if (reply.requestId !== request.requestId) throw new ControlError("INVALID_PROTOCOL")
  if (reply.handlerGeneration !== request.handlerGeneration) throw new ControlError("STALE_HANDLER")
  if (reply.ok && (request.op === "model_list" ? reply.result.state !== "catalog" : reply.result.state !== "refresh" || reply.result.command.commandId !== request.commandId)) throw new ControlError("INVALID_PROTOCOL")
}
export async function exchangeCatalog(socket: Socket, request: CatalogRequest, timeoutMs = 5000): Promise<CatalogReply> {
  try {
    const frame = encodeFrame(parseCatalogRequest(request)), incoming = receiveFrame(socket, timeoutMs)
    socket.end(frame)
    const reply = parseCatalogReply(await incoming)
    validateCatalogReply(reply, request)
    return reply
  } finally { socket.destroy() }
}
export function catalogErrorReply(request: Pick<CatalogRequest, "requestId" | "handlerGeneration">, error: unknown): CatalogReply {
  let code: ControlErrorCode = "INTERNAL", message = "Catalog operation failed"
  if (error instanceof ControlError) { code = error.code; message = error.message }
  else if (error instanceof CatalogError) {
    code = error.code === "STALE_HANDLER" || error.code === "COMMAND_CONFLICT" || error.code === "INCOMPLETE" ? error.code : error.code === "PROBE_CLEANUP_UNVERIFIED" || error.code === "CONFIG_CHANGED" ? "INCOMPLETE" : "UNAVAILABLE"
    message = error.message
  }
  return { protocol: CATALOG_PROTOCOL, requestId: request.requestId, handlerGeneration: request.handlerGeneration, ok: false, error: { code, message: message.slice(0, 2048) } }
}