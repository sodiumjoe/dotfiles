import type { AgentService } from "./service.js"
import type { AgentPage, PageInput } from "./queries.js"
import { AgentError } from "./types.js"
import { OrchestrationError } from "../orchestration/types.js"
import type { PermissionRef, PermissionReceipt, PermissionSnapshot } from "../orchestration/permission-routing.js"

export type RuntimeHumanRequest =
  | { op: "agent_roster"; input: PageInput }
  | { op: "agent_permissions" }
  | { op: "agent_permission_decide"; commandId: string; ref: PermissionRef; optionId: string }
  | { op: "agent_permission_inspect"; commandId: string }

export type RuntimeHumanResult = AgentPage
  | { state: "permissions"; snapshot: PermissionSnapshot }
  | { state: "permission"; receipt: PermissionReceipt | null }

export function isRuntimeHumanRequest(request: { op: string }): request is RuntimeHumanRequest {
  return ["agent_roster", "agent_permissions", "agent_permission_decide", "agent_permission_inspect"].includes(request.op)
}

export async function dispatchRuntimeHuman(service: AgentService, request: RuntimeHumanRequest): Promise<RuntimeHumanResult> {
  try {
    switch (request.op) {
      case "agent_roster": return await service.roster(request.input)
      case "agent_permissions": return { state: "permissions", snapshot: await service.permissionRouting.snapshot() }
      case "agent_permission_decide": return { state: "permission", receipt: await service.permissionRouting.decide(request.commandId, request.ref, request.optionId) }
      case "agent_permission_inspect": return { state: "permission", receipt: await service.permissionRouting.inspect(request.commandId) }
    }
  } catch (error) {
    if (error instanceof OrchestrationError) {
      if (error.code === "COMMAND_CONFLICT") throw new AgentError("COMMAND_CONFLICT")
      if (error.code === "INVALID_OPTION") throw new AgentError("USAGE")
      if (error.code === "PERMISSIONS_UNAVAILABLE") throw new AgentError("UNAVAILABLE")
    }
    throw error
  }
}