import { randomUUID } from "node:crypto"
import { readInputJson } from "../cli/input-json.js"
import { AgentError } from "../agent/types.js"
import type { ControlDependencies } from "../cli/control.js"
import { createHostInventory, parseHostEnrollment } from "./inventory.js"
import { HOST_PROTOCOL, type HostReply, type HostResult } from "./protocol.js"

function hostArguments(argv: readonly string[]) {
  const positional: string[] = [], flags = new Map<string, string>(), seen = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (!arg.startsWith("-")) { positional.push(arg); continue }
    if (seen.has(arg)) throw new AgentError("USAGE")
    seen.add(arg)
    if (arg === "--json") continue
    if (arg !== "--input-json") throw new AgentError("USAGE")
    const value = argv[++index]
    if (value === undefined || value.startsWith("--")) throw new AgentError("USAGE")
    flags.set(arg, value)
  }
  return { positional, flags }
}
export async function runHostClient(argv: readonly string[], deps: ControlDependencies): Promise<number> {
  const requestId = randomUUID()
  let executing = false
  const emit = (value: { ok: true; result: HostResult } | { ok: false; error: Extract<HostReply, { ok: false }>["error"] }) => deps.stdout(JSON.stringify({ protocol: HOST_PROTOCOL, requestId, hostId: null, handlerGeneration: null, ...value }) + "\n")
  try {
    const { positional, flags } = hostArguments(argv), action = positional[1]
    if (positional[0] !== "host" || positional.length !== 2 || !["list", "enroll"].includes(action!)) throw new AgentError("USAGE")
    if (action === "list" && flags.size) throw new AgentError("USAGE")
    const enrollment = action === "enroll" ? parseHostEnrollment(await readInputJson(flags.get("--input-json"), deps)) : undefined
    executing = true
    const env = await deps.environment(), inventory = deps.hostInventory?.(env) ?? createHostInventory(env.paths.persistentRoot)
    if (enrollment) { await inventory.enroll(enrollment); emit({ ok: true, result: { state: "enrolled", enrollment } }) }
    else emit({ ok: true, result: { state: "hosts", hosts: await inventory.list() } })
    return 0
  } catch (error) {
    const code = error instanceof AgentError ? error.code : executing ? "UNAVAILABLE" : "USAGE"
    emit({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } })
    return ["USAGE", "INVALID_PROTOCOL", "INPUT_TOO_LARGE"].includes(code) ? 64 : 69
  }
}