import type { ProviderId } from "../catalog/types.js"
import type { Activity, LiveAgent, LiveTable } from "./state.js"

export type LiveRow = { activity: Activity; handlerGeneration: string; providerGeneration: string; model: string | null; mode: string | null }
export type RosterRow = { agentId: string; backendId: ProviderId; cwd: string; createdAt: string; title: string | null; lastActivityAt: string | null; live: LiveRow | null }
export type History = { title: string | null; lastActivityAt: string | null }

export function currentSettings(agent: LiveAgent): { model: string | null; mode: string | null } {
  let snapshot
  try { snapshot = agent.session && agent.owner ? agent.owner.snapshot() : null } catch { snapshot = null }
  if (!snapshot || !agent.contract) return { model: null, mode: null }
  const option = (id: string | null): unknown => id === null ? undefined : snapshot.configOptions.find(value => value.id === id)?.currentValue
  const model = option(agent.contract.modelOption), mode = option(agent.contract.modeOption)
  return { model: typeof model === "string" ? model : typeof snapshot.models?.currentModelId === "string" ? snapshot.models.currentModelId : null,
    mode: typeof mode === "string" ? mode : typeof snapshot.modes?.currentModeId === "string" ? snapshot.modes.currentModeId : null }
}

export function liveRow(table: LiveTable, agent: LiveAgent, history?: History): RosterRow {
  return { agentId: agent.agentId, backendId: agent.backendId, cwd: agent.cwd, createdAt: agent.createdAt, title: agent.conversation.display().title ?? history?.title ?? null, lastActivityAt: agent.lastActivityAt ?? history?.lastActivityAt ?? null,
    live: { activity: table.activity(agent), handlerGeneration: agent.tuple.handlerGeneration, providerGeneration: agent.tuple.providerGeneration, ...currentSettings(agent) } }
}