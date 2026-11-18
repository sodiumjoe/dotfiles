import { spawn } from "node:child_process"
import { readInputJson } from "../cli/input-json.js"
import { isDeepStrictEqual } from "node:util"
import { randomUUID } from "node:crypto"
import { hash, id, keys, object } from "../config/validate.js"
import { AgentError } from "../agent/types.js"
import type { ControlDependencies } from "../cli/control.js"
import { hostArguments, openHostAccess } from "../hosts/cli.js"
import { createHostRuntimeClient, RuntimeOutcomeUnknown } from "../hosts/runtime.js"
import { HOST_PROTOCOL, parseHostReply, type HostResult } from "../hosts/protocol.js"
import { parseEntryTarget, parseRuntimeEntry } from "./runtime.js"
import type { PlatformPaths } from "../platform/paths.js"
import type { HandlerInspection, PlatformAdapter } from "../platform/types.js"

export async function runEntryClient(argv: readonly string[], deps: ControlDependencies): Promise<number> {
  const requestId = randomUUID()
  let hostId: string | null = null, generation: string | null = null, commandId: string | undefined, close: (() => void) | undefined, executing = false
  const emit = (value: object) => deps.stdout(JSON.stringify({ protocol: HOST_PROTOCOL, requestId, hostId, handlerGeneration: generation, ...(commandId ? { commandId } : {}), ...value }) + "\n")
  try {
    const args = hostArguments(argv), action = args.positional[1]
    if (args.positional[0] !== "entry" || !["open", "inspect"].includes(action!) || [...args.flags.keys()].some(flag => !(action === "open" ? ["--input-json", "--host"] : ["--host"]).includes(flag))) throw new AgentError("USAGE")
    let ref: ReturnType<typeof parseEntryTarget> | undefined
    if (action === "open") {
      if (args.positional.length !== 2) throw new AgentError("USAGE")
      const selected = args.flags.has("--host") ? hash(args.flags.get("--host")) : undefined
      const value = object(await readInputJson(args.flags.get("--input-json"), deps)); keys(value, ["commandId", "hostId", "target"])
      commandId = id(value.commandId); ref = parseEntryTarget({ hostId: value.hostId, target: value.target })
      if (selected && selected !== ref.hostId) throw new AgentError("USAGE")
    } else { if (args.positional.length !== 3 || !args.flags.has("--host")) throw new AgentError("USAGE"); commandId = id(args.positional[2]) }
    executing = true
    const access = await openHostAccess(deps); close = access.close
    hostId = ref?.hostId ?? hash(args.flags.get("--host"))
    const enrollment = hostId === access.env.paths.hostKey ? null : (await access.inventory.list()).find(host => host.hostId === hostId)
    if (enrollment === undefined) throw new AgentError("UNAVAILABLE")
    const client = createHostRuntimeClient({ localHostId: access.env.paths.hostKey, route: access.route })
    const owner = await client.identity(hostId); generation = owner.handlerGeneration
    if (ref && ref.target.handlerGeneration !== generation) throw new AgentError("STALE_HANDLER")
    let receipt: ReturnType<typeof parseRuntimeEntry> | null
    try {
      const raw = await access.route({ hostId, channel: action === "open" ? "entry-open" : "runtime-entry-inspect", payload: { commandId, ...(ref ? { ref } : {}) } })
      receipt = raw === null && action === "inspect" ? null : parseRuntimeEntry(raw)
      if (receipt && (receipt.commandId !== commandId || receipt.ref.hostId !== hostId || receipt.state !== "stale" && receipt.ref.target.handlerGeneration !== generation || ref && !isDeepStrictEqual(receipt.ref, ref))) throw new AgentError("INVALID_PROTOCOL")
    } catch (error) { if (action === "open") throw new RuntimeOutcomeUnknown({ hostId, commandId }, error); throw error }
    const result: HostResult = { state: "entry", receipt, enrollment }
    emit({ ok: true, result }); return receipt && receipt.state !== "opened" ? 75 : 0
  } catch (error) {
    const code = error instanceof RuntimeOutcomeUnknown ? "OUTCOME_UNKNOWN" : error instanceof AgentError ? error.code : executing ? "UNAVAILABLE" : "USAGE"
    emit({ ok: false, error: { code, message: code === "USAGE" ? "Use entry open --input-json JSON or entry inspect COMMAND --host HOST" : error instanceof Error ? error.message : String(error), ...(error instanceof RuntimeOutcomeUnknown ? { reference: error.reference } : {}) } })
    return code === "USAGE" || code === "INPUT_TOO_LARGE" ? 64 : code === "OUTCOME_UNKNOWN" ? 75 : 69
  } finally { close?.() }
}
export type EntryHelperDependencies = {
  environment(): Promise<{ paths: PlatformPaths; adapter: PlatformAdapter }>
  inspect(env: { paths: PlatformPaths; adapter: PlatformAdapter }): Promise<HandlerInspection | null>
  connect(input: { root: string; hostId: string; handlerGeneration: string }): Promise<{ request(channel: string, payload: unknown): Promise<unknown>; close(): void }>
  stderr(value: string): void
}
export async function runRuntimeEntryHelper(argv: readonly string[], deps: EntryHelperDependencies, enter = (file: string, args: string[]) => new Promise<number>((resolve, reject) => {
  const child = spawn(file, args, { stdio: "inherit" }); child.once("error", reject); child.once("close", code => resolve(code ?? 75))
})): Promise<number> {
  try {
    if (argv.length !== 3 || argv[1] !== "--target-json") return 64
    const commandId = id(argv[0]), ref = parseEntryTarget(JSON.parse(argv[2]!)), env = await deps.environment()
    if (env.paths.hostKey !== ref.hostId) return 69
    const inspection = await deps.inspect(env)
    if (!inspection || inspection.disposition !== "live" || inspection.record.phase !== "ready") { deps.stderr("The Agency Handler is not running on this host\n"); return 69 }
    const bridge = await deps.connect({ root: env.paths.runtimeRoot, hostId: env.paths.hostKey, handlerGeneration: inspection.record.generation })
    let raw: unknown
    try { raw = await bridge.request("runtime-entry-inspect", { commandId }) } finally { bridge.close() }
    const receipt = raw === null ? null : parseRuntimeEntry(raw)
    if (!receipt || receipt.state !== "opened" || !receipt.editor || !isDeepStrictEqual(receipt.ref, ref)) return 75
    return await enter("tmux", ["-S", receipt.editor.tmuxSocketPath, "attach-session", "-t", "=" + receipt.editor.session])
  } catch { deps.stderr("Entry outcome unavailable\n"); return 75 }
}