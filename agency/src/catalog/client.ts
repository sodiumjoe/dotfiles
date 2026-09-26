import { randomUUID } from "node:crypto"
import type { ControlDependencies } from "../cli/control.js"
import { ControlError, exitCode, UUID } from "../control/protocol.js"
import type { HandlerEnvironment } from "../handler/environment.js"
import { CATALOG_PROTOCOL, parseCatalogReply, validateCatalogReply, type CatalogReply, type CatalogRequest } from "./protocol.js"

export type CatalogClientDependencies = Pick<ControlDependencies, "environment" | "start" | "now" | "sleep" | "stdout" | "stderr"> & { callCatalog(env: HandlerEnvironment, request: CatalogRequest, timeoutMs?: number): Promise<CatalogReply> }
const unsupported = () => new ControlError("UNAVAILABLE", "catalog support is unavailable or the connection failed; an explicit Handler restart after upgrade may be needed")
export async function runCatalogClient(argv: readonly string[], dependencies: CatalogClientDependencies): Promise<number> {
  const requestId = randomUUID(), positional: string[] = [], flags = new Set<string>()
  let generation: string | null = null, commandId: string | undefined, json = false
  const emit = (ok: boolean, value: unknown) => dependencies.stdout(JSON.stringify({ protocol: CATALOG_PROTOCOL, requestId, handlerGeneration: generation, ...(commandId === undefined ? {} : { commandId }), ok, ...(ok ? { result: value } : { error: value }) }, null, json ? undefined : 2) + "\n")
  try {
    for (let i = 0; i < argv.length; i++) {
      const value = argv[i]!
      if (!value.startsWith("-")) { positional.push(value); continue }
      if (flags.has(value)) throw new ControlError("USAGE", "duplicate flag")
      flags.add(value)
      if (value === "--json") json = true
      else if (value === "--command-id" || value === "--handler-generation") {
        const next = argv[++i]
        if (next === undefined || !UUID.test(next)) throw new ControlError("USAGE", "retry IDs must be canonical UUIDs")
        if (value === "--command-id") commandId = next; else generation = next
      } else throw new ControlError("USAGE", "unsupported model command flag")
    }
    const command = positional.join(" ")
    if (command !== "model list" && command !== "model refresh") throw new ControlError("USAGE", "use model list or model refresh")
    if ((commandId === undefined) !== (generation === null) || command === "model list" && commandId !== undefined) throw new ControlError("USAGE", "refresh retry requires command ID and Handler generation together")
    if (command === "model refresh") commandId ??= randomUUID()
    const env = await dependencies.environment(), handler = await dependencies.start(env)
    if (generation !== null && generation !== handler.record.generation) throw new ControlError("STALE_HANDLER")
    generation ??= handler.record.generation
    const deadline = dependencies.now() + 60000
    let received = false
    for (let attempt = 0; attempt < 601; attempt++) {
      if (attempt > 0 && dependencies.now() >= deadline) break
      const request: CatalogRequest = commandId === undefined ? { protocol: CATALOG_PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, op: "model_list" } : { protocol: CATALOG_PROTOCOL, requestId: randomUUID(), handlerGeneration: generation, op: "model_refresh", commandId }
      let reply: CatalogReply | undefined
      try { reply = parseCatalogReply(await dependencies.callCatalog(env, request, Math.min(5000, deadline - dependencies.now()))); validateCatalogReply(reply, request); received = true }
      catch (error) {
        if (!(error instanceof ControlError) || error.code !== "UNAVAILABLE" && error.code !== "INCOMPLETE") throw error
        if (commandId === undefined) throw unsupported()
      }
      if (reply) {
        if (!reply.ok) throw new ControlError(reply.error.code, reply.error.message)
        if (reply.result.state === "catalog" || reply.result.command.state === "completed") { emit(true, reply.result); return 0 }
        if (reply.result.command.state === "interrupted") throw new ControlError("INCOMPLETE", "refresh was interrupted; new work requires a new command ID")
      }
      if (dependencies.now() >= deadline) break
      await dependencies.sleep(Math.min(100, deadline - dependencies.now()))
    }
    if (!received) throw unsupported()
    throw new ControlError("INCOMPLETE", "refresh remains incomplete; retry the returned command ID and Handler generation")
  } catch (error) {
    const value = error instanceof ControlError ? error : new ControlError("INTERNAL", "Catalog operation failed")
    emit(false, { code: value.code, message: value.message.slice(0, 2048) })
    dependencies.stderr(value.message.slice(0, 2048) + "\n")
    return exitCode(value.code)
  }
}