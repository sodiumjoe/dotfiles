import { LinuxObservationUnavailable } from "./linux.js"
import { spawn, type ChildProcess } from "node:child_process"
import { constants } from "node:fs"
import { lstat, open, realpath, type FileHandle } from "node:fs/promises"
import { createConnection } from "node:net"
import { join } from "node:path"
import { type Duplex } from "node:stream"
import { DarwinObservationUnavailable } from "./darwin.js"
import { assertPrivateSocket, unlinkStalePrivateSocket } from "./private-socket.js"
import { assertPrivateDirectory, readHandlerRecord } from "./private-state.js"
import { launchHandlerGeneration, type HandlerCommand, type StartTransition } from "./startup.js"
import { sameProcess, type HandlerInspection, type PlatformAdapter } from "./types.js"

export type { HandlerCommand, StartTransition } from "./startup.js"

export type StartupLockCommand = {
  file: string
  args: string[]
}

export type StartOrConnectOptions = {
  root: string
  hostId: string
  adapter: PlatformAdapter
  handler: HandlerCommand
  timeoutMs?: number
  lockTimeoutSeconds?: number
  onTransition?: (transition: StartTransition, pid?: number) => Promise<void> | void
}

export type StartupLockOptions = Pick<StartOrConnectOptions, "root" | "adapter" | "lockTimeoutSeconds">
export type StartupLockGuard = { assertHeld(): void; signal: AbortSignal }

type LockMetadata = {
  isFile(): boolean
  uid: number
  mode: number
}

const LOCK_HOLDER_SOURCE = "const fs=require('node:fs');fs.writeSync(4,'locked\\n');const input=fs.createReadStream(null,{fd:5});input.resume();input.on('end',()=>process.exit(0));input.on('error',()=>process.exit(1))"

function currentUid(): number {
  if (process.getuid === undefined) throw new Error("singleton startup requires a POSIX platform")
  return process.getuid()
}

export function assertStartupLockMetadata(stats: LockMetadata, uid: number): void {
  if (!stats.isFile()) throw new Error("startup lock is not a regular file")
  if (stats.uid !== uid) throw new Error("startup lock has the wrong owner")
  if ((stats.mode & 0o077) !== 0) throw new Error("startup lock is not private")
}

function commandWithTimeout(platform: "darwin" | "linux", lockFd: number, argv: readonly string[], timeoutSeconds: number): StartupLockCommand {
  if (lockFd !== 3) throw new Error("startup lock must be inherited as fd 3")
  if (argv.length === 0 || argv.some(value => value.length === 0)) throw new Error("startup lock command requires a nonempty argument vector")
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("startup lock timeout must be a positive integer")
  if (platform === "darwin") return { file: "/usr/bin/lockf", args: ["-s", "-t", String(timeoutSeconds), "/dev/fd/3", ...argv] }
  return { file: "/usr/bin/flock", args: ["--no-fork", "-w", String(timeoutSeconds), "/proc/self/fd/3", ...argv] }
}

export function startupLockCommand(platform: "darwin" | "linux", lockFd: number, argv: readonly string[]): StartupLockCommand {
  return commandWithTimeout(platform, lockFd, argv, 10)
}

async function assertLockHelper(path: string): Promise<void> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink()) throw new Error(`${path} is a symlink`)
  if (!stats.isFile()) throw new Error(`${path} is not a regular file`)
  if (stats.uid !== 0) throw new Error(`${path} is not root-owned`)
  if ((stats.mode & 0o022) !== 0) throw new Error(`${path} is group or world writable`)
  if (await realpath(path) !== path) throw new Error(`${path} is not canonical`)
}

