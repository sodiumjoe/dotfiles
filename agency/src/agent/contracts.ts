import { isDeepStrictEqual } from "node:util"
import { adapterEntry, digest } from "../config/providers.js"
import { absolutePath, hash, keys, object, providerId, type ProviderId } from "../config/validate.js"
import { parseCapability, type Capability, type ProviderSnapshot } from "../config/models.js"
import { type ConfigEvidence, type ProviderProfile } from "../config/providers.js"
import { AGENT_LIMITS, AgentError, agentText, parseLaunchSpec, parsePermissionEvidence, parseSelection, type AgentIds, type LaunchSpec, type PermissionEvidence, type StartSelection } from "./types.js"
import { staticProductionContracts } from "./production-contracts.js"

export type ContractDeadlines = { commandMs: number; spawnMs: number; initializeMs: number; sessionMs: number; optionMs: number; promptMs: number; transportCloseMs: number; processTerminateMs: number; absenceMs: number; overallMs: number }
export type LaunchContract = { id: string; providerId: ProviderId; adapterPackage: string; adapterVersion: string; sdkVersion?: string; sessionLoad: boolean; promptCapabilities?: { image: boolean; audio: boolean; embeddedContext: boolean }; modes: Capability; reasoning: Capability; effectiveMode: string | null; permissionProfiles: string[]; modelOption: string; reasoningOption: string | null; modeOption: string | null; permissionEvidence: PermissionEvidence; deadlines: ContractDeadlines }
export type ConfiguredLaunchContract = LaunchContract & { entrypoint: string; executable: string; fingerprint: string }
export const cleanupBudget = (contract: LaunchContract): number => contract.deadlines.processTerminateMs + contract.deadlines.absenceMs + contract.deadlines.transportCloseMs

const deadlineKeys = ["commandMs", "spawnMs", "initializeMs", "sessionMs", "optionMs", "promptMs", "transportCloseMs", "processTerminateMs", "absenceMs", "overallMs"] as const
function parseDeadlines(input: unknown): ContractDeadlines {
  const value = object(input)
  keys(value, deadlineKeys)
  const result = Object.fromEntries(deadlineKeys.map(key => [key, value[key]])) as Record<typeof deadlineKeys[number], unknown>
  for (const key of deadlineKeys) if (typeof result[key] !== "number" || !Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > 600000) throw new Error()
  return result as ContractDeadlines
}

export function productionLaunchContracts(): readonly LaunchContract[] { return staticProductionContracts() }
export function parseLaunchContract(input: unknown): LaunchContract {
  try {
    const v = object(input)
    keys(v, ["id", "providerId", "adapterPackage", "adapterVersion", "sessionLoad", ...["promptCapabilities", "sdkVersion"].filter(key => Object.hasOwn(v, key)), "modes", "reasoning", "effectiveMode", "permissionProfiles", "modelOption", "reasoningOption", "modeOption", "permissionEvidence", "deadlines"])
    if (typeof v.sessionLoad !== "boolean" || !Array.isArray(v.permissionProfiles) || v.permissionProfiles.length < 1 || v.permissionProfiles.length > 16) throw new Error()
    const provider = providerId(v.providerId), adapterPackage = agentText(v.adapterPackage), permissionEvidence = parsePermissionEvidence(v.permissionEvidence)
    if (adapterPackage !== `@agentclientprotocol/${provider}`) throw new Error()
    const modes = parseCapability(v.modes), reasoning = parseCapability(v.reasoning)
    const permissionProfiles = v.permissionProfiles.map(value => agentText(value)), modelOption = agentText(v.modelOption), modeOption = v.modeOption === null ? null : agentText(v.modeOption), reasoningOption = v.reasoningOption === null ? null : agentText(v.reasoningOption), effectiveMode = v.effectiveMode === null ? null : agentText(v.effectiveMode)
    if (new Set(permissionProfiles).size !== permissionProfiles.length || modes.state === "unknown" || reasoning.state === "unknown") throw new Error()
    if ((modes.state === "none") !== (modeOption === null) || (modes.state === "none") !== (effectiveMode !== null) || (reasoning.state === "none") !== (reasoningOption === null)) throw new Error()
    const optionIds = [modelOption, modeOption, reasoningOption].filter(value => value !== null)
    if (new Set(optionIds).size !== optionIds.length) throw new Error()
    let promptCapabilities: LaunchContract["promptCapabilities"]
    if (v.promptCapabilities !== undefined) {
      const capabilities = object(v.promptCapabilities)
      keys(capabilities, ["image", "audio", "embeddedContext"])
      if (["image", "audio", "embeddedContext"].some(key => typeof capabilities[key] !== "boolean")) throw new Error()
      promptCapabilities = capabilities as NonNullable<LaunchContract["promptCapabilities"]>
    }
    return { id: agentText(v.id), providerId: provider, adapterPackage, adapterVersion: agentText(v.adapterVersion), ...(v.sdkVersion !== undefined ? { sdkVersion: agentText(v.sdkVersion) } : {}), sessionLoad: v.sessionLoad, ...(promptCapabilities ? { promptCapabilities } : {}), modes, reasoning, effectiveMode, permissionProfiles, modelOption, reasoningOption, modeOption, permissionEvidence, deadlines: parseDeadlines(v.deadlines) }
  } catch { throw new AgentError("ADAPTER_UNQUALIFIED") }
}

export function launchContractFingerprint(input: LaunchContract & { entrypoint: string; executable: string }, configurationFingerprint: string): string {
  const { entrypoint, executable, ...candidate } = input as ConfiguredLaunchContract
  delete (candidate as Partial<ConfiguredLaunchContract>).fingerprint
  return digest(JSON.stringify([parseLaunchContract(candidate), hash(configurationFingerprint), absolutePath(entrypoint), absolutePath(executable)]))
}

export function parseConfiguredLaunchContract(input: unknown): ConfiguredLaunchContract {
  try {
    const v = object(input)
    keys(v, ["id", "providerId", "adapterPackage", "adapterVersion", "sessionLoad", ...["promptCapabilities", "sdkVersion"].filter(key => Object.hasOwn(v, key)), "modes", "reasoning", "effectiveMode", "permissionProfiles", "modelOption", "reasoningOption", "modeOption", "permissionEvidence", "deadlines", "entrypoint", "executable", "fingerprint"])
    const contract = parseLaunchContract(Object.fromEntries(Object.entries(v).filter(([key]) => !["entrypoint", "executable", "fingerprint"].includes(key))))
    return { ...contract, entrypoint: absolutePath(v.entrypoint), executable: absolutePath(v.executable), fingerprint: hash(v.fingerprint) }
  } catch { throw new AgentError("ADAPTER_UNQUALIFIED") }
}

export async function configureLaunchContract(input: LaunchContract, profile: ProviderProfile, configuration: ConfigEvidence): Promise<ConfiguredLaunchContract> {
  try {
    const contract = parseLaunchContract(input)
    if (!profile.enabled || profile.id !== contract.providerId || configuration.providerId !== contract.providerId || configuration.adapterVersion !== contract.adapterVersion || configuration.sdkVersion !== (contract.sdkVersion ?? null) || contract.adapterPackage !== `@agentclientprotocol/${profile.id}`) throw new Error()
    const configured = { ...contract, entrypoint: await adapterEntry(profile), executable: absolutePath(profile.executable) }
    return { ...configured, fingerprint: launchContractFingerprint(configured, configuration.fingerprint) }
  } catch { throw new AgentError("ADAPTER_UNQUALIFIED") }
}