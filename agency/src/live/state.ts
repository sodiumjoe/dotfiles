import type { ProviderSession } from "../agent/acp.js"
import type { Backend } from "../agent/backend-config.js"
import type { ConfiguredLaunchContract } from "../agent/contracts.js"
import type { Conversation } from "../agent/conversation.js"
import type { EditorRouting } from "../agent/editor-routing.js"
import type { OwnedAgentProcess } from "../agent/process.js"
import type { JsonObject, SessionConfiguration } from "../agent/session-config.js"
import type { TurnCoordinator } from "../agent/turns.js"
import type { AgentTuple, OwnedAgentRecord } from "../agent/types.js"
import type { ProviderId } from "../catalog/types.js"
import type { EchoFilter } from "./echo.js"

export type Activity = "starting" | "idle" | "working" | "stopping"
export type LiveAgent = {
  agentId: string; backendId: ProviderId; cwd: string; origin: "new" | "import"; createdAt: string; tuple: AgentTuple
  phase: "starting" | "ready" | "stopping"; launched: Promise<void>; ready: Promise<LiveAgent>; stopped?: Promise<void>; controller: AbortController; conversation: Conversation; echo: EchoFilter
  record?: OwnedAgentRecord; backend?: Backend; contract?: ConfiguredLaunchContract; owner?: OwnedAgentProcess; session?: ProviderSession; turns?: TurnCoordinator; editor?: EditorRouting
  running: Set<string>; prompts: Set<Promise<JsonObject>>; configuring: number; listeners: Set<(snapshot: SessionConfiguration) => void>; indexed: boolean; title: string | null; lastActivityAt: string | null
}
export type LiveTable = { get(agentId: string): LiveAgent | undefined; add(agent: LiveAgent): void; remove(agent: LiveAgent): void; all(): LiveAgent[]; activity(agent: LiveAgent): Activity; busy(): string[] }

export function createLiveTable(): LiveTable {
  const agents = new Map<string, LiveAgent>()
  const activity = (agent: LiveAgent): Activity => agent.phase === "starting" ? "starting" : agent.phase === "stopping" ? "stopping" : agent.running.size || agent.prompts.size || agent.configuring || agent.turns?.busy() ? "working" : "idle"
  return {
    get: agentId => agents.get(agentId),
    add(agent) { agents.set(agent.agentId, agent) },
    remove(agent) { if (agents.get(agent.agentId) === agent) agents.delete(agent.agentId) },
    all: () => [...agents.values()],
    activity,
    busy: () => [...agents.values()].filter(agent => activity(agent) !== "idle").map(agent => agent.agentId).sort(),
  }
}