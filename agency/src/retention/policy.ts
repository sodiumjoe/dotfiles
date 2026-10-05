export type RetentionNode = { path: string; references: readonly string[]; retained: boolean; removable: boolean }
export type RetentionPins = { paths: readonly string[] }
export const FAILED_START_TTL_MS = 604800000

export function expiredFailure(now: number, terminalTimes: readonly number[]): boolean {
  if (!Number.isFinite(now) || now < 0 || terminalTimes.length === 0) return false
  if (terminalTimes.some(time => !Number.isFinite(time) || time < 0 || time > now)) return false
  const latest = terminalTimes.reduce((maximum, time) => Math.max(maximum, time), 0)
  return now - latest >= FAILED_START_TTL_MS
}

export function reclaimable(nodes: readonly RetentionNode[], pins: readonly string[]): string[] {
  const indexed = new Map(nodes.map(node => [node.path, node]))
  if (indexed.size !== nodes.length) throw new Error("duplicate retention path")
  for (const node of nodes) for (const path of node.references) if (!indexed.has(path)) throw new Error("missing retention reference")
  const retained = new Set<string>()
  const pending = [...pins, ...nodes.filter(node => node.retained || !node.removable).map(node => node.path)]
  while (pending.length > 0) {
    const path = pending.pop()!, node = indexed.get(path)
    if (!node) throw new Error("missing retention pin")
    if (retained.has(path)) continue
    retained.add(path)
    pending.push(...node.references)
  }
  return nodes.filter(node => node.removable && !retained.has(node.path)).map(node => node.path).sort()
}