import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath, rename, rm, type FileHandle } from "node:fs/promises"
import { Socket } from "node:net"
import { basename, dirname, join } from "node:path"
import { type Duplex } from "node:stream"
import { fileURLToPath } from "node:url"

type ProviderMode = "normal" | "leader-exits-on-term"
type ReadyFileSystem = { open: typeof open; rename: typeof rename }

async function withPrivateUmask<T>(create: () => Promise<T>): Promise<T> {
  const previous = process.umask(0o077)
  try {
    return await create()
  } finally {
    process.umask(previous)
  }
}

async function publishReady(path: string, data: string, filesystem: ReadyFileSystem = { open, rename }): Promise<void> {
  const parent = dirname(path)
  const directory = await lstat(parent)
  if (!directory.isDirectory() || directory.uid !== process.getuid!() || directory.gid !== process.getgid!() || (directory.mode & 0o777) !== 0o700 || await realpath(parent) !== parent) throw new Error("provider ready parent is not private and canonical")
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`)
  let handle: FileHandle | undefined
  let created = false
  try {
    handle = await filesystem.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    const opened = await handle.stat()
    if (!opened.isFile() || opened.uid !== process.getuid!() || opened.gid !== process.getgid!() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600) throw new Error("provider ready temporary file is not private")
    await handle.writeFile(data)
    await handle.close()
    handle = undefined
    const written = await lstat(temporary)
    if (!written.isFile() || written.dev !== opened.dev || written.ino !== opened.ino || written.uid !== opened.uid || written.gid !== opened.gid || written.nlink !== 1 || (written.mode & 0o777) !== 0o600 || written.size !== Buffer.byteLength(data)) throw new Error("provider ready temporary file changed before publication")
    try {
      await lstat(path)
      throw new Error("provider ready destination already exists")
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error
    }
    await filesystem.rename(temporary, path)
    created = false
  } finally {
    try {
      await handle?.close()
    } finally {
      if (created) await rm(temporary)
    }
  }
}

function mode(value: string | undefined): ProviderMode {
  if (value === "normal" || value === "leader-exits-on-term") return value
  throw new Error("provider-tree mode is invalid")
}

function timeout(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new Error("provider-tree timeout is invalid")
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds)) throw new Error("provider-tree timeout is invalid")
  return milliseconds
}

function wait(): Promise<never> {
  setInterval(() => undefined, 1000)
  return new Promise(() => undefined)
}

function socketForFd(fd: number): Socket {
  return new Socket({ fd, readable: true, writable: true })
}

async function waitForAcknowledgement(status: Duplex, acknowledgement: Duplex, descendantReady: Duplex, structural: { type: "provider-structural"; leaderPid: number; descendantPid: number }, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let registered = false
    let ready = false
    let buffer = ""
    let readinessBuffer = ""
    const timer = setTimeout(() => finish(new Error(registered ? "provider descendant readiness timed out" : "provider acknowledgement timed out")), timeoutMs)
    const releaseAcknowledgement = (): void => {
      acknowledgement.off("data", received)
      acknowledgement.off("error", failed)
      acknowledgement.off("end", lost)
      acknowledgement.off("close", lost)
    }
    const releaseReadiness = (): void => {
      descendantReady.off("data", initialized)
      descendantReady.off("error", failed)
      descendantReady.off("end", readinessLost)
      descendantReady.off("close", readinessLost)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      status.off("error", failed)
      status.off("close", lost)
      releaseAcknowledgement()
      releaseReadiness()
      if (error === undefined) resolve()
      else reject(error)
    }
    const failed = (error: Error): void => finish(error)
    const lost = (): void => finish(new Error("provider acknowledgement path closed"))
    const readinessLost = (): void => finish(new Error("provider descendant readiness path closed"))
    const received = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      if (buffer === "registered\n") {
        registered = true
        releaseAcknowledgement()
        if (ready) finish()
      }
      else if (buffer.includes("\n") || Buffer.byteLength(buffer, "utf8") > 1024) finish(new Error("provider acknowledgement is invalid"))
    }
    const initialized = (chunk: Buffer | string): void => {
      readinessBuffer += chunk.toString()
      if (readinessBuffer === "ready\n") {
        ready = true
        releaseReadiness()
        if (registered) finish()
      }
      else if (readinessBuffer.includes("\n") || Buffer.byteLength(readinessBuffer, "utf8") > 1024) finish(new Error("provider descendant readiness is invalid"))
    }
    status.once("error", failed)
    status.once("close", lost)
    acknowledgement.on("data", received)
    acknowledgement.once("error", failed)
    acknowledgement.once("end", lost)
    acknowledgement.once("close", lost)
    descendantReady.on("data", initialized)
    descendantReady.once("error", failed)
    descendantReady.once("end", readinessLost)
    descendantReady.once("close", readinessLost)
    status.write(`${JSON.stringify(structural)}\n`, error => {
      if (error !== null && error !== undefined) finish(error)
    })
  })
}

async function publishBeforeMissingAcknowledgementFailure(status: Duplex, structural: { type: "provider-structural"; leaderPid: number; descendantPid: number }, timeoutMs: number): Promise<void> {
  await new Promise<void>(resolve => {
    let settled = false
    const timer = setTimeout(finish, timeoutMs)
    function finish(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      status.off("error", finish)
      status.off("end", finish)
      status.off("close", finish)
      resolve()
    }
    status.once("error", finish)
    status.once("end", finish)
    status.once("close", finish)
    status.write(`${JSON.stringify(structural)}\n`, error => {
      if (error !== null && error !== undefined) finish()
    })
  })
}

export async function stopDescendant(descendant: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (descendant.exitCode !== null || descendant.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error("provider-tree descendant did not exit"))
    }, timeoutMs)
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      descendant.off("exit", exited)
      descendant.off("error", failed)
      if (error === undefined) resolve()
      else reject(error)
    }
    const exited = (): void => finish()
    const failed = (error: Error): void => finish(new Error("provider-tree descendant SIGKILL delivery failed", { cause: error }))
    descendant.once("exit", exited)
    descendant.once("error", failed)
    try {
      if (!descendant.kill("SIGKILL")) finish(new Error("provider-tree descendant SIGKILL delivery was rejected"))
    } catch (error) {
      finish(error instanceof Error ? error : new Error("provider-tree descendant SIGKILL delivery threw"))
    }
  })
}

export async function leader(readyPath: string, providerMode: ProviderMode, timeoutMs: number, dependencies?: { spawnDescendant: () => ReturnType<typeof spawn>; socketForFd: (fd: number) => Duplex; readyFileSystem?: ReadyFileSystem }): Promise<never> {
  const fixturePath = process.argv[1]
  if (fixturePath === undefined) throw new Error("provider-tree fixture path is unavailable")
  const descendant = dependencies?.spawnDescendant() ?? spawn(process.execPath, [fixturePath, "descendant", providerMode], { stdio: ["ignore", "ignore", "ignore", "pipe"] })
  const openSocket = dependencies?.socketForFd ?? socketForFd
  let status: Duplex | undefined
  let acknowledgement: Duplex | undefined
  const releases: Array<() => void> = []
  const protect = (socket: Duplex): Duplex => {
    let released = false
    let closeObserved = false
    const failed = (): void => undefined
    const closed = (): void => {
      closeObserved = true
      if (!released) return
      socket.off("error", failed)
      socket.off("close", closed)
    }
    socket.on("error", failed)
    socket.once("close", closed)
    releases.push(() => {
      released = true
      socket.destroy()
      if (closeObserved) closed()
    })
    return socket
  }
  try {
    if (descendant.pid === undefined) throw new Error("provider-tree descendant pid is unavailable")
    status = protect(openSocket(3))
    const structural = { type: "provider-structural" as const, leaderPid: process.pid, descendantPid: descendant.pid }
    try {
      acknowledgement = protect(openSocket(4))
    } catch (error) {
      await publishBeforeMissingAcknowledgementFailure(status, structural, timeoutMs)
      throw error
    }
    const descendantReady = descendant.stdio[3]
    if (descendantReady === null || descendantReady === undefined) throw new Error("provider descendant readiness descriptor is unavailable")
    await waitForAcknowledgement(status, acknowledgement, protect(descendantReady as Duplex), structural, timeoutMs)
    if (providerMode === "leader-exits-on-term") process.once("SIGTERM", () => process.exit(0))
    await withPrivateUmask(() => publishReady(readyPath, JSON.stringify({ leaderPid: process.pid, descendantPid: descendant.pid }), dependencies?.readyFileSystem))
  } catch (error) {
    await stopDescendant(descendant, timeoutMs)
    throw error
  } finally {
    for (const release of releases) release()
  }
  return wait()
}

async function descendant(providerMode: ProviderMode): Promise<never> {
  if (providerMode === "leader-exits-on-term") process.on("SIGTERM", () => undefined)
  const ready = socketForFd(3)
  ready.once("error", () => process.exit(1))
  ready.end("ready\n", () => ready.destroy())
  return wait()
}

async function main(): Promise<void> {
  const role = process.argv[2]
  if (role === "leader" && process.argv.length === 6) await leader(process.argv[3]!, mode(process.argv[4]), timeout(process.argv[5]))
  else if (role === "descendant" && process.argv.length === 4) await descendant(mode(process.argv[3]))
  else throw new Error("usage: provider-tree <leader ready-path mode timeout-ms|descendant mode>")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()