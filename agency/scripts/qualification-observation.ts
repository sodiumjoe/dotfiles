import { isDeepStrictEqual } from "node:util"
import { sameProcessGeneration, type PlatformAdapter, type ProcessGroupIdentity, type ProcessIdentity } from "../src/platform/types.js"

export type ProcessAbsenceEvidence = {
  identity: ProcessGroupIdentity
  startedAt: number
  endedAt: number
  outcome: "absent" | "present" | "unavailable"
  group: ProcessIdentity[] | null
  processes: Array<{ identity: ProcessIdentity; observed: ProcessIdentity | null }>
}
export type QualificationAbsence = { first: ProcessAbsenceEvidence | null; second: ProcessAbsenceEvidence | null }
export const ABSENCE_SEPARATION_MS = 25

export function exactKeys(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error("invalid evidence")
  return value as Record<string, unknown>
}
export function parseProcessIdentity(value: unknown): ProcessIdentity {
  const v = exactKeys(value, ["bootId", "pid", "birth", "parentPid", "processGroupId", "sessionId", "uid", "gid"])
  for (const key of ["bootId", "birth"]) if (typeof v[key] !== "string" || !(v[key] as string).length || (v[key] as string).length > 1024 || /[\x00-\x1f]/.test(v[key] as string)) throw new Error("invalid identity")
  if (!/^[0-9]+:.+/.test(v.birth as string)) throw new Error("invalid birth")
  for (const key of ["pid", "parentPid", "processGroupId", "sessionId", "uid", "gid"]) if (!Number.isSafeInteger(v[key]) || (v[key] as number) < (["pid", "processGroupId", "sessionId"].includes(key) ? 1 : 0)) throw new Error("invalid identity")
  return structuredClone(v) as ProcessIdentity
}
export function parseGroupIdentity(value: unknown): ProcessGroupIdentity {
  const v = exactKeys(value, ["leader", "observed"]), leader = parseProcessIdentity(v.leader)
  if (!Array.isArray(v.observed) || v.observed.length < 1 || v.observed.length > 4096) throw new Error("invalid group")
  const observed = v.observed.map(parseProcessIdentity)
  if (leader.pid !== leader.processGroupId || leader.pid !== leader.sessionId || new Set(observed.map(p => p.pid)).size !== observed.length || !observed.some(p => isDeepStrictEqual(p, leader))) throw new Error("invalid group")
  if (observed.some(p => p.bootId !== leader.bootId || p.processGroupId !== leader.pid || p.sessionId !== leader.pid || p.uid !== leader.uid || p.gid !== leader.gid)) throw new Error("invalid group")
  return { leader, observed }
}
export function parseAbsence(value: unknown, expected: ProcessGroupIdentity): QualificationAbsence {
  const v = exactKeys(value, ["first", "second"])
  const pass = (value: unknown): ProcessAbsenceEvidence | null => {
    if (value === null) return null
    const p = exactKeys(value, ["identity", "startedAt", "endedAt", "outcome", "group", "processes"])
    if (!isDeepStrictEqual(parseGroupIdentity(p.identity), expected)) throw new Error("substituted identity")
    if (!Number.isSafeInteger(p.startedAt) || !Number.isSafeInteger(p.endedAt) || (p.startedAt as number) < 0 || (p.endedAt as number) < (p.startedAt as number)) throw new Error("invalid observation time")
    if (!["absent", "present", "unavailable"].includes(p.outcome as string) || !Array.isArray(p.processes) || p.processes.length > expected.observed.length) throw new Error("invalid absence")
    const processes = p.processes.map((entry, index) => {
      const item = exactKeys(entry, ["identity", "observed"]), identity = parseProcessIdentity(item.identity), observed = item.observed === null ? null : parseProcessIdentity(item.observed)
      if (!isDeepStrictEqual(identity, expected.observed[index])) throw new Error("missing or substituted target")
      return { identity, observed }
    })
    if (p.group !== null && (!Array.isArray(p.group) || p.group.length > 4096)) throw new Error("invalid group observation")
    const group = p.group === null ? null : (p.group as unknown[]).map(parseProcessIdentity)
    if (p.outcome === "absent" && (group === null || group.length || processes.length !== expected.observed.length || processes.some(p => p.observed !== null && sameProcessGeneration(p.identity, p.observed)))) throw new Error("unproven absence")
    return { identity: structuredClone(expected), startedAt: p.startedAt as number, endedAt: p.endedAt as number, outcome: p.outcome as ProcessAbsenceEvidence["outcome"], group, processes }
  }
  const first = pass(v.first), second = pass(v.second)
  if (second && (!first || second.startedAt < first.endedAt + ABSENCE_SEPARATION_MS)) throw new Error("unseparated observations")
  return { first, second }
}
export async function verifyQualificationAbsence(adapter: Pick<PlatformAdapter, "readProcess" | "readGroup">, input: ProcessGroupIdentity, limitMs: number): Promise<QualificationAbsence> {
  const identity = parseGroupIdentity(input), deadline = performance.now() + limitMs
  const result: QualificationAbsence = { first: null, second: null }
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error("absence timeout")
    let timer: NodeJS.Timeout | undefined
    try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("absence timeout")), remaining) })]) }
    finally { clearTimeout(timer) }
  }
  for (const key of ["first", "second"] as const) {
    if (performance.now() >= deadline) break
    const evidence: ProcessAbsenceEvidence = { identity: structuredClone(identity), startedAt: Date.now(), endedAt: Date.now(), outcome: "unavailable", group: null, processes: [] }
    try {
      evidence.group = await bounded(() => adapter.readGroup(identity.leader.pid))
      for (const target of identity.observed) evidence.processes.push({ identity: structuredClone(target), observed: await bounded(() => adapter.readProcess(target.pid)) })
      evidence.outcome = evidence.group.length || evidence.processes.some(p => p.observed !== null && sameProcessGeneration(p.identity, p.observed)) ? "present" : "absent"
    } catch {}
    evidence.endedAt = Date.now(); result[key] = evidence
    if (key === "first") {
      try { await bounded(() => new Promise<void>(resolve => setTimeout(resolve, ABSENCE_SEPARATION_MS + 1))) } catch { break }
    }
  }
  return result
}