import { spawn, type ChildProcess } from "node:child_process"
import { NativeFacade, type RegisteredChild, type DriverContext } from "./drivers/transport.js"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { observeConfig, parseProfile } from "./config.js"
import { cleanProbeEnvironment, parseProbeResult, type ProbeRequest, type ProbeResult } from "./probes.js"
import { CatalogError, id, invalid, keys, object, parseProbeMeta } from "./types.js"


export async function runWorker(discover: (context: DriverContext) => Promise<ProbeResult>): Promise<void> {
  const controller = new AbortController()
  let request: ProbeRequest | undefined, started = false, spawned = false, connected = true, stopping = false, exit = false, close = false, input = 0, output = 0
  let child: ChildProcess | undefined, acceptRegistration: (() => void) | undefined, rejectRegistration: (() => void) | undefined
  const send = (value: object): void => {
    if (!request || !connected || !process.connected) return
    const message = { ...value, attemptId: request.meta.attemptId, generation: request.meta.handlerGeneration }
    output += Buffer.byteLength(JSON.stringify(message))
    if (output > 1048576) { controller.abort(); return }
    try { process.send!(message, undefined, undefined, (error: Error | null) => { if (error) { connected = false; controller.abort(); rejectRegistration?.() } }) }
    catch { connected = false; controller.abort(); rejectRegistration?.() }
  }
  const failure = (): void => { controller.abort(); rejectRegistration?.(); send({ type: "failure" }) }
  const finishTerm = (): void => { if (stopping && (!spawned || exit && close)) process.exit(0) }
  const spawnNative = (file: string, args: readonly string[]): RegisteredChild => {
    if (!request || !connected || controller.signal.aborted || spawned || file !== request.profile.executable || !Array.isArray(args) || args.some(a => typeof a !== "string" || a.includes("\0"))) throw new CatalogError("PROBE_FAILED")
    spawned = true
    const registration = new Promise<void>((resolve, reject) => { acceptRegistration = resolve; rejectRegistration = () => reject(new CatalogError("PROBE_FAILED")) })
    void registration.catch(() => undefined)
    child = spawn(file, [...args], { detached: false, shell: false, cwd: request.meta.workPath, env: cleanProbeEnvironment(process.env), stdio: ["pipe", "pipe", "pipe"] })
    child.on("error", failure)
    child.on("exit", () => { exit = true; send({ type: "native-terminal" }); finishTerm() })
    child.on("close", () => { close = true; rejectRegistration?.(); finishTerm() })
    let stderr = 0, stdout = 0
    child.stderr!.on("data", (bytes: Buffer) => { stderr += bytes.length; if (stderr > 8192) failure() })
    child.stdout!.on("data", (bytes: Buffer) => { stdout += bytes.length; if (stdout > 1048576) failure() })
    const facade = new NativeFacade(child, registration, () => send({ type: "cancel" }))
    if (child.pid === undefined) failure()
    else send({ type: "native", pid: child.pid })
    return facade
  }
  process.on("message", raw => {
    void (async () => {
      input += Buffer.byteLength(JSON.stringify(raw))
      if (input > 1048576) invalid()
      const v = object(raw)
      id(v.attemptId); id(v.generation)
      if (v.type === "start") {
        keys(v, ["type", "attemptId", "generation", "request"])
        if (started || controller.signal.aborted || !connected) invalid()
        started = true
        const r = object(v.request)
        keys(r, ["meta", "profile", "evidence"])
        const meta = parseProbeMeta(r.meta), profile = parseProfile(r.profile), evidence = await observeConfig(profile)
        if (meta.attemptId !== v.attemptId || meta.handlerGeneration !== v.generation || meta.workPath !== process.cwd() || meta.providerId !== profile.id || meta.fingerprint !== evidence.fingerprint || !isDeepStrictEqual(r.evidence, evidence)) invalid()
        request = { meta, profile, evidence }
        const result = await discover({ request, signal: controller.signal, spawnNative })
        if (!spawned || controller.signal.aborted) throw new CatalogError("PROBE_FAILED")
        send({ type: "result", result: parseProbeResult(result, profile.id) })
      } else if (v.type === "registered") {
        keys(v, ["type", "attemptId", "generation", "pid"])
        if (!request || v.attemptId !== request.meta.attemptId || v.generation !== request.meta.handlerGeneration || !child || child.pid !== v.pid || exit || close || !acceptRegistration) invalid()
        acceptRegistration(); acceptRegistration = undefined
      } else invalid()
    })().catch(failure)
  })
  process.on("disconnect", () => { connected = false; controller.abort(); rejectRegistration?.() })
  process.on("SIGTERM", () => { stopping = true; controller.abort(); rejectRegistration?.(); finishTerm() })
  setInterval(() => undefined, 1000)
  await new Promise<void>(() => undefined)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runWorker(async context => {
  if (context.request.profile.id === "claude-agent-acp") return (await import("./drivers/claude.js")).discoverClaude(context)
  return (await import("./drivers/codex.js")).discoverCodex(context)
})