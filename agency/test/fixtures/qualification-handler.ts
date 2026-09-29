import { spawn } from "node:child_process"
import { openSync, closeSync } from "node:fs"
import { join } from "node:path"
import { runHandler } from "../../src/handler/daemon.js"
import { createAgentService } from "../../src/agent/service.js"
import { AgentError } from "../../src/agent/types.js"
import { contractFromQualifiedCandidate, launchEvidenceFromQualifiedCandidate } from "../../src/agent/qualification.js"
import { qualificationHandlerOptions, qualificationCatalog, qualificationProcessFactory, verifyInjectedLaunchEvidence, fatalQualificationHandler } from "../../scripts/qualify-codex-handler.js"
import { durableQualificationWrite, parseQualificationCandidate, readPrivateJson } from "../../scripts/qualify-codex.js"

process.umask(0o077)
const [candidatePath, root, scenario] = process.argv.slice(2) as [string, string, string]
try {
  const options = await qualificationHandlerOptions(candidatePath, root, "a".repeat(64))
  if (scenario === "survivor") options.adapter = { ...options.adapter, async signalGroup() {} }
  if (scenario === "handler-startup") options.onPhase = async () => { throw new Error("fixture startup failure") }
  const candidate = parseQualificationCandidate(await readPrivateJson(candidatePath)), evidence = launchEvidenceFromQualifiedCandidate(candidate, options.generation, Date.now())
  options.launchContracts = [contractFromQualifiedCandidate(candidate)]
  options.catalogFactory = context => qualificationCatalog(context, evidence)
  options.agentFactory = input => {
    const times = new Map<string, number>()
    const admission = { ...input.admission, async reserve(request: Parameters<typeof input.admission.reserve>[0]) { const before = performance.now(); const reserved = await input.admission.reserve(request); times.set(reserved.launch.launchAttemptId, performance.now() - before); if (scenario === "reservation-hang") await new Promise<void>(() => undefined); return reserved } }
    const store = { ...input.store, async writeCommand(next: Parameters<typeof input.store.writeCommand>[0], expected: Parameters<typeof input.store.writeCommand>[1]) { await input.store.writeCommand(next, expected); if (scenario === "command-hang" && next.op === "start" && next.state === "pending") await new Promise<void>(() => undefined) } }
    const service = createAgentService({ ...input, admission, store }, {
      processFactory: options => {
        const owner = qualificationProcessFactory(root, times, {
        spawn: ((file: string, args: readonly string[], config: Parameters<typeof spawn>[2]) => {
          if (scenario !== "descriptor-leak") return spawn(file, [...args, scenario, root], config!)
          const fd = openSync(join(root, "receipts"), "r")
          try { return spawn(file, [...args, scenario, root], { ...config, stdio: ["pipe", "pipe", "pipe", fd] }) } finally { closeSync(fd) }
        }) as typeof spawn,
        ...(scenario === "state-removal" ? { removeProviderState: async () => { throw new AgentError("CLEANUP_UNVERIFIED") } } : {}),
        publish: async (path, value) => {
          if (scenario === "descriptor-leak") { const audit = await readPrivateJson(join(root, "receipts/fd-audit.json")) as { inheritedDirectory: boolean }; Object.assign(value as object, { descriptors: !audit.inheritedDirectory }) }
          if (scenario !== "missing-evidence") await durableQualificationWrite(path, value)
        },
        })(options)
        if (scenario === "parent-overall") return { ...owner, cleanup: () => new Promise<ReturnType<typeof owner.record>>(() => undefined) }
        return owner
      },
      observeLaunchEvidence: (spec, expected) => verifyInjectedLaunchEvidence(candidate, evidence, spec, expected), fatalStartupTimeout: fatalQualificationHandler,
    })
    if (scenario === "stop-failure") return { ...service, async stop() { throw new AgentError("CLEANUP_UNVERIFIED") } }
    return service
  }
  await runHandler(options)
} catch { process.exitCode = 1 }