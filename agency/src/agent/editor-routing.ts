import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { isAbsolute, join } from "node:path"
import { bindPrivateSocket } from "../platform/private-socket.js"
import { AgentError } from "./types.js"

export type EditorOrigin = { connectionId: string; attachment: string; address?: string | null }
export type EditorRouting = {
  path: string
  attach(connectionId: string, address: string | null, token?: string): string
  detach(connectionId: string, expectedToken?: string): void
  begin(submissionId: string, origin?: EditorOrigin): void
  end(submissionId: string): void
  revoke(): void
  close(): void
}

export async function startEditorRouting(runtimeRoot: string): Promise<EditorRouting> {
  const name = "editor-" + randomUUID() + ".sock", path = join(runtimeRoot, name)
  type Attachment = { token: string; address: string | null }
  type Route = { submissionId: string; attachment: Attachment }
  const attachments = new Map<string, Attachment>(), pairs = new Set<{ downstream: Socket; upstream: Socket }>()
  let route: Route | null = null, closed = false, unavailable = false
  const revoke = (): void => { route = null; for (const pair of pairs) { pair.downstream.destroy(); pair.upstream.destroy() }; pairs.clear() }
  const address = (value: string | null): string | null => {
    if (value !== null && (!isAbsolute(value) || value.includes("\0") || value === path)) throw new AgentError("INVALID_PROTOCOL")
    return value
  }
  const server = await bindPrivateSocket(runtimeRoot, name, downstream => {
    downstream.on("error", () => downstream.destroy())
    const current = route
    if (closed || !current?.attachment.address) { downstream.destroy(); return }
    const upstream = createConnection(current.attachment.address), pair = { downstream, upstream }
    pairs.add(pair)
    const dispose = (): void => { pairs.delete(pair); downstream.destroy(); upstream.destroy() }
    downstream.on("close", dispose); upstream.on("close", dispose); upstream.on("error", dispose)
    downstream.pipe(upstream); upstream.pipe(downstream)
  })
  const close = (): void => { if (closed) return; closed = true; revoke(); attachments.clear(); server.close() }
  server.on("error", () => { if (closed || unavailable) return; unavailable = true; revoke(); server.close() })
  return {
    path,
    attach(connectionId, value, token = randomUUID()) {
      if (closed) throw new AgentError("STALE_ATTACHMENT")
      const next = { token, address: address(value) }, previous = attachments.get(connectionId)
      if (route && route.attachment === previous) revoke()
      attachments.set(connectionId, next)
      return token
    },
    detach(connectionId, expectedToken) {
      const previous = attachments.get(connectionId)
      if (!previous || expectedToken !== undefined && previous.token !== expectedToken) return
      if (route?.attachment === previous) revoke()
      attachments.delete(connectionId)
    },
    begin(submissionId, origin) {
      const attachment = origin ? attachments.get(origin.connectionId) : undefined
      if (closed || origin && (!attachment || attachment.token !== origin.attachment)) throw new AgentError("STALE_ATTACHMENT")
      const nextAddress = origin?.address === undefined ? attachment?.address ?? null : address(origin.address)
      revoke()
      if (attachment) { attachment.address = nextAddress; if (!unavailable) route = { submissionId, attachment } }
    },
    end(submissionId) { if (route?.submissionId === submissionId) revoke() },
    revoke, close,
  }
}