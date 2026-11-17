import { appendFileSync, writeFileSync } from "node:fs"
import { appendFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"

export type LoggedEvent = { type: string; agentId?: string } & Record<string, unknown>
export type EventLog = { append(event: LoggedEvent): void; appendSync(event: LoggedEvent): void; flush(): Promise<void>; lastSequence(): number }

async function readEnd(path: string): Promise<{ seq: number; endsWithNewline: boolean; size: number }> {
  let handle
  try {
    handle = await open(path, "r")
    const { size } = await handle.stat(), length = Math.min(size, 65536), buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const text = buffer.toString("utf8")
    for (const line of text.split("\n").reverse()) {
      try { const seq = JSON.parse(line).seq; if (Number.isSafeInteger(seq)) return { seq, endsWithNewline: text.endsWith("\n"), size } } catch {}
    }
    return { seq: 0, endsWithNewline: size === 0 || text.endsWith("\n"), size }
  } catch { return { seq: 0, endsWithNewline: true, size: 0 } } finally { await handle?.close() }
}

export async function openEventLog(input: { root: string; hostId: string; maxBytes?: number; keep?: number; now?: () => Date }): Promise<EventLog> {
  const path = join(input.root, "events.jsonl"), maxBytes = input.maxBytes ?? 10 * 1024 * 1024, keep = input.keep ?? 5, now = input.now ?? (() => new Date())
  const end = await readEnd(path)
  let seq = end.seq || (await readEnd(join(input.root, "events.1.jsonl"))).seq
  let chain: Promise<void> = mkdir(input.root, { recursive: true, mode: 0o700 }).then(() => end.size > 0 && !end.endsWithNewline ? appendFile(path, "\n") : undefined).then(() => undefined, () => undefined)
  const line = (event: LoggedEvent): string => {
    const { seq: _seq, at: _at, host: _host, ...rest } = event
    return JSON.stringify({ seq: ++seq, at: now().toISOString(), host: input.hostId, ...rest }) + "\n"
  }
  async function rotate(): Promise<void> {
    const size = await stat(path).then(info => info.size, () => 0)
    if (size < maxBytes) return
    await rm(join(input.root, `events.${keep}.jsonl`), { force: true })
    for (let index = keep - 1; index >= 1; index--) await rename(join(input.root, `events.${index}.jsonl`), join(input.root, `events.${index + 1}.jsonl`)).catch(() => undefined)
    await rename(path, join(input.root, "events.1.jsonl"))
  }
  return {
    append(event) {
      const text = line(event)
      chain = chain.then(async () => { await rotate(); await appendFile(path, text, { mode: 0o600 }) }).catch(() => undefined)
    },
    appendSync(event) { try { appendFileSync(path, line(event), { mode: 0o600 }) } catch {} },
    flush: () => chain,
    lastSequence: () => seq,
  }
}

export async function consumeCleanShutdown(root: string): Promise<boolean> {
  try { await rm(join(root, "clean-shutdown")); return true } catch { return false }
}

export function markCleanShutdownSync(root: string): void {
  try { writeFileSync(join(root, "clean-shutdown"), new Date().toISOString(), { mode: 0o600 }) } catch {}
}

export async function readEventLog(root: string, filter: { agentId?: string; since?: string; limit?: number } = {}, keep = 5): Promise<Array<LoggedEvent & { seq: number; at: string; host: string }>> {
  const events: Array<LoggedEvent & { seq: number; at: string; host: string }> = []
  for (const name of [...Array.from({ length: keep }, (_, index) => `events.${keep - index}.jsonl`), "events.jsonl"]) {
    let text: string
    try { text = await readFile(join(root, name), "utf8") } catch { continue }
    for (const line of text.split("\n")) {
      try {
        const event = JSON.parse(line)
        if (!Number.isSafeInteger(event?.seq) || typeof event.at !== "string" || typeof event.type !== "string") continue
        if (filter.agentId && event.agentId !== filter.agentId || filter.since && event.at < filter.since) continue
        events.push(event)
      } catch {}
    }
  }
  return events.slice(-(filter.limit ?? 200))
}