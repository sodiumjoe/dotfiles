import type { Readable } from "node:stream"
import { runSessionClient } from "../hosts/session-cli.js"
import { runEntryClient } from "../entry/cli.js"
import { runHostClient } from "../hosts/cli.js"
import type { HostRoute } from "../hosts/router.js"
import type { createHostInventory } from "../hosts/inventory.js"
import { randomUUID } from "node:crypto"
import { runRestart } from "./restart.js"
import { createConnection } from "node:net"
import { ControlError, PROTOCOL, UUID, controlError, exitCode, parseReply, validateReplyForRequest, type ControlRequest, type ControlReply, type DoctorDiagnostic } from "../control/protocol.js"
import { exchange } from "../control/wire.js"
import { productionEnvironment, type HandlerEnvironment } from "../handler/environment.js"
import { inspectHandlerGeneration, productionHandlerCommand, startOrConnect } from "../platform/singleton.js"
import { assertPrivateSocket } from "../platform/private-socket.js"
import { processBirthStart, sameProcess, sameProcessGeneration, type HandlerInspection, type ProcessIdentity } from "../platform/types.js"
import { DarwinObservationUnavailable } from "../platform/darwin.js"
import { LinuxObservationUnavailable } from "../platform/linux.js"
import { REQUEST_COMMANDS, REQUEST_HELP, runRequests } from "./requests.js"
import { exchangeLive, type LiveReply, type LiveRequest } from "../live/protocol.js"
import type { SessionHomes } from "../agent/excerpt.js"

export type ControlDependencies = {
  stdin?: Readable & { isTTY?: boolean }
  hostInventory?(env: HandlerEnvironment): Pick<ReturnType<typeof createHostInventory>, "list" | "enroll">
  hostRoute?(env: HandlerEnvironment, route: HostRoute, signal?: AbortSignal): Promise<unknown>
  environment(): Promise<HandlerEnvironment>
  start(env: HandlerEnvironment): Promise<HandlerInspection>
  inspect(env: HandlerEnvironment): Promise<HandlerInspection | null>
  call(env: HandlerEnvironment, request: ControlRequest): Promise<ControlReply>
  callLive?(env: HandlerEnvironment, request: LiveRequest, timeoutMs?: number): Promise<LiveReply>
  homes?(): SessionHomes
  cwd(): string
  now(): number
  sleep(ms: number): Promise<void>
  stdout(text: string): void
  stderr(text: string): void
}

export function productionControlDependencies(): ControlDependencies {
  return {
    stdin: process.stdin,
    environment: productionEnvironment,
    start: env => startOrConnect({ root: env.paths.runtimeRoot, hostId: env.paths.hostKey, adapter: env.adapter, handler: productionHandlerCommand() }),
    inspect: env => inspectHandlerGeneration(env.paths.runtimeRoot, env.adapter),
    call: async (env, request) => exchange(createConnection(await assertPrivateSocket(env.paths.runtimeRoot, "handler.sock")), request),
    callLive: async (env, request, timeoutMs) => exchangeLive(createConnection(await assertPrivateSocket(env.paths.runtimeRoot, "handler.sock")), request, timeoutMs),
    cwd: process.cwd, now: () => performance.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    stdout: text => { process.stdout.write(text) }, stderr: text => { process.stderr.write(text) },
  }
}

type Arguments = { command: "status" | "doctor" | "shutdown" | "help"; json: boolean; stopAgents: boolean; requireIdle: boolean; commandId?: string; generation?: string }