async function openStartupLock(root: string): Promise<FileHandle> {
  await assertPrivateDirectory(root)
  const path = join(root, "startup.lock")
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP") throw new Error("startup lock path is a symlink", { cause: error })
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EISDIR") throw new Error("startup lock is not a regular file", { cause: error })
    throw error
  }
  try {
    assertStartupLockMetadata(await handle.stat(), currentUid())
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

function pipe(child: ChildProcess, fd: number): Duplex {
  const value = child.stdio[fd]
  if (value === null) throw new Error(`lock helper fd ${fd} is unavailable`)
  return value as Duplex
}

async function waitForLock(child: ChildProcess, ready: Duplex, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = ""
    let settled = false
    const timer = setTimeout(() => finish(new Error("startup lock is unavailable")), timeoutMs)
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ready.off("data", data)
      ready.off("error", failed)
      child.off("error", failed)
      child.off("exit", exited)
      if (error === undefined) resolve()
      else reject(error)
    }
    const data = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      if (buffer.includes("locked\n")) finish()
    }
    const failed = (error: Error): void => finish(error)
    const exited = (): void => finish(new Error("startup lock is unavailable"))
    ready.on("data", data)
    ready.once("error", failed)
    child.once("error", failed)
    child.once("exit", exited)
  })
}

async function acquireStartupLock(options: StartupLockOptions, handle: FileHandle): Promise<{ child: ChildProcess; release: Duplex }> {
  const timeoutSeconds = options.lockTimeoutSeconds ?? 10
  const argv = [process.execPath, "-e", LOCK_HOLDER_SOURCE]
  const command = commandWithTimeout(options.adapter.platform, 3, argv, timeoutSeconds)
  await assertLockHelper(command.file)
  const child = spawn(command.file, command.args, {
    stdio: ["ignore", "ignore", "pipe", handle.fd, "pipe", "pipe"],
  })
  const ready = pipe(child, 4)
  const release = pipe(child, 5)
  try {
    await waitForLock(child, ready, (timeoutSeconds + 1) * 1000)
    ready.destroy()
    return { child, release }
  } catch (error) {
    ready.destroy()
    release.destroy()
    throw error
  }
}

export async function withStartupLock<T>(options: StartupLockOptions, work: (guard: StartupLockGuard) => Promise<T>): Promise<T> {
  const handle = await openStartupLock(options.root)
  let lock: Awaited<ReturnType<typeof acquireStartupLock>> | undefined
  const controller = new AbortController()
  const lost = (): void => { controller.abort(new Error("startup lock holder was lost")) }
  const guard: StartupLockGuard = {
    signal: controller.signal,
    assertHeld() {
      if (lock === undefined || lock.child.exitCode !== null || lock.child.signalCode !== null || lock.release.destroyed) lost()
      controller.signal.throwIfAborted()
    },
  }
  try {
    lock = await acquireStartupLock(options, handle)
    lock.child.once("exit", lost)
    lock.child.once("error", lost)
    guard.assertHeld()
    const result = await work(guard)
    guard.assertHeld()
    return result
  } finally {
    try {
      if (lock !== undefined) {
        lock.child.off("exit", lost)
        lock.child.off("error", lost)
        await releaseStartupLock(lock.child, lock.release)
      }
    } finally {
      await handle.close()
    }
  }
}

async function releaseStartupLock(child: ChildProcess, release: Duplex): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { release.end(); return }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup lock helper did not exit")), 1000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    child.once("error", error => {
      clearTimeout(timer)
      reject(error)
    })
    release.end()
  })
}

function handlerPath(root: string): string {
  return join(root, "handler.json")
}

function expectedSocketPath(root: string): string {
  return join(root, "handler.sock")
}

function observationReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.message + (error.cause === undefined ? "" : ": " + observationReason(error.cause))
}

