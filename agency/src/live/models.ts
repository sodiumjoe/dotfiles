import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { readProfiles } from "../catalog/config.js"
import { parseModels, type Model, type ProviderId, type ProviderProfile } from "../catalog/types.js"
import type { SessionConfiguration } from "../agent/session-config.js"
import { RequestError } from "./errors.js"

export type ModelListing = { backendId: ProviderId; models: Model[]; error: string | null }
export type ModelSource = (profile: ProviderProfile, timeoutMs: number) => Promise<Model[]>
export type ModelCache = { list(backendId: ProviderId): Promise<ModelListing>; observe(backendId: ProviderId, modelOption: string, configuration: SessionConfiguration): void }

const WORKER = fileURLToPath(new URL("./model-worker.js", import.meta.url)), PARENT_WATCH = new URL("../agent/parent-watch.js", import.meta.url).href

export const workerModels: ModelSource = (profile, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", PARENT_WATCH, WORKER], { detached: true, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, AGENCY_PARENT_PID: String(process.pid) } })
  let output = "", settled = false, closed = false
  const finish = (error: Error | null, models?: Model[]): void => {
    if (settled) return
    settled = true; clearTimeout(timer)
    if (!closed && child.pid !== undefined) try { process.kill(-child.pid, "SIGKILL") } catch {}
    if (error) reject(error); else resolve(models!)
  }
  const timer = setTimeout(() => finish(new RequestError("UNAVAILABLE", "model listing for " + profile.id + " timed out after " + timeoutMs + " ms")), timeoutMs)
  child.stdout!.on("data", (bytes: Buffer) => { output += bytes.toString("utf8"); if (output.length > 1048576) finish(new RequestError("FAILED", "model listing output too large")) })
  child.on("error", error => finish(new RequestError("UNAVAILABLE", "model listing could not start: " + error.message)))
  child.on("close", () => {
    closed = true
    try {
      const reply = JSON.parse(output) as { ok: boolean; models?: unknown; message?: string }
      if (reply.ok) finish(null, parseModels(reply.models, profile.id))
      else finish(new RequestError("UNAVAILABLE", "model listing for " + profile.id + " failed: " + String(reply.message)))
    } catch { finish(new RequestError("FAILED", "model listing for " + profile.id + " ended without a result")) }
  })
  child.stdin!.end(JSON.stringify(profile))
})

export function sessionModels(backendId: ProviderId, modelOption: string, configuration: SessionConfiguration): string[] {
  const option = configuration.configOptions.find(value => value.id === modelOption)
  const values = (entries: unknown): string[] => Array.isArray(entries) ? entries.flatMap(entry => {
    const value = entry as { value?: unknown; options?: unknown } | null
    return value && typeof value.value === "string" ? [value.value] : value && Array.isArray(value.options) ? values(value.options) : []
  }) : []
  if (option) return values(option.options)
  const models = configuration.models as { availableModels?: Array<{ modelId?: unknown }> } | null
  return backendId === "claude-agent-acp" && Array.isArray(models?.availableModels) ? models.availableModels.flatMap(model => typeof model.modelId === "string" ? [model.modelId] : []) : []
}

export function createModelCache(input: { root: string; timeoutMs?: number; source?: ModelSource }): ModelCache {
  const cached = new Map<ProviderId, Model[]>(), flights = new Map<ProviderId, Promise<Model[]>>(), source = input.source ?? workerModels, timeoutMs = input.timeoutMs ?? 20000
  return {
    async list(backendId) {
      const known = cached.get(backendId)
      if (known) return { backendId, models: structuredClone(known), error: null }
      let flight = flights.get(backendId)
      if (!flight) {
        flight = (async () => {
          const profile = (await readProfiles(input.root)).find(value => value.id === backendId && value.enabled)
          if (!profile) throw new RequestError("UNAVAILABLE", "backend " + backendId + " is not configured")
          const models = await source(profile, timeoutMs)
          cached.set(backendId, models)
          return models
        })().finally(() => flights.delete(backendId))
        flights.set(backendId, flight)
      }
      try { return { backendId, models: structuredClone(await flight), error: null } }
      catch (error) { return { backendId, models: [], error: error instanceof Error ? error.message : String(error) } }
    },
    observe(backendId, modelOption, configuration) {
      const known = cached.get(backendId), ids = sessionModels(backendId, modelOption, configuration)
      if (!known || !ids.length || ids.length === known.length && ids.every(id => known.some(model => model.modelId === id))) return
      cached.set(backendId, ids.map(id => known.find(model => model.modelId === id) ?? { providerId: backendId, modelId: id, resolvedModelId: null, displayName: id, reasoning: { state: "unknown" }, modes: { state: "unknown" }, availability: "advertised" }))
    },
  }
}