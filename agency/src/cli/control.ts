import { randomUUID } from "node:crypto"
import { createConnection } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ControlError, PROTOCOL, UUID, controlError, exitCode, parseReply, validateReplyForRequest, type ControlRequest, type ControlReply } from "../control/protocol.js"
import { exchange } from "../control/wire.js"
import { productionEnvironment, type HandlerEnvironment } from "../handler/environment.js"
import { inventoryLaunches } from "../handler/inventory.js"
import { readShutdownReceipt, assertSameShutdown, type ShutdownReceipt } from "../handler/receipt.js"
import { inspectHandlerGeneration, startOrConnect } from "../platform/singleton.js"
import { assertPrivateSocket } from "../platform/private-socket.js"
import { processBirthStart, sameProcess, sameProcessGeneration, type HandlerInspection, type ProcessIdentity } from "../platform/types.js"

export type ControlDependencies = {
  environment(): Promise<HandlerEnvironment>
  start(env: HandlerEnvironment): Promise<HandlerInspection>
  inspect(env: HandlerEnvironment): Promise<HandlerInspection | null>
  call(env: HandlerEnvironment, request: ControlRequest): Promise<ControlReply>
  receipt: typeof readShutdownReceipt
  inventory: typeof inventoryLaunches
  now(): number
  sleep(ms: number): Promise<void>
  stdout(text: string): void
  stderr(text: string): void
}

export function productionControlDependencies(): ControlDependencies {
  return {
    environment: productionEnvironment,
    start: env => startOrConnect({ root: env.paths.runtimeRoot, hostId: env.paths.hostKey, adapter: env.adapter, handler: { file: process.execPath, args: [fileURLToPath(new URL("../main.js", import.meta.url)), "internal-handler"] } }),
    inspect: env => inspectHandlerGeneration(env.paths.runtimeRoot, env.adapter),
    call: async (env, request) => exchange(createConnection(await assertPrivateSocket(env.paths.runtimeRoot, "handler.sock")), request),
    receipt: readShutdownReceipt, inventory: inventoryLaunches, now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    stdout: text => { process.stdout.write(text) }, stderr: text => { process.stderr.write(text) },
  }
}

type Arguments = { command: "status" | "doctor" | "shutdown" | "help"; json: boolean; stopAgents: boolean; commandId?: string; generation?: string }

function parseArguments(argv: readonly string[]): Arguments {
  const positional: string[] = [], seen = new Set<string>()
  const args: Arguments = { command: "help", json: false, stopAgents: false }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!
    if (!value.startsWith("-")) { positional.push(value); continue }
    if (seen.has(value)) throw new ControlError("USAGE", "duplicate flag")
    seen.add(value)
    if (value === "--json") args.json = true
    else if (value === "--stop-agents") args.stopAgents = true
    else if (value === "--help" || value === "-h") positional.push("help")
    else if (value === "--command-id" || value === "--handler-generation") {
      const id = argv[++i]
      if (id === undefined || !UUID.test(id)) throw new ControlError("USAGE", `${value} requires a canonical UUID`)
      if (value === "--command-id") args.commandId = id; else args.generation = id
    } else throw new ControlError("USAGE", `unknown flag: ${value}`)
  }
  const command = positional.join(" ")
  if (command === "status" || command === "handler status") args.command = "status"
  else if (command === "doctor" || command === "shutdown" || command === "help") args.command = command
  else if (command !== "") throw new ControlError("USAGE", "unsupported command; use agy --help")
  if (args.command !== "shutdown" && (args.stopAgents || args.commandId !== undefined || args.generation !== undefined)) throw new ControlError("USAGE", "shutdown flags require shutdown")
  if ((args.commandId === undefined) !== (args.generation === undefined)) throw new ControlError("USAGE", "--command-id and --handler-generation must be supplied together")
  return args
}

async function identityState(env: HandlerEnvironment, expected: ProcessIdentity): Promise<"absent" | "live"> {
  const boot = await env.adapter.bootId()
  if (boot !== expected.bootId) return "absent"
  const current = await env.adapter.readProcess(expected.pid)
  if (current === null) return "absent"
  if (current.bootId !== boot || processBirthStart(current.birth) === null || processBirthStart(expected.birth) === null) throw new ControlError("INCOMPLETE", "identity observation is ambiguous")
  if (!sameProcessGeneration(expected, current)) return "absent"
  if (!sameProcess(expected, current)) throw new ControlError("INCOMPLETE", "same process generation changed identity")
  return "live"
}

