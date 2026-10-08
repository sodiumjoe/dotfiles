import { spawn } from "node:child_process"
import { join } from "node:path"
import { id } from "../catalog/types.js"
import type { ControlDependencies } from "../cli/control.js"
import { runBureauClient } from "./cli.js"
import { parseEntryIntent } from "./entry.js"

export async function runEntryHelper(argv: string[], deps: ControlDependencies, enter = (file: string, args: string[]) => new Promise<number>((resolve, reject) => {
  const child = spawn(file, args, { stdio: "inherit" }); child.once("error", reject); child.once("close", code => resolve(code ?? 75))
})): Promise<number> {
  try {
    if (argv.length !== 9 || new Set([argv[1], argv[3], argv[5], argv[7]]).size !== 4
      || [argv[1], argv[3], argv[5], argv[7]].some(flag => !["--digest", "--host-id", "--inventory-id", "--handler-generation"].includes(flag!))) return 64
    const commandId = id(argv[0]), flags = new Map([[argv[1], argv[2]], [argv[3], argv[4]], [argv[5], argv[6]], [argv[7], argv[8]]])
    const env = await deps.environment()
    if (env.paths.hostKey !== flags.get("--host-id")) { deps.stderr("Entry host identity changed\n"); return 69 }
    let output = ""
    const code = await runBureauClient(["entry", "consume", ...argv, "--json"], { ...deps, stdout: text => { output += text } })
    if (code !== 0) return code
    const reply = JSON.parse(output), receipt = parseEntryIntent(reply.result)
    if (!reply.ok || receipt.commandId !== commandId || receipt.digest !== flags.get("--digest") || receipt.ref.hostId !== env.paths.hostKey
      || receipt.ref.inventoryId !== flags.get("--inventory-id") || receipt.ref.target.handlerGeneration !== flags.get("--handler-generation")) return 69
    if (receipt.state !== "consumed" || !receipt.editor) { deps.stderr("Entry " + receipt.state + "; inspect the retained intent\n"); return 75 }
    return await enter("tmux", ["-S", join(env.paths.runtimeRoot, "entry-tmux.sock"), "attach-session", "-t", "=" + receipt.editor.session])
  } catch { deps.stderr("Agency remote entry failed\n"); return 75 }
}