import { execFile } from "node:child_process"
import { isDeepStrictEqual, promisify } from "node:util"
import { sameProcess, sameProcessGeneration, type PlatformAdapter, type ProcessGroupIdentity, type ProcessIdentity } from "../src/platform/types.js"

export type DescriptorCommand = (file: string, args: readonly string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>
export type DescriptorEvidence = { process: ProcessIdentity; role: "handler" | "adapter" | "child"; descriptors: { fd: number; type: string; allowed: boolean }[] }
export type DescriptorObservation = { outcome: "verified" | "leaked"; durationMs: number; processes: DescriptorEvidence[] }
export type ParentAbsence = { limitMs: number; durationMs: number; outcome: "completed" | "timed_out" | "failed"; passes: number; targets: ProcessIdentity[]; groups: number[]; handler: "absent" | "present" | "unknown"; provider: "absent" | "present" | "unknown" }
export class QualificationObservationError extends Error { readonly code = "DESCRIPTOR_UNAVAILABLE" }
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
function unavailable(): never { throw new QualificationObservationError("descriptor observation unavailable") }
function unique(values: readonly ProcessIdentity[]): ProcessIdentity[] {
  const result: ProcessIdentity[] = []
  for (const p of values) { const previous = result.find(v => v.pid === p.pid); if (previous && !sameProcess(previous, p)) throw new Error("conflicting process identities"); if (!previous) result.push(structuredClone(p)) }
  return result
}
const runDescriptorCommand: DescriptorCommand = async (file, args, options) => promisify(execFile)(file, args, { ...options, encoding: "utf8", killSignal: "SIGKILL" })
function parseDescriptors(raw: string, pid: number, role: DescriptorEvidence["role"]): DescriptorEvidence["descriptors"] {
  if (!raw.length || Buffer.byteLength(raw) > 65536 || !raw.endsWith("\0\n")) unavailable()
  const lines = raw.split("\n").filter(Boolean)
  if (lines.shift() !== `p${pid}\0` || lines.length > 256) unavailable()
  const descriptors: DescriptorEvidence["descriptors"] = []
  for (const line of lines) {
    if (!line.endsWith("\0")) unavailable()
    const fields = line.slice(0, -1).split("\0"), values = new Map<string, string>()
    for (const field of fields) { if (!["f", "t", "n"].includes(field[0]!) || values.has(field[0]!)) unavailable(); values.set(field[0]!, field.slice(1)) }
    const fdText = values.get("f"), type = values.get("t"), name = values.get("n")
    if (!fdText || !type || name === undefined || !["REG", "DIR", "PIPE", "unix", "CHR", "KQUEUE", "IPv4", "IPv6", "PSXSEM", "PSXSHM"].includes(type)) unavailable()
    if (["cwd", "rtd", "txt", "mem"].includes(fdText)) continue
    if (!/^(0|[1-9][0-9]{0,5})$/.test(fdText)) unavailable()
    const fd = Number(fdText)
    if (descriptors.some(value => value.fd === fd)) unavailable()
    const piped = type === "PIPE" || type === "unix"
    const allowed = fd <= 2 ? piped || role === "handler" && type === "CHR" && name === "/dev/null" : role === "handler" && fd <= 4 && piped
    descriptors.push({ fd, type, allowed })
  }
  if ([0, 1, 2].some(fd => !descriptors.some(value => value.fd === fd))) unavailable()
  return descriptors.sort((a, b) => a.fd - b.fd)
}
export async function observeQualificationDescriptors(adapter: PlatformAdapter, handlers: readonly ProcessIdentity[], provider: ProcessGroupIdentity, limitMs: number, command: DescriptorCommand = runDescriptorCommand): Promise<DescriptorObservation> {
  const deadline = new Deadline(limitMs)
  try {
    const members = await deadline.read(() => adapter.readGroup(provider.leader.processGroupId))
    if (members.length < 2 || members.length > 4096 || new Set(members.map(p => p.pid)).size !== members.length || provider.observed.some(p => !members.some(current => isDeepStrictEqual(p, current))) || !members.some(p => isDeepStrictEqual(p, provider.leader))) unavailable()
    for (const member of members) {
      if (member.bootId !== provider.leader.bootId || member.processGroupId !== provider.leader.pid || member.sessionId !== provider.leader.pid || member.uid !== provider.leader.uid || member.gid !== provider.leader.gid) unavailable()
      let current = member, visited = new Set<number>()
      while (current.pid !== provider.leader.pid) { if (visited.has(current.pid)) unavailable(); visited.add(current.pid); const parent = members.find(p => p.pid === current.parentPid); if (!parent) unavailable(); current = parent }
    }
    const targets = [...handlers.map(process => ({ process, role: "handler" as const })), ...members.map(process => ({ process, role: process.pid === provider.leader.pid ? "adapter" as const : "child" as const }))]
    if (unique(targets.map(t => t.process)).length !== targets.length) unavailable()
    const processes: DescriptorEvidence[] = []
    for (const target of targets) {
      const before = await deadline.read(() => adapter.readProcess(target.process.pid))
      if (!before || !isDeepStrictEqual(target.process, before)) unavailable()
      const result = await deadline.read(() => command("/usr/sbin/lsof", ["-nP", "-a", "-p", String(target.process.pid), "-F0pftn"], { timeout: Math.max(1, Math.floor(deadline.remaining())), maxBuffer: 65536, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }))
      if (result.stderr) unavailable()
      const descriptors = parseDescriptors(result.stdout, target.process.pid, target.role)
      const after = await deadline.read(() => adapter.readProcess(target.process.pid))
      if (!after || !isDeepStrictEqual(target.process, after)) unavailable()
      processes.push({ process: structuredClone(target.process), role: target.role, descriptors })
    }
    const after = await deadline.read(() => adapter.readGroup(provider.leader.processGroupId))
    if (after.length !== members.length || members.some(p => !after.some(current => isDeepStrictEqual(p, current)))) unavailable()
    return { outcome: processes.every(p => p.descriptors.every(d => d.allowed)) ? "verified" : "leaked", durationMs: performance.now() - deadline.started, processes }
  } catch { return unavailable() }
}
export async function verifyQualificationAbsence(adapter: Pick<PlatformAdapter, "readProcess" | "readGroup">, handlers: readonly ProcessIdentity[], provider: ProcessGroupIdentity | null, additional: readonly ProcessIdentity[], limitMs: number): Promise<ParentAbsence> {
  const deadline = new Deadline(limitMs), targets = unique([...handlers, ...(provider ? [provider.leader, ...provider.observed] : []), ...additional])
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