import { randomUUID } from "node:crypto"
import { runAgentClient } from "../agent/client.js"
import { runAttachmentClient, productionAttachmentStreams, type AttachmentDependencies } from "../agent/attachment-client.js"
import { exchangeAgent, type AgentRequest, type AgentReply } from "../agent/protocol.js"
import { createAgentStore, type AgentStore } from "../agent/store.js"
import { createCatalogStore } from "../catalog/store.js"
import { runCatalogClient } from "../catalog/client.js"
import { runProbeRecovery } from "../catalog/recovery-client.js"
import { exchangeCatalog, type CatalogRequest, type CatalogReply } from "../catalog/protocol.js"
import { createConnection } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ControlError, PROTOCOL, UUID, controlError, exitCode, parseReply, validateReplyForRequest, type ControlRequest, type ControlReply, type DoctorDiagnostic } from "../control/protocol.js"
import { exchange } from "../control/wire.js"
import { productionEnvironment, type HandlerEnvironment } from "../handler/environment.js"
import { inventoryLaunchState, summarizeLaunches } from "../handler/inventory.js"
import { readShutdownReceipt, assertSameShutdown, type ShutdownReceipt } from "../handler/receipt.js"
import { inspectHandlerGeneration, startOrConnect } from "../platform/singleton.js"
import { assertPrivateSocket } from "../platform/private-socket.js"
import { processBirthStart, sameProcess, sameProcessGeneration, type HandlerInspection, type ProcessIdentity } from "../platform/types.js"
import { DarwinObservationUnavailable } from "../platform/darwin.js"
import { LinuxObservationUnavailable } from "../platform/linux.js"

export type ControlDependencies = {
  attachment?: Omit<AttachmentDependencies, "environment" | "inspect" | "stderr">
  environment(): Promise<HandlerEnvironment>
  start(env: HandlerEnvironment): Promise<HandlerInspection>
  inspect(env: HandlerEnvironment): Promise<HandlerInspection | null>
  call(env: HandlerEnvironment, request: ControlRequest): Promise<ControlReply>
  callCatalog?(env: HandlerEnvironment, request: CatalogRequest, timeoutMs?: number): Promise<CatalogReply>
  callAgent?(env: HandlerEnvironment, request: AgentRequest, timeoutMs?: number): Promise<AgentReply>
  agentStore?(env: HandlerEnvironment): AgentStore
  receipt: typeof readShutdownReceipt
  inventory: typeof inventoryLaunchState
  cwd(): string
  now(): number
  sleep(ms: number): Promise<void>
  stdout(text: string): void
  stderr(text: string): void
}

