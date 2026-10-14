import { createHash, randomUUID } from "node:crypto"
import { hash, id, keys, object, timestamp } from "../catalog/types.js"
import { bridgeError } from "./protocol.js"
import type { createBridgePeer, RequestOptions } from "./codec.js"

const PAGE_BYTES = 256 * 1024
const channels = new Set(["snapshot", "origin-read", "origin-retained", "runtime-read", "host-route-read"])
type Page = { transferId: string; index: number; data: string; done: boolean; digest: string | null }
function* jsonParts(value: unknown): Generator<Buffer> {
  if (Array.isArray(value)) {
    yield Buffer.from("[")
    for (let index = 0; index < value.length; index++) { if (index) yield Buffer.from(","); yield* jsonParts(value[index]) }
    yield Buffer.from("]")
  } else if (value !== null && typeof value === "object") {
    yield Buffer.from("{")
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    for (let index = 0; index < entries.length; index++) { const [key, item] = entries[index]!; if (index) yield Buffer.from(","); yield Buffer.from(JSON.stringify(key) + ":"); yield* jsonParts(item) }
    yield Buffer.from("}")
  } else {
    const json = JSON.stringify(value)
    if (json === undefined) bridgeError("INVALID_READ_PAGE")
    yield Buffer.from(json)
  }
}
export function createPagedReads(read: (channel: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) {
  type Transfer = { parts: Generator<Buffer>; remaining: Buffer; digest: ReturnType<typeof createHash>; last: Page | null; timer?: NodeJS.Timeout }
  const transfers = new Map<string, Transfer>()
  let opening = 0, closed = false
  function remove(transferId: string) { const transfer = transfers.get(transferId); if (!transfer) return; clearTimeout(transfer.timer); transfer.parts.return(undefined); transfers.delete(transferId) }
  function page(transferId: string, index: number): Page {
    const transfer = transfers.get(transferId)
    if (!transfer) bridgeError("INVALID_READ_CURSOR")
    if (transfer.last?.index === index) return transfer.last
    if (index !== (transfer.last?.index ?? -1) + 1 || transfer.last?.done) bridgeError("INVALID_READ_CURSOR")
    const pieces: Buffer[] = []
    let bytes = 0, done = false
    while (bytes < PAGE_BYTES) {
      if (!transfer.remaining.length) {
        const next = transfer.parts.next()
        if (next.done) { done = true; break }
        transfer.remaining = next.value
      }
      const size = Math.min(PAGE_BYTES - bytes, transfer.remaining.length)
      pieces.push(transfer.remaining.subarray(0, size)); transfer.remaining = transfer.remaining.subarray(size); bytes += size
    }
    const data = Buffer.concat(pieces); transfer.digest.update(data)
    const result: Page = { transferId, index, data: data.toString("base64"), done, digest: done ? transfer.digest.digest("hex") : null }
    transfer.last = result
    clearTimeout(transfer.timer); transfer.timer = setTimeout(() => remove(transferId), 60000); transfer.timer.unref()
    return result
  }
  return {
    async request(channel: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
      if (closed || signal.aborted) bridgeError("BRIDGE_CLOSED")
      const input = object(raw)
      if (channel === "read-open") {
        keys(input, ["channel", "payload"])
        if (!channels.has(String(input.channel))) bridgeError("UNSUPPORTED_CAPABILITY")
        if (opening + transfers.size >= 4) bridgeError("BRIDGE_BACKPRESSURE")
        opening++
        try {
          const value = await read(String(input.channel), input.payload, signal)
          if (closed || signal.aborted) bridgeError("BRIDGE_CLOSED")
          const transferId = randomUUID()
          transfers.set(transferId, { parts: jsonParts(value), remaining: Buffer.alloc(0), digest: createHash("sha256"), last: null })
          try { return page(transferId, 0) } catch (error) { remove(transferId); throw error }
        } finally { opening-- }
      }
      if (channel === "read-page") { keys(input, ["transferId", "index"]); return page(id(input.transferId), timestamp(input.index)) }
      if (channel === "read-close") { keys(input, ["transferId"]); remove(id(input.transferId)); return { closed: true } }
      return bridgeError("UNSUPPORTED_CAPABILITY")
    },
    close() { closed = true; for (const transferId of transfers.keys()) remove(transferId) }
  }
}
export async function requestBridgeRead(peer: ReturnType<typeof createBridgePeer>, channel: string, payload: unknown, options: RequestOptions = {}): Promise<unknown> {
  if (!channels.has(channel) || !(await peer.ready).capabilities.includes("read-pages")) return peer.request(channel, payload, options)
  const chunks: Buffer[] = [], digest = createHash("sha256")
  let transferId: string | undefined, index = 0
  try {
    let raw = await peer.request("read-open", { channel, payload }, options)
    while (true) {
      const page = object(raw); keys(page, ["transferId", "index", "data", "done", "digest"])
      const current = id(page.transferId)
      if (transferId !== undefined && current !== transferId || page.index !== index || typeof page.data !== "string" || page.data.length > Math.ceil(PAGE_BYTES / 3) * 4 || typeof page.done !== "boolean") bridgeError("INVALID_READ_PAGE")
      transferId = current
      const bytes = Buffer.from(page.data, "base64")
      if (bytes.length > PAGE_BYTES || bytes.toString("base64") !== page.data || !page.done && (!bytes.length || page.digest !== null)) bridgeError("INVALID_READ_PAGE")
      chunks.push(bytes); digest.update(bytes)
      if (page.done) {
        if (hash(page.digest) !== digest.digest("hex")) bridgeError("INVALID_READ_PAGE")
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) } catch { return bridgeError("INVALID_READ_PAGE") }
      }
      raw = await peer.request("read-page", { transferId, index: ++index }, options)
    }
  } finally { if (transferId) await peer.request("read-close", { transferId }).catch(() => undefined) }
}