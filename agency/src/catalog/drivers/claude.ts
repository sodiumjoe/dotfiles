import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { observeConfig, sdkEntry } from "../config.js"
import { normalizeClaude } from "../normalize.js"
import type { ProbeResult } from "../probes.js"
import { CatalogError, invalid, object } from "../types.js"
import { aborted, type DriverContext, type RegisteredChild } from "./transport.js"

export async function discoverClaude(context: DriverContext, loadSdk: (entry: string) => Promise<unknown> = entry => import(pathToFileURL(entry).href)): Promise<ProbeResult> {
  let count = 0, cancelled = false
  try {
    if (context.signal.aborted) throw new CatalogError("PROBE_FAILED")
    const entry = await sdkEntry(context.request.profile)
    if (!isDeepStrictEqual(await observeConfig(context.request.profile), context.request.evidence)) throw new CatalogError("CONFIG_CHANGED")
    const sdk = object(await aborted(loadSdk(entry), context.signal))
    if (typeof sdk.query !== "function") throw new CatalogError("UNSUPPORTED_PROVIDER_VERSION")
    async function* emptyPrompt() { }
    const spawnClaudeCodeProcess = (input: unknown): RegisteredChild => {
      const options = object(input)
      if (++count !== 1 || context.signal.aborted || options.command !== context.request.profile.executable || options.cwd !== context.request.meta.workPath || !Array.isArray(options.args) || options.args.length > 256 || options.args.some(value => typeof value !== "string" || value.includes("\0")) || Buffer.byteLength(JSON.stringify(options.args)) > 65536 || !(options.signal instanceof AbortSignal)) throw new CatalogError("PROBE_FAILED")
      const child = context.spawnNative(context.request.profile.executable, options.args)
      const abort = () => { cancelled = true; child.requestCleanup() }
      options.signal.addEventListener("abort", abort, { once: true })
      const signal = options.signal
      void child.terminal.then(() => signal.removeEventListener("abort", abort))
      if (signal.aborted) abort()
      return child
    }
    const query = object(sdk.query({ prompt: emptyPrompt(), options: { cwd: context.request.meta.workPath, pathToClaudeCodeExecutable: context.request.profile.executable, settingSources: [], mcpServers: {}, tools: [], persistSession: false, canUseTool: async () => ({ behavior: "deny", message: "Discovery does not allow tools" }), spawnClaudeCodeProcess } }))
    if (typeof query.supportedModels !== "function") invalid()
    const models = await aborted(Promise.resolve(query.supportedModels()), context.signal)
    if (count !== 1 || cancelled || context.signal.aborted) throw new CatalogError("PROBE_FAILED")
    return { models: normalizeClaude(models), providerVersion: null, providerVersionSource: "unknown" }
  } catch (error) { if (error instanceof CatalogError) throw error; throw new CatalogError("PROBE_FAILED") }
}