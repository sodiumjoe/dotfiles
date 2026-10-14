import { randomUUID } from "node:crypto"
import { hostArguments } from "../hosts/cli.js"
import { HOST_PROTOCOL } from "../hosts/protocol.js"
import type { ControlDependencies } from "../cli/control.js"
import { parseWorktreeInput, prepareWorktree } from "./worktree.js"

export async function runGitPrepare(argv: readonly string[], deps: ControlDependencies): Promise<number> {
  const common = { protocol: HOST_PROTOCOL, requestId: randomUUID(), hostId: null, handlerGeneration: null }
  let executing = false
  try {
    const args = hostArguments(argv)
    if (args.local || args.positional.length !== 2 || args.positional[0] !== "git" || args.positional[1] !== "prepare" || args.flags.size !== 1 || !args.flags.has("--input-json")) throw new Error("USAGE")
    const input = parseWorktreeInput(JSON.parse(args.flags.get("--input-json")!)); executing = true
    deps.stdout(JSON.stringify({ ...common, ok: true, result: { state: "worktree", worktree: await prepareWorktree(input) } }) + "\n"); return 0
  } catch (error) {
    deps.stdout(JSON.stringify({ ...common, ok: false, error: { code: executing ? "GIT_PREPARE_FAILED" : "USAGE", message: error instanceof Error ? error.message : String(error) } }) + "\n")
    return executing ? 75 : 64
  }
}