function parseArguments(argv: readonly string[]): Arguments {
  const positional: string[] = [], seen = new Set<string>()
  const args: Arguments = { command: "help", json: false, stopAgents: false, requireIdle: false }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!
    if (!value.startsWith("-")) { positional.push(value); continue }
    if (seen.has(value)) throw new ControlError("USAGE", "duplicate flag")
    seen.add(value)
    if (value === "--json") args.json = true
    else if (value === "--stop-agents") args.stopAgents = true
    else if (value === "--require-idle") args.requireIdle = true
    else if (value === "--help" || value === "-h") positional.push("help")
    else if (value === "--command-id" || value === "--handler-generation") {
      const id = argv[++i]
      if (id === undefined || !UUID.test(id)) throw new ControlError("USAGE", `${value} requires a canonical UUID`)
      if (value === "--command-id") args.commandId = id; else args.generation = id
    } else throw new ControlError("USAGE", `unknown flag: ${value}`)
  }
  const command = positional.join(" ")
  if (command === "status") args.command = "status"
  else if (command === "doctor" || command === "shutdown" || command === "help") args.command = command
  else if (command !== "") throw new ControlError("USAGE", "unsupported command; use agy --help")
  if (args.command !== "shutdown" && (args.stopAgents || args.requireIdle || args.commandId !== undefined || args.generation !== undefined)) throw new ControlError("USAGE", "shutdown flags require shutdown")
  if (args.requireIdle && !args.stopAgents) throw new ControlError("USAGE", "--require-idle requires --stop-agents")
  if ((args.commandId === undefined) !== (args.generation === undefined)) throw new ControlError("USAGE", "--command-id and --handler-generation must be supplied together")
  return args
}

async function identityState(env: HandlerEnvironment, expected: ProcessIdentity): Promise<"absent" | "live"> {
  try {
    const boot = await env.adapter.bootId()
    if (boot !== expected.bootId) return "absent"
    const current = await env.adapter.readProcess(expected.pid)
    if (current === null) return "absent"
    if (current.bootId !== boot || processBirthStart(current.birth) === null || processBirthStart(expected.birth) === null) throw new ControlError("INCOMPLETE", "identity observation is ambiguous")
    if (!sameProcessGeneration(expected, current)) return "absent"
    if (!sameProcess(expected, current)) throw new ControlError("INCOMPLETE", "same process generation changed identity")
    return "live"
  } catch (error) {
    if (error instanceof DarwinObservationUnavailable || error instanceof LinuxObservationUnavailable) throw new ControlError("INCOMPLETE", error.message)
    throw error
  }
}

