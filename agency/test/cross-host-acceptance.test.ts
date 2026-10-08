import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { parseCrossHostConfig, parseCrossHostArguments } from "../scripts/accept-cross-host.js"

function configuration() {
  const host = (name: string, platform: "darwin" | "linux") => ({ inventoryId: randomUUID(), hostId: name.repeat(64), handlerGeneration: randomUUID(), hostname: `acceptance-${name}`, agyPath: "/opt/agency/agy", nodePath: "/opt/node/bin/node", loginShell: "/bin/bash", cwd: "/workspace", platform, sourceRevision: "a".repeat(40), sourceDigest: "b".repeat(64), distDigest: "c".repeat(64), nodeVersion: "v24.13.0" })
  const hosts = { laptop: host("a", "darwin"), a: host("b", "linux"), b: host("c", "linux") }
  return { protocol: "agency-cross-host-config/1", hosts, settings: { supervisor: { backendId: "codex-acp", modelId: "explicit-model", overrides: { modeId: "read-only", configValues: { reasoning_effort: "low" } } }, worker: { backendId: "codex-acp", modelId: "explicit-model", overrides: { modeId: "read-only", configValues: { reasoning_effort: "low" } } } }, commands: { start: randomUUID(), delegate: randomUUID(), wait: randomUUID(), report: randomUUID(), supervisorSubmission: randomUUID(), stopSupervisor: randomUUID(), stopWorker: randomUUID() }, prompts: { supervisor: "Delegate exactly one worker on B, wait for its report, and finish.", worker: "Return one completed report. Do not delegate." }, promptBudget: 2, git: null, editor: { socketPath: "/private/editor.sock", detach: true, reattach: true }, interruption: { host: "b", count: 1 }, cleanup: { stopSupervisor: true, stopWorker: true, readbackPasses: 2 }, authority: { ssh: true, prompts: true, scopedStops: true, editorRouting: true, bridgeInterruption: true, install: false, restore: false, reboot: false, push: false }, evidenceRoot: "/private/agency-evidence" }
}

test("cross-host configuration retains exact hosts, settings, budgets and stable command IDs", () => {
  const input = configuration()
  assert.deepEqual(parseCrossHostConfig(input), input)
  assert.deepEqual(parseCrossHostArguments(["--check", "--config", "/private/acceptance.json"]), { configPath: "/private/acceptance.json", check: true })
})

for (const change of ["missing-target", "duplicate-host", "missing-settings", "duplicate-command", "extra-prompt", "missing-prompt", "runtime", "revision", "missing-authority", "restore", "reboot", "push", "missing-editor", "extra-interruption", "unscoped-cleanup", "git-publication", "unknown"] as const) test(`cross-host parser rejects ${change} without supplying defaults`, () => {
  const value: any = configuration()
  if (change === "missing-target") delete value.hosts.b
  if (change === "duplicate-host") value.hosts.b.hostId = value.hosts.a.hostId
  if (change === "missing-settings") delete value.settings.worker.modelId
  if (change === "duplicate-command") value.commands.report = value.commands.delegate
  if (change === "extra-prompt") value.promptBudget = 3
  if (change === "missing-prompt") value.prompts.worker = ""
  if (change === "runtime") value.hosts.b.nodeVersion = "v22.0.0"
  if (change === "revision") value.hosts.b.sourceRevision = "d".repeat(40)
  if (change === "missing-authority") delete value.authority.ssh
  if (["restore", "reboot", "push"].includes(change)) value.authority[change] = true
  if (change === "missing-editor") value.editor.reattach = false
  if (change === "extra-interruption") value.interruption.count = 2
  if (change === "unscoped-cleanup") value.cleanup.stopAllAgents = true
  if (change === "git-publication") value.git = { push: true }
  if (change === "unknown") value.discoverTargets = true
  assert.throws(() => parseCrossHostConfig(value), /INVALID_CROSS_HOST_CONFIG/)
})

for (const argv of [[], ["--config", "/private/a.json"], ["--check", "--config", "relative.json"], ["--check", "--config", "/private/a.json", "--check"], ["--check", "--config", "/private/a.json", "--execute"]]) test(`cross-host CLI rejects unreviewed invocation ${JSON.stringify(argv)}`, () => {
  assert.throws(() => parseCrossHostArguments(argv), /INVALID_CROSS_HOST_ARGUMENTS/)
})