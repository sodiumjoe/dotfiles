import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import type { Readable, Writable } from "node:stream"
import { isDeepStrictEqual } from "node:util"
import type { HandlerEnvironment } from "../handler/environment.js"
import { assertPrivateSocket } from "../platform/private-socket.js"
import type { HandlerInspection } from "../platform/types.js"
import { ATTACHMENT_PROTOCOL, ATTACHMENT_QUEUE_BYTES, ATTACHMENT_LIMITS, createNdjsonDecoder, parseAttachmentFrame, parseAttachmentRequest, type AttachmentRequest } from "./attachment-protocol.js"
import { AgentError, agentFailure, parseTuple, type AgentErrorCode, type AgentTuple } from "./types.js"

export type AttachmentDependencies = {
  environment(): Promise<HandlerEnvironment>
  inspect(env: HandlerEnvironment): Promise<HandlerInspection | null>
  connect(env: HandlerEnvironment): Promise<Socket>
  stdin: Readable
  stdout: Writable
  stderr(text: string): void
  onSignal(signal: "SIGINT" | "SIGTERM", callback: () => void): () => void
}
export function productionAttachmentStreams(): Omit<AttachmentDependencies, "environment" | "inspect" | "stderr"> {
  return { stdin: process.stdin, stdout: process.stdout, connect: async env => createConnection(await assertPrivateSocket(env.paths.runtimeRoot, "attachment.sock")), onSignal(signal, callback) { process.on(signal, callback); return () => { process.off(signal, callback) } } }
}
const exit = (code: AgentErrorCode): number => code === "USAGE" ? 64 : code === "INVALID_PROTOCOL" ? 65 : ["UNAVAILABLE", "STALE_HANDLER", "STALE_PROVIDER", "NOT_READY"].includes(code) ? 69 : code === "INTERNAL" ? 70 : 75
const classified = (error: unknown): AgentError => error instanceof AgentError ? error : new AgentError("UNAVAILABLE")

