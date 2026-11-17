import { randomUUID } from "node:crypto"
import type { LiveCore } from "./core.js"
import { liveErrorReply, parseLiveRequest, REQUEST_PROTOCOL, type LiveReply, type LiveRequest, type LiveResult } from "./protocol.js"

export async function dispatchLive(core: LiveCore, raw: unknown): Promise<LiveReply> {
  let request: LiveRequest
  try { request = parseLiveRequest(raw) }
  catch (error) {
    const requestId = typeof raw === "object" && raw !== null && typeof (raw as { requestId?: unknown }).requestId === "string" ? (raw as { requestId: string }).requestId : "00000000-0000-4000-8000-000000000000"
    core.failed("parse", undefined, error)
    return liveErrorReply({ requestId }, error)
  }
  try {
    let result: LiveResult
    switch (request.op) {
      case "start": { const { protocol: _protocol, requestId: _requestId, op: _op, ...start } = request; result = { state: "agent", agent: await core.start(start) }; break }
      case "restore": result = { state: "agent", agent: await core.restore(request.agentId, request.environment) }; break
      case "stop": result = { state: "agent", agent: await core.stop(request.agentId) }; break
      case "cancel": result = { state: "agent", agent: await core.cancel(request.agentId) }; break
      case "forget": result = await core.forget(request.agentId); break
      case "transcript": result = await core.transcript(request.agentId); break
      case "prompt": result = await core.prompt(request.agentId, request.text, request.environment, request.submissionId); break
      case "set": result = { state: "agent", agent: await core.set(request.agentId, request.setting, request.value) }; break
      case "excerpt": result = await core.excerpt(request.agentId, request.turns); break
      case "agents": result = { state: "agents", handlerGeneration: core.handlerGeneration, agents: await core.agents() }; break
      case "models": result = await core.models(); break
      case "permissions": result = { state: "permissions", snapshot: await core.permissions.snapshot() }; break
      case "decide": result = { state: "permission", receipt: await core.permissions.decide(randomUUID(), request.ref, request.optionId) }; break
    }
    return { protocol: REQUEST_PROTOCOL, requestId: request.requestId, ok: true, result }
  } catch (error) {
    core.failed(request.op, "agentId" in request ? request.agentId : undefined, error)
    return liveErrorReply(request, error)
  }
}