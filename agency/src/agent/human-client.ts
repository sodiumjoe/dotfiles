import { randomUUID } from "node:crypto"
import type { ControlDependencies } from "../cli/control.js"
import { id, keys, object, text } from "../catalog/types.js"
import { ControlError } from "../control/protocol.js"
import { parsePermissionRef } from "../agent/permission-types.js"
import { parsePageInput } from "./queries.js"
import { AgentError } from "./types.js"
import { AGENT_PROTOCOL, parseAgentReply, validateAgentReply, type AgentReply, type AgentRequest } from "./protocol.js"
import type { RuntimeHumanRequest } from "./human-controls.js"

function parseLocal(argv: readonly string[]): RuntimeHumanRequest {
  try {
    const positional: string[] = [], flags = new Map<string, string>(), seen = new Set<string>()
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!
      if (!arg.startsWith("-")) { positional.push(arg); continue }
      if (seen.has(arg)) throw new Error()
      seen.add(arg)
      if (arg === "--local" || arg === "--json") continue
      if (!["--limit", "--cursor", "--cwd", "--input-json"].includes(arg)) throw new Error()
      const value = argv[++i]
      if (!value || value.startsWith("--")) throw new Error()
      flags.set(arg, value)
    }
    if (!seen.has("--local")) throw new Error()
    const [group, command] = positional
    if (group === "roster" && command === "list" && positional.length === 2) {
      if ([...flags.keys()].some(flag => !["--limit", "--cursor", "--cwd"].includes(flag))) throw new Error()
      return { op: "agent_roster", input: parsePageInput({ limit: flags.has("--limit") ? Number(flags.get("--limit")) : 100,
        ...(flags.has("--cursor") ? { cursor: flags.get("--cursor") } : {}), ...(flags.has("--cwd") ? { cwd: flags.get("--cwd") } : {}) }) }
    }
    if (group !== "permission") throw new Error()
    if (command === "list" && positional.length === 2 && flags.size === 0) return { op: "agent_permissions" }
    if (command === "inspect" && positional.length === 3 && flags.size === 0) return { op: "agent_permission_inspect", commandId: id(positional[2]) }
    if (command === "decide" && positional.length === 2 && flags.size === 1 && flags.has("--input-json")) {
      const value = object(JSON.parse(flags.get("--input-json")!))
      keys(value, ["commandId", "ref", "optionId"])
      return { op: "agent_permission_decide", commandId: id(value.commandId), ref: parsePermissionRef(value.ref), optionId: text(value.optionId) }
    }
    throw new Error()
  } catch { throw new AgentError("USAGE") }
}

const exit = (code: string): number => code === "USAGE" ? 64 : code === "INVALID_PROTOCOL" ? 65 : ["UNAVAILABLE", "STALE_HANDLER", "STALE_PROVIDER"].includes(code) ? 69 : code === "INTERNAL" ? 70 : 75

export async function runLocalHumanClient(argv: readonly string[], dependencies: ControlDependencies): Promise<number> {
  const requestId = randomUUID(), json = argv.includes("--json")
  let generation: string | null = null
  const emit = (value: object) => dependencies.stdout(JSON.stringify({ protocol: AGENT_PROTOCOL, requestId, handlerGeneration: generation, ...value }, null, json ? undefined : 2) + "\n")
  try {
    const operation = parseLocal(argv), env = await dependencies.environment(), handler = await dependencies.inspect(env)
    if (!handler) throw new AgentError("UNAVAILABLE")
    generation = handler.record.generation
    if (handler.disposition !== "live" || handler.record.phase !== "ready" || handler.record.process === null) throw new AgentError("NOT_READY")
    if (handler.record.hostId !== env.paths.hostKey) throw new AgentError("UNAVAILABLE")
    if (operation.op === "agent_permission_decide") {
      if (operation.ref.hostId !== env.paths.hostKey) throw new AgentError("USAGE")
      if (operation.ref.target.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
    }
    if (!dependencies.callAgent) throw new AgentError("UNAVAILABLE")
    const request: AgentRequest = { protocol: AGENT_PROTOCOL, requestId, handlerGeneration: generation, ...operation }
    let reply: AgentReply
    try {
      reply = parseAgentReply(await dependencies.callAgent(env, request))
      validateAgentReply(reply, request)
      if (reply.ok && reply.result.state === "permissions" && reply.result.snapshot.hostId !== env.paths.hostKey) throw new AgentError("INVALID_PROTOCOL")
    } catch (error) {
      if (operation.op === "agent_permission_decide") {
        emit({ ok: false, error: { code: "INCOMPLETE", message: "Permission decision outcome unknown; inspect the command before another decision" }, result: { commandId: operation.commandId } })
        return 75
      }
      throw error
    }
    if (!reply.ok) { emit({ ok: false, error: reply.error }); return exit(reply.error.code) }
    emit({ ok: true, result: reply.result })
    return operation.op === "agent_permission_decide" && (reply.result.state !== "permission" || reply.result.receipt?.state !== "applied") ? 75 : 0
  } catch (error) {
    const code = error instanceof AgentError || error instanceof ControlError ? error.code : "UNAVAILABLE"
    emit({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } })
    return exit(code)
  }
}