function startupError(error: unknown): ControlError {
  if (error instanceof DarwinObservationUnavailable || error instanceof LinuxObservationUnavailable) return new ControlError("INCOMPLETE", error.message)
  if (error instanceof Error) {
    if (["Handler status timed out", "Handler gate delivery timed out", "Handler socket readiness timed out", "Handler generation is unavailable before readiness", "startup lock is unavailable"].includes(error.message) || /^Handler identity (is|became) ambiguous; startup is unavailable: /.test(error.message)) return new ControlError("INCOMPLETE", error.message)
    if (["Handler generation disappeared", "Handler status peer closed"].includes(error.message) || error.message.startsWith("Handler exited before acknowledgement: ") || error.message.startsWith("Handler startup failed: ") || ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return new ControlError("UNAVAILABLE", error.message)
  }
  return controlError(error)
}

async function checkedCall(dependencies: ControlDependencies, env: HandlerEnvironment, request: ControlRequest): Promise<ControlReply> {
  const reply = parseReply(await dependencies.call(env, request))
  validateReplyForRequest(reply, request)
  return reply
}

export async function runControl(argv: readonly string[], dependencies: ControlDependencies): Promise<number> {
  if (argv[0] === "restart") return runRestart(argv, dependencies, runControl)
  if (REQUEST_COMMANDS.includes(argv[0] ?? "")) return runRequests(argv, dependencies)
  if (argv[0] === "session") return runSessionClient(argv, dependencies)
  if (argv[0] === "entry") return runEntryClient(argv, dependencies)
  if (["host", "roster", "permission"].includes(argv[0] ?? "")) return runHostClient(argv, dependencies)
  const requestId = randomUUID()
  let generation: string | null = null, commandId: string | undefined
  const json = argv.includes("--json")
  const emit = (ok: boolean, value: unknown): void => {
    const envelope = { protocol: PROTOCOL, requestId, handlerGeneration: generation, ...(commandId === undefined ? {} : { commandId }), ok, ...(ok ? { result: value } : { error: value }) }
    dependencies.stdout(JSON.stringify(envelope, null, json ? undefined : 2) + "\n")
  }
  try {
    const args = parseArguments(argv)
    generation = args.generation ?? null
    commandId = args.commandId
    if (args.command === "help") { emit(true, { commands: [...REQUEST_HELP, "roster list [--host HOST_ID] [--limit 100] [--cursor CURSOR] [--cwd ABSOLUTE_PATH] (agents on enrolled hosts)", "roster excerpt AGENT_UUID --host HOST_ID (last conversation turns)", "permission list [--host HOST_ID]", "permission decide [--host HOST_ID] --input-json JSON (commandId, ref, optionId)", "session start|stop|submit|cancel|inspect|command|submission --host HOST_ID --input-json JSON", "entry open", "host list", "host enroll --input-json JSON", "acp (stdio connection to a ready Handler)", "status", "doctor", "shutdown [--stop-agents [--require-idle]] [--command-id UUID --handler-generation UUID] (with both flags, the next Handler restores the live agents)", "restart [--timeout SECONDS] (wait for running turns, hand the live agents to a new Handler with their model and mode)"], format: "--json" }); return 0 }
    const env = await dependencies.environment()
    if (args.command === "doctor") {
      const handler = await dependencies.inspect(env)
      generation = handler?.record.generation ?? null
      let runtimeIssues: DoctorDiagnostic["runtimeIssues"]
      if (handler?.disposition === "live" && handler.record.phase === "ready") {
        try {
          const reply = await checkedCall(dependencies, env, { protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: handler.record.generation, op: "status" })
          if (reply.ok && "phase" in reply.result && reply.result.issues?.length) runtimeIssues = reply.result.issues
        } catch {}
      }
      const result: DoctorDiagnostic = {
        ...(runtimeIssues ? { runtimeIssues } : {}),
        node: process.versions.node, platform: env.adapter.platform, hostId: env.paths.hostKey, paths: env.paths, handler,
      }
      emit(true, result)
      return 0
    }
    if (args.command === "status") {
      const inspection = await dependencies.start(env).catch(error => { throw startupError(error) })
      generation = inspection.record.generation
      const reply = await checkedCall(dependencies, env, { protocol: PROTOCOL, requestId, handlerGeneration: generation, op: "status" })
      if (!reply.ok) throw new ControlError(reply.error.code, reply.error.message)
      emit(true, reply.result)
      return 0
    }
    commandId ??= randomUUID()
    const success = (): number => { emit(true, { state: "shutdown_complete", commandId, handlerGeneration: generation }); return 0 }
    const inspection = await dependencies.inspect(env)
    if (inspection === null || inspection.disposition === "stale" || generation !== null && inspection.record.generation !== generation) {
      if (generation === null) throw new ControlError("UNAVAILABLE", "no Handler is running")
      return success()
    }
    generation ??= inspection.record.generation
    if (inspection.disposition !== "live" || inspection.record.process === null) throw new ControlError("INCOMPLETE", "Handler identity is ambiguous")
    const identity = inspection.record.process
    let refusal: ControlError | undefined
    try {
      const reply = await checkedCall(dependencies, env, { protocol: PROTOCOL, requestId, handlerGeneration: generation, op: "shutdown", commandId, stopAgents: args.stopAgents, ...(args.requireIdle ? { requireIdle: true as const } : {}) })
      if (!reply.ok) refusal = new ControlError(reply.error.code, reply.error.message)
    } catch (error) {
      const classified = controlError(error, "INCOMPLETE")
      if (classified.code !== "INCOMPLETE" && classified.code !== "UNAVAILABLE" && classified.code !== "STALE_HANDLER") throw classified
    }
    if (refusal && !(refusal.code === "INCOMPLETE" && refusal.message.includes("outcome remains unverified"))) throw refusal
    const deadline = dependencies.now() + 5000
    while (await identityState(env, identity) !== "absent") {
      if (dependencies.now() >= deadline) throw refusal ?? new ControlError("INCOMPLETE", "shutdown unverified; retry with the same command ID and Handler generation")
      await dependencies.sleep(50)
    }
    return success()
  } catch (error) {
    const value = controlError(error)
    emit(false, { code: value.code, message: value.message.slice(0, 2048) })
    dependencies.stderr(Buffer.from(value.message + "\n").subarray(0, 8192).toString())
    return exitCode(value.code)
  }
}