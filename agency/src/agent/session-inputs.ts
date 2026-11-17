import { withoutAgencyMetadata } from "./acp.js"
import type { JsonObject } from "./session-config.js"
import { AgentError } from "./types.js"

export function sessionInputs(cwd: string, raw: JsonObject | undefined, required: string[] = []): { params: JsonObject; names: string[] } {
  const params = withoutAgencyMetadata({ cwd, mcpServers: [], ...raw })
  if (params.cwd !== cwd || !Array.isArray(params.mcpServers)) throw new AgentError("SESSION_INPUT_REQUIRED")
  const names = params.mcpServers.map(value => {
    if (!value || Array.isArray(value) || typeof value !== "object" || typeof value.name !== "string" || !value.name.trim()) throw new AgentError("SESSION_INPUT_REQUIRED")
    const strings = (values: unknown): boolean => Array.isArray(values) && values.every(value => typeof value === "string")
    const pairs = (values: unknown): boolean => Array.isArray(values) && values.every(value => value && typeof value === "object" && !Array.isArray(value) && typeof value.name === "string" && typeof value.value === "string")
    if (value.type === "http" || value.type === "sse") {
      if (typeof value.url !== "string" || !URL.canParse(value.url) || !["http:", "https:"].includes(new URL(value.url).protocol) || !pairs(value.headers)) throw new AgentError("SESSION_INPUT_REQUIRED")
    } else if (value.type !== undefined || typeof value.command !== "string" || !value.command.trim() || !strings(value.args) || !pairs(value.env)) throw new AgentError("SESSION_INPUT_REQUIRED")
    return value.name
  })
  if (names.length > 128 || new Set(names).size !== names.length || required.some(name => !names.includes(name))) throw new AgentError("SESSION_INPUT_REQUIRED")
  return { params, names: names.sort() }
}