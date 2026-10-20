import { dispatchRuntimeSession, isRuntimeSessionRequest } from "./session-controls.js"
import { destinationEnvironment, type LaunchEnvironment } from "./environment.js"
import { dispatchRuntimeHuman, isRuntimeHumanRequest } from "./human-controls.js"
import { AGENT_PROTOCOL, agentErrorReply, commandIdFor, type AgentRequest, type AgentReply } from "./protocol.js"
import { AgentError } from "./types.js"
import type { AgentService } from "./service.js"

export async function dispatchAgentRequest(input: { agents: AgentService | undefined; generation: string; ready(): boolean; environment?(): LaunchEnvironment }, request: AgentRequest): Promise<AgentReply> {
  const bound = { ...request, handlerGeneration: input.generation }
  if (request.handlerGeneration !== input.generation) return agentErrorReply(bound, new AgentError("STALE_HANDLER"))
  if (!input.agents || !input.ready()) return agentErrorReply(bound, new AgentError("NOT_READY"))
  try {
    let result: Extract<AgentReply, { ok: true }>["result"]
    if (isRuntimeHumanRequest(request)) result = await dispatchRuntimeHuman(input.agents, request)
    else if (isRuntimeSessionRequest(request)) result = await dispatchRuntimeSession(input.agents, request, input.environment ?? (() => destinationEnvironment(process.env)))
    else switch (request.op) {
      case "agent_import": result = await input.agents.importSession(request.input); break
      case "agent_choices": result = await input.agents.choices(); break
      case "agent_page": result = await input.agents.page(request.input); break
      case "agent_start": result = await input.agents.start(request.input); break
      case "agent_restore": result = await input.agents.restore(request.input); break
      case "agent_prompt": result = await input.agents.prompt(request.input); break
      case "agent_command": result = await input.agents.command(request.commandId, request.commandGeneration); break
      case "agent_current": result = await input.agents.current(request.cwd); break
      case "agent_list": result = await input.agents.list(); break
      default: throw new AgentError("INVALID_PROTOCOL")
    }
    const commandId = commandIdFor(request)
    return { protocol: AGENT_PROTOCOL, requestId: request.requestId, handlerGeneration: input.generation, ...(commandId ? { commandId } : {}), ok: true, result }
  } catch (error) { return agentErrorReply(bound, error) }
}