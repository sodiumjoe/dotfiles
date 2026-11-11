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
export type LiveProcessGroup = { readonly owner: OwnedChild; identity(): ProcessGroupIdentity; observeMember(identity: ProcessIdentity): void; cleanup(input: CleanupLimits): Promise<LiveCleanupEvidence> }
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
  const observed = [structuredClone(leader)], absenceOnly: ProcessIdentity[] = []
  let cleanupStarted = false, authorityRevoked = false
  let pending: Promise<LiveCleanupEvidence> | undefined, rejected = false, result: LiveCleanupEvidence | undefined
  const cleanupAttempt = async (limits: CleanupLimits): Promise<void> => {
    const work = scope(owner, limits.deadline, now)
    const { bounded, check } = work
    try {
      check()
      if ([limits.terminateMs, limits.absenceMs, limits.transportCloseMs].some(value => !Number.isFinite(value) || value < 0)) throw new LiveProcessError("deadline")
      const terminationDeadline = Math.min(limits.deadline, now() + limits.terminateMs)
      const retain = (members: ProcessIdentity[]) => {
        for (const member of members) {
          if (!observed.some(prior => sameProcessGeneration(prior, member))) observed.push(structuredClone(member))
          for (let index = absenceOnly.length - 1; index >= 0; index--) if (sameProcessGeneration(absenceOnly[index]!, member)) absenceOnly.splice(index, 1)
        }
      }
      const rejectIdentity = (): never => { authorityRevoked = true; throw new LiveProcessError("identity") }
      const qualified = (member: ProcessIdentity): boolean => member !== null && typeof member === "object"
        && Number.isSafeInteger(member.pid) && member.pid > 0 && typeof member.birth === "string" && processBirthStart(member.birth) !== null
        && member.bootId === launchBootId && member.processGroupId === leader.processGroupId && member.sessionId === leader.sessionId
        && member.uid === leader.uid && member.gid === leader.gid
      const observeMembers = async (until: number): Promise<ProcessIdentity[]> => {
        const members = await bounded(() => adapter.readGroup(leader.processGroupId), until)
        for (const member of members) if (qualified(member) && ![...observed, ...absenceOnly].some(prior => sameProcessGeneration(prior, member))) absenceOnly.push(structuredClone(member))
        return members
      }
      const authenticate = async (until: number): Promise<ProcessIdentity[]> => {
        if (await bounded(() => adapter.bootId(), until) !== launchBootId) rejectIdentity()
        const first = await bounded(() => adapter.readProcess(leader.pid), until)
        const members = await observeMembers(until)
        if (members.length === 0) { authorityRevoked = true; return members }
        if (members.some(member => !qualified(member)) || new Set(members.map(member => member.pid)).size !== members.length) rejectIdentity()
        if (authorityRevoked || first && !sameAuthority(leader, first)
          || members.some(member => observed.some(prior => prior.pid === member.pid && !sameAuthority(prior, member)))) rejectIdentity()
        const anchors = members.filter(member => observed.some(prior => sameAuthority(prior, member)))
        if (anchors.length === 0) rejectIdentity()
        const last = await bounded(() => adapter.readProcess(leader.pid), until)
        if (last && (!sameAuthority(leader, last) || !members.some(member => sameAuthority(leader, member)))) rejectIdentity()
        if (await bounded(() => adapter.bootId(), until) !== launchBootId) rejectIdentity()
        let anchored = false
        for (const anchor of [...anchors, ...members.filter(member => !anchors.includes(member))]) {
          let current: ProcessIdentity | null
          try { current = await bounded(() => adapter.readProcess(anchor.pid), until) }
          catch (error) {
            if (!(error instanceof DarwinObservationUnavailable) && !(error instanceof LinuxObservationUnavailable)) throw error
            continue
          }
          if (current && !sameAuthority(anchor, current)) rejectIdentity()
          if (current) { anchored = true; break }
        }
        if (!anchored) {
          authorityRevoked = true
          if ((await observeMembers(until)).length === 0) return []
          rejectIdentity()
        }
        check()
        retain(members)
        return members
      }
      const signal = async (value: NodeJS.Signals): Promise<boolean> => {
        while (true) {
          try { if ((await authenticate(terminationDeadline)).length === 0) return false; break }
          catch (error) {
            if (!(error instanceof DarwinObservationUnavailable) && !(error instanceof LinuxObservationUnavailable)) throw error
            await bounded(() => new Promise<void>(resolve => setTimeout(resolve, 25)), terminationDeadline)
          }
        }
        check()
        if (authorityRevoked) rejectIdentity()
        try { await bounded(() => {
          check()
          if (authorityRevoked) rejectIdentity()
          return adapter.signalGroup(leader.processGroupId, value)
        }, terminationDeadline) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error instanceof LiveProcessError ? error : new LiveProcessError("signal") }
        return true
      }
      const termDeadline = Math.min(terminationDeadline, now() + Math.min(1000, Math.floor(limits.terminateMs / 2)))
      if (await signal("SIGTERM")) {
        let empty = false
        while (now() < termDeadline) {
          try { if ((await authenticate(termDeadline)).length === 0) { empty = true; break } }
          catch (error) {
            if (error instanceof LiveProcessError && error.reason === "deadline") { check(); break }
            if (!(error instanceof DarwinObservationUnavailable) && !(error instanceof LinuxObservationUnavailable)) throw error
          }
          try { await bounded(() => new Promise<void>(resolve => setTimeout(resolve, 25)), termDeadline) }
          catch (error) { if (!(error instanceof LiveProcessError) || error.reason !== "deadline") throw error; check(); break }
        }
        if (!empty) await signal("SIGKILL")
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
      let passes = 0
      while (passes < 2) {
        let absent = false
        try {
          if (await bounded(() => adapter.bootId(), absenceDeadline) !== launchBootId) { authorityRevoked = true; throw new LiveProcessError("absence") }
          absent = (await authenticate(absenceDeadline)).length === 0
          if (absent) for (const member of [...observed, ...absenceOnly]) {
            const current = await bounded(() => adapter.readProcess(member.pid), absenceDeadline)
            if (current && sameProcessGeneration(member, current)) { absent = false; break }
          }
        } catch (error) {
          if (!(error instanceof DarwinObservationUnavailable) && !(error instanceof LinuxObservationUnavailable)) throw error
          absent = false
        }
        passes = absent ? passes + 1 : 0
        if (!absent) await bounded(() => new Promise<void>(resolve => setTimeout(resolve, 25)), absenceDeadline)
      }
      check()
      const issued = Object.freeze({ launchAttemptId: owner.launchAttemptId, group: freezeGroup(structuredClone({ leader, observed: [...observed, ...absenceOnly] })), terminal, transport })
      evidence.set(issued, { group, attribution: structuredClone(issued) })
      result = issued
      owner.release()
    } finally { work.invalidate() }
  }
  const group: LiveProcessGroup = Object.freeze({
    owner, identity: () => structuredClone({ leader, observed }),
    observeMember(member: ProcessIdentity): void {
      if (cleanupStarted || !live() || owner.snapshot().abandoned) throw new LiveProcessError("terminal")
      if (!Number.isSafeInteger(member.pid) || member.pid <= 0 || member.pid === leader.pid || member.parentPid !== leader.pid
        || member.bootId !== leader.bootId || member.processGroupId !== leader.processGroupId || member.sessionId !== leader.sessionId
        || member.uid !== leader.uid || member.gid !== leader.gid || processBirthStart(member.birth) === null) throw new LiveProcessError("identity")
      const prior = observed.find(value => value.pid === member.pid)
      if (prior && !sameAuthority(prior, member)) throw new LiveProcessError("identity")
      if (!prior) observed.push(structuredClone(member))
    },
    cleanup(limits: CleanupLimits): Promise<LiveCleanupEvidence> {
      cleanupStarted = true
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