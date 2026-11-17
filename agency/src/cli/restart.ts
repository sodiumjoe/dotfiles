import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ControlError, PROTOCOL, controlError, exitCode, type ControlErrorCode } from "../control/protocol.js"
import { readDistDigest } from "../handler/build-digest.js"
import type { ControlDependencies } from "./control.js"

type Failure = { code: string; message: string }
type Envelope = { ok: boolean; handlerGeneration?: string | null; result?: any; error?: Failure }
type Run = (argv: readonly string[], deps: ControlDependencies) => Promise<number>
type Handoff = { fromGeneration: string; agents: string[]; pending: string[]; failed: Array<{ agentId: string; code: string; message: string }> }
export type RestartAgent = { agentId: string; outcome: "restored" | "failed" | "restoring"; failure: Failure | null }
export type RestartResult = { state: "restarted"; restarted: boolean; resumed: false; fromGeneration: string | null; toGeneration: string | null; agents: RestartAgent[] }

const known = new Set<string>(["USAGE", "INVALID_PROTOCOL", "STALE_HANDLER", "UNAVAILABLE", "INTERNAL", "INCOMPLETE", "ACTIVE_AGENTS", "COMMAND_CONFLICT", "BUSY"])
function code(failure?: Failure): ControlErrorCode { return failure && known.has(failure.code) ? failure.code as ControlErrorCode : "INCOMPLETE" }
function plural(count: number, noun: string): string { return count + " " + noun + (count === 1 ? "" : "s") }

function parse(argv: readonly string[]): { resume: boolean; timeoutSeconds: number } {
  const options = { resume: false, timeoutSeconds: 300 }
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]
    if (value === "--json") continue
    if (value === "--resume") options.resume = true
    else if (value === "--timeout" && /^[1-9][0-9]{0,4}$/.test(argv[index + 1] ?? "")) options.timeoutSeconds = Number(argv[++index])
    else throw new ControlError("USAGE", "use agy restart [--timeout SECONDS] [--json]")
  }
  return options
}

export async function runRestart(argv: readonly string[], deps: ControlDependencies, run: Run): Promise<number> {
  const requestId = randomUUID()
  let generation: string | null = null
  const emit = (ok: boolean, value: unknown): void => { deps.stdout(JSON.stringify({ protocol: PROTOCOL, requestId, handlerGeneration: generation, ok, ...(ok ? { result: value } : { error: value }) }) + "\n") }
  const progress = (text: string): void => { deps.stderr(text + "\n") }
  try {
    const options = parse(argv)
    const env = await deps.environment(), root = env.paths.persistentRoot
    const call = async (args: string[]): Promise<Envelope> => {
      let output = ""
      await run([...args, "--json"], { ...deps, stdout: text => { output += text }, stderr: () => {} })
      return JSON.parse(output) as Envelope
    }
    const status = async (): Promise<{ generation: string; distDigest: string | null }> => {
      const reply = await call(["status"])
      if (!reply.ok || !reply.handlerGeneration) throw new ControlError(code(reply.error), reply.error?.message ?? "status unavailable")
      return { generation: reply.handlerGeneration, distDigest: typeof reply.result?.distDigest === "string" ? reply.result.distDigest : null }
    }
    const before = await status()
    generation = before.generation
    if (options.resume) { emit(true, { state: "restarted", restarted: false, resumed: false, fromGeneration: before.generation, toGeneration: before.generation, agents: [] } satisfies RestartResult); return 0 }
    await rm(join(root, "restart-pending.json"), { force: true })
    const listed = await call(["agents"])
    const live: string[] = listed.ok && Array.isArray(listed.result?.agents) ? listed.result.agents.filter((row: any) => row?.live).map((row: any) => String(row.agentId)) : []
    const deadline = deps.now() + options.timeoutSeconds * 1000
    progress("handing off live agents and stopping the Handler")
    const commandId = randomUUID()
    for (let unverified = 0; ;) {
      const reply = await call(["shutdown", "--stop-agents", "--require-idle", "--command-id", commandId, "--handler-generation", before.generation])
      if (reply.ok) break
      if (reply.error?.code === "INCOMPLETE" && unverified++ < 3) { await deps.sleep(200); continue }
      if (reply.error?.code === "INVALID_PROTOCOL") throw new ControlError("INVALID_PROTOCOL", "this Handler cannot hand off its agents (" + reply.error.message + "); run agy shutdown --stop-agents once while agents are idle, then :AgencyReload or agy restart")
      if (reply.error?.code !== "BUSY") throw new ControlError(code(reply.error), reply.error?.code === "INCOMPLETE" ? "shutdown did not complete and the Handler is still running: " + reply.error.message : reply.error?.message ?? "shutdown failed")
      if (deps.now() >= deadline) throw new ControlError("BUSY", reply.error.message)
      progress("waiting: " + reply.error.message)
      await deps.sleep(1000)
    }
    progress("starting the new Handler")
    let after: { generation: string; distDigest: string | null }
    try { after = await status() } catch (error) { throw new ControlError("UNAVAILABLE", "the new Handler failed to start: " + controlError(error).message + "; fix it and run agy status") }
    generation = after.generation
    const handoff = async (): Promise<Handoff | null | undefined> => {
      const reply = await call(["agents"]).catch(() => null)
      if (!reply?.ok) return undefined
      const value = reply.result?.handoff as Handoff | undefined
      return value && value.fromGeneration === before.generation ? value : null
    }
    const waitUntil = deps.now() + options.timeoutSeconds * 1000
    let handed: Handoff | null | undefined, announced = false
    for (;;) {
      const current = await handoff()
      if (current !== undefined) handed = current
      if (handed?.pending.length && !announced) { announced = true; progress("restoring " + plural(handed.agents.length, "agent")) }
      if (handed !== undefined && !handed?.pending.length || deps.now() >= waitUntil) break
      await deps.sleep(250)
    }
    const failures = new Map((handed?.failed ?? []).map(item => [item.agentId, { code: item.code, message: item.message }]))
    const agents: RestartAgent[] = (handed?.agents ?? []).map(agentId => ({ agentId, outcome: failures.has(agentId) ? "failed" as const : handed!.pending.includes(agentId) ? "restoring" as const : "restored" as const, failure: failures.get(agentId) ?? null }))
    for (const agentId of live) if (!agents.some(agent => agent.agentId === agentId)) agents.push({ agentId, outcome: "failed", failure: { code: "UNAVAILABLE", message: "not handed off: it was never prompted, or the new Handler dropped its handoff entry; see agy log" } })
    const expected = readDistDigest(fileURLToPath(new URL("../../build-manifest.json", import.meta.url)))
    if (after.distDigest !== null && expected !== null && after.distDigest !== expected) throw new ControlError("INCOMPLETE", "the new Handler runs a different build than dist; reload again")
    emit(true, { state: "restarted", restarted: true, resumed: false, fromGeneration: before.generation, toGeneration: after.generation, agents } satisfies RestartResult)
    return 0
  } catch (error) {
    const value = controlError(error)
    emit(false, { code: value.code, message: value.message.slice(0, 2048) })
    deps.stderr(value.message + "\n")
    return exitCode(value.code)
  }
}