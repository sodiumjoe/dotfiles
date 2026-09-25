import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { type Duplex } from "node:stream"
import { join } from "node:path"
import { agencyLaunchMarker, exactAgencyBirth } from "./launch-marker.js"
import { readHandlerRecord, writeHandlerRecord } from "./private-state.js"
import { RUNTIME_RECORD_VERSION, sameProcess, type HandlerGenerationRecord, type HandlerInspection, type PlatformAdapter, type ProcessIdentity } from "./types.js"

export type StartTransition =
  | "lock_acquired"
  | "launch_pending_written"
  | "launch_attempt_recorded"
  | "handler_spawned"
  | "identity_verified"
  | "identity_published"
  | "gate_released"
  | "ready_acknowledged"

export type HandlerCommand = {
  file: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
}

export type LaunchHandlerOptions = {
  root: string
  hostId: string
  adapter: PlatformAdapter
  handler: HandlerCommand
  timeoutMs: number
  onTransition?: (transition: StartTransition, pid?: number) => Promise<void> | void
}

type StatusMessage =
  | { type: "identity"; identity: ProcessIdentity }
  | { type: "gate_released"; generation: string }
  | { type: "ready"; generation: string }

function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} is invalid`)
  return value
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is invalid`)
  return value
}

function claimedIdentity(value: unknown): ProcessIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Handler identity claim is invalid")
  const source = value as Record<string, unknown>
  return {
    bootId: text(source.bootId, "bootId"),
    pid: integer(source.pid, "pid", 1),
    birth: text(source.birth, "birth"),
    parentPid: integer(source.parentPid, "parentPid"),
    processGroupId: integer(source.processGroupId, "processGroupId", 1),
    sessionId: integer(source.sessionId, "sessionId", 1),
    uid: integer(source.uid, "uid"),
    gid: integer(source.gid, "gid"),
  }
}

function statusMessage(line: string): StatusMessage {
  const value: unknown = JSON.parse(line)
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Handler status message is invalid")
  const source = value as Record<string, unknown>
  if (source.type === "identity") return { type: "identity", identity: claimedIdentity(source.identity) }
  if (source.type === "gate_released") return { type: "gate_released", generation: text(source.generation, "generation") }
  if (source.type === "ready") return { type: "ready", generation: text(source.generation, "generation") }
  throw new Error("Handler status message type is invalid")
}

function remaining(deadline: number): number {
  const milliseconds = deadline - Date.now()
  if (milliseconds <= 0) throw new Error("Handler status timed out")
  return milliseconds
}

async function releaseGate(gate: Duplex, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Handler gate delivery timed out")), timeoutMs)
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      gate.off("error", failed)
      if (error === undefined) resolve()
      else reject(error)
    }
    const failed = (error: Error): void => {
      finish(error)
    }
    gate.once("error", failed)
    gate.end("start\n", () => {
      finish()
    })
  })
}

async function transition(options: LaunchHandlerOptions, value: StartTransition, pid?: number): Promise<void> {
  await options.onTransition?.(value, pid)
}

function pipe(child: ChildProcess, fd: number): Duplex {
  const value = child.stdio[fd]
  if (value === null) throw new Error(`Handler fd ${fd} is unavailable`)
  return value as Duplex
}

type PendingStatusRead = {
  resolve: (line: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

class StatusLineReader {
  private buffer = ""
  private readonly lines: string[] = []
  private queuedBytes = 0
  private terminal: Error | null = null
  private pending: PendingStatusRead | null = null

  constructor(
    private readonly stream: Duplex,
    private readonly child: ChildProcess,
    private readonly priorError: () => Error | null,
  ) {
    stream.on("data", this.data)
    stream.on("end", this.ended)
    stream.on("close", this.ended)
    stream.on("error", this.failed)
    child.on("error", this.failed)
    child.on("exit", this.exited)
    const error = priorError()
    if (error !== null) this.terminate(error)
    else if (child.exitCode !== null || child.signalCode !== null) this.exited(child.exitCode, child.signalCode)
  }

  async read(timeoutMs: number): Promise<string> {
    if (this.lines.length > 0) return this.shift()
    if (this.terminal !== null) throw this.terminal
    if (this.pending !== null) throw new Error("Handler status reader already has a pending read")
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.timer !== timer) return
        this.pending = null
        reject(new Error("Handler status timed out"))
      }, timeoutMs)
      this.pending = { resolve, reject, timer }
      this.drain()
    })
  }

  close(): void {
    this.stream.off("data", this.data)
    this.stream.off("end", this.ended)
    this.stream.off("close", this.ended)
    this.stream.off("error", this.failed)
    this.child.off("error", this.failed)
    this.child.off("exit", this.exited)
  }

  private readonly data = (chunk: Buffer | string): void => {
    this.buffer += chunk.toString()
    if (this.queuedBytes + Buffer.byteLength(this.buffer, "utf8") > 64 * 1024) {
      this.terminate(new Error("Handler status message exceeds 64 KiB"))
      return
    }
    let newline = this.buffer.indexOf("\n")
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.lines.push(line)
      this.queuedBytes += Buffer.byteLength(line, "utf8") + 1
      newline = this.buffer.indexOf("\n")
    }
    this.drain()
  }

  private readonly ended = (): void => {
    this.defer(() => this.priorError() ?? new Error("Handler status peer closed"))
  }

  private readonly failed = (error: Error): void => {
    this.defer(() => error)
  }

  private readonly exited = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.defer(() => new Error(`Handler exited before acknowledgement: ${code ?? signal ?? "unknown"}`))
  }

  private shift(): string {
    const line = this.lines.shift()!
    this.queuedBytes -= Buffer.byteLength(line, "utf8") + 1
    return line
  }

  private drain(): void {
    if (this.pending === null) return
    if (this.lines.length > 0) {
      const pending = this.pending
      this.pending = null
      clearTimeout(pending.timer)
      pending.resolve(this.shift())
    } else if (this.terminal !== null) {
      const pending = this.pending
      this.pending = null
      clearTimeout(pending.timer)
      pending.reject(this.terminal)
    }
  }

  private terminate(error: Error): void {
    if (this.terminal !== null) return
    this.terminal = error
    this.drain()
  }

  private defer(error: () => Error): void {
    setImmediate(() => this.terminate(error()))
  }
}

