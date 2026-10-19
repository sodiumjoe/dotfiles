import { isDeepStrictEqual } from "node:util"
import { isOwnedChild, type OwnedChild, type ChildTerminal } from "../runtime/owned-child.js"
import { DarwinObservationUnavailable } from "./darwin.js"
import { LinuxObservationUnavailable } from "./linux.js"
import { exactAgencyBirth } from "./launch-marker.js"
import { processBirthStart, sameProcessGeneration, type PlatformAdapter, type ProcessIdentity, type ProcessGroupIdentity } from "./types.js"

export class LiveProcessError extends Error {
  constructor(readonly reason: "identity" | "deadline" | "signal" | "terminal" | "absence" | "abandoned") { super(reason) }
}
export type LiveCleanupEvidence = Readonly<{ launchAttemptId: string; group: ProcessGroupIdentity; terminal: ChildTerminal; transport: "closed" | "destroyed" }>
type CleanupLimits = { deadline: number; terminateMs: number; absenceMs: number; transportCloseMs: number; retry?: true }
export type LiveProcessGroup = { readonly owner: OwnedChild; identity(): ProcessGroupIdentity; cleanup(input: CleanupLimits): Promise<LiveCleanupEvidence> }
const registrations = new WeakSet<LiveProcessGroup>()
const evidence = new WeakMap<LiveCleanupEvidence, { group: LiveProcessGroup; attribution: LiveCleanupEvidence }>()
export function isLiveProcessGroup(value: LiveProcessGroup): boolean { return registrations.has(value) }
export function isLiveCleanupEvidence(value: LiveCleanupEvidence, group: LiveProcessGroup): boolean {
  const issued = evidence.get(value)
  return !!issued && issued.group === group && isDeepStrictEqual(value, issued.attribution)
}
function freezeGroup(value: ProcessGroupIdentity): ProcessGroupIdentity {
  Object.freeze(value.leader)
  for (const member of value.observed) Object.freeze(member)
  Object.freeze(value.observed)
  return Object.freeze(value)
}
function scope(owner: OwnedChild, deadline: number, now: () => number) {
  let expired = false
  const check = () => {
    if (owner.snapshot().abandoned) throw new LiveProcessError("abandoned")
    if (expired || !Number.isFinite(deadline) || now() >= deadline) throw new LiveProcessError("deadline")
  }
  const bounded = async <T>(operation: () => Promise<T>, until = deadline): Promise<T> => {
    check()
    if (!Number.isFinite(until) || now() >= until) throw new LiveProcessError("deadline")
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LiveProcessError("deadline")), Math.max(1, Math.min(deadline, until) - now()))
      })])
      check()
      if (now() >= until) throw new LiveProcessError("deadline")
      return result
    } finally { clearTimeout(timer) }
  }
  return { check, bounded, invalidate() { expired = true } }
}
function sameAuthority(expected: ProcessIdentity, current: ProcessIdentity): boolean {
  return sameProcessGeneration(expected, current) && expected.uid === current.uid && expected.gid === current.gid && expected.processGroupId === current.processGroupId && expected.sessionId === current.sessionId
}