async function checkedCall(dependencies: ControlDependencies, env: HandlerEnvironment, request: ControlRequest): Promise<ControlReply> {
  const reply = parseReply(await dependencies.call(env, request))
  validateReplyForRequest(reply, request)
  return reply
}

export async function runControl(argv: readonly string[], dependencies: ControlDependencies): Promise<number> {
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
    if (args.command === "help") { emit(true, { commands: ["status", "handler status", "doctor", "shutdown [--stop-agents] [--command-id UUID --handler-generation UUID]"], format: "--json" }); return 0 }
    const env = await dependencies.environment()
    if (args.command === "doctor") {
      const handler = await dependencies.inspect(env)
      generation = handler?.record.generation ?? null
      const launches = await dependencies.inventory(join(env.paths.persistentRoot, "launches"))
      emit(true, { node: process.versions.node, platform: env.adapter.platform, hostId: env.paths.hostKey, paths: env.paths, handler, launches: launches.map(entry => entry.record) })
      return 0
    }
    if (args.command === "status") {
      const inspection = await dependencies.start(env)
      generation = inspection.record.generation
      const reply = await checkedCall(dependencies, env, { protocol: PROTOCOL, requestId, handlerGeneration: generation, op: "status" })
      if (!reply.ok) throw new ControlError(reply.error.code, reply.error.message)
      emit(true, reply.result)
      return 0
    }
    commandId ??= randomUUID()
    let retained = await dependencies.receipt(env.paths.persistentRoot, commandId)
    const validateReceipt = (receipt: ShutdownReceipt): void => {
      if (generation === null || receipt.hostId !== env.paths.hostKey) throw new ControlError("COMMAND_CONFLICT", "receipt target mismatch")
      assertSameShutdown(receipt, { commandId: commandId!, handlerGeneration: generation, stopAgents: args.stopAgents })
    }
    const success = (): number => { emit(true, { state: "shutdown_complete", commandId, handlerGeneration: generation }); return 0 }
    if (retained !== null) {
      validateReceipt(retained)
      if (await identityState(env, retained.handlerIdentity) === "absent") return success()
    }
    const inspection = await dependencies.inspect(env)
    if (inspection === null) throw new ControlError(generation === null ? "UNAVAILABLE" : "INCOMPLETE", "no matching Handler")
    if (generation !== null && generation !== inspection.record.generation) throw new ControlError("STALE_HANDLER", "refusing a replacement generation")
    generation ??= inspection.record.generation
    if (inspection.disposition !== "live" || inspection.record.process === null || inspection.record.phase !== "ready") throw new ControlError("INCOMPLETE", "Handler is not ready or identity is ambiguous")
    if (retained !== null && !sameProcess(retained.handlerIdentity, inspection.record.process)) throw new ControlError("INCOMPLETE", "receipt and Handler identity differ")
    let shouldSend = true
    if (retained !== null) {
      const status = await checkedCall(dependencies, env, { protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, op: "status" })
      shouldSend = status.ok && "phase" in status.result && status.result.phase === "ready"
    }
    if (shouldSend) {
      try {
        const reply = await checkedCall(dependencies, env, { protocol: PROTOCOL, requestId, handlerGeneration: generation, op: "shutdown", commandId, stopAgents: args.stopAgents })
        if (!reply.ok) throw new ControlError(reply.error.code, reply.error.message)
      } catch (error) {
        const classified = controlError(error, "INCOMPLETE")
        if (classified.code !== "INCOMPLETE" && classified.code !== "UNAVAILABLE") throw classified
      }
    }
    const deadline = dependencies.now() + 5000
    do {
      retained = await dependencies.receipt(env.paths.persistentRoot, commandId)
      if (retained !== null) {
        validateReceipt(retained)
        if (await identityState(env, retained.handlerIdentity) === "absent") return success()
      }
      if (dependencies.now() >= deadline) break
      await dependencies.sleep(50)
    } while (true)
    throw new ControlError("INCOMPLETE", "shutdown unverified; retry with the returned command ID and Handler generation")
  } catch (error) {
    const value = controlError(error)
    emit(false, { code: value.code, message: value.message.slice(0, 2048) })
    dependencies.stderr(Buffer.from(value.message + "\n").subarray(0, 8192).toString())
    return exitCode(value.code)
  }
}