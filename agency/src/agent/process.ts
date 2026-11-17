import { STDERR_TAIL_BYTES, failureIdentifier, underlyingFailureCode, type ProcessFailureEvent } from "./failure-diagnostics.js"
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import type { ProcessContext } from "../live/context.js"
import { agencyLaunchMarker } from "../platform/launch-marker.js"
import { spawnOwnedChild, type OwnedChild } from "../runtime/owned-child.js"
import { captureLiveProcess, LiveProcessError, type LiveProcessGroup, type LiveCleanupEvidence } from "../platform/live-process.js"
import type { ManagedLaunchRecord } from "../platform/types.js"
import { createAcpConnection, type AcpConnection, type DroppedUpdate, type ProviderSession } from "./acp.js"
import type { AcpObservation } from "./session-events.js"
import { cleanupBudget, type ConfiguredLaunchContract } from "./contracts.js"
import { parseLaunchEnvironment, type LaunchEnvironment } from "./environment.js"
import { AgentError, agentFailure, type AgentRecordV3, type SessionStart, type AgentFailure, type LaunchSpec } from "./types.js"
import type { JsonObject, SessionConfiguration } from "./session-config.js"
const PARENT_WATCH = new URL("./parent-watch.js", import.meta.url).href

export type OwnedAgentProcess = { initialize(signal: AbortSignal): Promise<ProviderSession>; request(method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject>; notify(method: string, params: JsonObject): void; respond(id: string | number, result: JsonObject): Promise<void>; snapshot(): SessionConfiguration; cancelPrompt(): Promise<void>; record(): ManagedLaunchRecord; markActive(): void; cleanup(): Promise<void>; dispose(): void; discharged: Promise<void>; fault: Promise<AgentFailure> }
export type AgentProcessSpec = Pick<LaunchSpec, "agentId" | "handlerGeneration" | "providerGeneration" | "launchAttemptId" | "cwd" | "limits">
export type AgentProcessDependencies = { spawn?: typeof spawn; now?: () => number; onSpawnInputReleased?(): void }

export function createAgentProcess(input: { context: ProcessContext; spec: AgentProcessSpec; agentRecord: AgentRecordV3; args?: string[]; session?: SessionStart; environment: LaunchEnvironment; contract: ConfiguredLaunchContract; deadline?: number; overallDeadline?: number; isReady?(): boolean; onUpdate?(event: AcpObservation): void; onRequest?(message: JsonObject): void; onDropped?(value: DroppedUpdate): void; revalidate(): Promise<void>; awaitExitOnStartupFault?: boolean }, dependencies: AgentProcessDependencies = {}): OwnedAgentProcess {
  const { context, spec, contract, isReady, revalidate, deadline, overallDeadline: configuredOverallDeadline, awaitExitOnStartupFault } = input, { adapter } = context
  const now = dependencies.now ?? (() => performance.now()), phases = contract.deadlines
  let overallDeadline = deadline ?? Infinity, spawnDeadline = Infinity
  const controller = new AbortController(), marker = agencyLaunchMarker("provider", spec.launchAttemptId)
  let current: ManagedLaunchRecord = { version: 2, owner: { kind: "agent", agentId: spec.agentId, providerGeneration: spec.providerGeneration }, handlerGeneration: spec.handlerGeneration, launchAttemptId: spec.launchAttemptId, launchBootId: "pending", launchAttempted: false, phase: "launch_pending", provider: null, reason: null }
  let spawnInvoked = false, child: ChildProcess | undefined, connection: AcpConnection | undefined
  let startup: { agentRecord: typeof input.agentRecord; session: typeof input.session; onUpdate: typeof input.onUpdate; onRequest: typeof input.onRequest; onDropped: typeof input.onDropped } | undefined = { agentRecord: input.agentRecord, session: input.session, onUpdate: input.onUpdate, onRequest: input.onRequest, onDropped: input.onDropped }
  let spawnArgs = input.args
  const discharged = Promise.withResolvers<void>()
  let initialization: Promise<ProviderSession> | undefined, preparation: Promise<void> | undefined, cleaning: Promise<void> | undefined
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
    env: { ...parseLaunchEnvironment(input.environment), ...(contract.providerId === "codex-acp" ? { CODEX_PATH: contract.executable } : { CLAUDE_CODE_EXECUTABLE: contract.executable }), AGENCY_PARENT_PID: String(process.pid) },
  }
  function cleanup(): Promise<void> {
    if (cleaning) return cleaning
    const cleanupDeadline = now() + cleanupBudget(contract)
    stopping = true; controller.abort(); connection?.close()
    child?.stdout?.resume(); child?.stderr?.resume()
    let expired = false
    const checkCleanup = (): void => {
      if (expired || now() >= cleanupDeadline) throw new AgentError("CLEANUP_UNVERIFIED")
    }
    const stopCapturedGroup = async (): Promise<void> => {
      if (!liveGroup) return
      if (current.phase !== "cleanup_verified") current = { ...current, phase: "cleanup_pending", provider: { kind: "process-group", group: liveGroup.identity() } }
      cleanupEvidence ??= await liveGroup.cleanup({ deadline: cleanupDeadline, terminateMs: phases.processTerminateMs, absenceMs: phases.absenceMs, transportCloseMs: phases.transportCloseMs, retry: true })
      checkCleanup()
      discharged.resolve()
    }
    cleaning = bounded(async () => {
      await stopCapturedGroup()
      await bounded(() => preparation?.catch(() => undefined) ?? Promise.resolve(), cleanupDeadline, "CLEANUP_UNVERIFIED")
      checkCleanup()
      if (!spawnInvoked) { discharged.resolve(); current = { ...current, launchAttempted: false, phase: "cleanup_verified" }; return }
      if (!owned || !liveGroup) throw new AgentError("CLEANUP_UNVERIFIED")
      await stopCapturedGroup()
      checkCleanup()
      current = { ...current, phase: "cleanup_verified", provider: { kind: "process-group", group: cleanupEvidence!.group } }
    }, cleanupDeadline, "CLEANUP_UNVERIFIED").catch(error => {
      expired = true; cleaning = undefined
      throw new AgentError("CLEANUP_UNVERIFIED", error instanceof LiveProcessError ? { boundary: "provider_cleanup", causeCode: error.reason } : error instanceof AgentError ? error.diagnostic : undefined)
    })
    return cleaning
  }
  return {
    record: () => structuredClone(current), fault, cleanup, discharged: discharged.promise,
    markActive() { if (current.phase === "readiness") current = { ...current, phase: "active" } },
    request(method, params, signal) { if (!initialized || !connection || stopping || disposed || ended()) return Promise.reject(new AgentError("NOT_READY")); return connection.request(method, params, signal) },
    notify(method, params) { if (!initialized || !connection || stopping || disposed || ended()) throw new AgentError("NOT_READY"); connection.notify(method, params) },
    respond(id, result) { if (!initialized || !connection || stopping || disposed || ended()) throw new AgentError("NOT_READY"); return connection.respond(id, result) },
    snapshot() { if (!connection) throw new AgentError("NOT_READY"); return connection.snapshot() },
    cancelPrompt() {
      if (!initialized || !connection || stopping || disposed || ended()) return Promise.reject(new AgentError("NOT_READY"))
      return connection.cancelPrompt()
    },
    dispose() {
      if (disposed) return
      disposed = true; stopping = true; controller.abort(); connection?.close()
      connection = undefined; initialization = undefined; startup = undefined; spawnOptions = undefined; spawnArgs = undefined
      stderrTail = Buffer.alloc(0)
      if (owned && !owned.release()) {
        owned.abandon("fatal process owner disposal")
        if (!failure) { failure = agentFailure(new AgentError("CLEANUP_UNVERIFIED")); resolveFault(failure) }
      }
    },
    initialize(signal) {
      if (disposed || stopping || !startup && !initialization) return Promise.reject(new AgentError("NOT_READY"))
      if (initialization) return initialization
      let start: typeof startup = startup!
      startup = undefined
      const abort = (): void => { controller.abort(); if (!stopping) fail(new AgentError("STARTUP_FAILED")) }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) controller.abort()
      overallDeadline = Math.min(overallDeadline, now() + (phases?.overallMs ?? spec.limits.startupMs))
      spawnDeadline = Math.min(overallDeadline, now() + (phases?.spawnMs ?? 5000))
      const prepared = (async () => {
        check(); await revalidate(); check()
        current = { ...current, launchBootId: await adapter.bootId() }
        check()
        current = { ...current, launchAttempted: true }
        await revalidate(); check()
        if (await adapter.bootId() !== current.launchBootId) throw new AgentError("CONFIG_CHANGED")
        check(); spawnInvoked = true
        if (!spawnOptions) throw new AgentError("STARTUP_FAILED")
        try {
          owned = spawnOwnedChild({ launchAttemptId: spec.launchAttemptId,
            spawn: () => (dependencies.spawn ?? spawn)(process.execPath, ["--import", PARENT_WATCH, contract.entrypoint, ...spawnArgs ?? []], spawnOptions!),
            onEvent: event => {
              if (event.kind === "error") processFailure("error", event.error)
              else processFailure(event.kind, undefined, event.code, event.signal)
            },
          })
        } finally { spawnOptions = undefined; spawnArgs = undefined; dependencies.onSpawnInputReleased?.() }
        child = owned.child
        registerStreams(child)
        try { liveGroup = await captureLiveProcess({ owner: owned, adapter, launchBootId: current.launchBootId, marker, deadline: spawnDeadline, now }) }
        catch (error) { throw error instanceof LiveProcessError ? new AgentError(error.reason === "deadline" ? "STARTUP_TIMEOUT" : "STARTUP_FAILED") : error }
        check()
        current = { ...current, phase: "readiness", provider: { kind: "process-group", group: liveGroup.identity() } }
      })()
      preparation = prepared
      const releasePreparation = (): void => { if (preparation === prepared) preparation = undefined; spawnOptions = undefined; spawnArgs = undefined }
      void prepared.then(releasePreparation, releasePreparation)
      initialization = (async () => {
        try {
          await bounded(() => prepared, spawnDeadline, "STARTUP_TIMEOUT"); check()
          if (!child?.stdin || !child.stdout) throw new AgentError("STARTUP_FAILED")
          connection = createAcpConnection({ readable: child.stdout, writable: child.stdin, limits: spec.limits, deadline: overallDeadline, ...(configuredOverallDeadline === undefined ? {} : { overallDeadline: configuredOverallDeadline }), ...(start!.onUpdate ? { onUpdate: start!.onUpdate } : {}), ...(start!.onRequest ? { onRequest: start!.onRequest } : {}), ...(start!.onDropped ? { onDropped: start!.onDropped } : {}), now })
          void connection.fault.then(async error => {
            if (awaitExitOnStartupFault && error.code === "STARTUP_FAILED" && owned) await Promise.race([owned.terminal, new Promise(resolve => setTimeout(resolve, 500))])
            if (!stopping) fail(new AgentError(error.code, error.diagnostic ?? { boundary: "acp_transport", causeCode: error.code }))
          })
          const evidence = await connection.initialize(start!.agentRecord!, contract, start!.session ?? { kind: "new", params: {} }, controller.signal)
          check(); initialized = true; if (!isReady) overallDeadline = Infinity; return evidence
        } catch (error) {
          fail(new AgentError(error instanceof AgentError ? error.code : "INTERNAL", error instanceof AgentError && error.diagnostic ? error.diagnostic : { boundary: "provider_initialize", causeCode: underlyingFailureCode(error) }))
          throw new AgentError(failure!.code, failure!.diagnostic)
        }
        finally { start = undefined; signal.removeEventListener("abort", abort) }
      })()
      return initialization
    },
  }
}