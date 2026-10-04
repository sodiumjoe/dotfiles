import type { LaunchContract } from "./contracts.js"

const codex: LaunchContract = Object.freeze({
  id: "codex-acp-1.7",
  providerId: "codex-acp",
  adapterPackage: "@agentclientprotocol/codex-acp",
  adapterVersion: "1.7.0",
  sessionLoad: true,
  modes: Object.freeze({ state: "values", values: Object.freeze(["read-only"]) }) as LaunchContract["modes"],
  reasoning: Object.freeze({ state: "values", values: Object.freeze(["high"]) }) as LaunchContract["reasoning"],
  effectiveMode: null,
  permissionProfiles: Object.freeze(["deny-all"]) as unknown as string[],
  modelOption: "model",
  reasoningOption: "reasoning_effort",
  modeOption: "mode",
  permissionEvidence: "agency-deny-all-v1",
  deadlines: Object.freeze({ commandMs: 5000, spawnMs: 5000, initializeMs: 15000, sessionMs: 15000, optionMs: 5000, promptMs: 90000, transportCloseMs: 1000, processTerminateMs: 5000, absenceMs: 2000, overallMs: 150000 }),
})
const contracts = Object.freeze([codex])
export const PRODUCTION_PROMPT_TRANSPORT_MS = Math.max(...contracts.map(contract => contract.deadlines.promptMs + contract.deadlines.transportCloseMs + 4000))
export const PRODUCTION_MUTATION_TRANSPORT_MS = Math.max(...contracts.map(contract => contract.deadlines.overallMs + contract.deadlines.transportCloseMs + 4000))

export function staticProductionContracts(): readonly LaunchContract[] { return contracts }