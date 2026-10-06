import { homedir } from "node:os"
import { join } from "node:path"
import { decodeJson, digest, readBoundedFile, readProfiles } from "../catalog/config.js"
import { keys, object, providerId, text, type ProviderId } from "../catalog/types.js"
import { assertPrivateDirectory } from "../platform/private-state.js"
import { parseLaunchEnvironment, type LaunchEnvironment } from "./environment.js"
import { canonicalJson, parseRequestedSettings, type RequestedSettings } from "./session-config.js"
import { AgentError } from "./types.js"

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
  try { await assertPrivateDirectory(catalog) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    throw new AgentError("UNAVAILABLE")
  }
  const bytes = await readBoundedFile(join(catalog, "backends.json"), 65536, true)
  if (bytes !== null) return parseBackendConfig(decodeJson(bytes))
  if (!(await readProfiles(root)).some(profile => profile.enabled && profile.id === "codex-acp")) throw new AgentError("UNAVAILABLE")
  return { version: 1, defaultBackendId: "codex-acp", backends: [{ id: "codex-acp", args: [], environmentDefaults: { CODEX_PATH: join(homedir(), "bin/acp-codex"), INITIAL_AGENT_MODE: "agent-full-access", MODEL_PROVIDER: "litellm" }, initial: { modeId: "agent-full-access" }, compatibilityId: "codex-acp-1.7" }] }
}

export function backendFingerprint(backend: Backend, manifest: unknown): string {
  return digest(canonicalJson([backend, manifest]))
}