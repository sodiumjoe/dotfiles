import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ControlError, PROTOCOL, UUID, controlError, exitCode, type ControlErrorCode } from "../control/protocol.js"
import { readDistDigest } from "../handler/build-digest.js"
import type { ControlDependencies } from "./control.js"

type Failure = { code: string; message: string }
type Envelope = { ok: boolean; handlerGeneration: string | null; result?: any; error?: Failure }
type View = { record: { version: number; phase: string; definition: { agentId: string }; launch?: { handlerGeneration: string } | null }; live: boolean; display?: { activity?: string } }
type PendingRestore = { version: 1; fromGeneration: string; agentIds: string[] }
type Run = (argv: readonly string[], deps: ControlDependencies) => Promise<number>
export type RestartAgent = { agentId: string; outcome: "restored" | "live" | "failed"; failure: Failure | null }
export type RestartResult = { state: "restarted"; restarted: boolean; resumed: boolean; fromGeneration: string | null; toGeneration: string | null; agents: RestartAgent[] }

const known = new Set<string>(["USAGE", "INVALID_PROTOCOL", "STALE_HANDLER", "UNAVAILABLE", "INTERNAL", "INCOMPLETE", "ACTIVE_AGENTS", "COMMAND_CONFLICT", "BUSY"])
const transitional = ["starting", "restoring", "stopping"]
const terminal = ["failed", "interrupted"]

function code(failure?: Failure): ControlErrorCode { return failure && known.has(failure.code) ? failure.code as ControlErrorCode : "INCOMPLETE" }
function plural(count: number, noun: string): string { return count + " " + noun + (count === 1 ? "" : "s") }

function parse(argv: readonly string[]): { resume: boolean; timeoutSeconds: number } {
  const options = { resume: false, timeoutSeconds: 300 }
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]
    if (value === "--json") continue
    if (value === "--resume") options.resume = true
    else if (value === "--timeout" && /^[1-9][0-9]{0,4}$/.test(argv[index + 1] ?? "")) options.timeoutSeconds = Number(argv[++index])
    else throw new ControlError("USAGE", "use agy restart [--resume] [--timeout SECONDS] [--json]")
  }
  return options
}

async function readPending(path: string): Promise<PendingRestore | null> {
  let text: string
  try { text = await readFile(path, "utf8") } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
  let value: PendingRestore
  try { value = JSON.parse(text) as PendingRestore } catch { throw new ControlError("INVALID_PROTOCOL", "invalid pending restore at " + path) }
  if (value?.version !== 1 || typeof value.fromGeneration !== "string" || !UUID.test(value.fromGeneration) || !Array.isArray(value.agentIds) || !value.agentIds.every(id => typeof id === "string" && UUID.test(id))) throw new ControlError("INVALID_PROTOCOL", "invalid pending restore at " + path)
  return value
}

async function writePending(path: string, value: PendingRestore): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp"
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, path)
}

