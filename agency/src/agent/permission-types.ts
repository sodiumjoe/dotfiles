import { createHash } from "node:crypto"
import { absolutePath, hash, id, keys, object, text, timestamp } from "../catalog/types.js"
import { canonicalJson, type JsonObject } from "./session-config.js"
import { AgentError, type AgentTuple } from "./types.js"

export const permissionDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex")
const canonicalDigest = permissionDigest
function fail(_code: string): never { throw new AgentError("INVALID_PROTOCOL") }
function checked<T>(parse: () => T): T { try { return parse() } catch { throw new AgentError("INVALID_PROTOCOL") } }
function enumValue<T extends string>(value: unknown, values: readonly T[]): T { if (!values.includes(value as T)) fail("INVALID_PERMISSION"); return value as T }
function encode(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) fail("INVALID_PERMISSION") }

function parseAgentTuple(raw: unknown): AgentTuple {
  const v = object(raw); keys(v, ["agentId", "handlerGeneration", "providerGeneration"])
  return { agentId: id(v.agentId), handlerGeneration: id(v.handlerGeneration), providerGeneration: id(v.providerGeneration) }
}
export type PermissionRef = { hostId: string; target: AgentTuple; permissionId: string; revision: number }
export type PermissionOffer = { ref: PermissionRef; title: string; subject: JsonObject; options: JsonObject[]; originCwd: string; toolCallId: string }
export type PermissionReceipt = { commandId: string; ref: PermissionRef; optionId: string; digest: string; state: "claimed" | "applied" | "withdrawn" | "stale" | "uncertain" }
export type PermissionSnapshot = { hostId: string; handlerGeneration: string; throughSeq: number; pending: PermissionOffer[]; receipts: PermissionReceipt[] }
export type PermissionEvent = { kind: "receipt"; receipt: PermissionReceipt } | { kind: "withdraw"; ref: PermissionRef }
export const permissionKey = (ref: PermissionRef): string => canonicalDigest(parsePermissionRef(ref))
function parsePermissionRefUnchecked(raw: unknown): PermissionRef {
  const v = object(raw); keys(v, ["hostId", "target", "permissionId", "revision"])
  const revision = timestamp(v.revision); if (!revision) fail("INVALID_PERMISSION")
  return { hostId: hash(v.hostId), target: parseAgentTuple(v.target), permissionId: id(v.permissionId), revision }
}
function parsePermissionOfferUnchecked(raw: unknown): PermissionOffer {
  const v = object(raw); keys(v, ["ref", "title", "subject", "options", "originCwd", "toolCallId"])
  if (!Array.isArray(v.options) || !v.options.length || v.options.length > 128) fail("INVALID_PERMISSION")
  const options = v.options.map(raw => { const o = object(raw); text(o.optionId); text(o.name, Infinity); enumValue(o.kind, ["allow_once", "allow_always", "reject_once", "reject_always"]); return structuredClone(o) as JsonObject })
  if (new Set(options.map(o => o.optionId)).size !== options.length) fail("INVALID_PERMISSION")
  const offer = { ref: parsePermissionRef(v.ref), title: text(v.title, 65536), subject: structuredClone(object(v.subject)) as JsonObject, options, originCwd: absolutePath(v.originCwd), toolCallId: text(v.toolCallId) }
  encode(offer); return offer
}
function parsePermissionReceiptUnchecked(raw: unknown): PermissionReceipt {
  const v = object(raw); keys(v, ["commandId", "ref", "optionId", "digest", "state"])
  const receipt = { commandId: id(v.commandId), ref: parsePermissionRef(v.ref), optionId: text(v.optionId), digest: hash(v.digest), state: enumValue(v.state, ["claimed", "applied", "withdrawn", "stale", "uncertain"]) }
  if (canonicalDigest({ commandId: receipt.commandId, ref: receipt.ref, optionId: receipt.optionId }) !== receipt.digest) fail("CORRUPT_PERMISSION")
  return receipt
}
function parsePermissionSnapshotUnchecked(raw: unknown): PermissionSnapshot {
  const v = object(raw); keys(v, ["hostId", "handlerGeneration", "throughSeq", "pending", "receipts"])
  if (!Array.isArray(v.pending) || !Array.isArray(v.receipts)) fail("INVALID_PERMISSION")
  const result = { hostId: hash(v.hostId), handlerGeneration: id(v.handlerGeneration), throughSeq: timestamp(v.throughSeq), pending: v.pending.map(parsePermissionOffer), receipts: v.receipts.map(parsePermissionReceipt) }
  if (result.pending.some(o => o.ref.hostId !== result.hostId || o.ref.target.handlerGeneration !== result.handlerGeneration) || result.receipts.some(r => r.ref.hostId !== result.hostId || r.state !== "stale" && r.ref.target.handlerGeneration !== result.handlerGeneration) || new Set(result.pending.map(o => permissionKey(o.ref))).size !== result.pending.length) fail("INVALID_PERMISSION")
  return result
}

export function parsePermissionRef(raw: unknown): PermissionRef { return checked(() => parsePermissionRefUnchecked(raw)) }
export function parsePermissionOffer(raw: unknown): PermissionOffer { return checked(() => parsePermissionOfferUnchecked(raw)) }
export function parsePermissionReceipt(raw: unknown): PermissionReceipt { return checked(() => parsePermissionReceiptUnchecked(raw)) }
export function parsePermissionSnapshot(raw: unknown): PermissionSnapshot { return checked(() => parsePermissionSnapshotUnchecked(raw)) }