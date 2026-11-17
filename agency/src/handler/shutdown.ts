import type { LiveCore } from "../live/core.js"
import { ControlError, PROTOCOL, controlError, errorReply, type ControlRequest, type ControlReply, type HandlerStatus } from "../control/protocol.js"
import type { PlatformPaths } from "../platform/paths.js"
import type { HandlerGenerationRecord, PlatformAdapter } from "../platform/types.js"

type ShutdownRequest = ControlRequest & { op: "shutdown" }
type AcceptedShutdown = { commandId: string; handlerGeneration: string; stopAgents: boolean }
export type ShutdownContext = {
  record: HandlerGenerationRecord
  state: HandlerStatus
  paths: PlatformPaths
  adapter: PlatformAdapter
  closeAfterReply(): Promise<void>
  agents?: Pick<LiveCore, "assertOrdinaryShutdownSafe" | "freezeIfIdle" | "freezeAndDrain" | "resume" | "verifyDischarged" | "prepareHandoff">
  accepted?: AcceptedShutdown
  pending?: { request: ShutdownRequest; operation: Promise<AcceptedShutdown>; deadline: number }
}

function checkDeadline(deadline: number): void { if (performance.now() >= deadline) throw new ControlError("INCOMPLETE", "shutdown deadline exceeded; outcome remains unverified") }
async function bounded(operation: Promise<AcceptedShutdown>, deadline: number): Promise<AcceptedShutdown> {
  let timer: NodeJS.Timeout | undefined
  void operation.catch(() => undefined)
  try {
    checkDeadline(deadline)
    const value = await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ControlError("INCOMPLETE", "shutdown deadline exceeded; outcome remains unverified")), Math.max(1, deadline - performance.now())) })])
    checkDeadline(deadline)
    return value
  } finally { clearTimeout(timer) }
}
function joined(existing: { commandId: string; stopAgents: boolean }, request: ShutdownRequest, busy: string): void {
  if (existing.commandId !== request.commandId) throw new ControlError("INCOMPLETE", busy)
  if (existing.stopAgents !== request.stopAgents) throw new ControlError("COMMAND_CONFLICT")
}

export async function drainHandlerServices(context: Pick<ShutdownContext, "agents">, stopAgents: boolean): Promise<void> {
  await context.agents?.freezeAndDrain(stopAgents)
}

export async function shutdownHandler(request: ShutdownRequest, context: ShutdownContext): Promise<ControlReply> {
  try {
    if (request.handlerGeneration !== context.record.generation) throw new ControlError("STALE_HANDLER")
    let accepted: AcceptedShutdown
    if (context.accepted !== undefined) {
      joined(context.accepted, request, "Handler is draining")
      accepted = context.accepted
    } else if (context.pending !== undefined) {
      joined(context.pending.request, request, "shutdown already in progress")
      accepted = await bounded(context.pending.operation, context.pending.deadline)
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
        if (request.requireIdle) await context.agents?.freezeIfIdle()
        if (request.requireIdle && request.stopAgents) await context.agents?.prepareHandoff()
        await drainHandlerServices(context, request.stopAgents)
        check()
        try { await context.agents?.verifyDischarged() } catch { throw new ControlError("INCOMPLETE", "agent cleanup remains unverified") }
        check()
        context.accepted = { commandId: request.commandId, handlerGeneration: context.record.generation, stopAgents: request.stopAgents }
        context.state.phase = "draining"
        return context.accepted
      }).finally(() => {
        if (context.pending?.operation !== operation) return
        delete context.pending
        if (context.accepted === undefined && context.state.phase === "ready") context.agents?.resume()
      })
      context.pending = { request, operation, deadline }
      accepted = await bounded(operation, deadline)
    }
    return { protocol: PROTOCOL, requestId: request.requestId, handlerGeneration: context.record.generation, ok: true, result: { state: "shutdown_accepted", commandId: accepted.commandId, handlerGeneration: accepted.handlerGeneration } }
  } catch (error) { return errorReply({ ...request, handlerGeneration: context.record.generation }, controlError(error, "INCOMPLETE")) }
}