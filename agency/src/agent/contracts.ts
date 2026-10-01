import { lstat, realpath } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { digest, readBoundedFile } from "../catalog/config.js"
import { absolutePath, hash, keys, object, parseCapability, providerId, type Capability, type ConfigEvidence, type ProviderId, type ProviderProfile, type ProviderSnapshot } from "../catalog/types.js"
import { AGENT_LIMITS, AgentError, agentText, parseLaunchSpec, parseSelection, parsePermissionEvidence, type AgentIds, type LaunchSpec, type PermissionEvidence, type StartSelection } from "./types.js"
import { parseCodexQualificationManifest, qualificationFingerprint, verifyCodexQualification, type CodexQualificationManifest, type LaunchEnvironmentPolicy } from "./qualification.js"
import { qualifiedLaunchContracts } from "./qualified-contracts.js"

export type LaunchContract = { id: string; sessionLoad: "unsupported" | "candidate" | "qualified"; providerId: ProviderId; adapterVersion: string; entrypoint: string; fingerprint: string; modes: Capability; reasoning: Capability; effectiveMode: string | null; permissionProfiles: string[]; modelOption: string; reasoningOption: string | null; modeOption: string | null; environment: LaunchEnvironmentPolicy; permissionEvidence: PermissionEvidence; qualification: CodexQualificationManifest | null }
export function productionLaunchContracts(): readonly LaunchContract[] { return Object.freeze([...qualifiedLaunchContracts()]) }
export function parseLaunchContract(input: unknown): LaunchContract {
  try {
    const v = object(input)
    keys(v, ["id", "sessionLoad", "providerId", "adapterVersion", "entrypoint", "fingerprint", "modes", "reasoning", "effectiveMode", "permissionProfiles", "modelOption", "reasoningOption", "modeOption", "environment", "permissionEvidence", "qualification"])
    if (v.sessionLoad !== "unsupported" && v.sessionLoad !== "candidate" && v.sessionLoad !== "qualified") throw new Error()
    const permissionEvidence = parsePermissionEvidence(v.permissionEvidence)
    if (!Array.isArray(v.permissionProfiles) || v.permissionProfiles.length < 1 || v.permissionProfiles.length > 16) throw new Error()
    const modes = parseCapability(v.modes), reasoning = parseCapability(v.reasoning), environment = object(v.environment)
    keys(environment, ["fixed", "private"])
    const fixed = object(environment.fixed), privatePaths = object(environment.private)
    const permissionProfiles = v.permissionProfiles.map(value => agentText(value)), modelOption = agentText(v.modelOption), modeOption = v.modeOption === null ? null : agentText(v.modeOption), reasoningOption = v.reasoningOption === null ? null : agentText(v.reasoningOption), effectiveMode = v.effectiveMode === null ? null : agentText(v.effectiveMode)
    if (new Set(permissionProfiles).size !== permissionProfiles.length || modes.state === "unknown" || reasoning.state === "unknown") throw new Error()
    if ((modes.state === "none") !== (modeOption === null) || (modes.state === "none") !== (effectiveMode !== null) || (reasoning.state === "none") !== (reasoningOption === null)) throw new Error()
    const optionIds = [modelOption, modeOption, reasoningOption].filter(value => value !== null)
    if (new Set(optionIds).size !== optionIds.length || Object.keys(fixed).length + Object.keys(privatePaths).length > 128 || Buffer.byteLength(JSON.stringify(environment)) > 65536) throw new Error()
    for (const [key, value] of [...Object.entries(fixed), ...Object.entries(privatePaths)]) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0") || !value.isWellFormed()) throw new Error()
    if (Object.keys(fixed).some(key => Object.hasOwn(privatePaths, key))) throw new Error()
    const contract: LaunchContract = { id: agentText(v.id), sessionLoad: v.sessionLoad, providerId: providerId(v.providerId), adapterVersion: agentText(v.adapterVersion), entrypoint: absolutePath(v.entrypoint), fingerprint: hash(v.fingerprint), modes, reasoning, effectiveMode, permissionProfiles, modelOption, modeOption, reasoningOption, environment: { fixed: { ...fixed } as Record<string, string>, private: { ...privatePaths } as Record<string, string> }, permissionEvidence, qualification: null }
    if (contract.permissionEvidence === "fixture-contract-v1") {
      if (v.qualification !== null) throw new Error()
    } else {
      const manifest = parseCodexQualificationManifest(v.qualification)
      if (contract.id !== manifest.contractId || contract.providerId !== manifest.providerId || contract.adapterVersion !== manifest.adapterVersion || contract.entrypoint !== manifest.adapterEntrypoint.path || contract.fingerprint !== qualificationFingerprint(manifest) || !isDeepStrictEqual(contract.environment, manifest.environment) || !isDeepStrictEqual(contract.permissionProfiles, ["deny-all"]) || !isDeepStrictEqual(contract.modes, { state: "values", values: ["read-only"] }) || !isDeepStrictEqual(contract.reasoning, { state: "values", values: ["high"] }) || contract.effectiveMode !== null || contract.modelOption !== "model" || contract.reasoningOption !== "reasoning_effort" || contract.modeOption !== "mode") throw new Error()
      contract.qualification = manifest
    }
    return contract
  } catch { throw new AgentError("ADAPTER_UNQUALIFIED") }
}
export function resolveLaunchSpec(input: { ids: AgentIds; selection: StartSelection; cwd: string; snapshotId: string; provider: ProviderSnapshot; profile: ProviderProfile; configuration: ConfigEvidence; contract: LaunchContract }): LaunchSpec {
  const contract = parseLaunchContract(input.contract), selection = parseSelection(input.selection)
  if (contract.qualification !== null) {
    const manifest = contract.qualification, profile = input.profile
    if (selection.modelId !== manifest.selection.modelId) throw new AgentError("SELECTION_UNSUPPORTED")
    if (profile.id !== manifest.providerId || !profile.enabled || profile.executable !== manifest.codexExecutable.path || profile.adapterPackageJson !== manifest.adapterPackageJson.path || profile.sdkPackageJson !== null || !isDeepStrictEqual(profile.configurationFiles, [])) throw new AgentError("ADAPTER_UNQUALIFIED")
  }
  if (input.provider.error || input.provider.fingerprint !== input.configuration.fingerprint || input.provider.verifiedHandlerGeneration !== input.ids.handlerGeneration) throw new AgentError("MODEL_UNAVAILABLE")
  if (contract.providerId !== selection.providerId || contract.adapterVersion !== input.configuration.adapterVersion) throw new AgentError("ADAPTER_UNQUALIFIED")
  if (!contract.permissionProfiles.includes(selection.permissionProfile)) throw new AgentError("SELECTION_UNSUPPORTED")
  if (selection.reasoning.kind === "none" ? contract.reasoning.state !== "none" : contract.reasoning.state !== "values" || !contract.reasoning.values.includes(selection.reasoning.value)) throw new AgentError("SELECTION_UNSUPPORTED")
  const modes = contract.modes
  const mode = selection.mode ?? (modes.state === "values" && modes.values.length === 1 ? modes.values[0]! : modes.state === "none" ? contract.effectiveMode : null)
  if (mode === null || (modes.state === "values" ? !modes.values.includes(mode) : mode !== contract.effectiveMode)) throw new AgentError("SELECTION_UNSUPPORTED")
  const model = input.provider.models.find(model => model.modelId === selection.modelId)
  if (!model || model.modes.state !== "unknown" && !isDeepStrictEqual(model.modes, modes)) throw new AgentError("MODEL_UNAVAILABLE")
  return parseLaunchSpec({ ...input.ids, createdCommandId: input.ids.commandId, cwd: input.cwd, selection: { ...selection, mode }, catalogSnapshotId: input.snapshotId, catalogEvidence: input.provider, configuration: input.configuration, contractId: contract.id, contractFingerprint: contract.fingerprint, containment: "direct-process-group-v1", authority: "normal-user", limits: AGENT_LIMITS })
}
export async function observeLaunchContract(input: LaunchContract): Promise<string> {
  try {
    const { fingerprint: _, ...contract } = parseLaunchContract(input)
    if (contract.qualification !== null) return (await verifyCodexQualification(contract.qualification)).fingerprint
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
    return digest(JSON.stringify([contract, Object.entries(contract.environment.fixed).sort(([a], [b]) => a.localeCompare(b)), Object.entries(contract.environment.private).sort(([a], [b]) => a.localeCompare(b)), before], (key, value) => key === "environment" ? null : value))
  } catch { throw new AgentError("CONFIG_CHANGED") }
}