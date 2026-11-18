import type { HostEnrollment } from "./inventory.js"
import { parseRosterRow, type RosterRow } from "../live/roster.js"

export type RemoteHost = { hostId: string; hostname: string; state: "connecting" | "online" | "offline" | "outdated"; since: number | null; handlerGeneration: string | null; agents: RosterRow[]; error: string | null }
type Entry = { host: RemoteHost; stopped: boolean }

export function createRemoteRosters(input: {
  list(): Promise<HostEnrollment[]>
  wait(hostId: string, after: string | null, waitMs: number): Promise<string>
  read(hostId: string): Promise<{ handlerGeneration: string; agents: RosterRow[] }>
  intervalMs?: number
  waitMs?: number
  refreshMs?: number
  backoffMs?: number
  maxBackoffMs?: number
}): { hosts(): RemoteHost[]; close(): void } {
  const intervalMs = input.intervalMs ?? 5000, waitMs = input.waitMs ?? 8000, refreshMs = input.refreshMs ?? 60000
  const backoffMs = input.backoffMs ?? 5000, maxBackoffMs = input.maxBackoffMs ?? 300000
  const entries = new Map<string, Entry>()
  let closed = false, timer: NodeJS.Timeout | undefined
  const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref() })
  const gone = (entry: Entry) => closed || entry.stopped
  async function run(entry: Entry): Promise<void> {
    let after: string | null = null, readAt = 0, failures = 0
    while (!gone(entry)) {
      try {
        const revision = await input.wait(entry.host.hostId, after, waitMs)
        if (gone(entry)) return
        if (revision !== after || Date.now() - readAt >= refreshMs) {
          const list = await input.read(entry.host.hostId)
          if (gone(entry)) return
          let agents: RosterRow[]
          try { agents = list.agents.map(parseRosterRow) } catch { throw new Error("INVALID_HOST_REPLY") }
          entry.host = { ...entry.host, handlerGeneration: list.handlerGeneration, agents }
          readAt = Date.now()
        }
        entry.host = { ...entry.host, state: "online", since: null, error: null }
        after = revision
        failures = 0
      } catch (error) {
        if (gone(entry)) return
        const message = error instanceof Error ? error.message : String(error)
        after = null
        if (message === "UNSUPPORTED_CAPABILITY") {
          entry.host = { ...entry.host, state: "outdated", since: null, error: message }
          await sleep(maxBackoffMs)
          continue
        }
        failures++
        entry.host = { ...entry.host, state: "offline", since: entry.host.state === "offline" ? entry.host.since : Date.now(), error: message }
        await sleep(Math.min(backoffMs * 2 ** (failures - 1), maxBackoffMs))
      }
    }
  }
  async function tick(): Promise<void> {
    if (closed) return
    try {
      const listed = await input.list()
      if (closed) return
      const enrolled = new Set(listed.map(host => host.hostId))
      for (const [hostId, entry] of entries) if (!enrolled.has(hostId)) { entry.stopped = true; entries.delete(hostId) }
      for (const enrollment of listed) {
        if (entries.has(enrollment.hostId)) continue
        const entry: Entry = { host: { hostId: enrollment.hostId, hostname: enrollment.hostname, state: "connecting", since: null, handlerGeneration: null, agents: [], error: null }, stopped: false }
        entries.set(enrollment.hostId, entry)
        void run(entry)
      }
    } catch {}
    if (!closed) { timer = setTimeout(() => void tick(), intervalMs); timer.unref() }
  }
  void tick()
  return {
    hosts: () => [...entries.values()].map(entry => structuredClone(entry.host)).sort((a, b) => a.hostname.localeCompare(b.hostname)),
    close() { closed = true; if (timer) clearTimeout(timer) },
  }
}