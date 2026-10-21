import { signalOwnedProcess } from "./fixture-signal.js"
import { randomUUID } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import { sameProcess, sameProcessGeneration, type PlatformAdapter, type ProcessIdentity } from "../../src/platform/types.js"

export type LaunchRef = Readonly<{ runId: string; launchId: string }>
export type Terminal = { code: number | null; signal: NodeJS.Signals | null }
export type Reporting = "direct" | "detached-handler" | "editor-endpoint" | "editor-control"
export type FixtureLaunchResult = {
  ref: LaunchRef; role: string; ownerId: string; pid: number | null
  identity: ProcessIdentity | null; error: string | null
  exit: Terminal | null; close: boolean | null; absent: boolean | null
  reporting: Reporting
  unavailable: null | "launcher-finished" | "prepared-owner-exit" | "editor-handle-closed" | "editor-api-completion"
}
export type FixtureResult = {
  version: 1; runId: string; workerFile: string
  state: "settled" | "incomplete"; launches: FixtureLaunchResult[]
  operations: { label: string; state: "fulfilled" | "rejected" | "pending"; error: string | null }[]
  failures: string[]; artifacts: string[]
}
export type ScopeOptions = { runId: string; workerFile: string; deadlineMs: number }
export type Admission<C extends ChildProcess> = { closeAdmission(child: C): void }
export type FixtureScope = {
  intent(role: string, options?: { ownGroup?: boolean; reporting?: Reporting }): LaunchRef
  spawn<C extends ChildProcess>(ref: LaunchRef, work: () => C, admission: Admission<C>): C
  observe(ref: LaunchRef): Promise<ProcessIdentity | null>
  operation<T>(label: string, work: () => Promise<T>): Promise<T>
  finalizer(label: string, work: () => Promise<void>): void
  artifact(path: string): void
  signal(ref: LaunchRef, value: NodeJS.Signals, options?: { allowAbsent: boolean }): Promise<void>
  finish(): Promise<FixtureResult>
  snapshot(): FixtureResult
}
type Launch = {
  result: FixtureLaunchResult; child: ChildProcess | null; attempted: boolean; ownGroup: boolean
  closed: Promise<void>; close: () => void; admission: (() => void) | null
  members: ProcessIdentity[]; failed: boolean; remote: boolean; parentPid: number
  authority: () => Promise<boolean | "prepared">; authorityCurrent: () => boolean
}
type Operation = FixtureResult["operations"][number] & { promise: Promise<unknown> }
export type NativeFixtureAccess = {
  deadlineMs: number
  settleChecks(refs?: readonly LaunchRef[]): Promise<void>
  declareExec(ref: LaunchRef, image: string): void
  admitSource(ref: LaunchRef): Promise<ProcessIdentity | null>
  signalPid(ref: LaunchRef, signal: NodeJS.Signals, deadlineMs?: number): Promise<void>
  sourceAlive(ref: LaunchRef): Promise<boolean>
  result(ref: LaunchRef): FixtureLaunchResult
  child(ref: LaunchRef): ChildProcess | null
  ownGroup(ref: LaunchRef): boolean
  fault(error: unknown, ref?: LaunchRef): void
  beforeAbsence(work: () => Promise<void>): void
  seal(): Promise<void>
  completeSource(): Promise<void>
  accept(result: FixtureLaunchResult, parentPid: number, ownGroup: boolean, authority: () => Promise<boolean | "prepared">, authorityCurrent?: () => boolean): Promise<void>
  unavailable(ref: LaunchRef, reason: FixtureLaunchResult["unavailable"]): void
}
const nativeAccess = new WeakMap<FixtureScope, NativeFixtureAccess>()
export function nativeFixtureAccess(scope: FixtureScope): NativeFixtureAccess {
  const access = nativeAccess.get(scope)
  if (!access) throw new Error("Native reporting requires a native fixture scope")
  return access
}
function reportedIdentity(expected: ProcessIdentity, observed: ProcessIdentity, role: string): boolean {
  return sameProcess(expected, observed) || role === "darwin-exec-helper"
    && sameProcessGeneration(expected, observed)
    && expected.pid !== expected.processGroupId
    && expected.birth.endsWith(":unmarked:/bin/sh") && observed.birth.endsWith(":unmarked:/bin/sleep")
    && expected.processGroupId === observed.processGroupId && expected.sessionId === observed.sessionId
    && expected.uid === observed.uid && expected.gid === observed.gid
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function createNativeFixtureScope(options: ScopeOptions): FixtureScope {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Unsupported fixture platform")
  return createScope(options, process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter(), (pid, value) => { process.kill(pid, value) }, true)
}
export function createSyntheticFixtureScope(options: ScopeOptions & {
  adapter: PlatformAdapter; signal: (pid: number, value: NodeJS.Signals) => void
}): FixtureScope {
  if (!options.adapter || typeof options.signal !== "function") throw new Error("Synthetic fixtures require paired adapter and signal")
  return createScope(options, options.adapter, options.signal, false)
}
function createScope(options: ScopeOptions, adapter: PlatformAdapter, sendSignal: (pid: number, value: NodeJS.Signals) => void, native: boolean): FixtureScope {
  if (!options.runId || !options.workerFile || !Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) throw new Error("Invalid fixture scope")
  const launches = new Map<string, Launch>(), operations: Operation[] = [], failures: string[] = [], artifacts = new Set<string>()
  const finalizers: Array<{ label: string; work: () => Promise<void> }> = []
  let phase: "open" | "operations" | "finalizers" | "closed" = "open", pending: Promise<FixtureResult> | undefined
  let until = Infinity, frozen = false
  const refusedAuthority = async () => false
  const execImages = new Map<string, string>()
  const checks = new Map<Promise<unknown>, string>(), faults: Array<{ text: string; ref: LaunchRef | undefined }> = [], boundaries: Array<() => Promise<void>> = []
  const fail = (label: string, error: unknown, ref?: LaunchRef) => { const text = label + ": " + message(error); failures.push(text); faults.push({ text, ref }) }
  const bounded = async <T>(label: string, work: () => Promise<T>, limitMs = 30000): Promise<T> => {
    const remaining = Math.min(options.deadlineMs, limitMs, until - Date.now())
    if (remaining <= 0) throw new Error(label + " deadline")
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " deadline")), remaining)
      })])
    } finally { clearTimeout(timer) }
  }
  const drainChecks = (refs?: readonly LaunchRef[]) => bounded("fixture checks", async () => {
    const selected = refs && new Set(refs.map(ref => { find(ref); return ref.launchId }))
    while (true) {
      const pending = [...checks].filter(([, id]) => !selected || selected.has(id)).map(([promise]) => promise)
      if (!pending.length) return
      await Promise.allSettled(pending)
    }
  })
  const find = (ref: LaunchRef): Launch => {
    const value = launches.get(ref.launchId)
    if (ref.runId !== options.runId || !value) throw new Error("Unknown fixture launch")
    return value
  }
  const live = (value: Launch) => value.result.exit === null && (value.remote || value.child !== null && value.child.exitCode === null && value.child.signalCode === null)
  const closeAdmission = (value: Launch) => {
    const close = value.admission
    value.admission = null
    if (close) try { close() } catch (error) { value.failed = true; fail(value.result.role + " admission", error, value.result.ref) }
  }
  const observeImpl = async (ref: LaunchRef): Promise<ProcessIdentity | null> => {
    const value = find(ref)
    try {
      if (!value.attempted) throw new Error("Unspawned fixture identity")
      if (!value.result.pid || !live(value)) return null
      const current = await bounded("observe", () => adapter.readProcess(value.result.pid!))
      if (!live(value)) return null
      if (!current || current.pid !== value.result.pid || (!value.result.identity && current.parentPid !== value.parentPid) || !sameProcess(current, current)
        || value.result.identity && !reportedIdentity(value.result.identity, current, value.result.role)
        || value.ownGroup && (current.processGroupId !== current.pid || current.sessionId !== current.pid)) throw new Error("Fixture identity mismatch")
      value.result.identity = structuredClone(current)
      return structuredClone(current)
    } catch (error) { value.failed = true; fail(value.result.role + " observation", error, ref); closeAdmission(value); throw error }
  }
  const observe = (ref: LaunchRef): Promise<ProcessIdentity | null> => {
    const work = observeImpl(ref)
    checks.set(work, ref.launchId)
    void work.finally(() => checks.delete(work)).catch(() => {})
    return work
  }
  let localDrain: Promise<void> | undefined
  const drainLocal = (): Promise<void> => {
    if (localDrain) return localDrain
    phase = "finalizers"
    until = Date.now() + Math.min(options.deadlineMs, 120000)
    localDrain = (async () => {
      await Promise.allSettled(finalizers.map(async value => {
        try { await bounded(value.label, value.work, Math.max(1, options.deadlineMs / 3)) } catch (error) { fail(value.label, error) }
      }))
      phase = "operations"
      try { await bounded("operations", async () => { await Promise.allSettled(operations.map(value => value.promise)) }, Math.max(1, options.deadlineMs / 3)) }
      catch (error) { fail("operations", error) }
      for (const value of launches.values()) if (value.failed) closeAdmission(value)
    })()
    return localDrain
  }
  const snapshot = (): FixtureResult => structuredClone({
    version: 1, runId: options.runId, workerFile: options.workerFile,
    state: failures.length || phase !== "closed" ? "incomplete" : "settled",
    launches: [...launches.values()].map(value => value.result),
    operations: operations.map(({ label, state, error }) => ({ label, state, error })),
    failures, artifacts: [...artifacts],
  })
  const signalObservation = async (pid: number): Promise<ProcessIdentity | null> => {
    const end = Date.now() + 15000
    while (true) {
      try { return await adapter.readProcess(pid) }
      catch (error) {
        if (!(error instanceof Error) || !error.name.endsWith("ObservationUnavailable") || Date.now() >= end) throw error
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
  }
  const deliverImpl = async (ref: LaunchRef, signal: NodeJS.Signals, group: boolean, absentIsSettled = false, deadlineMs = 15000): Promise<boolean> => {
      const value = find(ref), authorizationUntil = Math.min(until, Date.now() + Math.min(options.deadlineMs, deadlineMs, 15000))
      let active = true
      const authorized = () => active && Date.now() < Math.min(until, authorizationUntil) && live(value) && value.authority !== refusedAuthority && value.authorityCurrent()
      const authorize = <T>(label: string, work: () => Promise<T>) => bounded(label, work, authorizationUntil - Date.now())
      try {
        if (execImages.has(ref.launchId)) throw new Error("Fixture exec source not admitted")
        if (absentIsSettled && value.attempted && !live(value)) return false
        if (absentIsSettled && value.result.pid && await authorize("signal absence", () => signalObservation(value.result.pid!)) === null) return false
        const authority = await authorize("signal owner", value.authority)
        if (!value.attempted || !live(value) || !authority) throw new Error("Fixture terminal or missing identity")
        if (!value.result.identity && !value.remote) await authorize("signal observation", () => observe(ref))
        const expected = value.result.identity
        if (!expected || !live(value) || group && (expected.processGroupId !== expected.pid || expected.sessionId !== expected.pid)) throw new Error("Fixture missing identity")
        const outcome = await authorize("signal authorization", () => signalOwnedProcess(adapter, {
          identity: expected, parentPid: value.remote && authority === "prepared" ? null : value.parentPid, knownMembers: [...launches.values()].filter(known => known.authority !== refusedAuthority).flatMap(known => known.result.identity ? [known.result.identity] : []), signal, group,
        }, sendSignal, authorized, async () => Boolean(await value.authority())))
        if (outcome === "already-absent" && !absentIsSettled) throw new Error("Fixture identity mismatch")
        if (group) for (const member of [...launches.values()].filter(known => known.authority !== refusedAuthority).flatMap(known => known.result.identity && known.result.identity.processGroupId === expected.processGroupId ? [known.result.identity] : [])) {
          if (!value.members.some(prior => sameProcess(prior, member))) value.members.push(structuredClone(member))
        }
        return outcome === "delivered"
      } catch (error) { value.failed = true; fail(value.result.role + " signal", error, ref); throw error }
      finally { active = false }
  }
  const deliver: typeof deliverImpl = (...args) => {
    const work = deliverImpl(...args)
    checks.set(work, args[0].launchId)
    void work.finally(() => checks.delete(work)).catch(() => {})
    return work
  }
  const scope: FixtureScope = {
    intent(role, input = {}) {
      if (frozen || phase === "closed" || phase === "operations" && !operations.some(value => value.state === "pending")) throw new Error("Fixture admission closed")
      const ref = Object.freeze({ runId: options.runId, launchId: randomUUID() })
      let close!: () => void
      const closed = new Promise<void>(resolve => { close = resolve })
      launches.set(ref.launchId, {
        result: { ref, role, ownerId: options.workerFile, pid: null, identity: null, error: null, exit: null, close: null, absent: null, reporting: input.reporting ?? "direct", unavailable: null },
        child: null, attempted: false, ownGroup: input.ownGroup ?? false, closed, close, admission: null, members: [], failed: false, remote: false, parentPid: process.pid, authority: async () => true, authorityCurrent: () => true,
      })
      return ref
    },
    spawn(ref, work, admission) {
      const value = find(ref)
      if (frozen || value.attempted || phase === "closed") throw new Error("Fixture already spawned or closed")
      value.attempted = true
      let child: ReturnType<typeof work>
      try { child = work() }
      catch (error) { value.result.error = message(error); value.result.absent = true; value.close(); throw error }
      value.child = child
      value.result.pid = child.pid ?? null
      value.result.close = false
      value.admission = () => admission.closeAdmission(child)
      child.on("error", error => { value.result.error = message(error) })
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => { value.result.exit = { code, signal } })
      child.once("close", () => { value.result.close = true; value.close() })
      return child
    },
    observe,
    operation(label, work) {
      if (phase !== "open") throw new Error("Fixture operations closed")
      const value: Operation = { label, state: "pending", error: null, promise: Promise.resolve() }
      operations.push(value)
      value.promise = Promise.resolve().then(work).then(result => { value.state = "fulfilled"; return result }, error => {
        value.state = "rejected"; value.error = message(error); throw error
      })
      void value.promise.catch(() => {})
      return value.promise as ReturnType<typeof work>
    },
    finalizer(label, work) {
      if (phase !== "open") throw new Error("Fixture finalizers closed")
      finalizers.push({ label, work })
    },
    artifact(path) { artifacts.add(path) },
    signal: async (ref, signal, input) => { await deliver(ref, signal, find(ref).ownGroup, input?.allowAbsent ?? false) },
    finish() {
      if (pending) return pending
      pending = (async () => {
        await drainLocal()
        for (const boundary of boundaries) try { await bounded("reporting boundary", boundary) } catch (error) { fail("reporting", error) }
        try { await drainChecks() } catch (error) { fail("fixture checks", error) }
        await Promise.allSettled([...launches.values()].map(async value => {
          try {
            if (!value.attempted) throw new Error("unspawned intent")
            if (!value.child && !value.remote) return
            if (value.result.pid === null && value.result.error && value.result.close === null) { value.result.absent = true; return }
            if (value.result.reporting !== "direct" && !value.result.unavailable && !(value.result.close === true && (value.result.exit || value.result.pid === null && value.result.error))) throw new Error("reporting source unavailable")
            if (!value.result.unavailable) {
              if (value.remote && value.result.close !== true && !await value.authority()) throw new Error("Fixture source lost before terminal/close")
              await bounded(value.result.role + " close", () => value.closed)
              if (!value.result.exit && !(value.result.error && value.result.pid === null)) throw new Error("missing terminal event")
            }
            if (value.result.pid === null) { value.result.absent = true; return }
          } catch (error) { fail(value.result.role, error, value.result.ref) }
        }))
        for (const value of launches.values()) {
          if (value.result.pid === null) continue
          try {
            const absenceUntil = Math.min(until, Date.now() + Math.min(options.deadlineMs, 15000))
            const absence = <T>(label: string, work: () => Promise<T>) => bounded(label, work, absenceUntil - Date.now())
            while (true) {
              if (Date.now() >= absenceUntil) throw new Error("unresolved absence deadline")
              const boot = await absence("absence boot", () => adapter.bootId())
              if (value.result.identity && boot !== value.result.identity.bootId) throw new Error("absence boot mismatch")
              try {
                const current = await absence("absence identity", () => adapter.readProcess(value.result.pid!))
                let absent = current === null || value.result.identity !== null && !sameProcessGeneration(value.result.identity, current)
                if (value.ownGroup) {
                  const members = await absence("absence group", () => adapter.readGroup(value.result.pid!))
                  if (members.length) absent = false
                  for (const member of value.members) {
                    const observed = await absence("absence member", () => adapter.readProcess(member.pid))
                    if (observed && sameProcessGeneration(member, observed)) absent = false
                  }
                }
                if (Date.now() >= absenceUntil) throw new Error("unresolved absence deadline")
                value.result.absent = absent
                if (absent) break
              } catch (error) {
                if (Date.now() >= absenceUntil) throw error
                value.result.absent = null
              }
              await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, Math.max(1, absenceUntil - Date.now()))))
            }
          } catch (error) { fail(value.result.role, error, value.result.ref) }
        }
        phase = "closed"
        return snapshot()
      })()
      return pending
    },
    snapshot,
  }
  if (native) nativeAccess.set(scope, {
    deadlineMs: options.deadlineMs,
    async settleChecks(refs) {
      await drainChecks(refs)
      const selected = refs && new Set(refs.map(ref => ref.launchId))
      const errors = faults.filter(value => !selected || !value.ref || selected.has(value.ref.launchId))
      if (errors.length) throw new Error(errors.map(value => value.text).join("; "))
    },
    declareExec(ref, image) {
      const value = find(ref)
      if (value.attempted || !["qualification-command", "qualification-shell", "editor"].includes(value.result.role) || !image.startsWith("/") || execImages.has(ref.launchId)) throw new Error("Undeclared fixture exec")
      execImages.set(ref.launchId, image)
    },
    async admitSource(ref) {
      const image = execImages.get(ref.launchId)
      if (!image) return observe(ref)
      const value = find(ref)
      try {
        if (!value.child || !live(value)) throw new Error("Exec source has no live actual handle")
        const current = await bounded("exec source identity", () => signalObservation(value.result.pid!))
        const prior = value.result.identity
        if (!current || !live(value) || current.parentPid !== value.parentPid || !sameProcess(current, current)
          || current.birth !== current.birth.split(":")[0] + (adapter.platform === "darwin" ? ":unmarked:" : ":") + image
          || prior && (!sameProcessGeneration(prior, current) || prior.parentPid !== current.parentPid || prior.processGroupId !== current.processGroupId || prior.sessionId !== current.sessionId || prior.uid !== current.uid || prior.gid !== current.gid)
          || value.ownGroup && (current.processGroupId !== current.pid || current.sessionId !== current.pid)) throw new Error("Declared exec identity mismatch")
        value.result.identity = structuredClone(current)
        execImages.delete(ref.launchId)
        return structuredClone(current)
      } catch (error) { value.failed = true; fail(value.result.role + " exec", error, ref); closeAdmission(value); throw error }
    },
    signalPid: async (ref, signal, deadlineMs) => { await deliver(ref, signal, false, true, deadlineMs) },
    async sourceAlive(ref) {
      const value = find(ref), expected = value.result.identity
      if (!live(value) || !expected) return false
      const current = await bounded("source identity", () => signalObservation(expected.pid), 15000)
      return live(value) && current !== null && sameProcess(expected, current)
    },
    result: ref => structuredClone(find(ref).result),
    child: ref => find(ref).child,
    ownGroup: ref => find(ref).ownGroup,
    fault: (error, ref) => { if (ref) find(ref); fail("reporting", error, ref) },
    beforeAbsence(work) { boundaries.push(work) },
    async seal() { frozen = true; await Promise.allSettled([...checks.keys()]) },
    async completeSource() {
      await drainLocal()
      frozen = true
      await Promise.allSettled([...launches.values()].filter(value => value.result.reporting === "direct").map(async value => {
        try {
          if (!value.attempted) throw new Error("unspawned intent")
          if (value.child) await bounded(value.result.role + " close", () => value.closed)
          if (value.child && !value.result.exit && !(value.result.error && value.result.pid === null)) throw new Error("missing terminal event")
        } catch (error) { fail(value.result.role, error, value.result.ref) }
      }))
      try { await drainChecks() } catch (error) { fail("fixture checks", error) }
      if (failures.length) throw new Error(failures.join("; "))
    },
    async accept(result, parentPid, ownGroup, authority, authorityCurrent = () => true) {
      if (result.ref.runId !== options.runId) throw new Error("Foreign fixture ref")
      let value = launches.get(result.ref.launchId)
      const prior = value?.result
      if (value && (!value.remote || value.result.ownerId !== result.ownerId)) throw new Error("Conflicting fixture owner")
      if (!value) {
        let close!: () => void
        const closed = new Promise<void>(resolve => { close = resolve })
        value = { result: structuredClone(result), child: null, attempted: true, ownGroup, closed, close, admission: null, members: [], failed: false, remote: true, parentPid, authority: refusedAuthority, authorityCurrent: () => false }
        value.result.absent = null
        launches.set(result.ref.launchId, value)
      }
      value.authority = refusedAuthority
      const identity = result.identity ?? value.result.identity
      if (identity && (identity.parentPid !== parentPid || !sameProcess(identity, identity)
        || ownGroup && (identity.processGroupId !== result.pid || identity.sessionId !== result.pid))) throw new Error("Fixture reported identity mismatch")
      if (prior) {
        if (prior.pid !== result.pid || prior.role !== result.role || prior.reporting !== result.reporting || value.ownGroup !== ownGroup
          || prior.exit && JSON.stringify(prior.exit) !== JSON.stringify(result.exit)
          || prior.close === true && result.close !== true || prior.error && prior.error !== result.error
          || prior.identity && result.identity && (!reportedIdentity(prior.identity, result.identity, prior.role) || prior.identity.parentPid !== result.identity.parentPid)) throw new Error("Conflicting fixture snapshot")
        if (result.identity) prior.identity = structuredClone(result.identity)
        prior.exit = result.exit; prior.close = result.close; prior.error = result.error
      }
      value.authority = authority
      value.authorityCurrent = authorityCurrent
      if (value.result.close === true) value.close()
    },
    unavailable(ref, reason) { find(ref).result.unavailable = reason },
  })
  return scope
}