export async function runAttachmentClient(argv: readonly string[], deps: AttachmentDependencies): Promise<number> {
  let target: AgentTuple | null = null
  try {
    if (deps.stdout.destroyed || deps.stdout.writableEnded) throw new AgentError("UNAVAILABLE")
    const flags = new Map<string, string>()
    if (argv[0] !== "agent" || argv[1] !== "attach" || !argv[2]) throw new AgentError("USAGE")
    for (let i = 3; i < argv.length; i += 2) {
      const flag = argv[i]!, value = argv[i + 1]
      if (!["--handler-generation", "--provider-generation", "--format"].includes(flag) || flags.has(flag) || value === undefined || flag === "--format" && value !== "ndjson") throw new AgentError("USAGE")
      flags.set(flag, value)
    }
    try { target = parseTuple({ agentId: argv[2], handlerGeneration: flags.get("--handler-generation"), providerGeneration: flags.get("--provider-generation") }) } catch { throw new AgentError("USAGE") }
    const env = await deps.environment(), inspection = await deps.inspect(env)
    if (!inspection) throw new AgentError("UNAVAILABLE")
    if (inspection.record.generation !== target.handlerGeneration) throw new AgentError("STALE_HANDLER")
    if (inspection.disposition !== "live" || inspection.record.phase !== "ready") throw new AgentError("NOT_READY")
    let socket: Socket
    try { socket = await deps.connect(env) } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") deps.stderr("attachment endpoint unavailable; an explicit Handler restart after upgrade may be needed\n"); throw error }
    const tuple = target
    return await new Promise<number>(resolve => {
      let closed = false, active = false, writingFault = false, lastSeq = 0, firstSeq = 1, truncated = false
      let staging: { id: string; first: number; last: number; truncated: boolean; next: number; chunks: number; bytes: number; wireBytes: number; events: number } | undefined
      const pending = new Map<string, { request: AttachmentRequest; timer: ReturnType<typeof setTimeout> }>(), removeSignals: Array<() => void> = []
      const timer = setTimeout(() => fault(new AgentError("INCOMPLETE")), 5000)
      const finish = (code: number): void => {
        if (closed) return
        closed = true; clearTimeout(timer)
        for (const entry of pending.values()) clearTimeout(entry.timer)
        pending.clear(); staging = undefined
        for (const remove of removeSignals) remove()
        deps.stdin.pause(); deps.stdin.off("data", input); deps.stdin.off("end", eof); deps.stdin.off("error", inputError); deps.stdin.off("close", eof)
        deps.stdout.off("drain", drain); deps.stdout.off("error", outputError); deps.stdout.off("close", outputClosed)
        if (deps.stdout.destroyed || deps.stdout.writableLength > 0) deps.stdout.once("error", () => undefined)
        socket.destroy(); resolve(code)
      }
      const outputError = (): void => { if (!closed) deps.stderr("unavailable\n"); finish(69) }
      const outputClosed = (): void => finish(69)
      const fault = (error: unknown): void => {
        if (closed || writingFault) return
        writingFault = true
        const failure = classified(error)
        deps.stderr(failure.message + "\n")
        if (deps.stdout.destroyed || deps.stdout.writableLength > ATTACHMENT_QUEUE_BYTES) { finish(exit(failure.code)); return }
        const timeout = setTimeout(() => finish(exit(failure.code)), 100)
        deps.stdout.write(JSON.stringify({ protocol: ATTACHMENT_PROTOCOL, target: tuple, type: "fault", error: agentFailure(failure) }) + "\n", () => { clearTimeout(timeout); finish(exit(failure.code)) })
      }
      const output = (frame: object): void => {
        const bytes = Buffer.from(JSON.stringify(frame) + "\n")
        if (deps.stdout.writableLength + bytes.length > ATTACHMENT_QUEUE_BYTES) throw new AgentError("INCOMPLETE")
        if (!deps.stdout.write(bytes)) socket.pause()
      }
      const drain = (): void => { if (!closed) socket.resume() }
      const decoder = createNdjsonDecoder((value, wireBytes) => {
        if (closed || writingFault) return
        try {
          const frame = parseAttachmentFrame(value)
          if (!isDeepStrictEqual(frame.target, tuple)) throw new AgentError("INVALID_PROTOCOL")
          if (frame.type === "fault") { output(frame); deps.stderr(frame.error.message + "\n"); finish(exit(frame.error.code)); return }
          if (staging && (staging.wireBytes += wireBytes) > 17825792) throw new AgentError("INVALID_PROTOCOL")
          if (frame.type === "snapshot_begin") {
            if (active || staging) throw new AgentError("INVALID_PROTOCOL")
            staging = { id: frame.snapshotId, first: frame.firstSeq, last: frame.lastSeq, truncated: frame.historyTruncated, next: frame.firstSeq, chunks: 0, bytes: 0, wireBytes, events: 0 }
          } else if (frame.type === "snapshot_events") {
            if (!staging || frame.snapshotId !== staging.id || frame.chunkIndex !== staging.chunks++) throw new AgentError("INVALID_PROTOCOL")
            for (const event of frame.events) {
              if (event.seq !== staging.next++) throw new AgentError("INVALID_PROTOCOL")
              staging.bytes += Buffer.byteLength(JSON.stringify(event)); staging.events++
              if (staging.bytes > ATTACHMENT_LIMITS.historyBytes || staging.events > ATTACHMENT_LIMITS.historyEvents || event.seq > staging.last) throw new AgentError("INVALID_PROTOCOL")
            }
          } else if (frame.type === "snapshot_end") {
            if (!staging || frame.snapshotId !== staging.id || frame.chunkCount !== staging.chunks || frame.firstSeq !== staging.first || frame.lastSeq !== staging.last || frame.historyTruncated !== staging.truncated || staging.next !== staging.last + 1) throw new AgentError("INVALID_PROTOCOL")
            firstSeq = staging.first; lastSeq = staging.last; truncated = staging.truncated; staging = undefined; active = true; clearTimeout(timer); deps.stdin.resume()
          } else {
            if (!active) throw new AgentError("INVALID_PROTOCOL")
            if (frame.type === "event") {
              if (frame.event.seq !== lastSeq + 1 || frame.firstSeq < firstSeq || truncated && !frame.historyTruncated) throw new AgentError("INVALID_PROTOCOL")
              lastSeq = frame.event.seq; firstSeq = frame.firstSeq; truncated = frame.historyTruncated
            } else {
              const entry = pending.get(frame.requestId)
              if (!entry || frame.ok && frame.receipt && "submissionId" in entry.request && frame.receipt.submissionId !== entry.request.submissionId) throw new AgentError("INVALID_PROTOCOL")
              clearTimeout(entry.timer); pending.delete(frame.requestId)
            }
          }
          output(frame)
        } catch (error) { fault(error instanceof AgentError ? error : new AgentError("INVALID_PROTOCOL")) }
      }, fault)
      const requests = createNdjsonDecoder(value => {
        if (closed || writingFault) return
        try {
          const request = parseAttachmentRequest(value)
          if (!active || request.op === "attach" || !isDeepStrictEqual(request.target, tuple) || pending.has(request.requestId) || pending.size >= 64) throw new AgentError("INVALID_PROTOCOL")
          const bytes = Buffer.from(JSON.stringify(request) + "\n")
          if (socket.writableLength + bytes.length > ATTACHMENT_QUEUE_BYTES) throw new AgentError("INCOMPLETE")
          pending.set(request.requestId, { request, timer: setTimeout(() => fault(new AgentError("INCOMPLETE")), 5000) })
          if (!socket.write(bytes)) deps.stdin.pause()
        } catch (error) { fault(error) }
      }, fault)
      const input = (bytes: Buffer): void => requests.feed(bytes)
      const eof = (): void => { requests.end(); if (!writingFault) finish(0) }
      const inputError = (): void => fault(new AgentError("UNAVAILABLE"))
      deps.stdin.pause(); deps.stdin.on("data", input); deps.stdin.pause(); deps.stdin.once("end", eof); deps.stdin.once("close", eof); deps.stdin.once("error", inputError)
      deps.stdout.on("drain", drain); deps.stdout.once("error", outputError); deps.stdout.once("close", outputClosed)
      for (const signal of ["SIGINT", "SIGTERM"] as const) removeSignals.push(deps.onSignal(signal, () => finish(signal === "SIGINT" ? 130 : 143)))
      socket.on("data", bytes => decoder.feed(bytes)); socket.on("drain", () => { if (active && !closed) deps.stdin.resume() })
      socket.on("end", () => { decoder.end(); if (!writingFault) fault(new AgentError("UNAVAILABLE")) })
      socket.on("error", error => { if (!closed && (error as NodeJS.ErrnoException).code === "ENOENT") deps.stderr("attachment endpoint unavailable; an explicit Handler restart after upgrade may be needed\n"); fault(new AgentError("UNAVAILABLE")) })
      socket.on("close", () => { if (!closed && !writingFault) fault(new AgentError("UNAVAILABLE")) })
      socket.write(JSON.stringify({ protocol: ATTACHMENT_PROTOCOL, target: tuple, requestId: randomUUID(), op: "attach" }) + "\n")
      if (deps.stdout.destroyed) finish(69)
      else if (deps.stdin.readableEnded || deps.stdin.destroyed) finish(0)
    })
  } catch (error) {
    const failure = classified(error)
    deps.stderr(failure.message + "\n")
    if (!deps.stdout.destroyed) deps.stdout.write(JSON.stringify({ protocol: ATTACHMENT_PROTOCOL, target, type: "fault", error: agentFailure(failure) }) + "\n")
    return exit(failure.code)
  }
}