export function productionControlDependencies(): ControlDependencies {
  return {
    attachment: productionAttachmentStreams(),
    environment: productionEnvironment,
    start: env => startOrConnect({ root: env.paths.runtimeRoot, hostId: env.paths.hostKey, adapter: env.adapter, handler: { file: process.execPath, args: [fileURLToPath(new URL("../main.js", import.meta.url)), "internal-handler"] } }),
    inspect: env => inspectHandlerGeneration(env.paths.runtimeRoot, env.adapter),
    call: async (env, request) => exchange(createConnection(await assertPrivateSocket(env.paths.runtimeRoot, "handler.sock")), request),
    callCatalog: async (env, request, timeoutMs) => exchangeCatalog(createConnection(await assertPrivateSocket(env.paths.runtimeRoot, "handler.sock")), request, timeoutMs),
    callAgent: async (env, request, timeoutMs) => exchangeAgent(createConnection(await assertPrivateSocket(env.paths.runtimeRoot, "handler.sock")), request, timeoutMs),
    agentStore: env => createAgentStore(env.paths.persistentRoot),
    receipt: readShutdownReceipt, inventory: inventoryLaunchState, cwd: process.cwd, now: () => performance.now(),
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
    if (["Handler generation disappeared", "Handler status peer closed"].includes(error.message) || error.message.startsWith("Handler exited before acknowledgement: ") || ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return new ControlError("UNAVAILABLE", error.message)
  }
  return controlError(error)
}

async function checkedCall(dependencies: ControlDependencies, env: HandlerEnvironment, request: ControlRequest): Promise<ControlReply> {
  const reply = parseReply(await dependencies.call(env, request))
  validateReplyForRequest(reply, request)
  return reply
}

export async function runControl(argv: readonly string[], dependencies: ControlDependencies): Promise<number> {
  if (argv[0] === "model" && argv[1] === "recover-probe") return runProbeRecovery(argv, dependencies)
  if (argv[0] === "agent" && argv[1] === "attach") return runAttachmentClient(argv, { ...productionAttachmentStreams(), ...dependencies.attachment, environment: dependencies.environment, inspect: dependencies.inspect, stderr: dependencies.stderr })
  if (argv[0] === "agent") return runAgentClient(argv, { ...dependencies, callAgent: dependencies.callAgent ?? (async () => { throw new ControlError("UNAVAILABLE") }), agentStore: dependencies.agentStore ?? (env => createAgentStore(env.paths.persistentRoot)) })
  if (argv.find(value => !value.startsWith("-")) === "model") return runCatalogClient(argv, { ...dependencies, callCatalog: dependencies.callCatalog ?? (async () => { throw new ControlError("UNAVAILABLE", "catalog support unavailable") }) })
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
    if (args.command === "help") { emit(true, { commands: ["acp (stdio connection to a ready Handler)", "status", "handler status", "doctor", "shutdown [--stop-agents] [--command-id UUID --handler-generation UUID]", "model list", "model refresh [--command-id UUID --handler-generation UUID]", "agent start --provider ID --model ID --reasoning VALUE [--mode ID] --permission-profile ID [--command-id UUID] [--handler-generation UUID | --expected-handler-generation UUID]", "agent import --provider ID --session NATIVE_ID --cwd PATH [--command-id UUID] [--handler-generation UUID | --expected-handler-generation UUID]", "agent restore AGENT_UUID [--command-id UUID] [--handler-generation UUID | --expected-handler-generation UUID] [--mcp-servers-json JSON]", "agent current (list of agents in the current directory)", "agent list", "agent choices", "agent page --limit 100 [--cursor CURSOR] [--cwd PATH] [--active]", "agent command COMMAND_UUID --handler-generation UUID", "agent prompt AGENT_UUID --text TEXT --handler-generation UUID --provider-generation UUID [--json]", "agent attach AGENT_UUID --handler-generation UUID --provider-generation UUID --format ndjson", "agent stop AGENT_UUID --handler-generation UUID --provider-generation UUID [--command-id UUID]"], format: "--json" }); return 0 }
    const env = await dependencies.environment()
    if (args.command === "doctor") {
      const handler = await dependencies.inspect(env)
      generation = handler?.record.generation ?? null
      const launches = await dependencies.inventory(join(env.paths.persistentRoot, "launches"))
      const agents = await createAgentStore(env.paths.persistentRoot).inventory()
      const catalog = await createCatalogStore(env.paths.persistentRoot).inventory()
      const result: DoctorDiagnostic = {
        node: process.versions.node, platform: env.adapter.platform, hostId: env.paths.hostKey, paths: env.paths, handler,
        launches: summarizeLaunches(launches.records.map(entry => entry.record)),
        agents: { records: [...agents.agents.map(record => ({ id: record.definition.agentId, phase: record.phase })), ...agents.legacyAgents.map(record => ({ id: record.spec.agentId, phase: record.phase }))], commands: agents.commands.map(command => ({ id: command.commandId, op: command.op, state: command.state })), issues: agents.issues.map(issue => ({ path: issue.path, message: issue.message })) },
        catalog: { probes: summarizeLaunches(catalog.launches.map(entry => entry.record)), commands: catalog.commands.map(command => ({ id: command.commandId, state: command.state })), issues: catalog.issues },
        issues: [...launches.issues.map(issue => ({ source: "launch" as const, path: issue.path, message: "invalid launch record" })), ...agents.issues.map(issue => ({ source: "agent" as const, path: issue.path, message: issue.message })), ...catalog.issues.map(issue => ({ source: "catalog" as const, path: join(env.paths.persistentRoot, issue === "catalog" ? issue : join("catalog", issue)), message: issue }))],
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
      shouldSend = false
      try {
        const status = await checkedCall(dependencies, env, { protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, op: "status" })
        shouldSend = status.ok && "phase" in status.result && status.result.phase === "ready"
      } catch (error) {
        const classified = controlError(error)
        if (classified.code !== "INCOMPLETE" && classified.code !== "UNAVAILABLE") throw classified
      }
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