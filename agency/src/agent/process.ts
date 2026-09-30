import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { AdmissionContext, Reservation } from "../checkout/admission.js"
import { commitLaunchTransition, restoreUninvokedLaunch, type LaunchTransitionIO } from "../handler/launch-transitions.js"
import { refreshLaunchState } from "../handler/mutations.js"
import { agencyLaunchMarker, exactAgencyBirth } from "../platform/launch-marker.js"
import { readLaunchRecordForReconciliation } from "../platform/private-state.js"
import { reconcileRecord } from "../platform/reconcile.js"
import { sameProcess, sameProcessGeneration, type LaunchRecord, type PlatformAdapter, type ProcessIdentity } from "../platform/types.js"
import { createAcpConnection, type AcpConnection } from "./acp.js"
import { prepareProviderState, removeProviderState } from "./state.js"
import type { LaunchContract } from "./contracts.js"
import { AgentError, agentFailure, type AgentFailure, type LaunchSpec, type PromptResult, type SessionEvidence } from "./types.js"

export type OwnedAgentProcess = { initialize(signal: AbortSignal): Promise<SessionEvidence>; prompt(text: string, signal: AbortSignal): Promise<PromptResult>; record(): LaunchRecord; cleanup(): Promise<LaunchRecord>; dispose(): void; fault: Promise<AgentFailure> }

