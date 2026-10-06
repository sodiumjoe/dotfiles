import { chmod, lstat, realpath, unlink } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { isAbsolute, join, sep } from "node:path"
import { assertPrivateDirectory } from "./private-state.js"
import type { HandlerInspection } from "./types.js"

const MAX_SOCKET_PATH_BYTES = 99

function currentUid(): number {
  if (process.getuid === undefined) throw new Error("private sockets require a POSIX platform")
  return process.getuid()
}

function socketPath(root: string, name: string): string {
  if (name.length === 0 || name === "." || name === ".." || isAbsolute(name) || name.includes(sep) || name.includes("/") || name.includes("\\")) throw new Error("socket name must be one path component")
  const path = join(root, name)
  if (Buffer.byteLength(path, "utf8") > MAX_SOCKET_PATH_BYTES) throw new Error("socket path exceeds the Darwin-safe length bound")
  return path
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true
    throw error
  }
}

export async function assertPrivateSocket(root: string, name: string): Promise<string> {
  await assertPrivateDirectory(root)
  const path = socketPath(root, name)
  const stats = await lstat(path)
  if (stats.isSymbolicLink()) throw new Error(`${path} is a symlink`)
  if (!stats.isSocket()) throw new Error(`${path} is not a socket`)
  if (stats.uid !== currentUid()) throw new Error(`${path} has the wrong owner`)
  if ((stats.mode & 0o077) !== 0) throw new Error(`${path} is not private`)
  if (await realpath(root) !== root) throw new Error(`${root} is not canonical`)
  return path
}

export async function bindPrivateSocket(root: string, name: string, connectionListener?: (socket: Socket) => void): Promise<Server> {
  await assertPrivateDirectory(root)
  const path = socketPath(root, name)
  if (!await missing(path)) {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new Error(`${path} is a symlink`)
    throw new Error(`${path} already exists`)
  }
  const server = createServer(connectionListener)
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => {
        server.off("listening", listening)
        reject(error)
      }
      const listening = (): void => {
        server.off("error", failed)
        resolve()
      }
      server.once("error", failed)
      server.once("listening", listening)
      server.listen(path)
    })
    await chmod(path, 0o600)
    await assertPrivateSocket(root, name)
    return server
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()))
    throw error
  }
}

export async function unlinkStalePrivateSocket(root: string, name: string, inspection: HandlerInspection): Promise<void> {
  await assertPrivateDirectory(root)
  const path = socketPath(root, name)
  if (inspection.disposition !== "stale") throw new Error("only a proven stale generation authorizes socket removal")
  const companion = name === "attachment.sock" || name === "acp.sock"
  if (inspection.record.socketPath !== (companion ? socketPath(root, "handler.sock") : path)) throw new Error("stale generation socket is outside the qualified root")
  if (await missing(path)) return
  const stats = await lstat(path)
  if (stats.isSymbolicLink()) throw new Error(`${path} is a symlink`)
  if (!stats.isSocket()) throw new Error(`${path} is not a socket`)
  if (stats.uid !== currentUid()) throw new Error(`${path} has the wrong owner`)
  if (companion) await assertPrivateSocket(root, name)
  await unlink(path)
}