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
  authority: () => Promise<boolean>
}
type Operation = FixtureResult["operations"][number] & { promise: Promise<unknown> }
export type NativeFixtureAccess = {
  deadlineMs: number
  settleChecks(): Promise<void>
  declareExec(ref: LaunchRef, image: string): void
  admitSource(ref: LaunchRef): Promise<ProcessIdentity | null>
  signalEditor(ref: LaunchRef, signal: NodeJS.Signals, group: boolean): Promise<"delivered" | "already-absent" | "awaiting-reap">
  signalPid(ref: LaunchRef, signal: NodeJS.Signals): Promise<void>
  sourceAlive(ref: LaunchRef): Promise<boolean>
  result(ref: LaunchRef): FixtureLaunchResult
  child(ref: LaunchRef): ChildProcess | null
  ownGroup(ref: LaunchRef): boolean
  fault(error: unknown): void
  beforeAbsence(work: () => Promise<void>): void
  seal(): Promise<void>
  completeSource(): Promise<void>
  accept(result: FixtureLaunchResult, parentPid: number, ownGroup: boolean, authority: () => Promise<boolean>): Promise<void>
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
  const execImages = new Map<string, string>()
  const checks = new Set<Promise<unknown>>(), boundaries: Array<() => Promise<void>> = []
  const fail = (label: string, error: unknown) => { failures.push(label + ": " + message(error)) }
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
  const drainChecks = () => bounded("fixture checks", async () => { while (checks.size) await Promise.allSettled([...checks]) })
  const find = (ref: LaunchRef): Launch => {
    const value = launches.get(ref.launchId)
    if (ref.runId !== options.runId || !value) throw new Error("Unknown fixture launch")
    return value
  }
  const live = (value: Launch) => value.result.exit === null && (value.remote || value.child !== null && value.child.exitCode === null && value.child.signalCode === null)
  const closeAdmission = (value: Launch) => {
    const close = value.admission
    value.admission = null
    if (close) try { close() } catch (error) { value.failed = true; fail(value.result.role + " admission", error) }
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
    } catch (error) { value.failed = true; fail(value.result.role + " observation", error); closeAdmission(value); throw error }
  }
  const observe = (ref: LaunchRef): Promise<ProcessIdentity | null> => {
    const work = observeImpl(ref)
    checks.add(work)
    void work.finally(() => checks.delete(work)).catch(() => {})
    return work
  }
  let localDrain: Promise<void> | undefined
  const drainLocal = (): Promise<void> => {
    if (localDrain) return localDrain
    phase = "operations"
    until = Date.now() + Math.min(options.deadlineMs, 120000)
    localDrain = (async () => {
      try { await bounded("operations", async () => { await Promise.allSettled(operations.map(value => value.promise)) }) }
      catch (error) { fail("operations", error) }
      phase = "finalizers"
      await Promise.allSettled(finalizers.map(async value => {
        try { await bounded(value.label, value.work) } catch (error) { fail(value.label, error) }
      }))
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
  const deliverImpl = async (ref: LaunchRef, signal: NodeJS.Signals, group: boolean, absentIsSettled = false, editor = false): Promise<boolean | "awaiting-reap"> => {
      const value = find(ref)
      try {
        if (execImages.has(ref.launchId)) throw new Error("Fixture exec source not admitted")
        if (absentIsSettled && value.attempted && !live(value)) return false
        if (absentIsSettled && value.result.pid && await bounded("signal absence", () => signalObservation(value.result.pid!), 15000) === null) return false
        if (!value.attempted || !live(value) || !await bounded("signal owner", value.authority, 15000)) throw new Error("Fixture terminal or missing identity")
        if (!value.result.identity) await observe(ref)
        const expected = value.result.identity
        if (!expected || !live(value) || group && (expected.processGroupId !== expected.pid || expected.sessionId !== expected.pid)) throw new Error("Fixture missing identity")
        if (await bounded("signal boot", () => adapter.bootId(), 15000) !== expected.bootId) throw new Error("Fixture identity boot mismatch")
        const current = await bounded("signal identity", () => signalObservation(expected.pid), 15000)
        if (absentIsSettled && (!live(value) || current === null)) return false
        if (editor && current && value.result.reporting === "editor-endpoint" && value.result.unavailable === "editor-handle-closed"
          && adapter.platform === "darwin" && sameProcessGeneration(expected, current) && current.parentPid === expected.parentPid
          && current.uid === expected.uid && current.gid === expected.gid && current.processGroupId === expected.processGroupId && current.sessionId === expected.sessionId
          && /:unmarked:(?:\(node\)|<defunct>)$/.test(current.birth)) return "awaiting-reap"
        if (!live(value) || !current || !sameProcess(expected, current)) throw new Error("Fixture identity mismatch")
        if (group) {
          const members = await bounded("signal group", () => adapter.readGroup(expected.processGroupId), 15000)
          if (new Set(members.map(member => member.pid)).size !== members.length || !members.some(member => sameProcess(expected, member))
            || members.some(member => member.bootId !== expected.bootId || member.processGroupId !== expected.processGroupId || member.sessionId !== expected.sessionId || member.uid !== expected.uid || member.gid !== expected.gid || !sameProcess(member, member))) throw new Error("Fixture group identity mismatch")
          if (members.some(member => ![...launches.values()].some(known => known.result.identity && sameProcess(known.result.identity, member)))) throw new Error("Unregistered fixture group member")
          for (const member of members) if (!value.members.some(prior => sameProcess(prior, member))) value.members.push(structuredClone(member))
          const last = await bounded("signal identity", () => signalObservation(expected.pid), 15000)
          if (!live(value) || !last || !sameProcess(expected, last)) throw new Error("Fixture identity changed")
        }
        sendSignal(group ? -expected.processGroupId : expected.pid, signal)
        return true
      } catch (error) { value.failed = true; fail(value.result.role + " signal", error); throw error }
  }
  const deliver: typeof deliverImpl = (...args) => {
    const work = deliverImpl(...args)
    checks.add(work)
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
        child: null, attempted: false, ownGroup: input.ownGroup ?? false, closed, close, admission: null, members: [], failed: false, remote: false, parentPid: process.pid, authority: async () => true,
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
            const absenceUntil = Math.min(until, Date.now() + Math.min(options.deadlineMs, 15000))
            await bounded("final absence", async () => {
              while (true) {
                if (Date.now() >= absenceUntil) throw new Error("unresolved absence deadline")
                const boot = await bounded("absence boot", () => adapter.bootId(), 15000)
                if (value.result.identity && boot !== value.result.identity.bootId) throw new Error("absence boot mismatch")
                try {
                  const current = await bounded("absence identity", () => signalObservation(value.result.pid!), 15000)
                  let absent = current === null || value.result.identity !== null && !sameProcessGeneration(value.result.identity, current)
                  if (value.ownGroup) {
                    const members = await bounded("absence group", () => adapter.readGroup(value.result.pid!), 15000)
                    if (members.length) absent = false
                    for (const member of value.members) {
                      const observed = await bounded("absence member", () => adapter.readProcess(member.pid), 15000)
                      if (observed && sameProcessGeneration(member, observed)) absent = false
                    }
                  }
                  value.result.absent = absent
                  if (absent) return
                } catch (error) {
                  value.result.absent = null
                  if (Date.now() >= absenceUntil) throw error
                }
                await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, Math.max(1, absenceUntil - Date.now()))))
              }
            }, 15000)
          } catch (error) { fail(value.result.role, error) }
        }))
        phase = "closed"
        return snapshot()
      })()
      return pending
    },
    snapshot,
  }
  if (native) nativeAccess.set(scope, {
    deadlineMs: options.deadlineMs,
    async settleChecks() {
      await drainChecks()
      if (failures.length) throw new Error(failures.join("; "))
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
      } catch (error) { value.failed = true; fail(value.result.role + " exec", error); closeAdmission(value); throw error }
    },
    signalEditor: async (ref, signal, group) => { const outcome = await deliver(ref, signal, group, true, true); return outcome === "awaiting-reap" ? outcome : outcome ? "delivered" : "already-absent" },
    signalPid: async (ref, signal) => { await deliver(ref, signal, false, true) },
    async sourceAlive(ref) {
      const value = find(ref), expected = value.result.identity
      if (!live(value) || !expected) return false
      const current = await bounded("source identity", () => signalObservation(expected.pid), 15000)
      return live(value) && current !== null && sameProcess(expected, current)
    },
    result: ref => structuredClone(find(ref).result),
    child: ref => find(ref).child,
    ownGroup: ref => find(ref).ownGroup,
    fault: error => fail("reporting", error),
    beforeAbsence(work) { boundaries.push(work) },
    async seal() { frozen = true; await Promise.allSettled([...checks]) },
    async completeSource() {
      await drainLocal()
      frozen = true
      await Promise.allSettled([...launches.values()].filter(value => value.result.reporting === "direct").map(async value => {
        try {
          if (!value.attempted) throw new Error("unspawned intent")
          if (value.child) await bounded(value.result.role + " close", () => value.closed)
          if (value.child && !value.result.exit && !(value.result.error && value.result.pid === null)) throw new Error("missing terminal event")
        } catch (error) { fail(value.result.role, error) }
      }))
      if (failures.length) throw new Error(failures.join("; "))
    },
    async accept(result, parentPid, ownGroup, authority) {
      if (result.ref.runId !== options.runId) throw new Error("Foreign fixture ref")
      let value = launches.get(result.ref.launchId)
      if (value && (!value.remote || value.result.ownerId !== result.ownerId)) throw new Error("Conflicting fixture owner")
      if (!value) {
        let close!: () => void
        const closed = new Promise<void>(resolve => { close = resolve })
        value = { result: structuredClone(result), child: null, attempted: true, ownGroup, closed, close, admission: null, members: [], failed: false, remote: true, parentPid, authority }
        value.result.identity = null
        value.result.absent = null
        value.authority = async () => false
        launches.set(result.ref.launchId, value)
        if (result.pid !== null && !result.exit) {
          if (!await authority()) throw new Error("Fixture source lost")
          let identity: ProcessIdentity | null
          try { identity = await bounded("report identity", () => adapter.readProcess(result.pid!)) }
          catch (error) {
            if (await bounded("report absence", () => adapter.readProcess(result.pid!)) !== null) throw error
            identity = null
          }
          if (identity && (identity.parentPid !== parentPid || identity.pid !== result.pid || result.identity && !sameProcess(result.identity, identity))) throw new Error("Fixture reported identity mismatch")
          value.result.identity = identity
        } else if (result.identity) value.result.identity = structuredClone(result.identity)
        value.authority = authority
      } else {
        const prior = value.result
        if (prior.pid !== result.pid || prior.role !== result.role || prior.reporting !== result.reporting || value.ownGroup !== ownGroup
          || prior.exit && JSON.stringify(prior.exit) !== JSON.stringify(result.exit)
          || prior.close === true && result.close !== true || prior.error && prior.error !== result.error
          || prior.identity && result.identity && !reportedIdentity(prior.identity, result.identity, prior.role)) throw new Error("Conflicting fixture snapshot")
        if (result.identity) prior.identity = structuredClone(result.identity)
        prior.exit = result.exit; prior.close = result.close; prior.error = result.error
      }
      if (value.result.close === true) value.close()
    },
    unavailable(ref, reason) { find(ref).result.unavailable = reason },
  })
  return scope
}