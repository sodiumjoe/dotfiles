import { spawn } from "node:child_process"
import { isDeepStrictEqual } from "node:util"
import { randomUUID } from "node:crypto"
import { hash, id, keys, object } from "../catalog/types.js"
import { AgentError } from "../agent/types.js"
import type { ControlDependencies } from "../cli/control.js"
import { hostArguments, openHostAccess } from "../hosts/cli.js"
import { createHostRuntimeClient, RuntimeOutcomeUnknown } from "../hosts/runtime.js"
import { HOST_PROTOCOL, parseHostReply, type HostResult } from "../hosts/protocol.js"
import { parseEntryTarget, parseRuntimeEntry } from "./runtime.js"

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
      const value = object(JSON.parse(args.flags.get("--input-json") ?? "null")); keys(value, ["commandId", "hostId", "target"])
      commandId = id(value.commandId); ref = parseEntryTarget({ hostId: value.hostId, target: value.target })
      if (args.flags.has("--host") && hash(args.flags.get("--host")) !== ref.hostId) throw new AgentError("USAGE")
    } else { if (args.positional.length !== 3 || !args.local && !args.flags.has("--host")) throw new AgentError("USAGE"); commandId = id(args.positional[2]) }
    executing = true
    const access = await openHostAccess(deps); close = access.close
    hostId = ref?.hostId ?? (args.local ? access.env.paths.hostKey : hash(args.flags.get("--host")))
    if (args.local && hostId !== access.env.paths.hostKey) throw new AgentError("USAGE")
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
    emit({ ok: false, error: { code, message: code === "USAGE" ? "Use entry open --input-json JSON or entry inspect COMMAND (--host HOST | --local)" : error instanceof Error ? error.message : String(error), ...(error instanceof RuntimeOutcomeUnknown ? { reference: error.reference } : {}) } })
    return code === "USAGE" ? 64 : code === "OUTCOME_UNKNOWN" ? 75 : 69
  } finally { close?.() }
}
export async function runRuntimeEntryHelper(argv: readonly string[], deps: ControlDependencies, enter = (file: string, args: string[]) => new Promise<number>((resolve, reject) => {
  const child = spawn(file, args, { stdio: "inherit" }); child.once("error", reject); child.once("close", code => resolve(code ?? 75))
})): Promise<number> {
  try {
    if (argv.length !== 3 || argv[1] !== "--target-json") return 64
    const commandId = id(argv[0]), ref = parseEntryTarget(JSON.parse(argv[2]!)), env = await deps.environment()
    if (env.paths.hostKey !== ref.hostId) return 69
    let output = ""
    const code = await runEntryClient(["entry", "inspect", commandId, "--local", "--json"], { ...deps, stdout: value => { output += value } })
    if (code !== 0) return code
    const reply = parseHostReply(JSON.parse(output))
    if (!reply.ok || reply.result.state !== "entry") return 75
    const receipt = reply.result.receipt
    if (!receipt || receipt.state !== "opened" || !receipt.editor || !isDeepStrictEqual(receipt.ref, ref)) return 75
    return await enter("tmux", ["-S", receipt.editor.tmuxSocketPath, "attach-session", "-t", "=" + receipt.editor.session])
  } catch { deps.stderr("Entry outcome unavailable; inspect its owner and command\n"); return 75 }
}