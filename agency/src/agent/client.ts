import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { ControlDependencies } from "../cli/control.js"
import { id } from "../catalog/types.js"
import { ControlError } from "../control/protocol.js"
import type { HandlerEnvironment } from "../handler/environment.js"
import { snapshotLaunchEnvironment } from "./environment.js"
import type { AgentStore } from "./store.js"
import { AGENT_PROTOCOL, parseAgentReply, validateAgentReply, type AgentReply, type AgentRequest } from "./protocol.js"
import { AgentError, agentFailure, parseSelection, type AgentCommand, type AgentErrorCode, type CommandView, type StartSelection } from "./types.js"

const exit = (code: AgentErrorCode): number => code === "USAGE" || code === "SELECTION_UNSUPPORTED" ? 64 : code === "INVALID_PROTOCOL" ? 65 : ["UNAVAILABLE", "STALE_HANDLER", "STALE_PROVIDER", "ADAPTER_UNQUALIFIED", "MODEL_UNAVAILABLE", "INVALID_AGENT_STATE"].includes(code) ? 69 : code === "INTERNAL" ? 70 : 75
export async function runAgentClient(argv: readonly string[], deps: ControlDependencies & { callAgent(env: HandlerEnvironment, request: AgentRequest, timeoutMs?: number): Promise<AgentReply>; agentStore(env: HandlerEnvironment): AgentStore }): Promise<number> {
  const requestId = randomUUID(), positional: string[] = [], flags = new Map<string, string>()
  let json = false, generation: string | null = null, commandId: string | undefined, last: CommandView | undefined
  const emit = (ok: boolean, value: unknown): void => deps.stdout(JSON.stringify({ protocol: AGENT_PROTOCOL, requestId, handlerGeneration: generation, ...(commandId ? { commandId } : {}), ok, ...(ok ? { result: value } : { error: value }) }, null, json ? undefined : 2) + "\n")
  try {
    let selection: StartSelection | undefined
    try {
      const seen = new Set<string>()
      for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]!
        if (!flag.startsWith("-")) { positional.push(flag); continue }
        if (seen.has(flag)) throw new Error()
        seen.add(flag)
        if (flag === "--json") { json = true; continue }
        if (!["--provider", "--model", "--reasoning", "--mode", "--permission-profile", "--command-id", "--handler-generation", "--provider-generation"].includes(flag)) throw new Error()
        const value = argv[++i]
        if (!value || value.startsWith("--")) throw new Error()
        flags.set(flag, value)
      }
      if (positional[0] !== "agent" || !["start", "stop", "current", "list"].includes(positional[1] ?? "") || positional.length !== (positional[1] === "stop" ? 3 : 2)) throw new Error()
      commandId = flags.has("--command-id") ? id(flags.get("--command-id")) : undefined
      generation = flags.has("--handler-generation") ? id(flags.get("--handler-generation")) : null
      if (positional[1] === "start") {
        if (flags.has("--provider-generation") || generation && !commandId) throw new Error()
        const reasoning = flags.get("--reasoning")
        selection = parseSelection({ providerId: flags.get("--provider"), modelId: flags.get("--model"), reasoning: reasoning === "none" ? { kind: "none" } : { kind: "value", value: reasoning }, mode: flags.get("--mode") ?? null, permissionProfile: flags.get("--permission-profile") })
      } else if (positional[1] === "stop") {
        id(positional[2]); id(generation); id(flags.get("--provider-generation"))
        if ([...flags.keys()].some(flag => !["--command-id", "--handler-generation", "--provider-generation"].includes(flag))) throw new Error()
      } else if (flags.size) throw new Error()
    } catch { throw new AgentError("USAGE") }
    const operation = positional[1]!, pinned = operation === "start" && generation !== null
    if (operation === "start" || operation === "stop") commandId ??= randomUUID()
    const env = await deps.environment()
    let retained: AgentCommand | null = null
    const validateRetained = (command: AgentCommand): void => {
      if (command.hostId !== env.paths.hostKey || command.commandId !== commandId || command.handlerGeneration !== generation || command.op !== operation) throw new AgentError("COMMAND_CONFLICT")
      if (operation === "start" && !isDeepStrictEqual((command.input as import("./types.js").StartCommandInput).selection, selection)) throw new AgentError("COMMAND_CONFLICT")
      if (operation === "stop" && (!command.target || command.target.agentId !== positional[2] || command.target.providerGeneration !== flags.get("--provider-generation"))) throw new AgentError("COMMAND_CONFLICT")
    }
    if (pinned || operation === "stop") {
      retained = await deps.agentStore(env).readCommand(commandId!)
      if (retained) validateRetained(retained)
      else if (pinned) throw new AgentError("UNAVAILABLE")
    }
    const handler = pinned || operation === "stop" ? await deps.inspect(env) : await deps.start(env)
    if (!handler || handler.disposition !== "live" || handler.record.phase !== "ready") {
      if (retained) { last = { state: "command", command: retained, durability: "unverified" }; emit(true, last); return 75 }
      throw new AgentError("UNAVAILABLE")
    }
    const commandGeneration = generation ?? handler.record.generation
    if (operation === "stop" && !retained && handler.record.generation !== generation) throw new AgentError("STALE_HANDLER")
    generation = handler.record.generation
    const base = { protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration: generation }
    let request: AgentRequest = retained ? { ...base, op: "agent_command", commandId: commandId!, commandGeneration }
      : operation === "start" ? { ...base, op: "agent_start", input: { commandId: commandId!, handlerGeneration: generation, cwd: resolve(deps.cwd()), selection: selection!, environment: snapshotLaunchEnvironment(process.env) } }
      : operation === "stop" ? { ...base, op: "agent_stop", input: { commandId: commandId!, handlerGeneration: generation, agentId: positional[2]!, providerGeneration: flags.get("--provider-generation")! } }
      : operation === "current" ? { ...base, op: "agent_current", cwd: resolve(deps.cwd()) } : { ...base, op: "agent_list" }
    const deadline = deps.now() + 45000
    let received = false
    for (let attempt = 0; attempt < 451 && deps.now() < deadline; attempt++) {
      let reply: AgentReply | undefined
      try {
        reply = parseAgentReply(await deps.callAgent(env, request, Math.min(5000, deadline - deps.now())))
        validateAgentReply(reply, request); received = true
      } catch (error) {
        const code = error instanceof AgentError || error instanceof ControlError ? error.code : "INTERNAL"
        if (code !== "UNAVAILABLE" && code !== "INCOMPLETE") throw error
        if (!commandId) throw new AgentError("UNAVAILABLE")
      }
      if (reply) {
        if (!reply.ok) throw new AgentError(reply.error.code)
        if (reply.result.state === "prompt") throw new AgentError("INVALID_PROTOCOL")
        if (reply.result.state !== "command") { emit(true, reply.result); return reply.result.state === "agents" && reply.result.unavailable ? 69 : 0 }
        last = reply.result
        if (last.command.state !== "pending" && last.durability === "verified") { emit(true, last); return last.command.result?.outcome === "started" || last.command.result?.outcome === "stopped" ? 0 : 75 }
      }
      if (commandId) request = { ...base, requestId: randomUUID(), op: "agent_command", commandId, commandGeneration }
      if (deps.now() < deadline) await deps.sleep(Math.min(100, deadline - deps.now()))
    }
    if (last) { emit(true, last); return 75 }
    throw new AgentError(received ? "INCOMPLETE" : "UNAVAILABLE")
  } catch (error) {
    const value = error instanceof AgentError ? error : error instanceof ControlError ? new AgentError(error.code === "ACTIVE_AGENTS" ? "INCOMPLETE" : error.code) : new AgentError("INTERNAL")
    emit(false, agentFailure(value)); deps.stderr(value.message + (value.code === "UNAVAILABLE" ? "; an explicit Handler restart after upgrade may be needed" : "") + "\n"); return exit(value.code)
  }
}