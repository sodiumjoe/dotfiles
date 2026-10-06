import { randomUUID } from "node:crypto"
import type { Socket } from "node:net"
import { isDeepStrictEqual } from "node:util"
import { ATTACHMENT_PROTOCOL, ATTACHMENT_FRAME_BYTES, ATTACHMENT_QUEUE_BYTES, ATTACHMENT_LIMITS, createNdjsonDecoder, parseAttachmentRequest, type AttachmentFrame, type AttachmentRequest } from "./attachment-protocol.js"
import type { ConversationObservation, ConversationSnapshot } from "./conversation.js"
import { EDITOR_TURN_LIMITS } from "./session-events.js"
import type { AgentService } from "./service.js"
import { AgentError, agentFailure, type AgentTuple } from "./types.js"

export function serveAttachment(socket: Socket, agents: AgentService, expectedHandlerGeneration: string): Promise<void> {
  return new Promise(resolve => {
    let target: AgentTuple | undefined, observation: Pick<ConversationObservation, "close"> | undefined, snapshot: ConversationSnapshot | undefined
    let phase: "waiting" | "snapshot" | "active" | "closing" = "waiting", queuedBytes = 0, pumping = false, outstanding = 0
    const queue: Buffer[] = []
    const timer = setTimeout(() => fault(new AgentError("INVALID_PROTOCOL")), 5000)
    const isClosing = (): boolean => phase === "closing"
    const release = (): void => { clearTimeout(timer); observation?.close(); observation = undefined; snapshot = undefined; queue.length = 0; queuedBytes = 0 }
    const fault = (error: unknown): void => {
      if (phase === "closing") return
      phase = "closing"; release()
      if (!target || socket.destroyed || socket.writableLength > ATTACHMENT_QUEUE_BYTES) { socket.destroy(); return }
      const failure = agentFailure(error instanceof AgentError ? error : new AgentError("INVALID_PROTOCOL"))
      const deadline = setTimeout(() => socket.destroy(), 100)
      socket.once("close", () => clearTimeout(deadline))
      socket.end(JSON.stringify({ protocol: ATTACHMENT_PROTOCOL, target, type: "fault", error: failure }) + "\n")
    }
    const encode = (body: Omit<AttachmentFrame, "protocol" | "target"> | object): Buffer => {
      const bytes = Buffer.from(JSON.stringify({ protocol: ATTACHMENT_PROTOCOL, target, ...body }) + "\n")
      if (bytes.length > ATTACHMENT_FRAME_BYTES) throw new AgentError("INVALID_PROTOCOL")
      return bytes
    }
    const write = (bytes: Buffer): Promise<void> => new Promise((done, reject) => {
      if (phase === "closing" || socket.destroyed) { reject(new AgentError("UNAVAILABLE")); return }
      const closed = (): void => { socket.off("close", closed); reject(new AgentError("UNAVAILABLE")) }
      socket.once("close", closed)
      socket.write(bytes, error => { socket.off("close", closed); if (error) reject(error); else done() })
    })
    const pump = async (): Promise<void> => {
      if (pumping || phase !== "active") return
      pumping = true
      try {
        while (queue.length && phase === "active") {
          const next = queue.shift()!; queuedBytes -= next.length
          await write(next)
        }
      } catch (error) { fault(error) } finally { pumping = false }
    }
    const enqueue = (body: object): void => {
      if (phase === "closing") return
      try {
        const bytes = encode(body)
        if (queuedBytes + socket.writableLength + bytes.length > ATTACHMENT_QUEUE_BYTES) { fault(new AgentError("INCOMPLETE")); return }
        queue.push(bytes); queuedBytes += bytes.length
        void pump()
      } catch (error) { fault(error) }
    }
    const attach = async (): Promise<void> => {
      try {
        const observed = await agents.observe(target!, notification => {
          if (notification.kind === "closed") fault(new AgentError("NOT_READY"))
          else enqueue({ type: "event", event: notification.event, firstSeq: notification.firstSeq, historyTruncated: notification.historyTruncated })
        })
        if (phase === "closing") { observed.close(); return }
        observation = { close: observed.close }; snapshot = observed.snapshot
        const value = snapshot, snapshotId = randomUUID(), metadata = value.metadata
        if (!metadata.session || metadata.phase !== "ready") throw new AgentError("NOT_READY")
        const bounds = { firstSeq: value.firstSeq, lastSeq: value.lastSeq, historyTruncated: value.historyTruncated }
        await write(encode({ type: "snapshot_begin", snapshotId, sessionId: metadata.session.sessionId, cwd: metadata.cwd, selection: metadata.selection, metadata, ...bounds, currentTurn: value.currentTurn, limits: ATTACHMENT_LIMITS }))
        let chunkIndex = 0, index = 0
        while (index < value.events.length) {
          const events = [], start = index
          let bytes = 0
          while (index < value.events.length) {
            const event = value.events[index]!, size = Buffer.byteLength(JSON.stringify(event))
            if (index > start && bytes + size > 131072) break
            events.push(event); bytes += size; index++
          }
          await write(encode({ type: "snapshot_events", snapshotId, chunkIndex: chunkIndex++, events }))
        }
        await write(encode({ type: "snapshot_end", snapshotId, ...bounds, chunkCount: chunkIndex }))
        if (isClosing()) return
        snapshot = undefined; clearTimeout(timer); phase = "active"; void pump()
      } catch (error) { fault(error) }
    }
    const dispatch = async (request: Exclude<AttachmentRequest, { op: "attach" }>): Promise<void> => {
      try {
        const receipt = request.op === "submit" ? await agents.submit(target!, { submissionId: request.submissionId, text: request.text, limits: EDITOR_TURN_LIMITS }) : request.op === "cancel" ? await agents.cancel(target!, request.submissionId) : await agents.submission(target!, request.submissionId)
        enqueue({ type: "response", requestId: request.requestId, ok: true, receipt })
      } catch (error) {
        enqueue({ type: "response", requestId: request.requestId, ok: false, error: agentFailure(error instanceof AgentError ? error : new AgentError("INCOMPLETE")) })
      } finally { outstanding-- }
    }
    const decoder = createNdjsonDecoder(value => {
      if (phase === "closing") return
      try {
        const request = parseAttachmentRequest(value)
        if (phase === "waiting") {
          target = request.target
          if (target.handlerGeneration !== expectedHandlerGeneration) throw new AgentError("STALE_HANDLER")
          if (request.op !== "attach") throw new AgentError("INVALID_PROTOCOL")
          phase = "snapshot"; void attach(); return
        }
        if (phase !== "active" || request.op === "attach" || !isDeepStrictEqual(request.target, target)) throw new AgentError("INVALID_PROTOCOL")
        if (++outstanding > 64) throw new AgentError("INCOMPLETE")
        void dispatch(request)
      } catch (error) { fault(error) }
    }, fault)
    socket.on("data", bytes => decoder.feed(bytes))
    socket.on("end", () => { decoder.end(); phase = "closing"; release(); socket.destroy() })
    socket.on("error", () => { phase = "closing"; release(); socket.destroy() })
    socket.once("close", () => { phase = "closing"; release(); resolve() })
  })
}