import { spawn, type ChildProcess } from "node:child_process"
import { Socket } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { contractFromQualifiedCandidate, launchEvidenceFromQualifiedCandidate, verifyCodexQualification, type CodexQualificationCandidate } from "../src/agent/qualification.js"
import { createAgentProcess } from "../src/agent/process.js"
import { createAgentService } from "../src/agent/service.js"
import { AgentError, type LaunchSpec } from "../src/agent/types.js"
import { isFresh } from "../src/catalog/types.js"
import type { CatalogService, LaunchEvidence } from "../src/catalog/service.js"
import { runHandler, type HandlerOptions } from "../src/handler/daemon.js"
import { commitLaunchTransition } from "../src/handler/launch-transitions.js"
import { assertPrivateDirectory } from "../src/platform/private-state.js"
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { readHostId } from "../src/platform/host-id.js"
import { durableQualificationWrite, parseQualificationCandidate, qualificationPaths, readPrivateJson, type QualificationReceipt } from "./qualify-codex.js"

type CatalogContext = Parameters<NonNullable<HandlerOptions["catalogFactory"]>>[0]
export function qualificationCatalog(context: CatalogContext, input: LaunchEvidence): CatalogService {
  const evidence = structuredClone(input)
  if (evidence.provider.verifiedHandlerGeneration !== context.generation || !isFresh(evidence.provider.verifiedAt, Date.now())) throw new AgentError("MODEL_UNAVAILABLE")
  return {
    async initialize() {}, startScheduling() {}, async freezeAndDrain() {}, resume() {}, async verifyDischarged() {}, close() {},
    async refresh() { throw new AgentError("ADAPTER_UNQUALIFIED") },
    async launchEvidence(providerId) {
      if (providerId !== evidence.provider.providerId || !isFresh(evidence.provider.verifiedAt, Date.now())) throw new AgentError("MODEL_UNAVAILABLE")
      return structuredClone(evidence)
    },
    async list() { return { state: "catalog", hostId: context.paths.hostKey, handlerGeneration: context.generation, observedAt: Date.now(), launchAuthorized: false, providers: [{ ...structuredClone(evidence.provider), state: "ready", freshness: "fresh" }], refresh: null, discovery: { state: "idle", error: null } } },
  }
}
export async function verifyInjectedLaunchEvidence(candidate: CodexQualificationCandidate, injected: LaunchEvidence, spec: LaunchSpec, expected: LaunchEvidence): Promise<void> {
  if (spec.contractId !== candidate.manifest.contractId || !isDeepStrictEqual(spec.selection, { providerId: "codex-acp", modelId: "gpt-5.6-sol", reasoning: { kind: "value", value: "high" }, mode: "read-only", permissionProfile: "deny-all" })) throw new AgentError("CONFIG_CHANGED")
  if (!isDeepStrictEqual(injected, expected) || spec.catalogSnapshotId !== injected.snapshotId || !isDeepStrictEqual(spec.catalogEvidence, injected.provider) || !isDeepStrictEqual(spec.configuration, injected.configuration) || spec.handlerGeneration !== injected.provider.verifiedHandlerGeneration) throw new AgentError("CONFIG_CHANGED")
  const derived = launchEvidenceFromQualifiedCandidate(candidate, spec.handlerGeneration, injected.provider.verifiedAt!)
  if (!isDeepStrictEqual({ ...derived, snapshotId: injected.snapshotId }, injected) || (await verifyCodexQualification(candidate.manifest)).fingerprint !== spec.contractFingerprint) throw new AgentError("CONFIG_CHANGED")
}
export function fatalQualificationHandler(spec: LaunchSpec): never {
  if (spec.handlerGeneration !== process.env.AGENCY_HANDLER_GENERATION) throw new AgentError("STARTUP_TIMEOUT")
  process.kill(process.pid, "SIGKILL")
  throw new AgentError("STARTUP_TIMEOUT")
}
type AuditOptions = { spawn?: typeof spawn; removeProviderState?: NonNullable<Parameters<typeof createAgentProcess>[1]>["removeProviderState"]; publish?: typeof durableQualificationWrite }
export function qualificationProcessFactory(root: string, reservationTimes: Map<string, number>, options: AuditOptions = {}): typeof createAgentProcess {
  return input => {
    const receipt: QualificationReceipt = { version: 1, handlerGeneration: input.spec.handlerGeneration, launchAttemptId: input.spec.launchAttemptId, methods: [], durations: {}, prompt: { state: "not_started", challenge: null, prompt: null, answer: null, normalizedAnswer: null, stopReason: null, durationMs: null }, terminal: false, transportClosed: false, handlesClosed: false, failure: null }
    const reservation = reservationTimes.get(input.spec.launchAttemptId)
    if (reservation !== undefined) receipt.durations.reservation = reservation
    let child: ChildProcess | undefined, started = performance.now(), phaseStart = 0, pendingId: unknown, phase: "initialize" | "session" | "model" | "reasoning" | "mode" | "prompt" | undefined, sessionId: string | undefined, buffer = "", closeStart = 0, terminalAt = 0, closedAt = 0, absenceStart = 0, promptEvidence: Promise<void> | undefined
    let promptForward: { state: "publishing" | "forwarded" | "settled"; completion: Promise<void>; settle(error?: Error | null): void } | undefined
    const releasePrompt = (error = new AgentError("STARTUP_FAILED")): void => { promptForward?.settle(error) }
    const adapter = input.context.adapter
    const observedInput = { ...input, context: { ...input.context, adapter: { ...adapter,
      async readGroup(group: number) { const result = await adapter.readGroup(group); if (closeStart && !result.length) { absenceStart ||= performance.now(); receipt.durations.absence = performance.now() - absenceStart }; return result },
      async readProcess(pid: number) { const result = await adapter.readProcess(pid); if (absenceStart) receipt.durations.absence = performance.now() - absenceStart; return result },
    } } }
    const owner = createAgentProcess(observedInput, { ...(options.removeProviderState ? { removeProviderState: options.removeProviderState } : {}), spawn: ((file: string, args: readonly string[], config: Parameters<typeof spawn>[2]) => {
      if (!isDeepStrictEqual(config?.stdio, ["pipe", "pipe", "pipe"]) || config?.shell !== false || config?.detached !== true) throw new AgentError("STARTUP_FAILED")
      child = (options.spawn ?? spawn)(file, args, config!)
      const original = child.stdin!.write.bind(child.stdin!)
      child.stdin!.write = ((chunk: Buffer | string, ...rest: unknown[]) => {
        let publishPrompt = false
        try {
          const request = JSON.parse(chunk.toString())
          if (typeof request.method === "string") {
            const method = request.method === "session/set_config_option" ? request.method + ":" + request.params.configId : request.method
            const expected = ["initialize", "session/new", "session/set_config_option:model", "session/set_config_option:reasoning_effort", "session/set_config_option:mode", "session/prompt"][receipt.methods.length]
            if (method !== expected) throw new AgentError("INVALID_PROTOCOL")
            receipt.methods.push(method); phase = ["initialize", "session", "model", "reasoning", "mode", "prompt"][receipt.methods.length - 1] as typeof phase
            phaseStart = performance.now(); pendingId = request.id
            if (method === "session/prompt") {
              const prompt = request.params?.prompt?.[0]?.text, match = typeof prompt === "string" ? /^Return exactly this token and no other text:\n(AGENCY_CODEX_SMOKE_[0-9a-f]{32})\n\nDo not inspect files or use tools\.$/.exec(prompt) : null
              if (!match || request.params.prompt.length !== 1 || request.params.prompt[0].type !== "text" || request.params.sessionId !== sessionId) throw new AgentError("INVALID_PROTOCOL")
              receipt.prompt = { state: "in_flight_failed", challenge: match[1]!, prompt, answer: "", normalizedAnswer: null, stopReason: null, durationMs: 0 }
              publishPrompt = true
            }
            if (receipt.methods.length === 1) receipt.durations.spawn = phaseStart - started
          }
        } catch { receipt.failure = "INVALID_PROTOCOL" }
        if (publishPrompt) {
          const callback = rest.find(value => typeof value === "function") as ((error?: Error | null) => void) | undefined
          let resolve!: () => void, timer: NodeJS.Timeout | undefined
          const forward: NonNullable<typeof promptForward> = {
            state: "publishing",
            completion: new Promise<void>(done => { resolve = done }),
            settle(error) {
              if (forward.state === "settled") return
              forward.state = "settled"; clearTimeout(timer); callback?.(error); resolve()
            },
          }
          promptForward = forward
          timer = setTimeout(() => forward.settle(new AgentError("STARTUP_TIMEOUT")), input.spec.limits.rpcMs)
          promptEvidence = (options.publish ?? durableQualificationWrite)(join(root, "receipts", input.spec.launchAttemptId + ".prompt.json"), receipt)
          void promptEvidence.then(() => {
            if (promptForward !== forward || forward.state !== "publishing") return
            forward.state = "forwarded"
            const forwarded = [...rest], callbackIndex = forwarded.findIndex(value => typeof value === "function")
            const settled = (error?: Error | null): void => forward.settle(error)
            if (callbackIndex >= 0) forwarded[callbackIndex] = settled
            else forwarded.push(settled)
            try { (original as (...args: unknown[]) => boolean)(chunk, ...forwarded) }
            catch (error) { forward.settle(error instanceof Error ? error : new Error("prompt forwarding failed")) }
          }, error => {
            receipt.failure = "EVIDENCE_PUBLICATION_FAILED"
            forward.settle(error instanceof Error ? error : new Error("prompt evidence publication failed"))
          })
          return false
        }
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
      }) as NonNullable<ChildProcess["stdin"]>["write"]
      child.stdout!.on("data", (chunk: Buffer) => {
        if (buffer.length + chunk.length > input.spec.limits.frameBytes) { receipt.failure = "INVALID_PROTOCOL"; buffer = ""; return }
        buffer += chunk.toString("utf8")
        let newline: number
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
          try {
            const response = JSON.parse(line)
            if (response.method === "session/update" && response.params?.sessionId === sessionId && response.params.update?.sessionUpdate === "agent_message_chunk" && response.params.update.content?.type === "text" && receipt.prompt.state === "in_flight_failed") {
              const text = response.params.update.content.text
              if (typeof text !== "string" || !text.isWellFormed() || Buffer.byteLength(receipt.prompt.answer + text) > 4096) throw new AgentError("INVALID_PROTOCOL")
              receipt.prompt.answer += text
            }
            if (response.id === pendingId && response.result !== undefined && phase) {
              const duration = performance.now() - phaseStart
              receipt.durations[phase] = duration
              if (phase === "session" && typeof response.result.sessionId === "string") sessionId = response.result.sessionId
              if (phase === "prompt" && receipt.prompt.state === "in_flight_failed" && ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(response.result.stopReason)) {
                receipt.prompt = { ...receipt.prompt, state: "completed", normalizedAnswer: receipt.prompt.answer.trim(), stopReason: response.result.stopReason, durationMs: duration }
              }
              pendingId = undefined
            }
          } catch { receipt.failure = "INVALID_PROTOCOL" }
        }
      })
      child.once("exit", () => { releasePrompt(); receipt.terminal = true; terminalAt = performance.now(); if (closeStart) receipt.durations.processTerminate = terminalAt - closeStart })
      child.once("close", () => { releasePrompt(); closedAt = performance.now() })
      return child
    }) as typeof spawn })
    let cleanup: ReturnType<typeof owner.cleanup> | undefined
    return {
      ...owner,
      async initialize(signal) {
        started = performance.now()
        const deadline = input.deadline ?? started + (input.contract.qualification?.deadlines.overallMs ?? input.spec.limits.startupMs)
        const check = (): void => {
          if (signal.aborted) throw new AgentError("STARTUP_FAILED")
          if (performance.now() >= deadline) throw new AgentError("STARTUP_TIMEOUT")
        }
        try {
          const session = await owner.initialize(signal)
          await input.context.mutations.queue.run(async () => {
            check(); await input.revalidate(); check()
            const record = owner.record(), group = record.provider?.group
            if (record.phase !== "readiness" || !group) throw new AgentError("STARTUP_FAILED")
            const first = await adapter.readGroup(group.leader.pid); check()
            const second = await adapter.readGroup(group.leader.pid); check()
            if (second.length < 2 || second.length > 4096 || new Set(second.map(p => p.pid)).size !== second.length || !isDeepStrictEqual([...first].sort((a, b) => a.pid - b.pid), [...second].sort((a, b) => a.pid - b.pid)) || !second.some(p => isDeepStrictEqual(p, group.leader)) || group.observed.some(p => !second.some(other => isDeepStrictEqual(p, other)))) throw new AgentError("STARTUP_FAILED")
            for (const member of second) {
              if (member.bootId !== group.leader.bootId || member.processGroupId !== group.leader.pid || member.sessionId !== group.leader.pid || member.uid !== group.leader.uid || member.gid !== group.leader.gid) throw new AgentError("STARTUP_FAILED")
              let current = member, visited = new Set<number>()
              while (current.pid !== group.leader.pid) {
                if (visited.has(current.pid)) throw new AgentError("STARTUP_FAILED")
                visited.add(current.pid)
                const parent = second.find(p => p.pid === current.parentPid)
                if (!parent) throw new AgentError("STARTUP_FAILED")
                current = parent
              }
            }
            check(); await commitLaunchTransition(input.context, record, { ...record, provider: { kind: "process-group", group: { leader: group.leader, observed: second } } }); check()
          })
          check(); return session
        } catch (error) { if (error instanceof AgentError) receipt.failure = error.code; throw error }
      },
      cleanup() {
        if (cleanup) return cleanup
        closeStart = performance.now()
        releasePrompt()
        cleanup = (async () => {
          let result
          try { result = await owner.cleanup() }
          catch (error) { receipt.failure = "CLEANUP_UNVERIFIED"; throw error }
          finally {
            await promptForward?.completion
            await new Promise<void>(resolve => setImmediate(resolve))
            receipt.transportClosed = child === undefined || closedAt > 0 && !!child.stdin?.destroyed && !!child.stdout?.destroyed && !!child.stderr?.destroyed
            receipt.handlesClosed = receipt.transportClosed
            if (closedAt && terminalAt) receipt.durations.transportClose = Math.max(0, closedAt - terminalAt)
            if (!child) { receipt.terminal = true; receipt.durations.processTerminate = 0 }
            if (receipt.prompt.state === "in_flight_failed" && phaseStart) receipt.prompt.durationMs = performance.now() - phaseStart
            await (options.publish ?? durableQualificationWrite)(join(root, "receipts", input.spec.launchAttemptId + ".json"), receipt)
          }
          return result
        })()
        return cleanup
      },
      dispose() { releasePrompt(); owner.dispose() },
    }
  }
}
export async function qualificationHandlerOptions(candidatePath: string, root: string, hostKey: string): Promise<HandlerOptions> {
  const paths = qualificationPaths(root, hostKey)
  await assertPrivateDirectory(root); await assertPrivateDirectory(paths.persistentRoot); await assertPrivateDirectory(paths.runtimeRoot); await assertPrivateDirectory(join(root, "receipts"))
  const candidate = parseQualificationCandidate(await readPrivateJson(candidatePath))
  const generation = process.env.AGENCY_HANDLER_GENERATION, recordPath = process.env.AGENCY_HANDLER_RECORD
  if (!generation || recordPath !== join(paths.runtimeRoot, "handler.json")) throw new AgentError("USAGE")
  const contract = contractFromQualifiedCandidate(candidate), evidence = launchEvidenceFromQualifiedCandidate(candidate, generation, Date.now()), reservationTimes = new Map<string, number>()
  return { paths, adapter: createDarwinAdapter(), recordPath, generation, status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }), launchContracts: [contract],
    catalogFactory: context => qualificationCatalog(context, evidence),
    agentFactory(input) {
      const admission = { ...input.admission, async reserve(request: Parameters<typeof input.admission.reserve>[0]) { const start = performance.now(); const result = await input.admission.reserve(request); reservationTimes.set(result.launch.launchAttemptId, performance.now() - start); return result } }
      return createAgentService({ ...input, admission }, { processFactory: qualificationProcessFactory(root, reservationTimes), observeLaunchEvidence: (spec, expected) => verifyInjectedLaunchEvidence(candidate, evidence, spec, expected), fatalStartupTimeout: fatalQualificationHandler })
    },
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.umask(0o077)
  try {
    if (process.argv.length !== 4 || process.platform !== "darwin") throw new AgentError("USAGE")
    await runHandler(await qualificationHandlerOptions(process.argv[2]!, process.argv[3]!, await readHostId("darwin")))
  } catch { process.exitCode = 1 }
}