export async function inspectHandlerGeneration(root: string, adapter: PlatformAdapter): Promise<HandlerInspection | null> {
  await assertPrivateDirectory(root)
  let record
  try {
    record = await readHandlerRecord(handlerPath(root))
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null
    throw error
  }
  if (record.socketPath !== expectedSocketPath(root)) throw new Error("Handler socket is outside the qualified root")
  let currentBoot: string
  try {
    currentBoot = await adapter.bootId()
  } catch (error) {
    if (error instanceof DarwinObservationUnavailable || error instanceof LinuxObservationUnavailable) return { record, disposition: "ambiguous", diagnostic: { reason: observationReason(error), expected: record.process, observed: null } }
    throw error
  }
  if (record.launchBootId !== currentBoot || record.process === null) return { record, disposition: "stale" }
  let observed
  try {
    observed = await adapter.readProcess(record.process.pid)
  } catch (error) {
    if (error instanceof DarwinObservationUnavailable || error instanceof LinuxObservationUnavailable) return { record, disposition: "ambiguous", diagnostic: { reason: observationReason(error), expected: record.process, observed: null } }
    throw error
  }
  if (observed === null) return { record, disposition: "stale" }
  if (!sameProcess(record.process, observed)) return { record, disposition: "ambiguous", diagnostic: { reason: "observed identity mismatch", expected: record.process, observed } }
  return { record, disposition: "live" }
}

async function socketAccepts(path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("Handler socket readiness timed out"))
    }, timeoutMs)
    socket.once("connect", () => {
      clearTimeout(timer)
      socket.destroy()
      resolve()
    })
    socket.once("error", error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function waitForExisting(root: string, adapter: PlatformAdapter, deadline: number): Promise<HandlerInspection> {
  while (true) {
    const inspection = await inspectHandlerGeneration(root, adapter)
    if (inspection === null) throw new Error("Handler generation disappeared")
    if (inspection.disposition !== "live") return inspection
    if (inspection.record.phase === "ready") {
      await assertPrivateSocket(root, "handler.sock")
      await socketAccepts(inspection.record.socketPath, Math.max(1, deadline - Date.now()))
      return inspection
    }
    if (Date.now() >= deadline) throw new Error("Handler generation is unavailable before readiness")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

export async function startOrConnect(options: StartOrConnectOptions): Promise<HandlerInspection> {
  const timeoutMs = options.timeoutMs ?? 5000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("startup timeout must be a positive integer")
  const socketPath = expectedSocketPath(options.root)
  return withStartupLock(options, async guard => {
    await options.onTransition?.("lock_acquired")
    const deadline = Date.now() + timeoutMs
    const existing = await inspectHandlerGeneration(options.root, options.adapter)
    if (existing?.disposition === "ambiguous") throw new Error("Handler identity is ambiguous; startup is unavailable: " + JSON.stringify(existing.diagnostic))
    if (existing?.disposition === "live") {
      const settled = await waitForExisting(options.root, options.adapter, deadline)
      if (settled.disposition === "ambiguous") throw new Error("Handler identity became ambiguous; startup is unavailable: " + JSON.stringify(settled.diagnostic))
      if (settled.disposition === "live") return settled
      await unlinkStalePrivateSocket(options.root, "handler.sock", settled)
      await unlinkStalePrivateSocket(options.root, "attachment.sock", settled)
      await unlinkStalePrivateSocket(options.root, "acp.sock", settled)
    } else if (existing?.disposition === "stale") {
      await unlinkStalePrivateSocket(options.root, "handler.sock", existing)
      await unlinkStalePrivateSocket(options.root, "attachment.sock", existing)
      await unlinkStalePrivateSocket(options.root, "acp.sock", existing)
    }
    const launchOptions = {
      root: options.root,
      hostId: options.hostId,
      adapter: options.adapter,
      handler: options.handler,
      timeoutMs: Math.max(1, deadline - Date.now()),
      ...(options.onTransition === undefined ? {} : { onTransition: options.onTransition }),
    }
    guard.assertHeld()
    const launched = await launchHandlerGeneration(launchOptions)
    await assertPrivateSocket(options.root, "handler.sock")
    await socketAccepts(socketPath, Math.max(1, deadline - Date.now()))
    return launched
  })
}