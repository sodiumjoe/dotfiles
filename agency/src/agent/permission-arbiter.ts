import { randomUUID } from "node:crypto"
import { hash, id, object, text } from "../catalog/types.js"
import { MutationQueue } from "../handler/mutations.js"
import type { JsonObject } from "./session-config.js"
import { AgentError, type AgentTuple } from "./types.js"
import { permissionDigest, permissionKey, parsePermissionOffer, parsePermissionRef, parsePermissionSnapshot, type PermissionEvent, type PermissionOffer, type PermissionReceipt, type PermissionRef } from "./permission-types.js"

type Request = { offer: PermissionOffer; state: "pending" | "claimed"; respond?: (optionId: string) => Promise<void> }
type Command = { receipt: PermissionReceipt; completion?: Promise<PermissionReceipt> }
export type PermissionArbiter = ReturnType<typeof createPermissionArbiter>
export function createPermissionArbiter(input: { hostId: string; handlerGeneration: string }) {
  const hostId = hash(input.hostId), handlerGeneration = id(input.handlerGeneration), queue = new MutationQueue()
  const requests = new Map<string, Request>(), commands = new Map<string, Command>(), listeners = new Set<(event: PermissionEvent) => void>()
  let throughSeq = 0, closed = false
  const ready = () => { if (closed) throw new AgentError("UNAVAILABLE") }
  const publish = (event: PermissionEvent) => { throughSeq++; for (const listener of listeners) { try { listener(structuredClone(event)) } catch {} } }
  const record = (receipt: PermissionReceipt): Command => { const command = { receipt }; commands.set(receipt.commandId, command); publish({ kind: "receipt", receipt }); return command }
  function validated<T>(parse: () => T): T { try { return parse() } catch { throw new AgentError("INVALID_PROTOCOL") } }
  return {
    async open(target: AgentTuple, params: JsonObject, originCwd: string, respond: (optionId: string) => Promise<void>): Promise<PermissionRef> {
      ready()
      const ref = parsePermissionRef({ hostId, target, permissionId: randomUUID(), revision: 1 })
      if (ref.target.handlerGeneration !== handlerGeneration) throw new AgentError("STALE_HANDLER")
      const subject = validated(() => object(params.toolCall))
      const offer = parsePermissionOffer({ ref, title: typeof subject.title === "string" && subject.title.length ? subject.title : "Permission request", subject, options: params.options, originCwd, toolCallId: subject.toolCallId })
      return queue.run(async () => { ready(); requests.set(permissionKey(ref), { offer, respond, state: "pending" }); throughSeq++; return structuredClone(ref) })
    },
    async decide(commandId: string, rawRef: PermissionRef, optionId: string): Promise<PermissionReceipt> {
      ready()
      const ref = parsePermissionRef(rawRef)
      commandId = validated(() => id(commandId)); optionId = validated(() => text(optionId))
      const value = { commandId, ref, optionId }, wanted: PermissionReceipt = { ...value, digest: permissionDigest(value), state: "claimed" }
      const begun = await queue.run(async () => {
        ready()
        const prior = commands.get(commandId)
        if (prior) { if (prior.receipt.digest !== wanted.digest) throw new AgentError("COMMAND_CONFLICT"); return prior }
        if (ref.hostId !== hostId) return { receipt: { ...wanted, state: "stale" as const } }
        const request = requests.get(permissionKey(ref))
        if (ref.target.handlerGeneration !== handlerGeneration || !request) return record({ ...wanted, state: "stale" })
        if (!request.offer.options.some(option => option.optionId === optionId)) throw new AgentError("USAGE")
        if (request.state === "claimed") return record({ ...wanted, state: "withdrawn" })
        const respond = request.respond!
        request.state = "claimed"; delete request.respond
        const command: Command = { receipt: wanted }
        command.completion = Promise.resolve().then(() => respond(optionId)).then(() => "applied" as const, () => "uncertain" as const).then(state => queue.run(async () => {
          const result = { ...wanted, state }
          if (!closed && commands.get(commandId) === command && command.receipt.state === "claimed") { command.receipt = result; publish({ kind: "receipt", receipt: result }) }
          return result
        }))
        commands.set(commandId, command)
        publish({ kind: "receipt", receipt: wanted }); publish({ kind: "withdraw", ref })
        return command
      })
      return structuredClone(begun.completion ? await begun.completion : begun.receipt)
    },
    async invalidate(target: AgentTuple): Promise<void> {
      ready()
      const exact = validated(() => { const ref = parsePermissionRef({ hostId, target, permissionId: randomUUID(), revision: 1 }); return permissionDigest(ref.target) })
      return queue.run(async () => { ready(); for (const [key, request] of requests) if (permissionDigest(request.offer.ref.target) === exact) { requests.delete(key); delete request.respond; publish({ kind: "withdraw", ref: request.offer.ref }) } })
    },
    async snapshot() {
      ready()
      return queue.run(async () => { ready(); return parsePermissionSnapshot({ hostId, handlerGeneration, throughSeq, pending: [...requests.values()].filter(request => request.state === "pending").map(request => request.offer), receipts: [...commands.values()].map(command => command.receipt) }) })
    },
    async inspect(commandId: string): Promise<PermissionReceipt | null> {
      ready(); validated(() => id(commandId))
      return queue.run(async () => { ready(); return structuredClone(commands.get(commandId)?.receipt ?? null) })
    },
    subscribe(listener: (event: PermissionEvent) => void): () => void { ready(); listeners.add(listener); return () => { listeners.delete(listener) } },
    close(): void {
      if (closed) return
      closed = true
      const refs = [...requests.values()].map(request => request.offer.ref)
      requests.clear(); commands.clear()
      for (const ref of refs) publish({ kind: "withdraw", ref })
      listeners.clear()
    }
  }
}