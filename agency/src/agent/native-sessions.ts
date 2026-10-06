import { constants } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { absolutePath, CatalogError, object, text } from "../catalog/types.js"
import { AgentError } from "./types.js"

export type NativeSession = { backendId: "codex-acp"; nativeSessionId: string; cwd: string; title: string | null; updatedAt: string | null }
export function nativeSessionId(value: unknown): string {
  const result = text(value, 1024)
  if (result.startsWith("agency:")) throw new AgentError("INVALID_AGENT_STATE")
  return result
}

export async function discoverCodexSessions(root: string): Promise<NativeSession[]> {
  absolutePath(root)
  const found = new Map<string, NativeSession>(), conflicts = new Set<string>()
  let entries = 0
  async function visit(path: string, depth: number): Promise<void> {
    let stat
    try { stat = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      if (depth > 3) return
      for (const entry of (await readdir(path)).sort()) {
        if (++entries > 10000) throw new AgentError("INCOMPLETE")
        await visit(join(path, entry), depth + 1)
      }
      return
    }
    if (!stat.isFile() || !path.endsWith(".jsonl")) return
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const current = await handle.stat()
      if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) return
      const buffer = Buffer.alloc(65537)
      let length = 0, newline = -1
      while (length < buffer.length && newline < 0) {
        const read = await handle.read(buffer, length, Math.min(4096, buffer.length - length), length)
        if (!read.bytesRead) break
        const end = length + read.bytesRead
        newline = buffer.subarray(length, end).indexOf(10)
        if (newline >= 0) newline += length
        length = end
      }
      const end = newline >= 0 ? newline : length
      if (end > 65536) return
      const line = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end))
      const record = object(JSON.parse(line)), payload = object(record.payload)
      if (record.type !== "session_meta") return
      const session: NativeSession = { backendId: "codex-acp", nativeSessionId: nativeSessionId(payload.id), cwd: absolutePath(payload.cwd), title: typeof payload.title === "string" ? text(payload.title, 1024) : null, updatedAt: current.mtime.toISOString() }
      const prior = found.get(session.nativeSessionId)
      if (prior && prior.cwd !== session.cwd) conflicts.add(session.nativeSessionId)
      else if (!prior || session.updatedAt! > prior.updatedAt!) found.set(session.nativeSessionId, session)
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof CatalogError || error instanceof AgentError && error.code === "INVALID_AGENT_STATE" || ["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return
      throw error
    } finally { await handle?.close() }
  }
  await visit(root, 0)
  return [...found.values()].filter(value => !conflicts.has(value.nativeSessionId)).sort((a, b) => a.nativeSessionId.localeCompare(b.nativeSessionId))
}