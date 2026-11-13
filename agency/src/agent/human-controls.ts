import type { AgentService } from "./service.js"
import type { AgentPage, PageInput } from "./queries.js"
import type { PermissionRef, PermissionReceipt, PermissionSnapshot } from "./permission-types.js"
import type { ConversationExcerpt, ExcerptInput } from "./excerpt.js"

export type RuntimeHumanRequest =
  | { op: "agent_roster"; input: PageInput }
  | { op: "agent_permissions" }
  | { op: "agent_permission_decide"; commandId: string; ref: PermissionRef; optionId: string }
  | { op: "agent_permission_inspect"; commandId: string }
  | { op: "agent_excerpt"; input: ExcerptInput }

export type RuntimeHumanResult = AgentPage
  | { state: "permissions"; snapshot: PermissionSnapshot }
  | { state: "permission"; receipt: PermissionReceipt | null }
  | ConversationExcerpt

export function isRuntimeHumanRequest(request: { op: string }): request is RuntimeHumanRequest {
  return ["agent_roster", "agent_permissions", "agent_permission_decide", "agent_permission_inspect", "agent_excerpt"].includes(request.op)
}

export async function dispatchRuntimeHuman(service: AgentService, request: RuntimeHumanRequest): Promise<RuntimeHumanResult> {
  switch (request.op) {
    case "agent_roster": return await service.roster(request.input)
    case "agent_permissions": return { state: "permissions", snapshot: await service.permissions.snapshot() }
    case "agent_permission_decide": return { state: "permission", receipt: await service.permissions.decide(request.commandId, request.ref, request.optionId) }
    case "agent_permission_inspect": return { state: "permission", receipt: await service.permissions.inspect(request.commandId) }
    case "agent_excerpt": return await service.excerpt(request.input)
  }
}