export async function runRestart(argv: readonly string[], deps: ControlDependencies, run: Run): Promise<number> {
  const requestId = randomUUID()
  let generation: string | null = null
  const emit = (ok: boolean, value: unknown): void => { deps.stdout(JSON.stringify({ protocol: PROTOCOL, requestId, handlerGeneration: generation, ok, ...(ok ? { result: value } : { error: value }) }) + "\n") }
  const progress = (text: string): void => { deps.stderr(text + "\n") }
  try {
    const options = parse(argv)
    const env = await deps.environment()
    const pendingPath = join(env.paths.persistentRoot, "restart-pending.json")
    const call = async (args: string[]): Promise<Envelope> => {
      let output = ""
      await run([...args, "--json"], { ...deps, stdout: text => { output += text }, stderr: () => {} })
      return JSON.parse(output) as Envelope
    }
    const status = async (): Promise<{ generation: string; distDigest: string | null; reportsDigest: boolean }> => {
      const reply = await call(["status"])
      if (!reply.ok || !reply.handlerGeneration) throw new ControlError(code(reply.error), reply.error?.message ?? "status unavailable")
      return { generation: reply.handlerGeneration, distDigest: typeof reply.result?.distDigest === "string" ? reply.result.distDigest : null, reportsDigest: Object.hasOwn(reply.result ?? {}, "distDigest") }
    }
    const list = async (): Promise<View[]> => {
      const reply = await call(["agent", "list"])
      if (!reply.ok) throw new ControlError(code(reply.error), reply.error?.message ?? "agent list unavailable")
      return (reply.result.agents as View[]).filter(view => view.record.version === 3)
    }
    const restore = async (agentIds: string[], current: string): Promise<RestartAgent[]> => {
      const views = await list(), agents: RestartAgent[] = []
      for (const agentId of agentIds) {
        const view = views.find(value => value.record.definition.agentId === agentId)
        if (view?.live && view.record.phase === "ready" && view.record.launch?.handlerGeneration === current) { agents.push({ agentId, outcome: "live", failure: null }); continue }
        progress("restoring " + agentId)
        const reply = await call(["agent", "restore", agentId])
        const outcome = reply.ok ? reply.result?.command?.result : null
        if (outcome?.outcome === "restored") agents.push({ agentId, outcome: "restored", failure: null })
        else agents.push({ agentId, outcome: "failed", failure: reply.error ?? outcome?.failure ?? { code: "INCOMPLETE", message: "restore did not complete" } })
      }
      return agents
    }
    const resume = async (): Promise<RestartResult> => {
      const pending = await readPending(pendingPath)
      const current = await status()
      generation = current.generation
      if (!pending) return { state: "restarted", restarted: false, resumed: false, fromGeneration: current.generation, toGeneration: current.generation, agents: [] }
      const agents = await restore(pending.agentIds, current.generation)
      const failed = agents.filter(agent => agent.outcome === "failed")
      const views = failed.length ? await list() : []
      const retryable = failed.filter(agent => views.some(view => view.record.definition.agentId === agent.agentId && !terminal.includes(view.record.phase))).map(agent => agent.agentId)
      if (retryable.length) await writePending(pendingPath, { version: 1, fromGeneration: pending.fromGeneration, agentIds: retryable })
      else await rm(pendingPath, { force: true })
      return { state: "restarted", restarted: pending.fromGeneration !== current.generation, resumed: true, fromGeneration: pending.fromGeneration, toGeneration: current.generation, agents }
    }
    if (options.resume) { emit(true, await resume()); return 0 }
    let carried: PendingRestore | null = null
    if (await readPending(pendingPath)) {
      await resume()
      carried = await readPending(pendingPath)
    }
    const before = await status()
    generation = before.generation
    const deadline = deps.now() + options.timeoutSeconds * 1000
    for (;;) {
      const views = await list()
      const working = views.filter(view => view.live && view.display?.activity === "working" || transitional.includes(view.record.phase)).map(view => view.record.definition.agentId)
      if (working.length) {
        if (deps.now() >= deadline) throw new ControlError("BUSY", "agents still working: " + working.join(", "))
        progress("waiting for " + plural(working.length, "agent") + ": " + working.join(", "))
        await deps.sleep(1000)
        continue
      }
      const agentIds = [...new Set([...views.filter(view => view.live && ["ready", "recoverable"].includes(view.record.phase)).map(view => view.record.definition.agentId), ...carried?.agentIds ?? []])]
      await writePending(pendingPath, { version: 1, fromGeneration: before.generation, agentIds })
      if (!before.reportsDigest) throw new ControlError("INCOMPLETE", "the running Handler predates agy restart; run agy shutdown --stop-agents once while agents are idle, then agy restart --resume; the agents to restore are saved in " + pendingPath)
      progress("stopping " + plural(agentIds.length, "agent") + " and the Handler")
      const reply = await call(["shutdown", "--stop-agents", "--require-idle", "--command-id", randomUUID(), "--handler-generation", before.generation])
      if (reply.ok) break
      if (reply.error?.code === "BUSY") {
        if (carried) await writePending(pendingPath, carried)
        else await rm(pendingPath, { force: true })
        if (deps.now() >= deadline) throw new ControlError("BUSY", reply.error.message)
        await deps.sleep(1000)
        continue
      }
      if (reply.error?.code === "INCOMPLETE") {
        const result = await resume()
        throw new ControlError("INCOMPLETE", "shutdown did not complete; " + result.agents.filter(agent => agent.outcome === "restored").length + " stopped agents restored under Handler " + result.toGeneration)
      }
      throw new ControlError(code(reply.error), reply.error?.message ?? "shutdown failed")
    }
    progress("starting the new Handler")
    let after: { generation: string; distDigest: string | null; reportsDigest: boolean }
    try { after = await status() } catch (error) { throw new ControlError("UNAVAILABLE", "the new Handler failed to start: " + controlError(error).message + "; fix it and run agy restart --resume to restore the agents saved in " + pendingPath) }
    generation = after.generation
    const result = await resume()
    const expected = readDistDigest(fileURLToPath(new URL("../../build-manifest.json", import.meta.url)))
    if (after.distDigest !== null && expected !== null && after.distDigest !== expected) throw new ControlError("INCOMPLETE", "the new Handler runs a different build than dist; agents were restored; reload again")
    emit(true, { ...result, restarted: true, fromGeneration: before.generation })
    return 0
  } catch (error) {
    const value = controlError(error)
    emit(false, { code: value.code, message: value.message.slice(0, 2048) })
    deps.stderr(value.message + "\n")
    return exitCode(value.code)
  }
}