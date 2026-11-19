import { execFile } from "node:child_process"
import type { RosterRow } from "../live/roster.js"

export type AttentionHost = { hostId: string; label: string; agents: RosterRow[] }

export function createAttentionNotifier(input: { notify(title: string, message: string): void }): { observe(hosts: AttentionHost[]): void } {
  const announced = new Map<string, number>()
  return {
    observe(hosts) {
      const seen = new Set<string>()
      for (const host of hosts) for (const row of host.agents) {
        if (!row.live) continue
        const key = host.hostId + ":" + row.agentId + ":" + row.live.providerGeneration, count = row.live.pendingApprovals
        seen.add(key)
        if (count > (announced.get(key) ?? 0) && row.live.editors === 0) {
          try { input.notify("Agency", (row.title ?? "Agent " + row.agentId.slice(0, 8)) + " on " + host.label + " needs approval") } catch {}
        }
        announced.set(key, count)
      }
      for (const key of [...announced.keys()]) if (!seen.has(key)) announced.delete(key)
    },
  }
}

export function appleScriptString(value: string): string {
  return '"' + value.replace(/[\p{Cc}]/gu, " ").replace(/[\\"]/g, match => "\\" + match) + '"'
}

export function macNotify(title: string, message: string): void {
  execFile("osascript", ["-e", "display notification " + appleScriptString(message) + " with title " + appleScriptString(title)], { timeout: 5000 }, () => {})
}