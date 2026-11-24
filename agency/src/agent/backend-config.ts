import { join } from "node:path"
import { decodeJson, digest, readBoundedFile, readProfiles } from "../config/providers.js"
import { keys, object, providerId, text, type ProviderId } from "../config/validate.js"
import { assertPrivateDirectory } from "../platform/private-state.js"
import { parseLaunchEnvironment, type LaunchEnvironment } from "./environment.js"
import { canonicalJson, parseRequestedSettings, type RequestedSettings } from "./session-config.js"
import { CatalogError } from "../config/validate.js"
import { AgentError } from "./types.js"
import { staticProductionContracts } from "./production-contracts.js"

export type Backend = { id: ProviderId; args: string[]; environmentDefaults: LaunchEnvironment; initial: RequestedSettings; compatibilityId: string }
export type BackendConfig = { version: 1; defaultBackendId: ProviderId; backends: Backend[] }

export function mergeBackendEnvironment(caller: LaunchEnvironment, defaults: LaunchEnvironment): LaunchEnvironment {
  return parseLaunchEnvironment({ ...parseLaunchEnvironment(defaults), ...parseLaunchEnvironment(caller) })
}

export function parseBackendConfig(input: unknown): BackendConfig {
  const v = object(input)
  keys(v, ["version", "defaultBackendId", "backends"])
  if (v.version !== 1 || !Array.isArray(v.backends) || !v.backends.length || v.backends.length > 2) throw new Error("invalid backend configuration")
  const backends = v.backends.map(raw => {
    const b = object(raw)
    keys(b, ["id", "args", "environmentDefaults", "initial", "compatibilityId"])
    if (!Array.isArray(b.args) || b.args.length > 128) throw new Error("invalid backend arguments")
    const environmentDefaults = parseLaunchEnvironment(b.environmentDefaults)
    if (Object.hasOwn(environmentDefaults, "NVIM")) throw new Error("NVIM must come from the caller")
    return { id: providerId(b.id), args: b.args.map(arg => text(arg, 4096)), environmentDefaults, initial: parseRequestedSettings(b.initial), compatibilityId: text(b.compatibilityId, 1024) }
  })
  const defaultBackendId = providerId(v.defaultBackendId)
  if (new Set(backends.map(b => b.id)).size !== backends.length || !backends.some(b => b.id === defaultBackendId)) throw new Error("invalid default backend")
  return { version: 1, defaultBackendId, backends }
}

export async function readBackendConfig(root: string): Promise<BackendConfig> {
  await assertPrivateDirectory(root)
  const catalog = join(root, "catalog")
  try {
    await assertPrivateDirectory(catalog)
    const path = join(catalog, "backends.json"), bytes = await readBoundedFile(path, 65536, true)
    if (bytes !== null) {
      const value = decodeJson(bytes, path)
      try { return parseBackendConfig(value) } catch (error) { throw new CatalogError("INVALID_CATALOG", path + ": " + (error instanceof CatalogError ? "a field has the wrong type or value" : error instanceof Error ? error.message : String(error))) }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const enabled = new Set((await readProfiles(root)).filter(profile => profile.enabled).map(profile => profile.id))
  const backends: Backend[] = staticProductionContracts().filter(contract => enabled.has(contract.providerId)).map(contract => ({
    id: contract.providerId, args: [], compatibilityId: contract.id,
    environmentDefaults: contract.providerId === "codex-acp" ? { INITIAL_AGENT_MODE: "agent-full-access", MODEL_PROVIDER: "litellm" } : {},
    initial: contract.providerId === "codex-acp" ? { modeId: "agent-full-access" } : { modelId: "opus" },
  }))
  if (!backends.length) throw new AgentError("UNAVAILABLE", undefined, "no enabled provider in " + join(catalog, "providers.json") + " has a backend this Agency build supports")
  return { version: 1, defaultBackendId: (backends.find(backend => backend.id === "claude-agent-acp") ?? backends[0]!).id, backends }
}

export function backendFingerprint(backend: Backend, manifest: unknown): string {
  return digest(canonicalJson([backend, manifest]))
}