function assertReadyRecord(published: HandlerGenerationRecord, ready: HandlerGenerationRecord): void {
  if (ready.phase !== "ready" || ready.writer !== "handler" || ready.reconciliation === null || ready.reconciliation.classified !== ready.reconciliation.total || ready.reason !== null) throw new Error("Handler ready record is incomplete")
  if (ready.version !== published.version
    || ready.hostId !== published.hostId
    || ready.launchBootId !== published.launchBootId
    || ready.generation !== published.generation
    || ready.launchAttemptId !== published.launchAttemptId
    || ready.socketPath !== published.socketPath) throw new Error("Handler ready record does not match the published launch")
  if (published.process === null || ready.process === null || !sameProcess(published.process, ready.process)) throw new Error("Handler ready identity does not match the published identity")
}

export async function launchHandlerGeneration(options: LaunchHandlerOptions): Promise<HandlerInspection> {
  const deadline = Date.now() + options.timeoutMs
  const recordPath = join(options.root, "handler.json")
  const socketPath = join(options.root, "handler.sock")
  const launchBootId = await options.adapter.bootId()
  const generation = randomUUID()
  const launchAttemptId = randomUUID()
  const pending = {
    version: RUNTIME_RECORD_VERSION,
    hostId: options.hostId,
    launchBootId,
    generation,
    launchAttemptId,
    launchAttempted: false,
    phase: "launch_pending",
    process: null,
    socketPath,
    writer: "launcher",
    reconciliation: null,
    reason: null,
  } as const
  await writeHandlerRecord(recordPath, pending)
  await transition(options, "launch_pending_written")
  await writeHandlerRecord(recordPath, { ...pending, launchAttempted: true })
  await transition(options, "launch_attempt_recorded")
  const launchMarker = agencyLaunchMarker("handler", launchAttemptId)
  const child = spawn(options.handler.file, [...options.handler.args], {
    argv0: launchMarker,
    detached: true,
    env: {
      ...process.env,
      ...options.handler.env,
      AGENCY_HANDLER_RECORD: recordPath,
      AGENCY_HANDLER_GENERATION: generation,
    },
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  })
  let launchError: Error | null = null
  child.on("error", error => launchError = error)
  let status: Duplex | undefined
  let gate: Duplex | undefined
  let reader: StatusLineReader | undefined
  let released = false
  try {
    status = pipe(child, 3)
    gate = pipe(child, 4)
    await transition(options, "handler_spawned", child.pid)
    reader = new StatusLineReader(status, child, () => launchError)
    if (launchError !== null) throw launchError
    const identityMessage = statusMessage(await reader.read(remaining(deadline)))
    if (identityMessage.type !== "identity") throw new Error("Handler did not publish identity first")
    if (identityMessage.identity.pid !== child.pid) throw new Error("Handler claimed a different pid")
    const observed = await options.adapter.readProcess(identityMessage.identity.pid)
    if (observed === null || !sameProcess(identityMessage.identity, observed)) throw new Error("Handler identity could not be verified")
    if (observed.bootId !== launchBootId) throw new Error("Handler identity boot does not match launch boot")
    if (!exactAgencyBirth(observed.birth, launchMarker)) throw new Error("Handler identity does not contain the exact launch marker")
    if (observed.pid !== observed.processGroupId || observed.pid !== observed.sessionId) throw new Error("Handler identity does not own its process group and session")
    if (observed.uid !== process.getuid!() || observed.gid !== process.getgid!()) throw new Error("Handler identity owner does not match launcher")
    await transition(options, "identity_verified")
    const published = {
      ...pending,
      launchAttempted: true,
      phase: "identity_published",
      process: observed,
    } as const
    await writeHandlerRecord(recordPath, published)
    assert.deepEqual(await readHandlerRecord(recordPath), published)
    await transition(options, "identity_published")
    await releaseGate(gate, remaining(deadline))
    released = true
    const gateMessage = statusMessage(await reader.read(remaining(deadline)))
    if (gateMessage.type !== "gate_released" || gateMessage.generation !== generation) throw new Error("Handler gate acknowledgement is invalid")
    await transition(options, "gate_released")
    const readyMessage = statusMessage(await reader.read(remaining(deadline)))
    if (readyMessage.type !== "ready" || readyMessage.generation !== generation) throw new Error("Handler readiness acknowledgement is invalid")
    const ready = await readHandlerRecord(recordPath)
    assertReadyRecord(published, ready)
    await transition(options, "ready_acknowledged")
    const live = await options.adapter.readProcess(published.process.pid)
    if (live === null || !sameProcess(published.process, live)) throw new Error("Handler published identity is not live after readiness acknowledgement")
    return { record: ready, disposition: "live" }
  } finally {
    reader?.close()
    gate?.destroy()
    status?.destroy()
    if (released) child.unref()
  }
}