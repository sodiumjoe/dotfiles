import { lstat, realpath } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { digest, readBoundedFile } from "../catalog/config.js"
import { absolutePath, hash, keys, object, parseCapability, providerId, type Capability, type ConfigEvidence, type ProviderId, type ProviderSnapshot } from "../catalog/types.js"
import type { CheckoutIdentity } from "../checkout/identity.js"
import { AGENT_LIMITS, AgentError, agentText, parseLaunchSpec, parseSelection, type AgentIds, type LaunchSpec, type StartSelection } from "./types.js"

export type LaunchContract = { id: string; providerId: ProviderId; adapterVersion: string; entrypoint: string; fingerprint: string; modes: Capability; reasoning: Capability; effectiveMode: string | null; permissionProfiles: string[]; modelOption: string; reasoningOption: string | null; modeOption: string | null; environment: NodeJS.ProcessEnv; permissionEvidence: "fixture-contract-v1" }
export function productionLaunchContracts(): readonly LaunchContract[] { return Object.freeze([]) }
export function parseLaunchContract(input: unknown): LaunchContract {
  try {
    const v = object(input)
    keys(v, ["id", "providerId", "adapterVersion", "entrypoint", "fingerprint", "modes", "reasoning", "effectiveMode", "permissionProfiles", "modelOption", "reasoningOption", "modeOption", "environment", "permissionEvidence"])
    if (v.permissionEvidence !== "fixture-contract-v1" || !Array.isArray(v.permissionProfiles) || v.permissionProfiles.length < 1 || v.permissionProfiles.length > 16) throw new Error()
    const modes = parseCapability(v.modes), reasoning = parseCapability(v.reasoning), environment = object(v.environment)
    const permissionProfiles = v.permissionProfiles.map(value => agentText(value)), modelOption = agentText(v.modelOption), modeOption = v.modeOption === null ? null : agentText(v.modeOption), reasoningOption = v.reasoningOption === null ? null : agentText(v.reasoningOption), effectiveMode = v.effectiveMode === null ? null : agentText(v.effectiveMode)
    if (new Set(permissionProfiles).size !== permissionProfiles.length || modes.state === "unknown" || reasoning.state === "unknown") throw new Error()
    if ((modes.state === "none") !== (modeOption === null) || (modes.state === "none") !== (effectiveMode !== null) || (reasoning.state === "none") !== (reasoningOption === null)) throw new Error()
    const optionIds = [modelOption, modeOption, reasoningOption].filter(value => value !== null)
    if (new Set(optionIds).size !== optionIds.length || Object.keys(environment).length > 128 || Buffer.byteLength(JSON.stringify(environment)) > 65536) throw new Error()
    for (const [key, value] of Object.entries(environment)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0") || !value.isWellFormed()) throw new Error()
    return { id: agentText(v.id), providerId: providerId(v.providerId), adapterVersion: agentText(v.adapterVersion), entrypoint: absolutePath(v.entrypoint), fingerprint: hash(v.fingerprint), modes, reasoning, effectiveMode, permissionProfiles, modelOption, modeOption, reasoningOption, environment: { ...environment } as NodeJS.ProcessEnv, permissionEvidence: "fixture-contract-v1" }
  } catch { throw new AgentError("ADAPTER_UNQUALIFIED") }
}
export function resolveLaunchSpec(input: { ids: AgentIds; selection: StartSelection; checkout: CheckoutIdentity; snapshotId: string; provider: ProviderSnapshot; configuration: ConfigEvidence; contract: LaunchContract }): LaunchSpec {
  const contract = parseLaunchContract(input.contract), selection = parseSelection(input.selection)
  if (input.provider.error || input.provider.fingerprint !== input.configuration.fingerprint || input.provider.verifiedHandlerGeneration !== input.ids.handlerGeneration) throw new AgentError("MODEL_UNAVAILABLE")
  if (contract.providerId !== selection.providerId || contract.adapterVersion !== input.configuration.adapterVersion) throw new AgentError("ADAPTER_UNQUALIFIED")
  if (!contract.permissionProfiles.includes(selection.permissionProfile)) throw new AgentError("SELECTION_UNSUPPORTED")
  if (selection.reasoning.kind === "none" ? contract.reasoning.state !== "none" : contract.reasoning.state !== "values" || !contract.reasoning.values.includes(selection.reasoning.value)) throw new AgentError("SELECTION_UNSUPPORTED")
  const modes = contract.modes
  const mode = selection.mode ?? (modes.state === "values" && modes.values.length === 1 ? modes.values[0]! : modes.state === "none" ? contract.effectiveMode : null)
  if (mode === null || (modes.state === "values" ? !modes.values.includes(mode) : mode !== contract.effectiveMode)) throw new AgentError("SELECTION_UNSUPPORTED")
  const model = input.provider.models.find(model => model.modelId === selection.modelId)
  if (!model || model.modes.state !== "unknown" && !isDeepStrictEqual(model.modes, modes)) throw new AgentError("MODEL_UNAVAILABLE")
  return parseLaunchSpec({ version: 1, ...input.ids, selection: { ...selection, mode }, modelIdentity: "advertised", resolvedModelId: null, checkout: input.checkout, catalogSnapshotId: input.snapshotId, catalogEvidence: input.provider, configuration: input.configuration, contractId: contract.id, contractFingerprint: contract.fingerprint, containment: "direct-process-group-v1", authority: "normal-user", limits: AGENT_LIMITS })
}
export async function observeLaunchContract(input: LaunchContract): Promise<string> {
  try {
    const { fingerprint: _, ...contract } = parseLaunchContract(input)
    const observe = async () => {
      const files = []
      for (const path of [await realpath(process.execPath), contract.entrypoint]) {
        if (await realpath(path) !== path) throw new Error()
        const stat = await lstat(path, { bigint: true })
        if (!stat.isFile()) throw new Error()
        files.push([path, [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink].map(String)])
      }
      const bytes = await readBoundedFile(contract.entrypoint, 1048576)
      if (bytes === null) throw new Error()
      return [files, digest(bytes)]
    }
    const before = await observe(), after = await observe()
    if (!isDeepStrictEqual(before, after)) throw new Error()
    return digest(JSON.stringify([contract, Object.entries(contract.environment).sort(([a], [b]) => a.localeCompare(b)), before], (key, value) => key === "environment" ? null : value))
  } catch { throw new AgentError("CONFIG_CHANGED") }
}