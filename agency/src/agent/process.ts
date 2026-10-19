import { STDERR_TAIL_BYTES, failureIdentifier, underlyingFailureCode, type ProcessFailureEvent } from "./failure-diagnostics.js"
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { beginOwnedCleanup, finishOwnedCleanup, finishUnspawnedCleanup, commitLaunchTransition, type LaunchContext, type LaunchTransitionIO } from "../handler/launch-transitions.js"
import { summarizeLaunches } from "../handler/inventory.js"
import { agencyLaunchMarker } from "../platform/launch-marker.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../platform/private-state.js"
import { spawnOwnedChild, type OwnedChild } from "../runtime/owned-child.js"
import { captureLiveProcess, LiveProcessError, type LiveProcessGroup, type LiveCleanupEvidence } from "../platform/live-process.js"
import { type LaunchRecord, type ManagedLaunchRecord } from "../platform/types.js"
import { createAcpConnection, type AcpConnection, type ProviderSession } from "./acp.js"
import type { AcpObservation, TurnOptions } from "./session-events.js"
import { cleanupBudget, type ConfiguredLaunchContract } from "./contracts.js"
import { parseLaunchEnvironment, type LaunchEnvironment } from "./environment.js"
import { AgentError, agentFailure, splitLaunchSpec, type AgentRecordV3, type SessionStart, type AgentFailure, type LaunchSpec, type PromptResult } from "./types.js"
import type { JsonObject, SessionConfiguration } from "./session-config.js"

