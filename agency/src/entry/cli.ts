import { spawn } from "node:child_process"
import { isDeepStrictEqual } from "node:util"
import { id } from "../config/validate.js"
import { parseEntryTarget, parseRuntimeEntry } from "./runtime.js"
import type { PlatformPaths } from "../platform/paths.js"
import type { HandlerInspection, PlatformAdapter } from "../platform/types.js"

export type EntryHelperDependencies = {
  environment(): Promise<{ paths: PlatformPaths; adapter: PlatformAdapter }>
  inspect(env: { paths: PlatformPaths; adapter: PlatformAdapter }): Promise<HandlerInspection | null>
  connect(input: { root: string; hostId: string; handlerGeneration: string }): Promise<{ request(channel: string, payload: unknown): Promise<unknown>; close(): void }>
  stderr(value: string): void
}
export async function runRuntimeEntryHelper(argv: readonly string[], deps: EntryHelperDependencies, enter = (file: string, args: string[]) => new Promise<number>((resolve, reject) => {
  const child = spawn(file, args, { stdio: "inherit" }); child.once("error", reject); child.once("close", code => resolve(code ?? 75))
})): Promise<number> {
  try {
    if (argv.length !== 3 || argv[1] !== "--target-json") return 64
    const commandId = id(argv[0]), ref = parseEntryTarget(JSON.parse(argv[2]!)), env = await deps.environment()
    if (env.paths.hostKey !== ref.hostId) return 69
    const inspection = await deps.inspect(env)
    if (!inspection || inspection.disposition !== "live" || inspection.record.phase !== "ready") { deps.stderr("The Agency Handler is not running on this host\n"); return 69 }
    const bridge = await deps.connect({ root: env.paths.runtimeRoot, hostId: env.paths.hostKey, handlerGeneration: inspection.record.generation })
    let raw: unknown
    try { raw = await bridge.request("runtime-entry-inspect", { commandId }) } finally { bridge.close() }
    const receipt = raw === null ? null : parseRuntimeEntry(raw)
    if (!receipt || receipt.state !== "opened" || !receipt.editor || !isDeepStrictEqual(receipt.ref, ref)) return 75
    return await enter("tmux", ["-S", receipt.editor.tmuxSocketPath, "attach-session", "-t", "=" + receipt.editor.session])
  } catch { deps.stderr("Entry outcome unavailable\n"); return 75 }
}