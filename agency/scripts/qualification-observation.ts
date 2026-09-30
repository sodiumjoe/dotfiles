import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { isAbsolute, normalize } from "node:path"
import { isDeepStrictEqual, promisify } from "node:util"
import { sameProcess, sameProcessGeneration, type PlatformAdapter, type ProcessGroupIdentity, type ProcessIdentity } from "../src/platform/types.js"

export type DescriptorCommand = (file: string, args: readonly string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>
export type DescriptorPurpose = "stdio" | "control" | "provider-stdio" | "runtime-pipe" | "runtime-queue" | "runtime-root" | "runtime-device" | "listener" | "provider-state" | "provider-network" | "unexpected"
export type DescriptorEvidence = { process: ProcessIdentity; role: "handler" | "adapter" | "child"; descriptors: { fd: number; type: string; allowed: boolean; purpose: DescriptorPurpose }[] }
export type DescriptorScope = { handlerSocketPath: string; providerStateRoot: string }
type Descriptor = { fd: number; type: string; name: string; device?: string; flags?: string; protocol?: string; state?: string }
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
function parseDescriptors(raw: string, pid: number): Descriptor[] {
  if (!raw.length || Buffer.byteLength(raw) > 65536 || !raw.endsWith("\0\n")) unavailable()
  const lines = raw.split("\n").filter(Boolean)
  if (lines.shift() !== `p${pid}\0` || lines.length > 256) unavailable()
  const descriptors: Descriptor[] = []
  for (const line of lines) {
    if (!line.endsWith("\0")) unavailable()
    const fields = line.slice(0, -1).split("\0"), values = new Map<string, string>()
    for (const field of fields) { const key = field[0] === "T" ? field.slice(0, field.indexOf("=")) : field[0]!; if (!["f", "t", "n", "d", "G", "P", "TST", "TQR", "TQS"].includes(key) || values.has(key)) unavailable(); values.set(key, field.slice(key.length + (key.startsWith("T") ? 1 : 0))) }
    const fdText = values.get("f"), type = values.get("t"), name = values.get("n")
    if (!fdText || !type || name === undefined || !["REG", "DIR", "PIPE", "unix", "CHR", "KQUEUE", "IPv4", "IPv6", "PSXSEM", "PSXSHM"].includes(type)) unavailable()
    if (["cwd", "rtd", "txt", "mem"].includes(fdText)) continue
    if (!/^(0|[1-9][0-9]{0,5})$/.test(fdText)) unavailable()
    const fd = Number(fdText)
    if (descriptors.some(value => value.fd === fd)) unavailable()
    descriptors.push({ fd, type, name, ...(values.has("d") ? { device: values.get("d")! } : {}), ...(values.has("G") ? { flags: values.get("G")! } : {}), ...(values.has("P") ? { protocol: values.get("P")! } : {}), ...(values.has("TST") ? { state: values.get("TST")! } : {}) })
  }
  if ([0, 1, 2].some(fd => !descriptors.some(value => value.fd === fd))) unavailable()
  return descriptors.sort((a, b) => a.fd - b.fd)
}
export function descriptorPurposeValid(fd: number, type: string, purpose: string, role: DescriptorEvidence["role"]): boolean {
  const pipe = type === "PIPE" || type === "unix"
  if (purpose === "unexpected") return true
  if (purpose === "stdio") return fd <= 2 && (pipe || role === "handler" && type === "CHR")
  if (fd <= 2) return false
  if (purpose === "control") return role === "handler" && fd <= 4 && pipe
  if (purpose === "provider-stdio" || purpose === "runtime-pipe") return pipe
  if (purpose === "runtime-queue") return type === "KQUEUE"
  if (purpose === "runtime-root") return type === "DIR"
  if (purpose === "runtime-device") return type === "CHR"
  if (purpose === "listener") return role === "handler" && type === "unix"
  if (purpose === "provider-state") return role !== "handler" && (type === "REG" || type === "DIR")
  return purpose === "provider-network" && role === "child" && (type === "IPv4" || type === "IPv6")
}
export const DESCRIPTOR_LIMITS = { "runtime-queue": 3, "runtime-root": 3, "runtime-device": 2, listener: 1, "provider-state": 64, "provider-network": 16 } as const
export function descriptorLimits(role: DescriptorEvidence["role"]): Record<string, number> { return { ...DESCRIPTOR_LIMITS, "runtime-pipe": role === "handler" ? 4 : 2 } }
function connected(a: Descriptor, b: Descriptor): boolean {
  return a !== b && a.type === b.type && (a.type === "PIPE" || a.type === "unix") && /^0x[0-9a-f]+$/.test(a.device ?? "") && /^0x[0-9a-f]+$/.test(b.device ?? "") && a.name === `->${b.device}` && b.name === `->${a.device}`
}
export async function observeQualificationDescriptors(adapter: PlatformAdapter, handlers: readonly ProcessIdentity[], provider: ProcessGroupIdentity, limitMs: number, command: DescriptorCommand = runDescriptorCommand, scope?: DescriptorScope): Promise<DescriptorObservation> {
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
    const observations: Array<typeof targets[number] & { descriptors: Descriptor[] }> = []
    for (const target of targets) {
      const before = await deadline.read(() => adapter.readProcess(target.process.pid))
      if (!before || !isDeepStrictEqual(target.process, before)) unavailable()
      const result = await deadline.read(() => command("/usr/sbin/lsof", ["-nP", "-a", "-p", String(target.process.pid), "-F0pftndGPT"], { timeout: Math.max(1, Math.floor(deadline.remaining())), maxBuffer: 65536, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }))
      if (result.stderr) unavailable()
      const descriptors = parseDescriptors(result.stdout, target.process.pid)
      const after = await deadline.read(() => adapter.readProcess(target.process.pid))
      if (!after || !isDeepStrictEqual(target.process, after)) unavailable()
      observations.push({ ...target, descriptors })
    }
    for (const target of observations) {
      const descriptors: DescriptorEvidence["descriptors"] = []
      for (const fd of target.descriptors) {
        let purpose: DescriptorPurpose = "unexpected"
        const pipe = fd.type === "PIPE" || fd.type === "unix", unshared = /^0x[0-9a-f]+;0x2$/.test(fd.flags ?? "")
        if (fd.fd <= 2 && (pipe || target.role === "handler" && fd.type === "CHR" && fd.name === "/dev/null")) purpose = "stdio"
        else if (target.role === "handler" && fd.fd <= 4 && pipe && /^->0x[0-9a-f]+$/.test(fd.name)) purpose = "control"
        else if (scope && target.role === "handler" && fd.type === "unix" && fd.name === scope.handlerSocketPath) purpose = "listener"
        else if (observations.some(child => child.process.parentPid === target.process.pid && child.descriptors.some(other => other.fd <= 2 && connected(fd, other)))) purpose = "provider-stdio"
        else if (target.descriptors.some(other => connected(fd, other))) purpose = "runtime-pipe"
        else if (unshared && fd.type === "KQUEUE" && /^count=[0-9]+, state=0x[0-9a-f]+$/.test(fd.name)) purpose = "runtime-queue"
        else if (unshared && fd.type === "DIR" && fd.name === "/") purpose = "runtime-root"
        else if (unshared && fd.type === "CHR" && ["/dev/null", "/dev/urandom"].includes(fd.name)) purpose = "runtime-device"
        else if (scope && target.role !== "handler" && unshared && ["REG", "DIR"].includes(fd.type) && fd.name.startsWith(scope.providerStateRoot + "/") && isAbsolute(fd.name) && normalize(fd.name) === fd.name && await deadline.read(() => realpath(fd.name)) === fd.name) purpose = "provider-state"
        else if (target.role === "child" && unshared && ["IPv4", "IPv6"].includes(fd.type) && fd.protocol === "TCP" && fd.state === "ESTABLISHED" && /->[^\s]+:[0-9]+$/.test(fd.name)) purpose = "provider-network"
        descriptors.push({ fd: fd.fd, type: fd.type, purpose, allowed: purpose !== "unexpected" })
      }
      for (const [purpose, maximum] of Object.entries(descriptorLimits(target.role))) if (descriptors.filter(fd => fd.purpose === purpose).length > maximum) for (const fd of descriptors.filter(fd => fd.purpose === purpose)) { fd.allowed = false; fd.purpose = "unexpected" }
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