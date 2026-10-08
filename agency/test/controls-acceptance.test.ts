import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { parseControlsAcceptancePlan } from "../scripts/accept-cross-host.js"

function plan() {
  const host = (name: string, platform: string) => ({ inventoryId: randomUUID(), hostId: name.repeat(64), handlerGeneration: randomUUID(), hostname: `controls-${name}`, agyPath: "/previous/agy", nodePath: "/node", loginShell: "/bin/bash", cwd: "/previous/work", platform, sourceRevision: "a".repeat(40), sourceDigest: "b".repeat(64), distDigest: "c".repeat(64), nodeVersion: "v24.13.0" })
  const deployment = (name: string) => ({ root: `/controls/${name}`, stateRoot: `/controls/${name}/state`, runtimeRoot: `/tmp/controls-${name}`, agyPath: `/controls/${name}/agy` })
  const selection = { backendId: "codex-acp", modelId: "explicit-model", overrides: { modeId: "agent", configValues: { reasoning_effort: "low" } } }
  return { protocol: "agency-controls-acceptance/1", approval: "pending", source: { revision: "d".repeat(40), sourceDigest: "e".repeat(64), distDigest: "f".repeat(64), nodeVersion: "v24.13.0" },
    observedHosts: { laptop: host("a", "darwin"), a: host("b", "linux"), b: host("c", "linux") },
    deployment: { laptop: deployment("laptop"), a: deployment("a"), b: deployment("b") }, settings: { supervisor: selection, worker: selection },
    commands: Object.fromEntries(["start", "delegate", "supervisorSubmission", "workerSubmission", "permissionA", "permissionB", "publish", "report", "integrate", "stopSupervisor", "stopWorker", "shutdown"].map(key => [key, randomUUID()])),
    prompts: { supervisor: "Delegate one child; await its report.", worker: "Request approval, edit, publish and report once." }, promptBudget: 2,
    permission: { outsideFile: "/controls/b/outside.txt", deciders: ["a", "b"] },
    git: { sourceRepository: "/controls/b/repository", remote: "/controls/b/exchange.git", fetchUrl: "ssh://controls-c/controls/b/exchange.git", destinationCwd: "/controls/laptop/destination", destinationRef: "refs/heads/controls-acceptance", publicationRef: "allocated-attempt", strategy: "merge", validations: [["node", "--test"]], publicationCount: 2, branchMovement: true },
    editors: { a: "/tmp/controls-a/editor.sock", b: "/tmp/controls-b/editor.sock" },
    cleanup: { stopSupervisor: true, stopWorker: true, closeOwnedEditors: true, stopOwnedCoordinator: true, readbackPasses: 2, retainGitEvidence: true },
    authority: { ssh: true, install: true, prompts: true, remoteEditors: true, publication: true, integration: true, scopedStops: true, restartExistingHandlers: false, restore: false, reboot: false, retire: false }, evidenceRoot: "/controls/evidence" }
}

test("controls acceptance proposal pins live scope without changing the transport schema", () => {
  const input = plan()
  assert.deepEqual(parseControlsAcceptancePlan(input), input)
})

for (const change of ["approved", "budget", "duplicate-command", "missing-host", "duplicate-host", "runtime", "missing-model", "source", "wildcard-ref", "unscoped-destination", "worker-validation", "extra-publication", "restore", "retire", "restart-existing", "unscoped-cleanup", "existing-install", "unknown"] as const) test(`controls acceptance refuses ${change}`, () => {
  const input: any = plan()
  if (change === "approved") input.approval = "approved"
  if (change === "budget") input.promptBudget = 3
  if (change === "duplicate-command") input.commands.integrate = input.commands.publish
  if (change === "missing-host") delete input.observedHosts.b
  if (change === "duplicate-host") input.observedHosts.b.hostId = input.observedHosts.a.hostId
  if (change === "runtime") input.source.nodeVersion = "v22.0.0"
  if (change === "missing-model") delete input.settings.worker.modelId
  if (change === "source") input.source.revision = "master"
  if (change === "wildcard-ref") input.git.publicationRef = "refs/heads/*"
  if (change === "unscoped-destination") input.git.destinationRef = "HEAD"
  if (change === "worker-validation") input.git.validations = ["sh -c worker-supplied"]
  if (change === "extra-publication") input.git.publicationCount = 3
  if (change === "restore") input.authority.restore = true
  if (change === "retire") input.authority.retire = true
  if (change === "restart-existing") input.authority.restartExistingHandlers = true
  if (change === "unscoped-cleanup") input.cleanup.stopAll = true
  if (change === "existing-install") input.deployment.b.agyPath = input.observedHosts.b.agyPath
  if (change === "unknown") input.execute = true
  assert.throws(() => parseControlsAcceptancePlan(input), /INVALID_CONTROLS_ACCEPTANCE_PLAN/)
})