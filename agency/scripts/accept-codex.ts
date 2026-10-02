import { randomBytes, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import { isAbsolute, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { productionLaunchContracts } from "../src/agent/contracts.js"
import { launchEnvironmentDigest, snapshotLaunchEnvironment, type LaunchEnvironment } from "../src/agent/environment.js"
import { AGENT_PROTOCOL, type AgentReply, type AgentRequest } from "../src/agent/protocol.js"
import { AgentError, type AgentList, type AgentTuple, type CommandView, type PromptView, type SessionEvidence } from "../src/agent/types.js"
import { hash, id, keys, object, text } from "../src/catalog/types.js"
import { productionControlDependencies } from "../src/cli/control.js"
import { assertPrivateDirectory } from "../src/platform/private-state.js"

export type AcceptanceLifecycle = {
  cwd(): string
  snapshot(): LaunchEnvironment
  start(cwd: string, environment: LaunchEnvironment): Promise<CommandView>
  prompt(target: AgentTuple, text: string): Promise<PromptView>
  stop(target: AgentTuple): Promise<CommandView>
  restore(agentId: string, environment: LaunchEnvironment): Promise<CommandView>
  list(): Promise<AgentList>
}
export type AcceptanceGeneration = { agentId: string; providerGeneration: string; launchAttemptId: string; sessionId: string; sessionGeneration: string; answer: string }
export type AcceptanceCleanup = { stage: "initial" | "restored"; launchAttemptId: string; processGroupId: number; cleanup: "verified" }
export type CodexAcceptanceReport = {
  protocol: "agency-codex-acceptance/1"
  cwd: string
  challenge: string
  startEnvironmentDigest: string
  restoreEnvironmentDigest: string | null
  steps: Array<"start" | "prompt" | "stop" | "restore">
  first: AcceptanceGeneration | null
  restored: AcceptanceGeneration | null
  cleanup: AcceptanceCleanup[]
  success: boolean
  failure: string | null
}
export type AcceptanceResult = { report: CodexAcceptanceReport; reportPath: string }

function canonical(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value.length > 4096 || /[\x00-\x1f]/u.test(value)) throw new AgentError("INVALID_PROTOCOL")
  return value
}
function generation(value: unknown): AcceptanceGeneration {
  const v = object(value); keys(v, ["agentId", "providerGeneration", "launchAttemptId", "sessionId", "sessionGeneration", "answer"])
  return { agentId: id(v.agentId), providerGeneration: id(v.providerGeneration), launchAttemptId: id(v.launchAttemptId), sessionId: text(v.sessionId), sessionGeneration: id(v.sessionGeneration), answer: text(v.answer, 4096) }
}
function cleanup(value: unknown): AcceptanceCleanup {
  const v = object(value); keys(v, ["stage", "launchAttemptId", "processGroupId", "cleanup"])
  if (v.stage !== "initial" && v.stage !== "restored" || v.cleanup !== "verified" || typeof v.processGroupId !== "number" || !Number.isSafeInteger(v.processGroupId) || v.processGroupId <= 1) throw new AgentError("INVALID_PROTOCOL")
  return { stage: v.stage, launchAttemptId: id(v.launchAttemptId), processGroupId: v.processGroupId, cleanup: "verified" }
}
export function parseCodexAcceptanceReport(input: unknown): CodexAcceptanceReport {
  try {
    const v = object(input); keys(v, ["protocol", "cwd", "challenge", "startEnvironmentDigest", "restoreEnvironmentDigest", "steps", "first", "restored", "cleanup", "success", "failure"])
    if (v.protocol !== "agency-codex-acceptance/1" || typeof v.success !== "boolean" || v.failure !== null && typeof v.failure !== "string" || !Array.isArray(v.steps) || v.steps.some(step => !["start", "prompt", "stop", "restore"].includes(String(step))) || !Array.isArray(v.cleanup) || v.cleanup.length > 2) throw new Error()
    const report = { protocol: "agency-codex-acceptance/1" as const, cwd: canonical(v.cwd), challenge: text(v.challenge), startEnvironmentDigest: hash(v.startEnvironmentDigest), restoreEnvironmentDigest: v.restoreEnvironmentDigest === null ? null : hash(v.restoreEnvironmentDigest), steps: [...v.steps] as CodexAcceptanceReport["steps"], first: v.first === null ? null : generation(v.first), restored: v.restored === null ? null : generation(v.restored), cleanup: v.cleanup.map(cleanup), success: v.success, failure: v.failure === null ? null : text(v.failure) }
    if (report.success !== (report.failure === null) || report.success && (report.steps.join(",") !== "start,prompt,stop,restore,prompt,stop" || !report.first || !report.restored || report.cleanup.length !== 2 || report.restoreEnvironmentDigest === null || report.first.agentId !== report.restored.agentId || report.first.sessionId !== report.restored.sessionId || report.first.providerGeneration === report.restored.providerGeneration || report.first.launchAttemptId === report.restored.launchAttemptId)) throw new Error()
    return report
  } catch { throw new AgentError("INVALID_PROTOCOL") }
}

async function publish(parent: string, report: CodexAcceptanceReport): Promise<string> {
  await assertPrivateDirectory(parent)
  const directory = join(parent, `codex-acceptance-${randomUUID()}`)
  await mkdir(directory, { mode: 0o700 })
  await assertPrivateDirectory(directory)
  const path = join(directory, "report.json"), handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { await handle.writeFile(JSON.stringify(report)); await handle.sync() } finally { await handle.close() }
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
  try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  return path
}

function commandResult(view: CommandView, outcome: "started" | "restored" | "stopped"): CommandView {
  if (view.durability !== "verified" || view.command.state !== "completed" || view.command.result?.outcome !== outcome || !view.command.target) throw new AgentError(view.command.result?.failure?.code ?? "INCOMPLETE")
  return view
}
function generationFrom(view: CommandView, session: SessionEvidence, launchAttemptId: string, answer: string): AcceptanceGeneration {
  const target = view.command.target!
  return { agentId: target.agentId, providerGeneration: target.providerGeneration, launchAttemptId, sessionId: session.sessionId, sessionGeneration: session.sessionGeneration, answer }
}
async function cleanupEvidence(lifecycle: AcceptanceLifecycle, stage: AcceptanceCleanup["stage"], target: AgentTuple): Promise<AcceptanceCleanup> {
  commandResult(await lifecycle.stop(target), "stopped")
  const listed = await lifecycle.list(), view = listed.agents.find(candidate => candidate.record.version === 2 && candidate.record.definition.agentId === target.agentId)
  if (!view || view.record.version !== 2 || view.cleanup !== "verified" || view.launch?.version !== 2 || view.launch.owner.kind !== "agent" || view.launch.phase !== "cleanup_verified" || !view.launch.provider) throw new AgentError("CLEANUP_UNVERIFIED")
  return { stage, launchAttemptId: view.launch.launchAttemptId, processGroupId: view.launch.provider.group.leader.processGroupId, cleanup: "verified" }
}

export async function runCodexAcceptance(input: { evidenceParent: string }, lifecycle: AcceptanceLifecycle): Promise<AcceptanceResult> {
  const evidenceParent = canonical(input.evidenceParent), cwd = canonical(lifecycle.cwd()), challenge = randomBytes(16).toString("hex"), startEnvironment = lifecycle.snapshot()
  const report: CodexAcceptanceReport = { protocol: "agency-codex-acceptance/1", cwd, challenge, startEnvironmentDigest: launchEnvironmentDigest(startEnvironment), restoreEnvironmentDigest: null, steps: [], first: null, restored: null, cleanup: [], success: false, failure: null }
  let active: AgentTuple | null = null
  try {
    report.steps.push("start")
    const started = commandResult(await lifecycle.start(cwd, startEnvironment), "started"), initialSession = started.command.result!.session!, initialTarget = started.command.target!
    active = initialTarget
    report.steps.push("prompt")
    const firstPrompt = `AGENCY_ACCEPTANCE_READ ${challenge}: read package.json in the current working directory and return exactly ${challenge} @moon/agency 24.13.0; remember the nonce.`
    const firstAnswer = (await lifecycle.prompt(initialTarget, firstPrompt)).text
    if (firstAnswer !== `${challenge} @moon/agency 24.13.0`) throw new AgentError("STARTUP_FAILED")
    report.steps.push("stop"); report.cleanup.push(await cleanupEvidence(lifecycle, "initial", initialTarget)); active = null
    const initialView = (await lifecycle.list()).agents.find(candidate => candidate.record.version === 2 && candidate.record.definition.agentId === initialTarget.agentId)
    if (!initialView || initialView.record.version !== 2) throw new AgentError("INVALID_AGENT_STATE")
    report.first = generationFrom(started, initialSession, initialView.record.launch.launchAttemptId, firstAnswer)
    const restoreEnvironment = lifecycle.snapshot(); report.restoreEnvironmentDigest = launchEnvironmentDigest(restoreEnvironment)
    report.steps.push("restore")
    const restored = commandResult(await lifecycle.restore(initialTarget.agentId, restoreEnvironment), "restored"), restoredSession = restored.command.result!.session!, restoredTarget = restored.command.target!
    active = restoredTarget
    report.steps.push("prompt")
    const restoredAnswer = (await lifecycle.prompt(restoredTarget, "AGENCY_ACCEPTANCE_RECALL: return exactly the nonce from the previous turn without reading files.")).text
    if (restoredAnswer !== challenge) throw new AgentError("STARTUP_FAILED")
    report.steps.push("stop"); report.cleanup.push(await cleanupEvidence(lifecycle, "restored", restoredTarget)); active = null
    const restoredView = (await lifecycle.list()).agents.find(candidate => candidate.record.version === 2 && candidate.record.definition.agentId === restoredTarget.agentId)
    if (!restoredView || restoredView.record.version !== 2) throw new AgentError("INVALID_AGENT_STATE")
    report.restored = generationFrom(restored, restoredSession, restoredView.record.launch.launchAttemptId, restoredAnswer)
    if (report.first.agentId !== report.restored.agentId || report.first.sessionId !== report.restored.sessionId || report.first.providerGeneration === report.restored.providerGeneration || report.first.launchAttemptId === report.restored.launchAttemptId) throw new AgentError("INVALID_PROTOCOL")
    report.success = true
  } catch (error) {
    report.failure = error instanceof AgentError ? error.code : "ACCEPTANCE_FAILED"
    if (active) await cleanupEvidence(lifecycle, report.cleanup.length ? "restored" : "initial", active).then(value => { if (!report.cleanup.some(entry => entry.stage === value.stage)) report.cleanup.push(value) }, () => undefined)
  }
  return { report, reportPath: await publish(evidenceParent, report) }
}

async function productionLifecycle(): Promise<AcceptanceLifecycle> {
  const dependencies = productionControlDependencies(), environment = await dependencies.environment(), inspection = await dependencies.start(environment)
  if (inspection.disposition !== "live" || inspection.record.phase !== "ready" || !dependencies.callAgent) throw new AgentError("UNAVAILABLE")
  const handlerGeneration = inspection.record.generation
  const call = async (request: AgentRequest): Promise<AgentReply> => {
    const reply = await dependencies.callAgent!(environment, request, 5000)
    if (!reply.ok) throw new AgentError(reply.error.code)
    return reply
  }
  const complete = async (request: Extract<AgentRequest, { op: "agent_start" | "agent_restore" | "agent_stop" }>): Promise<CommandView> => {
    let reply = await call(request), deadline = performance.now() + 45000
    while (reply.ok && reply.result.state === "command" && (reply.result.command.state === "pending" || reply.result.durability !== "verified")) {
      if (performance.now() >= deadline) throw new AgentError("INCOMPLETE")
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
      reply = await call({ protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration, op: "agent_command", commandId: request.input.commandId, commandGeneration: handlerGeneration })
    }
    if (!reply.ok || reply.result.state !== "command") throw new AgentError("INVALID_PROTOCOL")
    return reply.result
  }
  const selection = { providerId: "codex-acp" as const, modelId: "gpt-5.6-sol", reasoning: { kind: "value" as const, value: "high" }, mode: "read-only", permissionProfile: "deny-all" }
  return {
    cwd: () => resolve(process.cwd()), snapshot: () => snapshotLaunchEnvironment(process.env),
    start: (cwd, launchEnvironment) => complete({ protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration, op: "agent_start", input: { commandId: randomUUID(), handlerGeneration, cwd, selection, environment: launchEnvironment } }),
    restore: (agentId, launchEnvironment) => complete({ protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration, op: "agent_restore", input: { commandId: randomUUID(), handlerGeneration, agentId, environment: launchEnvironment } }),
    stop: target => complete({ protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration, op: "agent_stop", input: { ...target, commandId: randomUUID() } }),
    async prompt(target, prompt) { const reply = await call({ protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration, op: "agent_prompt", input: { ...target, text: prompt } }); if (!reply.ok || reply.result.state !== "prompt") throw new AgentError("INVALID_PROTOCOL"); return reply.result },
    async list() { const reply = await call({ protocol: AGENT_PROTOCOL, requestId: randomUUID(), handlerGeneration, op: "agent_list" }); if (!reply.ok || reply.result.state !== "agents") throw new AgentError("INVALID_PROTOCOL"); return reply.result },
  }
}

function argumentsFor(argv: readonly string[]): { evidenceParent: string } {
  if (argv.length !== 2 || argv[0] !== "--evidence-parent" || !argv[1] || argv[1].startsWith("--")) throw new AgentError("USAGE")
  if (["--candidate", "--report-sha256", "--reviewed-commit", "--stage", "--register"].some(flag => argv.includes(flag))) throw new AgentError("USAGE")
  return { evidenceParent: canonical(argv[1]) }
}
export async function codexAcceptanceMain(argv: readonly string[]): Promise<number> {
  const input = argumentsFor(argv), contracts = productionLaunchContracts()
  if (contracts.length !== 1 || contracts[0]!.providerId !== "codex-acp" || !contracts[0]!.sessionLoad) throw new AgentError("ADAPTER_UNQUALIFIED")
  const result = await runCodexAcceptance(input, await productionLifecycle())
  process.stdout.write(JSON.stringify({ success: result.report.success, failure: result.report.failure, reportPath: result.reportPath }) + "\n")
  return result.report.success ? 0 : 1
}
if (process.argv[1] === fileURLToPath(import.meta.url)) void codexAcceptanceMain(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { process.stderr.write((error instanceof AgentError ? error.code : "ACCEPTANCE_FAILED") + "\n"); process.exitCode = 1 })