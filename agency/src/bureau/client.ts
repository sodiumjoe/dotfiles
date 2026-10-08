import type { BureauService } from "./service.js"
import type { BureauReply, BureauRequest } from "./protocol.js"
import { fail, OrchestrationError } from "../orchestration/types.js"

export async function dispatchBureau(core: BureauService, generation: string, request: BureauRequest): Promise<BureauReply> {
  const base = { protocol: request.protocol, requestId: request.requestId, handlerGeneration: generation }
  try {
    if (request.handlerGeneration !== generation) fail("STALE_HANDLER")
    let result: unknown
    switch (request.op) {
      case "bureau_status": result = await core.status(); break
      case "bureau_enable": await core.enable(); result = await core.status(); break
      case "bureau_disable": await core.disable(); result = await core.status(); break
      case "run_list": result = await core.list(); break
      case "run_inspect": result = await core.inspect(request.runId, request.after ?? null); break
      case "run_start": result = await core.startRun(request.commandId, request.input, request.invocation); break
      case "run_restore": result = await core.restoreRun(request.commandId, request.runId, request.invocation); break
      case "notification_retry": result = await core.retryNotification(request.commandId, request.deliveryId, request.target, request.bindingEpoch); break
      case "run_begin": result = await core.beginRun(request.commandId, request.root, request.objective); break
      case "run_cancel": result = await core.cancel(request.commandId, request.runId); break
      case "run_close": result = await core.closeRun(request.commandId, request.runId); break
      case "run_forget": result = await core.forget(request.commandId, request.runId); break
      case "assignment_create": result = await core.delegate(request.commandId, request.runId, request.input, request.invocation); break
      case "assignment_retry": result = await core.retry(request.commandId, request.assignmentId, request.mode, request.invocation); break
      case "command_inspect": result = await core.command(request.commandId); break
      case "assignment_inspect": result = await core.assignment(request.assignmentId); break
    }
    return { ...base, ok: true, result }
  } catch (error) {
    const code = error instanceof OrchestrationError ? error.code : "BUREAU_UNAVAILABLE"
    return { ...base, ok: false, error: { code, message: code } }
  }
}