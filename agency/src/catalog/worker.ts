import { spawn } from "node:child_process"
import { NativeFacade, type RegisteredChild, type DriverContext } from "./drivers/transport.js"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { observeConfig, parseProfile } from "./config.js"
import { cleanProbeEnvironment, parseProbeResult, type ProbeRequest, type ProbeResult } from "./probes.js"
import { CatalogError, id, invalid, keys, object, parseProbeMeta } from "./types.js"
import { probeFailureDetail, writeProbeStderr, type ProbeStage } from "./diagnostics.js"
import { spawnOwnedChild, type OwnedChild } from "../runtime/owned-child.js"
import { parseWorkerEnvelope, type NativeSettlement, type WorkerBinding } from "./worker-protocol.js"

export type WorkerHost = {
  cwd(): string
  connected(): boolean
  send(message: object): Promise<void>
  on(event: "message" | "disconnect" | "SIGTERM", listener: (...args: any[]) => void): void
  off(event: "message" | "disconnect" | "SIGTERM", listener: (...args: any[]) => void): void
  finish(): void
}
export type WorkerDependencies = { spawn?: typeof spawn; host?: WorkerHost }
const processHost: WorkerHost = {
  cwd: () => process.cwd(), connected: () => !!process.connected,
  send: message => new Promise((resolve, reject) => { process.send!(message, undefined, undefined, (error: Error | null) => error ? reject(error) : resolve()) }),
  on: (event, listener) => { process.on(event, listener) }, off: (event, listener) => { process.off(event, listener) },
  finish() { if (process.connected) process.disconnect() },
}
export async function runWorker(discover: (context: DriverContext) => Promise<ProbeResult>, dependencies: WorkerDependencies = {}): Promise<void> {
  const host = dependencies.host ?? processHost, controller = new AbortController()
  let request: ProbeRequest | undefined, started = false, invoked = false, connected = true, stopping = false, input = 0, output = 0
  let nativeOwner: OwnedChild | undefined, acceptRegistration: (() => void) | undefined, rejectRegistration: (() => void) | undefined
  let binding: WorkerBinding | undefined, stage: ProbeStage = "worker-config"
  let resolveStop!: () => void
  const stopped = new Promise<void>(resolve => { resolveStop = resolve })
  const work: Promise<unknown>[] = [], sends: Promise<void>[] = []
  const stop = (): void => {
    if (stopping) return
    stopping = true; controller.abort(); rejectRegistration?.(); acceptRegistration = undefined
    nativeOwner?.child.stdin?.end()
    resolveStop()
  }
  const send = (value: object): void => {
    if (!binding || !connected || !host.connected()) return
    const message = { ...value, ...binding }
    output += Buffer.byteLength(JSON.stringify(message))
    if (output > 1048576) { connected = false; stop(); return }
    const pending = Promise.resolve().then(() => host.send(message)).catch(() => { connected = false; stop() })
    sends.push(pending)
  }
  const failure = (cause: unknown, at: ProbeStage = stage): void => { send({ type: "failure", detail: probeFailureDetail(at, cause) }); stop() }
  const spawnNative = (file: string, args: readonly string[]): RegisteredChild => {
    if (!request || stopping || !connected || controller.signal.aborted || invoked || file !== request.profile.executable || !Array.isArray(args) || args.some(a => typeof a !== "string" || a.includes("\0"))) throw new CatalogError("PROBE_FAILED")
    stage = "native-launch"
    send({ type: "native-command", command: { file, args } })
    const registration = new Promise<void>((resolve, reject) => { acceptRegistration = resolve; rejectRegistration = () => reject(new CatalogError("PROBE_FAILED")) })
    void registration.catch(() => undefined)
    invoked = true
    nativeOwner = spawnOwnedChild({
      launchAttemptId: request.meta.attemptId,
      spawn: () => (dependencies.spawn ?? spawn)(file, [...args], { detached: false, shell: false, cwd: request!.meta.workPath, env: cleanProbeEnvironment(process.env), stdio: ["pipe", "pipe", "pipe"] }),
      onEvent: event => {
        if (event.kind === "error") failure(event.error, "native-launch")
        if (event.kind === "exit") send({ type: "native-terminal", terminal: { code: event.code, signal: event.signal } })
        if (event.kind === "close") { send({ type: "native-closed" }); rejectRegistration?.() }
      },
    })
    const child = nativeOwner.child
    let stdout = 0
    child.stderr!.on("error", cause => failure(cause, "native-stream"))
    child.stderr!.on("data", (bytes: Buffer) => { try { writeProbeStderr(4, bytes) } catch (cause) { failure(cause, "diagnostic-write") } })
    child.stdout!.on("data", (bytes: Buffer) => { stdout += bytes.length; if (stdout > 1048576) failure(new CatalogError("PROBE_FAILED"), "native-stream") })
    const facade = new NativeFacade(nativeOwner, registration, () => { send({ type: "cancel" }); stop() })
    if (child.pid !== undefined) { stage = "native-registration"; send({ type: "native", pid: child.pid }) }
    return facade
  }
  const message = (raw: unknown): void => {
    const admitted = (async () => {
      input += Buffer.byteLength(JSON.stringify(raw))
      if (input > 1048576) invalid()
      const v = parseWorkerEnvelope(raw, binding)
      if (v.type === "start") {
        keys(v, ["type", "attemptId", "generation", "request"])
        if (started || stopping || !connected) invalid()
        started = true; binding = { attemptId: id(v.attemptId), generation: id(v.generation) }
        const r = object(v.request); keys(r, ["meta", "profile", "evidence"])
        const meta = parseProbeMeta(r.meta), profile = parseProfile(r.profile), evidence = await observeConfig(profile)
        if (meta.attemptId !== binding.attemptId || meta.handlerGeneration !== binding.generation || meta.workPath !== host.cwd() || meta.providerId !== profile.id || meta.fingerprint !== evidence.fingerprint || !isDeepStrictEqual(r.evidence, evidence)) invalid()
        if (stopping) return
        request = { meta, profile, evidence }; stage = "discovery"
        const result = await discover({ request, signal: controller.signal, spawnNative })
        if (stopping) return
        if (!invoked) throw new CatalogError("PROBE_FAILED")
        send({ type: "result", result: parseProbeResult(result, profile.id) })
      } else if (v.type === "registered") {
        keys(v, ["type", "attemptId", "generation", "pid"])
        if (stopping) return
        if (typeof v.pid !== "number" || !Number.isSafeInteger(v.pid) || v.pid <= 0 || !request || !nativeOwner || nativeOwner.child.pid !== v.pid || nativeOwner.snapshot().terminal || nativeOwner.snapshot().closed || !acceptRegistration) invalid()
        acceptRegistration(); acceptRegistration = undefined; stage = "discovery"
      } else if (v.type === "stop") {
        keys(v, ["type", "attemptId", "generation"])
        if (!binding) invalid()
        stop()
      } else invalid()
    })().catch(cause => failure(cause))
    work.push(admitted)
  }
  const disconnect = () => { connected = false; stop() }
  host.on("message", message); host.on("disconnect", disconnect); host.on("SIGTERM", stop)
  await stopped
  for (let drained = 0; drained < work.length;) { const batch = work.slice(drained); drained = work.length; await Promise.allSettled(batch) }
  let settlement: NativeSettlement | undefined
  if (nativeOwner) {
    const [terminal] = await Promise.all([nativeOwner.terminal, nativeOwner.closed])
    settlement = terminal.kind === "spawn-error" ? nativeOwner.child.pid === undefined ? { kind: "spawn-error" } : undefined
      : nativeOwner.child.pid === undefined ? undefined : { kind: "exit", pid: nativeOwner.child.pid, code: terminal.code, signal: terminal.signal }
    nativeOwner.release()
  } else if (!invoked) settlement = { kind: "not-spawned" }
  await Promise.allSettled(sends)
  if (settlement && connected && host.connected()) send({ type: "native-settled", native: settlement })
  await Promise.allSettled(sends)
  host.off("message", message); host.off("disconnect", disconnect); host.off("SIGTERM", stop)
  host.finish()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runWorker(async context => {
  if (context.request.profile.id === "claude-agent-acp") return (await import("./drivers/claude.js")).discoverClaude(context)
  return (await import("./drivers/codex.js")).discoverCodex(context)
})