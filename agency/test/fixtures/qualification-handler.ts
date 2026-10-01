import { Socket } from "node:net"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { runHandler } from "../../src/handler/daemon.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
import { qualificationHandlerOptions, qualificationProcessFactory } from "../../scripts/qualify-codex-handler.js"
import { createAgentService } from "../../src/agent/service.js"
import { observeLaunchContract, type LaunchContract } from "../../src/agent/contracts.js"
import { isDeepStrictEqual } from "node:util"
import { parseQualificationCandidate, readPrivateJson } from "../../scripts/qualify-codex.js"

process.umask(0o077)
const [path, receipts, encodedPaths] = process.argv.slice(2) as [string, string, string]
const candidate = parseQualificationCandidate(await readPrivateJson(path))
const paths = JSON.parse(encodedPaths)
const options = qualificationHandlerOptions(candidate, receipts, {
  paths, generation: process.env.AGENCY_HANDLER_GENERATION!, recordPath: process.env.AGENCY_HANDLER_RECORD!,
  adapter: process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter(),
  status: new Socket({ fd: 3, readable: true, writable: true }), gate: new Socket({ fd: 4, readable: true, writable: true }),
}, async () => ({ ...candidate, nodeVersion: candidate.manifest.nodeVersion, selection: candidate.manifest.selection, artifacts: { adapterPackageJson: candidate.manifest.adapterPackageJson, adapterEntrypoint: candidate.manifest.adapterEntrypoint, codexExecutable: candidate.manifest.codexExecutable, nodeExecutable: candidate.manifest.nodeExecutable } }))
if (process.argv[5] === "readiness-timeout") options.onPhase = async phase => { if (phase === "ready") await new Promise<void>(() => undefined) }
if (process.argv[5] === "readiness-race") options.onPhase = async phase => {
  if (phase === "ready") while (true) {
    try { await access(join(paths.runtimeRoot, "release-ready")); break } catch {}
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const contract: LaunchContract = { ...options.launchContracts![0]!, permissionEvidence: "fixture-contract-v1", qualification: null }
contract.fingerprint = await observeLaunchContract(contract)
options.launchContracts = [contract]
options.agentFactory = input => createAgentService({ ...input, candidateRestoreContracts: new Set([contract.id]) }, {
  processFactory: qualificationProcessFactory(receipts),
  async observeLaunchEvidence(spec, expected) {
    if (spec.contractFingerprint !== contract.fingerprint || !isDeepStrictEqual(spec.catalogEvidence, expected.provider) || !isDeepStrictEqual(spec.configuration, expected.configuration)) throw new Error("fixture evidence mismatch")
  },
  fatalStartupTimeout(): never { throw new Error("unexpected fixture timeout") },
})
if (process.argv[5] === "pre-gate-failure") {
  const identity = await options.adapter.readProcess(process.pid)
  options.status.write(JSON.stringify({ type: "identity", identity }) + "\n")
  await new Promise<void>(() => setInterval(() => undefined, 1000))
} else await runHandler(options)