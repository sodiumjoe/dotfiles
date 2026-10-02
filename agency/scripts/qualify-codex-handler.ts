import { spawn } from "node:child_process"
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
import { createDarwinAdapter } from "../src/platform/darwin.js"
import { readHostId } from "../src/platform/host-id.js"
import { resolvePlatformPaths } from "../src/platform/paths.js"
import { assertPrivateDirectory } from "../src/platform/private-state.js"
import { durableQualificationWrite, parseQualificationCandidate, readPrivateJson, type QualificationReceipt } from "./qualify-codex.js"

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
export async function verifyInjectedLaunchEvidence(candidate: CodexQualificationCandidate, injected: LaunchEvidence, spec: LaunchSpec, expected: LaunchEvidence, verify = verifyCodexQualification): Promise<void> {
  const selection = candidate.manifest.selection
  if (spec.contractId !== candidate.manifest.contractId || !isDeepStrictEqual(spec.selection, { providerId: candidate.manifest.providerId, ...selection, reasoning: { kind: "value", value: selection.reasoning } })) throw new AgentError("CONFIG_CHANGED")
  if (!isDeepStrictEqual(injected, expected) || spec.catalogSnapshotId !== injected.snapshotId || !isDeepStrictEqual(spec.catalogEvidence, injected.provider) || !isDeepStrictEqual(spec.configuration, injected.configuration) || spec.handlerGeneration !== injected.provider.verifiedHandlerGeneration) throw new AgentError("CONFIG_CHANGED")
  const derived = launchEvidenceFromQualifiedCandidate(candidate, spec.handlerGeneration, injected.provider.verifiedAt!)
  if (!isDeepStrictEqual({ ...derived, snapshotId: injected.snapshotId }, injected) || (await verify(candidate.manifest)).fingerprint !== spec.contractFingerprint) throw new AgentError("CONFIG_CHANGED")
}
export function qualificationProcessFactory(receipts: string): typeof createAgentProcess {
  return input => {
    const qualification = (input.contract as any).qualification
    if (qualification && input.environment.CODEX_PATH !== qualification.codexExecutable.path) throw new AgentError("CONFIG_CHANGED")
    const receipt: QualificationReceipt = { version: 4, handlerGeneration: input.spec.handlerGeneration, providerGeneration: input.spec.providerGeneration, launchAttemptId: input.spec.launchAttemptId, methods: [], promptCount: 0, prompts: [], terminal: false, streamsClosed: false, failure: null }
    let child: ReturnType<typeof spawn> | undefined
    const owner = createAgentProcess(input, { spawn: ((file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const spawned = spawn(file, args, options!)
      child = spawned
      const write = spawned.stdin!.write.bind(spawned.stdin!)
      spawned.stdin!.write = ((chunk: Buffer | string, ...rest: unknown[]) => {
        try {
          const request = JSON.parse(chunk.toString())
          if (typeof request.method === "string") {
            if (receipt.methods.length >= 32) throw new Error("too many methods")
            receipt.methods.push(request.method)
            if (request.method === "session/prompt") {
              receipt.promptCount++
              if (typeof request.params?.sessionId !== "string" || request.params.sessionId.length > 1024 || !Array.isArray(request.params.prompt) || request.params.prompt.length !== 1 || request.params.prompt[0]?.type !== "text" || typeof request.params.prompt[0].text !== "string" || Buffer.byteLength(request.params.prompt[0].text) > 4096) throw new Error("invalid prompt")
              receipt.prompts.push({ sessionId: request.params.sessionId, text: request.params.prompt[0].text })
            }
          }
        } catch { receipt.failure = "INVALID_PROTOCOL" }
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest)
      }) as NonNullable<typeof spawned.stdin>["write"]
      spawned.once("exit", () => { receipt.terminal = true })
      return spawned
    }) as typeof spawn })
    let cleanup: ReturnType<typeof owner.cleanup> | undefined
    return { ...owner, cleanup() {
      return cleanup ??= (async () => {
        try { return await owner.cleanup() }
        catch (error) { receipt.failure = "CLEANUP_UNVERIFIED"; throw error }
        finally {
          receipt.streamsClosed = !!child && !!child.stdin?.destroyed && !!child.stdout?.destroyed && !!child.stderr?.destroyed
          await durableQualificationWrite(join(receipts, input.spec.launchAttemptId + ".json"), receipt)
        }
      })()
    } }
  }
}
export function qualificationHandlerOptions(candidate: CodexQualificationCandidate, receipts: string, base: HandlerOptions, verify = verifyCodexQualification): HandlerOptions {
  const contract = contractFromQualifiedCandidate(candidate), evidence = launchEvidenceFromQualifiedCandidate(candidate, base.generation, Date.now())
  return { ...base, launchContracts: [contract], catalogFactory: context => qualificationCatalog(context, evidence), agentFactory: input => createAgentService(input, {
    processFactory: qualificationProcessFactory(receipts),
    observeLaunchEvidence: (spec, expected) => verifyInjectedLaunchEvidence(candidate, evidence, spec, expected, verify),
    fatalStartupTimeout(spec): never {
      if (spec.handlerGeneration !== base.generation || base.generation !== process.env.AGENCY_HANDLER_GENERATION) throw new AgentError("STARTUP_TIMEOUT")
      process.kill(process.pid, "SIGKILL"); throw new AgentError("STARTUP_TIMEOUT")
    },
  }) }
}
async function main(): Promise<void> {
  const [candidatePath, receipts] = process.argv.slice(2)
  if (!candidatePath || !receipts) throw new AgentError("USAGE")
  const candidate = parseQualificationCandidate(await readPrivateJson(candidatePath))
  await verifyCodexQualification(candidate.manifest); await assertPrivateDirectory(receipts)
  const paths = await resolvePlatformPaths({ platform: "darwin", uid: process.getuid!(), hostKey: await readHostId("darwin"), home: process.env.HOME!, ...(process.env.XDG_STATE_HOME ? { xdgStateHome: process.env.XDG_STATE_HOME } : {}) })
  await runHandler(qualificationHandlerOptions(candidate, receipts, {
    paths, adapter: createDarwinAdapter(), generation: process.env.AGENCY_HANDLER_GENERATION!, recordPath: process.env.AGENCY_HANDLER_RECORD!,
    status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }),
  }))
}
if (process.argv[1] === fileURLToPath(import.meta.url)) void main().catch(() => { process.exitCode = 1 })