export async function captureLiveProcess(input: { owner: OwnedChild; adapter: PlatformAdapter; launchBootId: string; marker: string; deadline: number; now?: () => number }): Promise<LiveProcessGroup> {
  const { owner, adapter, launchBootId, marker } = input, now = input.now ?? (() => performance.now())
  if (!isOwnedChild(owner)) throw new LiveProcessError("identity")
  const capture = scope(owner, input.deadline, now)
  const live = () => !owner.snapshot().terminal && owner.child.exitCode === null && owner.child.signalCode === null
  const checkLive = () => { capture.check(); if (!live()) throw new LiveProcessError("terminal") }
  let leader: ProcessIdentity
  try {
    while (true) {
      checkLive()
      const pid = owner.child.pid
      if (!pid || !Number.isSafeInteger(pid) || pid <= 0) throw new LiveProcessError("identity")
      let observed: ProcessIdentity | null
      try { observed = await capture.bounded(() => adapter.readProcess(pid)) }
      catch (error) {
        checkLive()
        if (!(error instanceof DarwinObservationUnavailable) && !(error instanceof LinuxObservationUnavailable)) throw error
        await capture.bounded(() => new Promise<void>(resolve => setTimeout(resolve, 25)))
        continue
      }
      checkLive()
      if (!observed || observed.pid !== pid || observed.bootId !== launchBootId || !exactAgencyBirth(observed.birth, marker)
        || observed.parentPid !== process.pid || observed.processGroupId !== pid || observed.sessionId !== pid || observed.uid !== process.getuid!() || observed.gid !== process.getgid!()) throw new LiveProcessError("identity")
      leader = structuredClone(observed)
      break
    }
  } finally { capture.invalidate() }
  const initial = freezeGroup({ leader, observed: [structuredClone(leader)] }), observed = [structuredClone(leader)]
  let pending: Promise<LiveCleanupEvidence> | undefined, rejected = false, result: LiveCleanupEvidence | undefined
  const cleanupAttempt = async (limits: CleanupLimits): Promise<void> => {
    const work = scope(owner, limits.deadline, now)
    const { bounded, check } = work
    try {
      check()
      if ([limits.terminateMs, limits.absenceMs, limits.transportCloseMs].some(value => !Number.isFinite(value) || value < 0)) throw new LiveProcessError("deadline")
      const terminationDeadline = Math.min(limits.deadline, now() + limits.terminateMs)
      const retain = (members: ProcessIdentity[]) => {
        for (const member of members) if (!observed.some(prior => sameProcessGeneration(prior, member))) observed.push(structuredClone(member))
      }
      const authorize = async (): Promise<boolean> => {
        if (!live()) return false
        if (await bounded(() => adapter.bootId(), terminationDeadline) !== launchBootId) throw new LiveProcessError("identity")
        if (!live()) return false
        const first = await bounded(() => adapter.readProcess(leader.pid), terminationDeadline)
        if (!live()) return false
        if (!first || !sameAuthority(leader, first)) throw new LiveProcessError("identity")
        const members = await bounded(() => adapter.readGroup(leader.processGroupId), terminationDeadline)
        if (new Set(members.map(member => member.pid)).size !== members.length
          || !members.some(member => sameAuthority(leader, member))
          || members.some(member => !Number.isSafeInteger(member.pid) || member.pid <= 0 || processBirthStart(member.birth) === null || member.bootId !== launchBootId || member.processGroupId !== leader.processGroupId || member.sessionId !== leader.sessionId || member.uid !== leader.uid || member.gid !== leader.gid)) throw new LiveProcessError("identity")
        retain(members)
        if (!live()) return false
        const last = await bounded(() => adapter.readProcess(leader.pid), terminationDeadline)
        if (!live()) return false
        if (!last || !sameAuthority(leader, last)) throw new LiveProcessError("identity")
        return true
      }
      const signal = async (value: NodeJS.Signals): Promise<void> => {
        if (!await authorize()) return
        check()
        if (!live()) return
        try { await bounded(() => {
          check()
          if (!live()) return Promise.resolve()
          return adapter.signalGroup(leader.processGroupId, value)
        }, terminationDeadline) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error instanceof LiveProcessError ? error : new LiveProcessError("signal") }
      }
      const termDeadline = Math.min(terminationDeadline, now() + Math.min(1000, Math.floor(limits.terminateMs / 2)))
      if (!owner.snapshot().terminal) {
        await signal("SIGTERM")
        if (!owner.snapshot().terminal) {
          try { await bounded(() => owner.terminal, termDeadline) }
          catch (error) { if (!(error instanceof LiveProcessError) || error.reason !== "deadline") throw error; check() }
        }
        if (!owner.snapshot().terminal) await signal("SIGKILL")
      }
      const terminal = await bounded(() => owner.terminal, terminationDeadline)
      if (terminal.kind !== "exit") throw new LiveProcessError("terminal")
      owner.child.stdout?.resume(); owner.child.stderr?.resume()
      let transport: "closed" | "destroyed" = "closed"
      if (!owner.snapshot().closed) {
        try { await bounded(() => owner.closed, Math.min(limits.deadline, now() + limits.transportCloseMs)) }
        catch (error) {
          if (!(error instanceof LiveProcessError) || error.reason !== "deadline") throw error
          check()
          const streams = [owner.child.stdin, owner.child.stdout, owner.child.stderr].filter(stream => stream !== null)
          for (const stream of streams) stream.destroy()
          if (!streams.every(stream => stream.destroyed)) throw new LiveProcessError("terminal")
          transport = "destroyed"
        }
      }
      const absenceDeadline = Math.min(limits.deadline, now() + limits.absenceMs)
      if (await bounded(() => adapter.bootId(), absenceDeadline) !== launchBootId) throw new LiveProcessError("absence")
      for (let pass = 0; pass < 2; pass++) {
        if ((await bounded(() => adapter.readGroup(leader.processGroupId), absenceDeadline)).length) throw new LiveProcessError("absence")
        for (const member of observed) {
          const current = await bounded(() => adapter.readProcess(member.pid), absenceDeadline)
          if (current && sameProcessGeneration(member, current)) throw new LiveProcessError("absence")
        }
      }
      check()
      const issued = Object.freeze({ launchAttemptId: owner.launchAttemptId, group: freezeGroup(structuredClone({ leader, observed })), terminal, transport })
      evidence.set(issued, { group, attribution: structuredClone(issued) })
      result = issued
      owner.release()
    } finally { work.invalidate() }
  }
  const group: LiveProcessGroup = Object.freeze({
    owner, identity: () => structuredClone(initial),
    cleanup(limits: CleanupLimits): Promise<LiveCleanupEvidence> {
      if (pending && (!limits.retry || !rejected)) return pending
      rejected = false
      const stopped = limits.retry ? owner.retryStop(() => cleanupAttempt(limits)) : owner.stop(() => cleanupAttempt(limits))
      pending = stopped.then(() => {
        if (!result) throw new LiveProcessError("absence")
        return result
      }, error => { throw error instanceof LiveProcessError ? error : new LiveProcessError(owner.snapshot().abandoned ? "abandoned" : "signal") })
      void pending.catch(() => { rejected = true })
      return pending
    },
  })
  registrations.add(group)
  return group
}