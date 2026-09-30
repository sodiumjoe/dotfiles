import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { openSync, closeSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
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
          if (scenario !== "descriptor-leak") {
            const child = spawn(file, [...args, scenario, root, dirname(candidatePath)], config!)
            if (scenario.startsWith("prompt-forward-")) {
              const original = child.stdin!.write.bind(child.stdin!), path = join(dirname(candidatePath), "prompt-forward-audit.json")
              let promptWrites = 0
              child.stdin!.write = ((chunk: Buffer | string, ...rest: unknown[]) => {
                try { if (JSON.parse(chunk.toString()).method === "session/prompt") writeFileSync(path, JSON.stringify({ promptWrites: ++promptWrites }), { mode: 0o600 }) } catch {}
                return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
              }) as NonNullable<typeof child.stdin>["write"]
            }
            return child
          }
          const fd = openSync(join(root, "receipts"), "r")
          try { return spawn(file, [...args, scenario, root], { ...config, stdio: ["pipe", "pipe", "pipe", fd] }) } finally { closeSync(fd) }
        }) as typeof spawn,
        ...(scenario === "state-removal" ? { removeProviderState: async () => { throw new AgentError("CLEANUP_UNVERIFIED") } } : {}),
        publish: async (path, value) => {
          if (scenario !== "missing-evidence") await durableQualificationWrite(path, value)
          if (path.endsWith(".prompt.json") && scenario.startsWith("prompt-forward-")) {
            await durableQualificationWrite(join(root, "receipts/prompt-publication-held.json"), { held: true })
            await new Promise(resolve => setTimeout(resolve, scenario === "prompt-forward-timeout" ? 5500 : scenario === "prompt-forward-success" ? 100 : 3000))
          }
        },
        })(options)
        if (scenario === "parent-overall") return { ...owner, cleanup: () => new Promise<ReturnType<typeof owner.record>>(() => undefined) }
        return owner
      },
      observeLaunchEvidence: (spec, expected) => verifyInjectedLaunchEvidence(candidate, evidence, spec, expected), fatalStartupTimeout: fatalQualificationHandler,
    })
    if (scenario === "stop-failure") return { ...service, async stop() { throw new AgentError("CLEANUP_UNVERIFIED") } }
    if (scenario === "prompt-forward-stop") return { ...service, prompt(input) {
      const pending = service.prompt(input)
      void (async () => {
        const marker = join(root, "receipts/prompt-publication-held.json")
        for (let attempt = 0; attempt < 200; attempt++) {
          if (await readFile(marker).then(() => true, () => false)) {
            const { text: _, ...target } = input
            await service.stop({ ...target, commandId: randomUUID() }).catch(() => undefined)
            return
          }
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      })()
      return pending
    } }
    return service
  }
  await runHandler(options)
} catch { process.exitCode = 1 }