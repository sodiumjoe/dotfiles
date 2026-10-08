import { createConnection, type Socket } from "node:net"
import { dirname, basename } from "node:path"
import { randomUUID } from "node:crypto"
import { id, keys, object } from "../catalog/types.js"
import { assertPrivateSocket } from "../platform/private-socket.js"
import { encodeFrame, receiveFrame } from "../control/wire.js"
import { serveMcp, toolResult, type ToolResult } from "./mcp.js"
import type { createToolBindings } from "./tool-bindings.js"
import { boundedText, fail } from "./types.js"

export async function exchangeTool(socketPath: string, token: string, op: "call" | "cancel", name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const path = await assertPrivateSocket(dirname(socketPath), basename(socketPath)), socket = createConnection(path), requestId = randomUUID()
  const abort = () => socket.destroy(new Error("TRANSPORT_DETACHED"))
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const response = receiveFrame(socket, 0)
    if (signal?.aborted) abort(); else socket.end(encodeFrame({ protocol: "agency-tools-v1", requestId, token, op, name, args }))
    const result = object(await response)
    keys(result, ["protocol", "requestId", "result"])
    if (result.protocol !== "agency-tools-v1" || result.requestId !== requestId) fail("INVALID_PROTOCOL")
    const body = object(result.result); keys(body, ["content", "isError"])
    if (typeof body.isError !== "boolean" || !Array.isArray(body.content) || body.content.some(entry => { const e = object(entry); keys(e, ["type", "text"]); return e.type !== "text" || typeof e.text !== "string" })) fail("INVALID_PROTOCOL")
    return body as ToolResult
  } finally { signal?.removeEventListener("abort", abort); socket.destroy() }
}
export async function serveToolSocket(socket: Socket, tools: ReturnType<typeof createToolBindings>): Promise<void> {
  socket.allowHalfOpen = true
  const controller = new AbortController(), abort = () => controller.abort(), protect = () => undefined
  socket.on("error", protect); socket.once("close", abort)
  let requestId: string | null = null
  try {
    const v = object(await receiveFrame(socket)); keys(v, ["protocol", "requestId", "token", "op", "name", "args"])
    requestId = id(v.requestId)
    if (v.protocol !== "agency-tools-v1" || !["call", "cancel"].includes(v.op as string)) fail("INVALID_PROTOCOL")
    const token = boundedText(v.token, 64, false), name = boundedText(v.name, 256, false), args = object(v.args)
    let result: ToolResult
    if (v.op === "cancel") { keys(args, ["waitId"]); await tools.cancel(token, id(args.waitId)); result = toolResult({ cancelled: true }) }
    else result = await tools.call(token, name, args, controller.signal)
    if (!socket.destroyed) await new Promise<void>(resolve => socket.end(encodeFrame({ protocol: "agency-tools-v1", requestId, result }), resolve))
  } catch {
    if (requestId && !socket.destroyed) { try { socket.end(encodeFrame({ protocol: "agency-tools-v1", requestId, result: toolResult({ code: "TOOLS_UNAVAILABLE" }, true) })) } catch { socket.destroy() } }
    else socket.destroy()
  } finally { if (!socket.destroyed) socket.destroy(); socket.off("close", abort); socket.off("error", protect) }
}
export async function runAgencyTools(): Promise<void> {
  const socketPath = process.env.AGENCY_TOOLS_SOCKET, token = process.env.AGENCY_TOOLS_TOKEN
  if (process.argv.length !== 3 || !socketPath?.startsWith("/") || !token || !/^[a-f0-9]{64}$/.test(token)) fail("INVALID_HELPER_INPUT")
  delete process.env.AGENCY_TOOLS_TOKEN
  await serveMcp({ input: process.stdin, output: process.stdout, call: async (name, args, signal) => {
    try { return await exchangeTool(socketPath, token, "call", name, args, signal) } catch { return toolResult({ code: "TOOLS_UNAVAILABLE" }, true) }
  }, cancel: async waitId => { await exchangeTool(socketPath, token, "cancel", "agency_wait", { waitId }) } })
}