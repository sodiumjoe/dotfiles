import type { CatalogService } from "../catalog/service.js"
import type { AgentService } from "../agent/service.js"
import { isDeepStrictEqual } from "node:util"
import { ControlError, PROTOCOL, controlError, errorReply, type ControlRequest, type ControlReply, type HandlerStatus } from "../control/protocol.js"
import type { PlatformPaths } from "../platform/paths.js"
import type { HandlerGenerationRecord, PlatformAdapter } from "../platform/types.js"
import { assertSameShutdown, readShutdownReceipt, writeShutdownReceipt, type ShutdownReceipt } from "./receipt.js"
import { type HandlerMutations } from "./mutations.js"

type ShutdownRequest = ControlRequest & { op: "shutdown" }
export type ShutdownContext = {
  record: HandlerGenerationRecord
  state: HandlerStatus
  paths: PlatformPaths
  adapter: PlatformAdapter
  mutations: HandlerMutations
  closeAfterReply(): Promise<void>
  publishReceipt?: typeof writeShutdownReceipt
  catalog?: Pick<CatalogService, "freezeAndDrain" | "resume" | "verifyDischarged">
  agents?: Pick<AgentService, "assertOrdinaryShutdownSafe" | "freezeAndDrain" | "resume" | "verifyDischarged">
  accepted?: ShutdownReceipt
  pending?: { request: ShutdownRequest; operation: Promise<ShutdownReceipt>; deadline: number }
}

function checkDeadline(deadline: number): void { if (performance.now() >= deadline) throw new ControlError("INCOMPLETE", "shutdown deadline exceeded; outcome remains unverified") }
async function bounded(operation: Promise<ShutdownReceipt>, deadline: number): Promise<ShutdownReceipt> {
  let timer: NodeJS.Timeout | undefined
  void operation.catch(() => undefined)
  try {
    checkDeadline(deadline)
    const value = await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ControlError("INCOMPLETE", "shutdown deadline exceeded; outcome remains unverified")), Math.max(1, deadline - performance.now())) })])
    checkDeadline(deadline)
    return value
  } finally { clearTimeout(timer) }
}

async function admit(request: ShutdownRequest, context: ShutdownContext, check: () => void): Promise<ShutdownReceipt> {
  check()
  const previous = await readShutdownReceipt(context.paths.persistentRoot, request.commandId)
  check()
  if (previous !== null) {
    assertSameShutdown(previous, request)
    if (previous.hostId !== context.record.hostId || !isDeepStrictEqual(previous.handlerIdentity, context.record.process)) throw new ControlError("COMMAND_CONFLICT")
  }
  if (context.record.process === null) throw new ControlError("INCOMPLETE", "Handler identity unavailable")
  const receipt: ShutdownReceipt = { version: 1, commandId: request.commandId, handlerGeneration: context.record.generation, hostId: context.record.hostId, handlerIdentity: context.record.process, stopAgents: request.stopAgents, state: "accepted" }
  await (context.publishReceipt ?? writeShutdownReceipt)(context.paths.persistentRoot, receipt)
  check()
  context.accepted = receipt
  context.state.phase = "draining"
  return receipt
}

export async function drainHandlerServices(context: Pick<ShutdownContext, "agents" | "catalog">, stopAgents: boolean): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => context.agents?.freezeAndDrain(stopAgents)),
    Promise.resolve().then(() => context.catalog?.freezeAndDrain()),
  ])
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, "Handler service drain failed")
}

export async function shutdownHandler(request: ShutdownRequest, context: ShutdownContext): Promise<ControlReply> {
  try {
    if (request.handlerGeneration !== context.record.generation) throw new ControlError("STALE_HANDLER")
    let receipt: ShutdownReceipt
    if (context.accepted !== undefined) {
      if (context.accepted.commandId !== request.commandId) throw new ControlError("INCOMPLETE", "Handler is draining")
      assertSameShutdown(context.accepted, request)
      receipt = context.accepted
    } else if (context.pending !== undefined) {
      if (context.pending.request.commandId !== request.commandId) throw new ControlError("INCOMPLETE", "shutdown already in progress")
      assertSameShutdown(context.pending.request, request)
      receipt = await bounded(context.pending.operation, context.pending.deadline)
    } else {
      if (context.state.phase !== "ready") throw new ControlError("INCOMPLETE", "Handler has not completed startup")
      if (!request.stopAgents) context.agents?.assertOrdinaryShutdownSafe()
      const deadline = performance.now() + 15000
      const check = (): void => {
        checkDeadline(deadline)
        if (request.handlerGeneration !== context.record.generation) throw new ControlError("STALE_HANDLER")
        if (context.state.phase !== "ready") throw new ControlError("INCOMPLETE", "Handler is not ready")
      }
      const operation = Promise.resolve().then(async () => {
        check()
        await drainHandlerServices(context, request.stopAgents)
        check()
        await context.catalog?.verifyDischarged()
        check()
        return context.mutations.queue.run(async () => {
          check()
          try { await context.agents?.verifyDischarged() } catch { throw new ControlError("INCOMPLETE", "agent cleanup or command durability remains unverified") }
          check()
          return await admit(request, context, check)
        })
      }).finally(() => {
        if (context.pending?.operation !== operation) return
        delete context.pending
        if (context.accepted === undefined && context.state.phase === "ready") { context.catalog?.resume(); context.agents?.resume() }
      })
      context.pending = { request, operation, deadline }
      receipt = await bounded(operation, deadline)
    }
    return { protocol: PROTOCOL, requestId: request.requestId, handlerGeneration: context.record.generation, ok: true, result: { state: "shutdown_accepted", commandId: receipt.commandId, handlerGeneration: receipt.handlerGeneration } }
  } catch (error) { return errorReply({ ...request, handlerGeneration: context.record.generation }, controlError(error, "INCOMPLETE")) }
}