export function createAgentProcess(input: { context: AdmissionContext; reservation: Reservation; spec: LaunchSpec; contract: LaunchContract; deadline?: number; overallDeadline?: number; isReady?(): boolean; revalidate(): Promise<void> }, dependencies: { spawn?: typeof spawn; transitionIO?: LaunchTransitionIO; now?: () => number; removeProviderState?: typeof removeProviderState } = {}): OwnedAgentProcess {
  const { context, spec, contract } = input, { adapter, mutations } = context
  const now = dependencies.now ?? (() => performance.now()), phases = contract.qualification?.deadlines
  let overallDeadline = input.deadline ?? Infinity, spawnDeadline = Infinity
  const directory = join(context.paths.persistentRoot, "launches"), path = join(directory, spec.launchAttemptId + ".json")
  const controller = new AbortController(), marker = agencyLaunchMarker("provider", spec.launchAttemptId)
  let current = structuredClone(input.reservation.launch), spawnInvoked = false, child: ChildProcess | undefined, connection: AcpConnection | undefined
  let initialization: Promise<SessionEvidence> | undefined, preparation: Promise<void> | undefined, cleaning: Promise<LaunchRecord> | undefined
  let terminal = false, closed = false, stopping = false, disposed = false, initialized = false, failure: AgentFailure | undefined
  let resolveFault!: (value: AgentFailure) => void, resolveTerminal!: () => void, resolveClose!: () => void
  const fault = new Promise<AgentFailure>(resolve => { resolveFault = resolve })
  const terminalEvent = new Promise<void>(resolve => { resolveTerminal = resolve }), closeEvent = new Promise<void>(resolve => { resolveClose = resolve })
  const fail = (error: unknown): void => {
    if (!failure) { failure = agentFailure(error); resolveFault(failure) }
    controller.abort()
    if (!stopping) void cleanup().catch(() => undefined)
  }
  const check = (): void => {
    if (stopping || controller.signal.aborted || terminal) throw new AgentError("STARTUP_FAILED")
    if (context.state.handlerGeneration !== spec.handlerGeneration) throw new AgentError("STALE_HANDLER")
    if (context.state.phase !== "ready") throw new AgentError("NOT_READY")
    if (mutations.unavailable !== null) throw new AgentError("ADMISSION_UNAVAILABLE")
    if (now() >= overallDeadline || !connection && now() >= spawnDeadline) throw new AgentError("STARTUP_TIMEOUT")
  }
  const bounded = async <T>(operation: () => Promise<T>, deadline: number, code: "STARTUP_TIMEOUT" | "CLEANUP_UNVERIFIED"): Promise<T> => {
    if (deadline === Infinity) return operation()
    let timer: NodeJS.Timeout | undefined
    try {
      if (now() >= deadline) throw new AgentError(code)
      const value = await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentError(code)), Math.max(1, deadline - now())) })])
      if (now() >= deadline) throw new AgentError(code)
      return value
    } finally { clearTimeout(timer) }
  }
  const snapshot = (): LaunchRecord => structuredClone(mutations.accepted.find(entry => entry.record.launchAttemptId === spec.launchAttemptId)?.record ?? current)
  const transition = async (next: LaunchRecord): Promise<void> => {
    try { await commitLaunchTransition(context, current, next, dependencies.transitionIO) }
    finally { current = snapshot() }
  }
  function registerChildObservers(value: ChildProcess): void {
    value.on("error", () => { terminal = true; resolveTerminal(); if (!stopping) fail(new AgentError("STARTUP_FAILED")) })
    value.once("exit", () => { terminal = true; resolveTerminal(); if (!stopping) fail(new AgentError("STARTUP_FAILED")) })
    value.once("close", () => { closed = true; resolveClose(); if (!stopping) fail(new AgentError("STARTUP_FAILED")) })
    let stderrBytes = 0
    value.stderr?.on("data", (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > spec.limits.stderrBytes && !stopping) fail(new AgentError("STARTUP_FAILED")) })
    for (const stream of [value.stdin, value.stdout, value.stderr]) stream?.on("error", () => { if (!stopping) fail(new AgentError("STARTUP_FAILED")) })
  }
  const spawnOptions: SpawnOptions = {
    argv0: marker, detached: true, shell: false, cwd: spec.checkout.root.path, stdio: ["pipe", "pipe", "pipe"],
    env: {},
  }
  const observe = async (): Promise<{ leader: ProcessIdentity; observed: ProcessIdentity[] }> => {
    if (!child?.pid) throw new AgentError("STARTUP_FAILED")
    const leader = await adapter.readProcess(child.pid), members = await adapter.readGroup(child.pid)
    if (!leader || leader.pid !== child.pid || leader.bootId !== current.launchBootId || !exactAgencyBirth(leader.birth, marker)
      || leader.processGroupId !== child.pid || leader.sessionId !== child.pid || leader.parentPid !== process.pid
      || leader.uid !== process.getuid!() || leader.gid !== process.getgid!()
      || new Set(members.map(member => member.pid)).size !== members.length || !members.some(member => sameProcess(leader, member))
      || members.some(member => member.bootId !== leader.bootId || member.processGroupId !== leader.pid || member.sessionId !== leader.pid || member.uid !== leader.uid || member.gid !== leader.gid)) throw new AgentError("STARTUP_FAILED")
    return { leader, observed: members }
  }
  const waitForCloseOrGrace = async (ms: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([closeEvent, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })]) }
    finally { clearTimeout(timer) }
  }
  const absent = async (deadline: number): Promise<void> => {
    if (current.provider === null || await bounded(() => adapter.bootId(), deadline, "CLEANUP_UNVERIFIED") !== current.launchBootId) return
    for (let pass = 0; pass < 2; pass++) {
      if ((await bounded(() => adapter.readGroup(current.provider!.group.leader.processGroupId), deadline, "CLEANUP_UNVERIFIED")).length) throw new AgentError("CLEANUP_UNVERIFIED")
      for (const retained of current.provider.group.observed) {
        const observed = await bounded(() => adapter.readProcess(retained.pid), deadline, "CLEANUP_UNVERIFIED")
        if (observed && sameProcessGeneration(retained, observed)) throw new AgentError("CLEANUP_UNVERIFIED")
      }
    }
  }
  function cleanup(): Promise<LaunchRecord> {
    if (cleaning) return cleaning
    if (input.isReady?.()) overallDeadline = Infinity
    stopping = true; controller.abort(); connection?.close()
    child?.stdout?.resume(); child?.stderr?.resume()
    let expired = false
    const checkCleanup = (): void => {
      if (expired || overallDeadline !== Infinity && now() >= overallDeadline) throw new AgentError("CLEANUP_UNVERIFIED")
    }
    cleaning = bounded(async () => {
      await preparation?.catch(() => undefined)
      checkCleanup()
      await mutations.queue.run(async () => {
        try {
          checkCleanup()
          await refreshLaunchState(context.state, mutations, directory)
          checkCleanup()
          current = snapshot()
          if (!spawnInvoked && current.launchAttempted && current.provider === null) {
            try { current = await restoreUninvokedLaunch(context, current, { spawnInvoked: false }, dependencies.transitionIO) }
            catch { current = snapshot() }
          }
          checkCleanup()
          const terminationDeadline = Math.min(overallDeadline, now() + (phases?.processTerminateMs ?? 5000))
          const cleanupAdapter: PlatformAdapter = {
            platform: adapter.platform,
            bootId: () => bounded(() => adapter.bootId(), terminationDeadline, "CLEANUP_UNVERIFIED"),
            readProcess: pid => bounded(() => adapter.readProcess(pid), terminationDeadline, "CLEANUP_UNVERIFIED"),
            readGroup: group => bounded(() => adapter.readGroup(group), terminationDeadline, "CLEANUP_UNVERIFIED"),
            signalGroup: (group, signal) => bounded(() => adapter.signalGroup(group, signal), terminationDeadline, "CLEANUP_UNVERIFIED"),
          }
          try {
            const result = await reconcileRecord(path, cleanupAdapter, current)
            current = result.record
            if (!isDeepStrictEqual(await readLaunchRecordForReconciliation(path), current)) throw new AgentError("CLEANUP_UNVERIFIED")
            const entry = mutations.accepted.find(entry => entry.path === path)
            if (!entry) throw new AgentError("CLEANUP_UNVERIFIED")
            entry.record = structuredClone(current)
          } finally { await refreshLaunchState(context.state, mutations, directory) }
          checkCleanup()
          if (current.phase !== "cleanup_verified") throw new AgentError("CLEANUP_UNVERIFIED")
          if (child && !terminal) await bounded(() => terminalEvent, terminationDeadline, "CLEANUP_UNVERIFIED")
          await absent(Math.min(overallDeadline, now() + (phases?.absenceMs ?? 2000)))
          checkCleanup()
          if (child && !closed) await waitForCloseOrGrace(phases?.transportCloseMs ?? 1000)
          checkCleanup()
          if (child) { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy() }
          await (dependencies.removeProviderState ?? removeProviderState)(context.paths.persistentRoot, spec.launchAttemptId)
          checkCleanup()
        } catch {
          mutations.unavailable ??= `provider cleanup unverified: ${spec.launchAttemptId}`
          throw new AgentError("CLEANUP_UNVERIFIED")
        }
      })
      checkCleanup()
      return structuredClone(current)
    }, overallDeadline, "CLEANUP_UNVERIFIED").catch(() => { expired = true; mutations.unavailable ??= `provider cleanup unverified: ${spec.launchAttemptId}`; throw new AgentError("CLEANUP_UNVERIFIED") })
    return cleaning
  }
  return {
    record: snapshot, fault, cleanup,
    prompt(text, signal) {
      if (!initialized || !connection || stopping || disposed || terminal || closed) return Promise.reject(new AgentError("NOT_READY"))
      return connection.prompt(text, signal)
    },
    dispose() {
      if (disposed) return
      disposed = true; stopping = true; controller.abort(); connection?.close()
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref()
    },
    initialize(signal) {
      if (initialization) return initialization
      const abort = (): void => { controller.abort(); if (!stopping) fail(new AgentError("STARTUP_FAILED")) }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) controller.abort()
      overallDeadline = Math.min(overallDeadline, now() + (phases?.overallMs ?? spec.limits.startupMs))
      spawnDeadline = Math.min(overallDeadline, now() + (phases?.spawnMs ?? 5000))
      preparation = mutations.queue.run(async () => {
        check(); await input.revalidate(); check()
        if (await adapter.bootId() !== current.launchBootId) throw new AgentError("CONFIG_CHANGED")
        const prepared = await prepareProviderState(context.paths.persistentRoot, spec.launchAttemptId, contract.environment)
        spawnOptions.env = prepared.environment
        check()
        await transition({ ...current, launchAttempted: true })
        await input.revalidate(); check()
        if (await adapter.bootId() !== current.launchBootId) throw new AgentError("CONFIG_CHANGED")
        check(); spawnInvoked = true
        child = (dependencies.spawn ?? spawn)(process.execPath, [contract.entrypoint], spawnOptions)
        registerChildObservers(child)
        const first = await bounded(observe, spawnDeadline, "STARTUP_TIMEOUT"), second = await bounded(observe, spawnDeadline, "STARTUP_TIMEOUT")
        check()
        if (!sameProcess(first.leader, second.leader) || first.observed.length !== second.observed.length || first.observed.some(member => !second.observed.some(other => sameProcess(member, other)))) throw new AgentError("STARTUP_FAILED")
        await transition({ ...current, phase: "readiness", provider: { kind: "process-group", group: second } })
      })
      initialization = (async () => {
        try {
          await bounded(() => preparation!, spawnDeadline, "STARTUP_TIMEOUT"); check()
          if (!child?.stdin || !child.stdout) throw new AgentError("STARTUP_FAILED")
          connection = createAcpConnection({ readable: child.stdout, writable: child.stdin, limits: spec.limits, deadline: overallDeadline, ...(input.overallDeadline === undefined ? {} : { overallDeadline: input.overallDeadline }), now })
          void connection.fault.then(error => { if (!stopping) fail(new AgentError(error.code)) })
          const session = await connection.initialize(spec, contract, controller.signal)
          check(); initialized = true; if (!input.isReady) overallDeadline = Infinity; return session
        } catch (error) { fail(error); throw error }
        finally { signal.removeEventListener("abort", abort) }
      })()
      return initialization
    },
  }
}