import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { createAgentIndex } from "../agent/agent-index.js"
import { snapshotLaunchEnvironment } from "../agent/environment.js"
import { defaultHomes } from "../agent/excerpt.js"
import { parsePermissionRef } from "../agent/permission-types.js"
import { AgentError } from "../agent/types.js"
import { absolutePath, id, object, providerId } from "../catalog/types.js"
import { PROTOCOL } from "../control/protocol.js"
import type { HandlerEnvironment } from "../handler/environment.js"
import { readEventLog } from "../handler/event-log.js"
import { PRE_LIVE_HANDLER, RequestError, requestFailure, type RequestCode } from "../live/errors.js"
import { REQUEST_PROTOCOL, type LiveOperation, type LiveResult } from "../live/protocol.js"
import { createRoster } from "../live/roster.js"
import { createLiveTable } from "../live/state.js"
import type { ControlDependencies } from "./control.js"
import { readInputJson, readStdin } from "./input-json.js"

export const REQUEST_COMMANDS = ["start", "restore", "stop", "set", "prompt", "cancel", "agents", "excerpt", "transcript", "models", "permissions", "forget", "log"]
export const REQUEST_HELP = [
  "start [--backend ID] [--agent UUID] [--cwd PATH] [--model ID] [--mode ID] (start an agent and wait until it is ready)",
  "restore AGENT_UUID (make a stopped agent live)", "stop AGENT_UUID", "set AGENT_UUID SETTING VALUE (model, mode or a provider option)",
  "prompt AGENT_UUID [--submission-id UUID] (prompt text on stdin; restores a stopped agent first)", "cancel AGENT_UUID",
  "agents (indexed and live agents)", "excerpt AGENT_UUID [--turns 1-8]", "transcript AGENT_UUID", "models", "permissions", "permissions decide --input-json JSON (ref, optionId)",
  "forget AGENT_UUID (delete a stopped agent from the index)", "log [--agent UUID] [--since ISO_TIME] [--limit N]",
]
const exits: Record<RequestCode, number> = { INVALID: 64, NOT_FOUND: 66, UNAVAILABLE: 69, FAILED: 70, BUSY: 75 }

function parse(argv: readonly string[], allowed: string[], count: number, usage: string): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [], flags = new Map<string, string>()
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!
    if (value === "--json") continue
    if (!value.startsWith("--")) { positional.push(value); continue }
    const next = argv[index + 1]
    if (!allowed.includes(value) || flags.has(value) || next === undefined || next.startsWith("--")) throw new RequestError("INVALID", "use agy " + usage)
    flags.set(value, next); index++
  }
  if (positional.length !== count) throw new RequestError("INVALID", "use agy " + usage)
  return { positional, flags }
}
const agent = (value: string | undefined): string => { try { return id(value) } catch { throw new RequestError("INVALID", "agent IDs are canonical UUIDs") } }

export async function runRequests(argv: readonly string[], deps: ControlDependencies): Promise<number> {
  const json = argv.includes("--json")
  const emit = (value: object): void => deps.stdout(JSON.stringify({ protocol: REQUEST_PROTOCOL, ...value }, null, json ? undefined : 2) + "\n")
  try {
    emit({ ok: true, result: await perform(argv, deps) })
    return 0
  } catch (error) {
    const failure = requestFailure(error instanceof AgentError && error.code === "USAGE" ? new RequestError("INVALID", "input must be noninteractive JSON or text on stdin") : error)
    emit({ ok: false, error: failure })
    deps.stderr(failure.message + "\n")
    return exits[failure.code]
  }
}

