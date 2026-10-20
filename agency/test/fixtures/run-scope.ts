import { randomUUID } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import { sameProcess, type PlatformAdapter, type ProcessIdentity } from "../../src/platform/types.js"

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
  signal(ref: LaunchRef, value: NodeJS.Signals): Promise<void>
  finish(): Promise<FixtureResult>
  snapshot(): FixtureResult
}
type Launch = {
  result: FixtureLaunchResult; child: ChildProcess | null; attempted: boolean; ownGroup: boolean
  closed: Promise<void>; close: () => void; admission: (() => void) | null
  members: ProcessIdentity[]; failed: boolean
}
type Operation = FixtureResult["operations"][number] & { promise: Promise<unknown> }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function createNativeFixtureScope(options: ScopeOptions): FixtureScope {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Unsupported fixture platform")
  return createScope(options, process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter(), (pid, value) => { process.kill(pid, value) })
}
export function createSyntheticFixtureScope(options: ScopeOptions & {
  adapter: PlatformAdapter; signal: (pid: number, value: NodeJS.Signals) => void
}): FixtureScope {
  if (!options.adapter || typeof options.signal !== "function") throw new Error("Synthetic fixtures require paired adapter and signal")
  return createScope(options, options.adapter, options.signal)
}
function createScope(options: ScopeOptions, adapter: PlatformAdapter, sendSignal: (pid: number, value: NodeJS.Signals) => void): FixtureScope {
  if (!options.runId || !options.workerFile || !Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) throw new Error("Invalid fixture scope")
  const launches = new Map<string, Launch>(), operations: Operation[] = [], failures: string[] = [], artifacts = new Set<string>()
  const finalizers: Array<{ label: string; work: () => Promise<void> }> = []
  let phase: "open" | "operations" | "finalizers" | "closed" = "open", pending: Promise<FixtureResult> | undefined
  let until = Infinity
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
  const find = (ref: LaunchRef): Launch => {
    const value = launches.get(ref.launchId)
    if (ref.runId !== options.runId || !value) throw new Error("Unknown fixture launch")
    return value
  }
  const live = (value: Launch) => value.child !== null && value.result.exit === null && value.child.exitCode === null && value.child.signalCode === null
  const closeAdmission = (value: Launch) => {
    const close = value.admission
    value.admission = null
    if (close) try { close() } catch (error) { value.failed = true; fail(value.result.role + " admission", error) }
  }
  const observe = async (ref: LaunchRef): Promise<ProcessIdentity | null> => {
    const value = find(ref)
    try {
      if (!value.attempted) throw new Error("Unspawned fixture identity")
      if (!value.result.pid || !live(value)) return null
      const current = await bounded("observe", () => adapter.readProcess(value.result.pid!))
      if (!live(value)) return null
      if (!current || current.pid !== value.result.pid || current.parentPid !== process.pid || !sameProcess(current, current)
        || value.result.identity && !sameProcess(value.result.identity, current)
        || value.ownGroup && (current.processGroupId !== current.pid || current.sessionId !== current.pid)) throw new Error("Fixture identity mismatch")
      value.result.identity = structuredClone(current)
      return structuredClone(current)
    } catch (error) { value.failed = true; fail(value.result.role + " observation", error); closeAdmission(value); throw error }
  }
  const snapshot = (): FixtureResult => structuredClone({
    version: 1, runId: options.runId, workerFile: options.workerFile,
    state: failures.length || phase !== "closed" ? "incomplete" : "settled",
    launches: [...launches.values()].map(value => value.result),
    operations: operations.map(({ label, state, error }) => ({ label, state, error })),
    failures, artifacts: [...artifacts],
  })
  const scope: FixtureScope = {
    intent(role, input = {}) {
      if (phase === "closed" || phase === "operations" && !operations.some(value => value.state === "pending")) throw new Error("Fixture admission closed")
      const ref = Object.freeze({ runId: options.runId, launchId: randomUUID() })
      let close!: () => void
      const closed = new Promise<void>(resolve => { close = resolve })
      launches.set(ref.launchId, {
        result: { ref, role, ownerId: options.workerFile, pid: null, identity: null, error: null, exit: null, close: null, absent: null, reporting: input.reporting ?? "direct", unavailable: null },
        child: null, attempted: false, ownGroup: input.ownGroup ?? false, closed, close, admission: null, members: [], failed: false,
      })
      return ref
    },
    spawn(ref, work, admission) {
      const value = find(ref)
      if (value.attempted || phase === "closed") throw new Error("Fixture already spawned or closed")
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
    async signal(ref, signal) {
      const value = find(ref)
      try {
        if (!value.attempted || !live(value)) throw new Error("Fixture terminal or missing identity")
        if (!value.result.identity) await observe(ref)
        const expected = value.result.identity
        if (!expected || !live(value)) throw new Error("Fixture missing identity")
        if (await bounded("signal boot", () => adapter.bootId(), 15000) !== expected.bootId) throw new Error("Fixture identity boot mismatch")
        const current = await bounded("signal identity", () => adapter.readProcess(expected.pid), 15000)
        if (!live(value) || !current || !sameProcess(expected, current)) throw new Error("Fixture identity mismatch")
        if (value.ownGroup) {
          const members = await bounded("signal group", () => adapter.readGroup(expected.processGroupId), 15000)
          if (new Set(members.map(member => member.pid)).size !== members.length || !members.some(member => sameProcess(expected, member))
            || members.some(member => member.bootId !== expected.bootId || member.processGroupId !== expected.processGroupId || member.sessionId !== expected.sessionId || member.uid !== expected.uid || member.gid !== expected.gid || !sameProcess(member, member))) throw new Error("Fixture group identity mismatch")
          for (const member of members) if (!value.members.some(prior => sameProcess(prior, member))) value.members.push(structuredClone(member))
          const last = await bounded("signal identity", () => adapter.readProcess(expected.pid), 15000)
          if (!live(value) || !last || !sameProcess(expected, last)) throw new Error("Fixture identity changed")
        }
        sendSignal(value.ownGroup ? -expected.processGroupId : expected.pid, signal)
      } catch (error) { value.failed = true; fail(value.result.role + " signal", error); throw error }
    },
    finish() {
      if (pending) return pending
      phase = "operations"
      until = Date.now() + Math.min(options.deadlineMs, 120000)
      pending = (async () => {
        try { await bounded("operations", async () => { await Promise.allSettled(operations.map(value => value.promise)) }) }
        catch (error) { fail("operations", error) }
        phase = "finalizers"
        await Promise.allSettled(finalizers.map(async value => {
          try { await bounded(value.label, value.work) } catch (error) { fail(value.label, error) }
        }))
        for (const value of launches.values()) if (value.failed) closeAdmission(value)
        await Promise.allSettled([...launches.values()].map(async value => {
          try {
            if (!value.attempted) throw new Error("unspawned intent")
            if (!value.child) return
            if (value.result.reporting !== "direct") throw new Error("reporting source unavailable")
            await bounded(value.result.role + " close", () => value.closed)
            if (!value.result.exit && !(value.result.error && value.result.pid === null)) throw new Error("missing terminal event")
            if (value.result.pid === null) { value.result.absent = true; return }
            const boot = await bounded("absence boot", () => adapter.bootId(), 15000)
            const current = await bounded("absence identity", () => adapter.readProcess(value.result.pid!), 15000)
            if (value.result.identity && boot !== value.result.identity.bootId) throw new Error("absence boot mismatch")
            value.result.absent = current === null || value.result.identity !== null && !sameProcess(value.result.identity, current)
            if (value.ownGroup) {
              const members = await bounded("absence group", () => adapter.readGroup(value.result.pid!), 15000)
              if (members.length) value.result.absent = false
              for (const member of value.members) {
                const observed = await bounded("absence member", () => adapter.readProcess(member.pid), 15000)
                if (observed && sameProcess(member, observed)) value.result.absent = false
              }
            }
            if (!value.result.absent) throw new Error("unresolved absence")
          } catch (error) { fail(value.result.role, error) }
        }))
        phase = "closed"
        return snapshot()
      })()
      return pending
    },
    snapshot,
  }
  return scope
}