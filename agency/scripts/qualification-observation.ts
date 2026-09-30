import { isDeepStrictEqual } from "node:util"
import { sameProcess, sameProcessGeneration, type PlatformAdapter, type ProcessGroupIdentity, type ProcessIdentity } from "../src/platform/types.js"

export type ParentAbsence = { limitMs: number; durationMs: number; outcome: "completed" | "timed_out" | "failed"; passes: number; targets: ProcessIdentity[]; groups: number[]; handler: "absent" | "present" | "unknown"; provider: "absent" | "present" | "unknown" }
class DeadlineExpired extends Error {}
class Deadline {
  readonly started = performance.now()
  constructor(readonly limitMs: number) { if (!Number.isFinite(limitMs) || limitMs <= 0) throw new DeadlineExpired() }
  remaining(): number { const remaining = this.started + this.limitMs - performance.now(); if (remaining <= 0) throw new DeadlineExpired(); return remaining }
  async read<T>(operation: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      const remaining = this.remaining()
      const value = await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineExpired()), Math.ceil(remaining)) })])
      this.remaining(); return value
    } finally { clearTimeout(timer) }
  }
}
function unique(values: readonly ProcessIdentity[]): ProcessIdentity[] {
  const result: ProcessIdentity[] = []
  for (const p of values) { const previous = result.find(v => v.pid === p.pid); if (previous && !sameProcess(previous, p)) throw new Error("conflicting process identities"); if (!previous) result.push(structuredClone(p)) }
  return result
}
export async function verifyQualificationAbsence(adapter: Pick<PlatformAdapter, "readProcess" | "readGroup">, handlers: readonly ProcessIdentity[], provider: ProcessGroupIdentity | null, limitMs: number): Promise<ParentAbsence> {
  const deadline = new Deadline(limitMs), targets = unique([...handlers, ...(provider ? [provider.leader, ...provider.observed] : [])])
  const groups = [...new Set(targets.map(p => p.processGroupId))].sort((a, b) => a - b)
  const result: ParentAbsence = { limitMs, durationMs: 0, outcome: "failed", passes: 0, targets, groups, handler: "unknown", provider: "unknown" }
  let handlerPresent = false, providerPresent = false
  const readProcesses = async (): Promise<Array<ProcessIdentity | null>> => {
    const observations: Array<ProcessIdentity | null> = []
    for (let index = 0; index < targets.length; index += 8) observations.push(...await Promise.all(targets.slice(index, index + 8).map(p => deadline.read(() => adapter.readProcess(p.pid)))))
    return observations
  }
  try {
    for (let pass = 0; pass < 2; pass++) {
      const [observedGroups, observedProcesses] = await Promise.all([
        Promise.all(groups.map(group => deadline.read(() => adapter.readGroup(group)))),
        readProcesses(),
      ])
      const present = targets.filter((p, i) => observedProcesses[i] !== null && sameProcessGeneration(p, observedProcesses[i]!))
      const populated = groups.filter((_, i) => observedGroups[i]!.length)
      handlerPresent ||= handlers.some(h => present.some(p => isDeepStrictEqual(h, p)) || populated.includes(h.processGroupId))
      providerPresent ||= provider !== null && (present.some(p => p.processGroupId === provider.leader.pid) || populated.includes(provider.leader.pid))
      result.passes++
    }
    result.outcome = handlerPresent || providerPresent ? "failed" : "completed"; result.handler = handlerPresent ? "present" : "absent"; result.provider = providerPresent ? "present" : "absent"
  } catch (error) { result.outcome = error instanceof DeadlineExpired ? "timed_out" : "failed" }
  finally { result.durationMs = performance.now() - deadline.started }
  return result
}