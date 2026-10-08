import { runBureauWatch } from "./watch-client.js"
import { randomUUID } from "node:crypto"
import { createConnection } from "node:net"
import { assertPrivateSocket } from "../platform/private-socket.js"
import { snapshotLaunchEnvironment } from "../agent/environment.js"
import type { ControlDependencies } from "../cli/control.js"
import { BUREAU_PROTOCOL, exchangeBureau, parseBureauRequest, type BureauRequest } from "./protocol.js"
import { id } from "../catalog/types.js"

export async function runBureauClient(argv: readonly string[], deps: ControlDependencies): Promise<number> {
  if (argv[0] === "roster" && !(["watch", "list"].includes(argv[1] ?? ""))) argv = ["roster", "list", ...argv.slice(1)]
  if (argv[1] === "watch") return runBureauWatch(argv, deps)
  try {
    const group = argv[0], action = argv[1], position: string[] = [], flags = new Map<string, string>()
    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i]!
      if (arg === "--json") { if (flags.has(arg)) throw new Error("duplicate flag"); flags.set(arg, "true"); continue }
      if (!arg.startsWith("--")) { position.push(arg); continue }
      if (!["--command-id", "--handler-generation", "--input-json", "--mcp-servers-json", "--after", "--mode", "--objective", "--parent-id", "--run-id", "--target-json", "--binding-epoch", "--digest", "--host-id", "--inventory-id"].includes(arg) || flags.has(arg) || argv[i + 1] === undefined) throw new Error("invalid flag")
      flags.set(arg, argv[++i]!)
    }
    const operations: Record<string, string> = { "entry prepare": "entry_prepare", "entry consume": "entry_consume", "entry inspect": "entry_inspect", "roster list": "roster_snapshot", "permission list": "permission_snapshot", "permission decide": "permission_decide", "permission inspect": "permission_inspect", "bureau enroll": "bureau_enroll", "bureau hosts": "bureau_hosts", "bureau enable": "bureau_enable", "bureau disable": "bureau_disable", "bureau status": "bureau_status", "run list": "run_list", "run start": "run_start", "run begin": "run_begin", "run inspect": "run_inspect", "run cancel": "run_cancel", "run close": "run_close", "run forget": "run_forget", "assignment create": "assignment_create", "assignment inspect": "assignment_inspect", "assignment retry": "assignment_retry", "run restore": "run_restore", "bureau command": "command_inspect", "bureau retry-notification": "notification_retry", "bureau acknowledge-reports": "report_acknowledge", "bureau recover-stop": "stop_recover", "bureau inbox": "inbox_inspect" }
    const op = operations[group + " " + action]
    if (!op) throw new Error("unsupported Bureau command")
    const env = await deps.environment(), expected = flags.get("--handler-generation"), commandId = flags.has("--command-id") ? id(flags.get("--command-id")) : randomUUID()
    const raw: Record<string, unknown> = { protocol: BUREAU_PROTOCOL, requestId: randomUUID(), handlerGeneration: expected ?? "00000000-0000-4000-8000-000000000000", op }
    const invocation = { environment: snapshotLaunchEnvironment(process.env), nativeParams: { mcpServers: JSON.parse(flags.get("--mcp-servers-json") ?? "[]") } }
    const input = () => JSON.parse(flags.get("--input-json") ?? "null")
    if (["run_start", "run_cancel", "run_close", "run_forget", "run_begin", "assignment_create", "assignment_retry", "run_restore", "notification_retry", "report_acknowledge", "stop_recover"].includes(op)) raw.commandId = commandId
    if (op === "entry_prepare" || op === "entry_inspect") { raw.commandId = op === "entry_prepare" ? commandId : position[0]; raw.ref = input() }
    if (op === "entry_consume") { raw.commandId = position[0]; raw.digest = flags.get("--digest"); raw.hostId = flags.get("--host-id"); raw.inventoryId = flags.get("--inventory-id") }
    if (op === "permission_decide") { raw.commandId = commandId; const value = input(); raw.ref = value?.ref; raw.optionId = value?.optionId }
    if (op === "permission_inspect") raw.commandId = position[0]
    if (op === "bureau_enroll") raw.enrollment = input()
    if (op === "run_start") { raw.input = { hostId: env.paths.hostKey, cwd: deps.cwd(), ...input() }; raw.invocation = invocation }
    if (op === "run_begin") { raw.root = { hostId: env.paths.hostKey, agentId: position[0] }; raw.objective = flags.get("--objective") }
    if (["run_inspect", "run_cancel", "run_close", "run_forget", "run_restore"].includes(op)) raw.runId = position[0]
    if (op === "run_restore") raw.invocation = invocation
    if (op === "run_inspect" && flags.has("--after")) raw.after = flags.get("--after")
    if (op === "assignment_create") { raw.runId = flags.get("--run-id"); raw.input = { hostId: env.paths.hostKey, cwd: deps.cwd(), parent: { hostId: env.paths.hostKey, agentId: flags.get("--parent-id") }, ...input() }; raw.invocation = invocation }
    if (["assignment_inspect", "assignment_retry"].includes(op)) raw.assignmentId = position[0]
    if (op === "assignment_retry") { raw.mode = flags.get("--mode"); raw.invocation = invocation }
    if (op === "command_inspect") raw.commandId = position[0]
    if (op === "report_acknowledge") { raw.runId = position[0]; raw.sources = input() }
    if (op === "stop_recover") { if (!flags.has("--command-id")) throw new Error("original command ID required"); raw.runId = position[0] }
    if (op === "inbox_inspect") { raw.runId = position[0]; raw.parent = { hostId: env.paths.hostKey, agentId: flags.get("--parent-id") }; raw.after = Number(flags.get("--after") ?? "0") }
    if (op === "notification_retry") { raw.deliveryId = position[0]; raw.target = JSON.parse(flags.get("--target-json") ?? "null"); raw.bindingEpoch = flags.get("--binding-epoch") }
    let request: BureauRequest
    try { request = parseBureauRequest(raw) } catch { deps.stderr("Invalid Bureau arguments\n"); return 64 }
    const handler = await deps.inspect(env)
    if (!handler || handler.disposition !== "live" || handler.record.phase !== "ready") { deps.stderr("Bureau requires a ready Handler\n"); return 69 }
    request = { ...request, handlerGeneration: expected ?? handler.record.generation }
    const response = deps.callBureau ? await deps.callBureau(env, request, 150000) : await exchangeBureau(createConnection(await assertPrivateSocket(env.paths.runtimeRoot, "bureau.sock")), request, 150000)
    deps.stdout(JSON.stringify({ ...response, ...(raw.commandId ? { commandId: raw.commandId } : {}) }) + "\n")
    return response.ok ? 0 : ["STALE_HANDLER", "STALE_EXECUTION", "BUREAU_DISABLED", "BUREAU_UNAVAILABLE"].includes(response.error.code) ? 69 : 75
  } catch { deps.stderr("Bureau command failed\n"); return 64 }
}