export type OwnedAgentProcess = { initialize(signal: AbortSignal): Promise<ProviderSession>; request(method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject>; notify(method: string, params: JsonObject): void; respond(id: string | number, result: JsonObject): Promise<void>; snapshot(): SessionConfiguration; prompt(text: string, signal: AbortSignal, limits?: TurnOptions): Promise<PromptResult>; cancelPrompt(): Promise<void>; record(): LaunchRecord; cleanup(): Promise<LaunchRecord>; dispose(): void; fault: Promise<AgentFailure> }
export type AgentProcessSpec = Pick<LaunchSpec, "agentId" | "handlerGeneration" | "providerGeneration" | "launchAttemptId" | "cwd" | "limits">
export type AgentProcessDependencies = { spawn?: typeof spawn; transitionIO?: LaunchTransitionIO; now?: () => number; onSpawnInputReleased?(): void }

export function createAgentProcess(input: { context: LaunchContext; spec: AgentProcessSpec; agentRecord?: AgentRecordV3; args?: string[]; session?: SessionStart; environment: LaunchEnvironment; contract: ConfiguredLaunchContract; deadline?: number; overallDeadline?: number; isReady?(): boolean; onUpdate?(event: AcpObservation): void; onRequest?(message: JsonObject): void; revalidate(): Promise<void> }, dependencies: AgentProcessDependencies = {}): OwnedAgentProcess {
  const { context, spec, contract, session, isReady, revalidate, deadline, overallDeadline: configuredOverallDeadline } = input, { adapter, mutations } = context
  const now = dependencies.now ?? (() => performance.now()), phases = contract.deadlines
  let overallDeadline = deadline ?? Infinity, spawnDeadline = Infinity
  const directory = join(context.paths.persistentRoot, "launches"), path = join(directory, spec.launchAttemptId + ".json")
  const controller = new AbortController(), marker = agencyLaunchMarker("provider", spec.launchAttemptId)
  let current: ManagedLaunchRecord = { version: 2, owner: { kind: "agent", agentId: spec.agentId, providerGeneration: spec.providerGeneration }, handlerGeneration: spec.handlerGeneration, launchAttemptId: spec.launchAttemptId, launchBootId: "pending", launchAttempted: false, phase: "launch_pending", provider: null, reason: null }
  let published = false, spawnInvoked = false, child: ChildProcess | undefined, connection: AcpConnection | undefined
  let initialization: Promise<ProviderSession> | undefined, preparation: Promise<void> | undefined, cleaning: Promise<LaunchRecord> | undefined
  let owned: OwnedChild | undefined, liveGroup: LiveProcessGroup | undefined, cleanupEvidence: LiveCleanupEvidence | undefined
  let stopping = false, disposed = false, initialized = false, failure: AgentFailure | undefined
  let resolveFault!: (value: AgentFailure) => void
  const fault = new Promise<AgentFailure>(resolve => { resolveFault = resolve })
  const ended = () => !!owned?.snapshot().terminal || !!owned?.snapshot().closed
  const fail = (error: unknown): void => {
    if (!failure) { failure = agentFailure(error); resolveFault(failure) }
    controller.abort()
    if (!stopping) void cleanup().catch(() => undefined)
  }
  const check = (): void => {
    if (stopping || controller.signal.aborted || ended()) throw new AgentError("STARTUP_FAILED")
    if (context.state.handlerGeneration !== spec.handlerGeneration) throw new AgentError("STALE_HANDLER")
    if (context.state.phase !== "ready") throw new AgentError("NOT_READY")
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
  const snapshot = (): ManagedLaunchRecord => structuredClone(mutations.accepted.find(entry => entry.record.launchAttemptId === spec.launchAttemptId)?.record as ManagedLaunchRecord ?? current)
  const transition = async (next: ManagedLaunchRecord): Promise<void> => {
    try { await commitLaunchTransition(context, current, next, dependencies.transitionIO) }
    finally { current = snapshot() }
  }
  let stderrBytes = 0, stderrTail: Buffer = Buffer.alloc(0)
  const processFailure = (event: ProcessFailureEvent, error?: unknown, exitCode: number | null = null, signal: string | null = null): void => {
    if (!stopping) fail(new AgentError("STARTUP_FAILED", { boundary: "provider_process", event, causeCode: underlyingFailureCode(error), exitCode, signal: failureIdentifier(signal), stderrBytes, stderrTailBase64: stderrTail.toString("base64") }))
  }
  function registerStreams(value: ChildProcess): void {
    value.stderr?.on("data", (bytes: Buffer) => {
      if (stopping) return
      stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + bytes.length)
      stderrTail = bytes.length >= STDERR_TAIL_BYTES ? Buffer.from(bytes.subarray(-STDERR_TAIL_BYTES)) : Buffer.concat([stderrTail.subarray(Math.max(0, stderrTail.length + bytes.length - STDERR_TAIL_BYTES)), bytes])
    })
    for (const [stream, event] of [[value.stdin, "stdin_error"], [value.stdout, "stdout_error"], [value.stderr, "stderr_error"]] as const) stream?.on("error", error => processFailure(event, error))
  }
  let spawnOptions: SpawnOptions | undefined = {
    argv0: marker, detached: true, shell: false, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"],
    env: { ...parseLaunchEnvironment(input.environment), ...(input.agentRecord ? {} : { CODEX_PATH: contract.executable }) },
  }
  function cleanup(): Promise<LaunchRecord> {
    if (cleaning) return cleaning
    const budget = cleanupBudget(contract), readyForCleanup = isReady?.() ?? initialized
    const computed = readyForCleanup ? now() + budget : Math.min(overallDeadline + budget, now() + budget)
    const cleanupDeadline = Number.isFinite(computed) ? computed : now() + budget
    stopping = true; controller.abort(); connection?.close()
    child?.stdout?.resume(); child?.stderr?.resume()
    let expired = false
    const checkCleanup = (): void => {
      if (expired || now() >= cleanupDeadline) throw new AgentError("CLEANUP_UNVERIFIED")
    }
    const publishCleanup = async (operation: () => Promise<ManagedLaunchRecord>): Promise<void> => {
      await bounded(() => mutations.queue.run(async () => {
        checkCleanup()
        current = snapshot()
        try { current = await operation() }
        finally { current = snapshot() }
        checkCleanup()
      }), cleanupDeadline, "CLEANUP_UNVERIFIED")
    }
    cleaning = bounded(async () => {
      await bounded(() => preparation?.catch(() => undefined) ?? Promise.resolve(), cleanupDeadline, "CLEANUP_UNVERIFIED")
      checkCleanup()
      if (!published && !spawnInvoked) return structuredClone(current)
      if (!spawnInvoked) {
        await publishCleanup(() => finishUnspawnedCleanup(context, current, { spawnInvoked: false }, dependencies.transitionIO))
      } else {
        if (!owned || !liveGroup) throw new AgentError("CLEANUP_UNVERIFIED")
        const group = liveGroup
        if (!cleanupEvidence) {
          let publicationFailure: unknown
          try { await publishCleanup(() => beginOwnedCleanup(context, current, group, dependencies.transitionIO)) }
          catch (error) { publicationFailure = error }
          checkCleanup()
          cleanupEvidence = await group.cleanup({ deadline: cleanupDeadline, terminateMs: phases.processTerminateMs, absenceMs: phases.absenceMs, transportCloseMs: phases.transportCloseMs, retry: true })
          checkCleanup()
          if (publicationFailure) throw publicationFailure
        }
        if (snapshot().phase !== "cleanup_verified" && snapshot().phase !== "cleanup_pending") {
          await publishCleanup(() => beginOwnedCleanup(context, current, group, dependencies.transitionIO))
        }
        await publishCleanup(() => finishOwnedCleanup(context, current, group, cleanupEvidence!, dependencies.transitionIO))
      }
      checkCleanup()
      return structuredClone(current)
    }, cleanupDeadline, "CLEANUP_UNVERIFIED").catch(() => { expired = true; cleaning = undefined; throw new AgentError("CLEANUP_UNVERIFIED") })
    return cleaning
  }
  return {
    record: snapshot, fault, cleanup,
    request(method, params, signal) { if (!initialized || !connection || stopping || disposed || ended()) return Promise.reject(new AgentError("NOT_READY")); return connection.request(method, params, signal) },
    notify(method, params) { if (!initialized || !connection || stopping || disposed || ended()) throw new AgentError("NOT_READY"); connection.notify(method, params) },
    respond(id, result) { if (!initialized || !connection || stopping || disposed || ended()) throw new AgentError("NOT_READY"); return connection.respond(id, result) },
    snapshot() { if (!connection) throw new AgentError("NOT_READY"); return connection.snapshot() },
    prompt(text, signal, limits) {
      if (!initialized || !connection || stopping || disposed || ended()) return Promise.reject(new AgentError("NOT_READY"))
      return connection.prompt(text, signal, limits)
    },
    cancelPrompt() {
      if (!initialized || !connection || stopping || disposed || ended()) return Promise.reject(new AgentError("NOT_READY"))
      return connection.cancelPrompt()
    },
    dispose() {
      if (disposed) return
      disposed = true; stopping = true; controller.abort(); connection?.close()
      if (owned && !owned.release()) {
        owned.abandon("fatal process owner disposal")
        if (!failure) { failure = agentFailure(new AgentError("CLEANUP_UNVERIFIED")); resolveFault(failure) }
      }
    },
    initialize(signal) {
      if (initialization) return initialization
      const abort = (): void => { controller.abort(); if (!stopping) fail(new AgentError("STARTUP_FAILED")) }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) controller.abort()
      overallDeadline = Math.min(overallDeadline, now() + (phases?.overallMs ?? spec.limits.startupMs))
      spawnDeadline = Math.min(overallDeadline, now() + (phases?.spawnMs ?? 5000))
      preparation = mutations.queue.run(async () => {
        check(); await revalidate(); check()
        current = { ...current, launchBootId: await adapter.bootId() }
        if (mutations.accepted.some(entry => entry.record.launchAttemptId === spec.launchAttemptId) || mutations.issues?.some(issue => issue.launchAttemptId === spec.launchAttemptId)) throw new AgentError("INVALID_AGENT_STATE")
        try { await writeLaunchRecord(path, current) }
        finally {
          try {
            const visible = await readLaunchRecordForReconciliation(path)
            if (isDeepStrictEqual(visible, current)) {
              mutations.accepted.push({ path, record: structuredClone(current) })
              published = true
            }
          } catch { }
          context.state.launches = summarizeLaunches(mutations.accepted.map(entry => entry.record))
        }
        if (!published || mutations.issues?.some(issue => issue.path === path)) throw new AgentError("UNAVAILABLE")
        check()
        await transition({ ...current, launchAttempted: true })
        await revalidate(); check()
        if (await adapter.bootId() !== current.launchBootId) throw new AgentError("CONFIG_CHANGED")
        check(); spawnInvoked = true
        const options = spawnOptions
        if (!options) throw new AgentError("STARTUP_FAILED")
        spawnOptions = undefined
        dependencies.onSpawnInputReleased?.()
        owned = spawnOwnedChild({ launchAttemptId: spec.launchAttemptId,
          spawn: () => (dependencies.spawn ?? spawn)(process.execPath, [contract.entrypoint, ...input.args ?? []], options),
          onEvent: event => {
            if (event.kind === "error") processFailure("error", event.error)
            else processFailure(event.kind, undefined, event.code, event.signal)
          },
        })
        child = owned.child
        registerStreams(child)
        try { liveGroup = await captureLiveProcess({ owner: owned, adapter, launchBootId: current.launchBootId, marker, deadline: spawnDeadline, now }) }
        catch (error) { throw error instanceof LiveProcessError ? new AgentError(error.reason === "deadline" ? "STARTUP_TIMEOUT" : "STARTUP_FAILED") : error }
        check()
        await transition({ ...current, phase: "readiness", provider: { kind: "process-group", group: liveGroup.identity() } })
      })
      initialization = (async () => {
        try {
          await bounded(() => preparation!, spawnDeadline, "STARTUP_TIMEOUT"); check()
          if (!child?.stdin || !child.stdout) throw new AgentError("STARTUP_FAILED")
          connection = createAcpConnection({ readable: child.stdout, writable: child.stdin, limits: spec.limits, deadline: overallDeadline, ...(configuredOverallDeadline === undefined ? {} : { overallDeadline: configuredOverallDeadline }), ...(input.onUpdate ? { onUpdate: input.onUpdate } : {}), ...(input.onRequest ? { onRequest: input.onRequest } : {}), now })
          void connection.fault.then(error => { if (!stopping) fail(new AgentError(error.code, error.diagnostic ?? { boundary: "acp_transport", causeCode: error.code })) })
          const evidence = await connection.initialize(input.agentRecord ?? { version: 2, ...splitLaunchSpec(spec as LaunchSpec), phase: "starting", session: null, failure: null }, contract, session ?? { kind: "new", params: {} }, controller.signal)
          check(); initialized = true; if (!isReady) overallDeadline = Infinity; return evidence
        } catch (error) {
          fail(new AgentError(error instanceof AgentError ? error.code : "INTERNAL", error instanceof AgentError && error.diagnostic ? error.diagnostic : { boundary: "provider_initialize", causeCode: underlyingFailureCode(error) }))
          throw new AgentError(failure!.code, failure!.diagnostic)
        }
        finally { signal.removeEventListener("abort", abort) }
      })()
      return initialization
    },
  }
}