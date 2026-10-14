import { hostname } from "node:os"
import { randomUUID } from "node:crypto"
import { absolutePath, hash, id, keys, object, text } from "../catalog/types.js"
import { AgentError } from "../agent/types.js"
import { parsePageInput } from "../agent/queries.js"
import { parsePermissionRef } from "../orchestration/permission-routing.js"
import { connectHandlerBridge } from "../bridge/handler-client.js"
import { connectBridge } from "../bridge/ssh.js"
import type { ControlDependencies } from "../cli/control.js"
import { createHostInventory, parseHostEnrollment } from "./inventory.js"
import { createHostRouter, isRoutedRead } from "./router.js"
import { createHostRuntimeClient, RuntimeOutcomeUnknown } from "./runtime.js"
import { rosterView, permissionView } from "./views.js"
import { HOST_PROTOCOL, type HostReply, type HostResult } from "./protocol.js"

export function hostArguments(argv: readonly string[]) {
  const positional: string[] = [], flags = new Map<string, string>(), seen = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (!arg.startsWith("-")) { positional.push(arg); continue }
    if (seen.has(arg)) throw new AgentError("USAGE")
    seen.add(arg)
    if (arg === "--json" || arg === "--local") continue
    if (!["--host", "--limit", "--cursor", "--cwd", "--command-id", "--input-json"].includes(arg)) throw new AgentError("USAGE")
    const value = argv[++index]
    if (value === undefined || value.startsWith("--")) throw new AgentError("USAGE")
    flags.set(arg, value)
  }
  if (seen.has("--local") && flags.has("--host")) throw new AgentError("USAGE")
  return { positional, flags, local: seen.has("--local"), json: seen.has("--json") }
}
export async function runHostClient(argv: readonly string[], deps: ControlDependencies): Promise<number> {
  const requestId = randomUUID()
  let executing = false
  let hostId: string | null = null, generation: string | null = null, commandId: string | undefined, close: (() => void) | undefined
  const emit = (value: { ok: true; result: HostResult } | { ok: false; error: Extract<HostReply, { ok: false }>["error"] }) => deps.stdout(JSON.stringify({ protocol: HOST_PROTOCOL, requestId, hostId, handlerGeneration: generation, ...(commandId ? { commandId } : {}), ...value }) + "\n")
  try {
    const args = hostArguments(argv), [group, action, argument] = args.positional, flags = args.flags
    const allow = (allowed: string[]) => { if ([...flags.keys()].some(flag => !allowed.includes(flag))) throw new AgentError("USAGE") }
    let operation: import("../agent/human-controls.js").RuntimeHumanRequest | undefined
    const selected = flags.has("--host") ? hash(flags.get("--host")) : undefined
    if (group === "host") {
      if (args.local || args.positional.length !== 2 || !["list", "enroll"].includes(action!)) throw new AgentError("USAGE")
      allow(action === "enroll" ? ["--input-json"] : [])
      const enrollment = action === "enroll" ? parseHostEnrollment(JSON.parse(flags.get("--input-json") ?? "null")) : undefined
      const env = await deps.environment(), inventory = deps.hostInventory?.(env) ?? createHostInventory(env.paths.persistentRoot)
      if (enrollment) { await inventory.enroll(enrollment); emit({ ok: true, result: { state: "enrolled", enrollment } }) }
      else emit({ ok: true, result: { state: "hosts", hosts: await inventory.list() } })
      return 0
    }
    if (args.local || !["roster", "permission"].includes(group!) || !["list", "decide", "inspect"].includes(action!)) throw new AgentError("USAGE")
    if (group === "roster") {
      if (action !== "list" || args.positional.length !== 2) throw new AgentError("USAGE")
      allow(["--host", "--limit", "--cursor", "--cwd"])
      if (!selected && (flags.has("--limit") || flags.has("--cursor"))) throw new AgentError("USAGE")
      if (selected) operation = { op: "agent_roster", input: parsePageInput({ limit: flags.has("--limit") ? Number(flags.get("--limit")) : 100, ...(flags.has("--cursor") ? { cursor: flags.get("--cursor") } : {}), ...(flags.has("--cwd") ? { cwd: flags.get("--cwd") } : {}) }) }
    } else if (action === "list") { allow(["--host"]); if (args.positional.length !== 2) throw new AgentError("USAGE"); if (selected) operation = { op: "agent_permissions" } }
    else if (action === "inspect") {
      allow(["--host"]); if (args.positional.length !== 3 || !selected) throw new AgentError("USAGE")
      commandId = id(argument); operation = { op: "agent_permission_inspect", commandId }
    } else {
      allow(["--host", "--input-json", "--command-id"]); if (args.positional.length !== 2) throw new AgentError("USAGE")
      const raw = object(JSON.parse(flags.get("--input-json") ?? "null")); keys(raw, ["ref", "optionId", ...(raw.commandId === undefined ? [] : ["commandId"])])
      commandId = id(raw.commandId ?? flags.get("--command-id"))
      if (raw.commandId !== undefined && flags.has("--command-id") && commandId !== id(flags.get("--command-id"))) throw new AgentError("USAGE")
      const ref = parsePermissionRef(raw.ref)
      if (selected && selected !== ref.hostId) throw new AgentError("USAGE")
      operation = { op: "agent_permission_decide", commandId, ref, optionId: text(raw.optionId) }
    }
    executing = true
    const access = await openHostAccess(deps), { env, inventory } = access
    close = access.close
    const client = createHostRuntimeClient({ localHostId: env.paths.hostKey, async route(route, signal) {
      const result = await access.route(route, signal)
      if (route.channel === "host-identity" && operation) { const value = object(result); generation = id(value.handlerGeneration) }
      return result
    } })
    let result: HostResult
    if (operation) {
      hostId = operation.op === "agent_permission_decide" ? operation.ref.hostId : selected!
      result = await client.human(hostId, operation)
    } else {
      const input = { client, localHostId: env.paths.hostKey, localHostname: hostname(), hosts: await inventory.list(), ...(flags.has("--cwd") ? { cwd: absolutePath(flags.get("--cwd")) } : {}) }
      result = group === "roster" ? await rosterView(input) : await permissionView(input)
    }
    emit({ ok: true, result })
    return operation?.op === "agent_permission_decide" && (result.state !== "permission" || result.receipt?.state !== "applied") ? 75 : 0
  } catch (error) {
    const code = error instanceof RuntimeOutcomeUnknown ? error.code : error instanceof AgentError ? error.code : executing ? "UNAVAILABLE" : "USAGE"
    emit({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error), ...(error instanceof RuntimeOutcomeUnknown ? { reference: error.reference } : {}) } })
    return code === "USAGE" || code === "INVALID_PROTOCOL" ? 64 : code === "OUTCOME_UNKNOWN" ? 75 : 69
  } finally { close?.() }
}
export async function openHostAccess(deps: ControlDependencies) {
  const env = await deps.environment(), inventory = deps.hostInventory?.(env) ?? createHostInventory(env.paths.persistentRoot)
  let local: Awaited<ReturnType<typeof connectHandlerBridge>> | undefined
  const router = createHostRouter({ hostId: env.paths.hostKey, inventory, async local(channel, payload, signal) {
    if (!local) {
      const owner = await deps.inspect(env)
      if (!owner || owner.disposition !== "live" || owner.record.phase !== "ready") throw new AgentError("UNAVAILABLE")
      local = await connectHandlerBridge({ root: env.paths.runtimeRoot, hostId: env.paths.hostKey, handlerGeneration: owner.record.generation })
    }
    return local.request(channel, payload, { timeoutMs: isRoutedRead(channel) ? 10000 : 60000, ...(signal ? { signal } : {}) })
  }, connect: enrollment => connectBridge(enrollment, { action: "internal-runtime-bridge", requiredCapabilities: ["runtime-read", "host-identity"] }) })
  const close = () => { local?.close(); router.close() }
  return { env, inventory, close, route: (route: import("./router.js").HostRoute, signal?: AbortSignal) => deps.hostRoute ? deps.hostRoute(env, route, signal) : router.request(route, signal) }
}