async function perform(argv: readonly string[], deps: ControlDependencies): Promise<unknown> {
  const env = await deps.environment(), environment = snapshotLaunchEnvironment(process.env)
  const live = async (start: boolean): Promise<boolean> => {
    if (start) { try { await deps.start(env) } catch (error) { throw new RequestError("UNAVAILABLE", "the Agency Handler could not start: " + (error instanceof Error ? error.message : String(error))) } return true }
    const inspection = await deps.inspect(env)
    return !!inspection && inspection.disposition === "live" && inspection.record.phase === "ready"
  }
  const answersControl = async (): Promise<boolean> => {
    try {
      const inspection = await deps.inspect(env)
      if (!inspection) return false
      await deps.call(env, { protocol: PROTOCOL, requestId: randomUUID(), handlerGeneration: inspection.record.generation, op: "status" })
      return true
    } catch { return false }
  }
  const call = async (operation: LiveOperation): Promise<LiveResult> => {
    if (!deps.callLive) throw new RequestError("UNAVAILABLE", "live requests are unavailable")
    let reply
    try { reply = await deps.callLive(env, { protocol: REQUEST_PROTOCOL, requestId: randomUUID(), ...operation }) } catch (error) {
      if (error instanceof RequestError && error.code === "UNAVAILABLE" && error.message.startsWith("the Handler did not answer") && await answersControl()) throw new RequestError("UNAVAILABLE", PRE_LIVE_HANDLER)
      throw error
    }
    if (!reply.ok) throw new RequestError(reply.error.code, reply.error.message)
    return reply.result
  }
  const local = () => ({ index: createAgentIndex(env.paths.persistentRoot), roster: createRoster({ index: createAgentIndex(env.paths.persistentRoot), homes: deps.homes?.() ?? defaultHomes() }), table: createLiveTable() })
  const stopped = (message: string): never => { throw new RequestError("UNAVAILABLE", message + ": the Agency Handler is not running") }
  switch (argv[0]) {
    case "start": {
      const { flags } = parse(argv, ["--backend", "--agent", "--cwd", "--model", "--mode"], 0, "start [--backend ID] [--agent UUID] [--cwd PATH] [--model ID] [--mode ID]")
      let backendId, cwd
      try { backendId = flags.has("--backend") ? providerId(flags.get("--backend")) : undefined; cwd = absolutePath(resolve(deps.cwd(), flags.get("--cwd") ?? ".")) } catch { throw new RequestError("INVALID", "--backend must be codex-acp or claude-agent-acp") }
      await live(true)
      return call({ op: "start", agentId: flags.has("--agent") ? agent(flags.get("--agent")) : randomUUID(), cwd, environment, ...(backendId ? { backendId } : {}), ...(flags.has("--model") ? { model: flags.get("--model")! } : {}), ...(flags.has("--mode") ? { mode: flags.get("--mode")! } : {}) })
    }
    case "restore": { const agentId = agent(parse(argv, [], 1, "restore AGENT_UUID").positional[0]); await live(true); return call({ op: "restore", agentId, environment }) }
    case "prompt": {
      const { positional, flags } = parse(argv, ["--submission-id"], 1, "prompt AGENT_UUID [--submission-id UUID] < text")
      const agentId = agent(positional[0]), bytes = await readStdin(deps, 262144)
      let text: string
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { throw new RequestError("INVALID", "prompt text must be UTF-8") }
      if (!text.trim()) throw new RequestError("INVALID", "prompt text on stdin is empty")
      await live(true)
      return call({ op: "prompt", agentId, text, environment, ...(flags.has("--submission-id") ? { submissionId: agent(flags.get("--submission-id")) } : {}) })
    }
    case "stop": case "cancel": case "forget": case "transcript": {
      const op = argv[0], agentId = agent(parse(argv, [], 1, op + " AGENT_UUID").positional[0])
      if (await live(false)) return call({ op, agentId })
      const { index, roster, table } = local()
      if (op === "cancel") return stopped("agent " + agentId + " is not live")
      if (op === "transcript") return await roster.transcript(agentId) ?? Promise.reject(new RequestError("NOT_FOUND", "agent " + agentId + " is not known on this host"))
      const row = await roster.row(table, agentId)
      if (!row) throw new RequestError("NOT_FOUND", "agent " + agentId + " is not known on this host")
      if (op === "stop") return { state: "agent", agent: row }
      await index.remove(agentId)
      return { state: "forgotten", agentId }
    }
    case "set": {
      const { positional } = parse(argv, [], 3, "set AGENT_UUID SETTING VALUE"), agentId = agent(positional[0]), value = positional[2] === "true" ? true : positional[2] === "false" ? false : positional[2]!
      if (!await live(false)) stopped("agent " + agentId + " is not live")
      return call({ op: "set", agentId, setting: positional[1]!, value })
    }
    case "excerpt": {
      const { positional, flags } = parse(argv, ["--turns"], 1, "excerpt AGENT_UUID [--turns 1-8]"), agentId = agent(positional[0]), turns = Number(flags.get("--turns") ?? 4)
      if (!Number.isInteger(turns) || turns < 1 || turns > 8) throw new RequestError("INVALID", "--turns must be an integer from 1 to 8")
      if (await live(false)) return call({ op: "excerpt", agentId, turns })
      const { roster, table } = local()
      return await roster.excerpt(table, agentId, turns) ?? Promise.reject(new RequestError("NOT_FOUND", "agent " + agentId + " is not known on this host"))
    }
    case "agents": {
      parse(argv, [], 0, "agents")
      if (await live(false)) return call({ op: "agents" })
      const { roster, table } = local()
      return { state: "agents", handlerGeneration: null, agents: await roster.rows(table) }
    }
    case "models": { parse(argv, [], 0, "models"); await live(true); return call({ op: "models" }) }
    case "permissions": {
      if (argv[1] === "decide") {
        const { flags } = parse(argv.slice(1), ["--input-json"], 0, "permissions decide --input-json JSON")
        let input: Record<string, unknown>
        try { input = object(await readInputJson(flags.get("--input-json"), deps)) } catch (error) { if (error instanceof AgentError && error.code === "INPUT_TOO_LARGE") throw error; throw new RequestError("INVALID", "--input-json must be an object with ref and optionId") }
        if (!await live(false)) stopped("no permission is pending")
        let ref
        try { ref = parsePermissionRef(input.ref) } catch { throw new RequestError("INVALID", "ref must be a permission reference from agy permissions") }
        return call({ op: "decide", ref, optionId: String(input.optionId) })
      }
      parse(argv, [], 0, "permissions")
      if (!await live(false)) stopped("no permission is pending")
      return call({ op: "permissions" })
    }
    case "log": {
      const { flags } = parse(argv, ["--agent", "--since", "--limit"], 0, "log [--agent UUID] [--since ISO_TIME] [--limit N]"), limit = Number(flags.get("--limit") ?? 200)
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new RequestError("INVALID", "--limit must be an integer from 1 to 10000")
      if (flags.has("--since") && !Number.isFinite(Date.parse(flags.get("--since")!))) throw new RequestError("INVALID", "--since must be an ISO time")
      return { state: "log", events: await readEventLog(env.paths.persistentRoot, { ...(flags.has("--agent") ? { agentId: agent(flags.get("--agent")) } : {}), ...(flags.has("--since") ? { since: new Date(flags.get("--since")!).toISOString() } : {}), limit }) }
    }
  }
  throw new RequestError("INVALID", "unknown command " + String(argv[0]).slice(0, 64))
}