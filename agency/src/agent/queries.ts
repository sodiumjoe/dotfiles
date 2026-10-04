import { randomUUID } from "node:crypto"
import { digest } from "../catalog/config.js"
import { absolutePath, id, keys, object, type ProviderId } from "../catalog/types.js"
import type { LaunchEvidence } from "../catalog/service.js"
import { resolveLaunchSpec, type ConfiguredLaunchContract } from "./contracts.js"
import { AgentError, type AgentView, type LegacyAgentView, type StartSelection } from "./types.js"
import type { AgentStateIssue } from "./store.js"

export type LaunchChoice = { displayName: string; selection: StartSelection; snapshotId: string; contractFingerprint: string }
export type AgentChoices = { state: "choices"; choices: LaunchChoice[]; unavailable: Array<{ providerId: ProviderId; reason: string }> }
export type AgentPage = { state: "page"; revision: string; agents: Array<AgentView | LegacyAgentView>; issues: AgentStateIssue[]; nextCursor: string | null }
export type PageInput = { limit: number; cursor?: string; cwd?: string; activeOnly?: boolean }
export const QUERY_BYTES = 7 * 1024 * 1024
export const CURSOR_BYTES = 1024
export function parsePageInput(input: unknown): PageInput {
  try {
    const v = object(input)
    keys(v, ["limit", ...["cursor", "cwd", "activeOnly"].filter(key => Object.hasOwn(v, key))])
    if (!Number.isSafeInteger(v.limit) || (v.limit as number) < 1 || (v.limit as number) > 100) throw new Error()
    if (Object.hasOwn(v, "activeOnly") && typeof v.activeOnly !== "boolean") throw new Error()
    if (Object.hasOwn(v, "cursor") && (typeof v.cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(v.cursor) || v.cursor.length > CURSOR_BYTES)) throw new Error()
    return { limit: v.limit as number, ...(Object.hasOwn(v, "cursor") ? { cursor: v.cursor as string } : {}), ...(Object.hasOwn(v, "cwd") ? { cwd: absolutePath(v.cwd) } : {}), ...(Object.hasOwn(v, "activeOnly") ? { activeOnly: v.activeOnly as boolean } : {}) }
  } catch { throw new AgentError("INVALID_PROTOCOL") }
}
export function launchChoices(evidence: LaunchEvidence, contract: ConfiguredLaunchContract, hostId: string, generation: string): LaunchChoice[] {
  const choices: LaunchChoice[] = []
  const modes = contract.modes.state === "values" ? contract.modes.values : contract.effectiveMode ? [contract.effectiveMode] : []
  const reasonings = contract.reasoning.state === "values" ? contract.reasoning.values.map(value => ({ kind: "value" as const, value })) : contract.reasoning.state === "none" ? [{ kind: "none" as const }] : []
  for (const model of evidence.provider.models) for (const reasoning of reasonings) for (const mode of modes) for (const permissionProfile of contract.permissionProfiles) {
    const selection: StartSelection = { providerId: contract.providerId, modelId: model.modelId, reasoning, mode, permissionProfile }
    try {
      const spec = resolveLaunchSpec({ ids: { hostId, handlerGeneration: generation, agentId: randomUUID(), providerGeneration: randomUUID(), launchAttemptId: randomUUID(), commandId: randomUUID() }, cwd: "/", selection, snapshotId: evidence.snapshotId, provider: evidence.provider, configuration: evidence.configuration, contract })
      choices.push({ displayName: model.displayName, selection: structuredClone(spec.selection), snapshotId: evidence.snapshotId, contractFingerprint: contract.fingerprint })
    } catch (error) { if (!(error instanceof AgentError) || !["MODEL_UNAVAILABLE", "INVALID_AGENT_STATE", "SELECTION_UNSUPPORTED"].includes(error.code)) throw error }
    if (choices.length > 4096 || Buffer.byteLength(JSON.stringify(choices)) > QUERY_BYTES) throw new AgentError("INCOMPLETE")
  }
  return choices
}
export function inventoryPage(state: { revision: string; agents: Array<AgentView | LegacyAgentView>; issues: AgentStateIssue[] }, raw: PageInput): AgentPage {
  const input = parsePageInput(raw), filters = digest(JSON.stringify([input.cwd ?? null, input.activeOnly ?? false]))
  const agentId = (a: AgentView | LegacyAgentView): string => a.record.version === 2 ? a.record.definition.agentId : a.record.spec.agentId
  const agents = state.agents.filter(a => !input.cwd || (a.record.version === 2 ? a.record.definition.cwd : a.record.spec.checkout.root.path) === input.cwd).sort((a, b) => agentId(a).localeCompare(agentId(b)))
  const issues = [...state.issues].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  let after: string | null = null, issueOffset = 0
  if (input.cursor) {
    let c: Record<string, unknown>
    try {
      const bytes = Buffer.from(input.cursor, "base64url")
      if (bytes.toString("base64url") !== input.cursor) throw new Error()
      c = object(JSON.parse(bytes.toString("utf8"))); keys(c, ["revision", "filters", "after", "issueOffset"])
      id(c.revision)
      if (typeof c.filters !== "string" || !/^[a-f0-9]{64}$/.test(c.filters)) throw new Error()
      if (c.after !== null) id(c.after)
      if (!Number.isSafeInteger(c.issueOffset) || (c.issueOffset as number) < 0) throw new Error()
    } catch { throw new AgentError("INVALID_PROTOCOL") }
    if (c.revision !== state.revision || c.filters !== filters) throw new AgentError("RESYNC_REQUIRED")
    after = c.after as string | null; issueOffset = c.issueOffset as number
    if (after !== null && !agents.some(a => agentId(a) === after) || issueOffset > issues.length) throw new AgentError("INVALID_PROTOCOL")
  }
  const remaining = agents.filter(a => after === null || agentId(a) > after)
  if (issueOffset > 0 && remaining.length) throw new AgentError("INVALID_PROTOCOL")
  const result: AgentPage = { state: "page", revision: state.revision, agents: [], issues: [], nextCursor: null }
  let bytes = 2048, count = 0
  for (const a of remaining) {
    const size = Buffer.byteLength(JSON.stringify(a)) + 1
    if (size + 2048 > QUERY_BYTES) throw new AgentError("INCOMPLETE")
    if (count === input.limit || bytes + size > QUERY_BYTES) break
    result.agents.push(a); bytes += size; count++; after = agentId(a)
  }
  if (result.agents.length === remaining.length) for (const issue of issues.slice(issueOffset)) {
    const size = Buffer.byteLength(JSON.stringify(issue)) + 1
    if (size + 2048 > QUERY_BYTES) throw new AgentError("INCOMPLETE")
    if (count === input.limit || bytes + size > QUERY_BYTES) break
    result.issues.push(issue); bytes += size; count++; issueOffset++
  }
  if (result.agents.length < remaining.length || issueOffset < issues.length) result.nextCursor = Buffer.from(JSON.stringify({ revision: state.revision, filters, after, issueOffset })).toString("base64url")
  return structuredClone(result)
}