import type { SpawnSyncReturns } from "node:child_process"
import { readFile } from "node:fs/promises"
import { runTests } from "./test-run.js"
import { fileURLToPath } from "node:url"

export const deterministicFiles = [
  "acp-core.test.js",
  "acp-protocol.test.js",
  "acp-request-log.test.js",
  "acp-wire.test.js",
  "agent-attachment-cli.test.js",
  "agent-attachment-protocol.test.js",
  "agent-attachment-server.test.js",
  "agent-cli.test.js",
  "agent-contracts.test.js",
  "agent-conversation.test.js",
  "agent-human-cli.test.js",
  "agent-human-controls.test.js",
  "agent-process.test.js",
  "agent-production-contracts.test.js",
  "agent-queries.test.js",
  "agent-service.test.js",
  "agent-session-controls.test.js",
  "agent-store.test.js",
  "agent-turns.test.js",
  "agent-types.test.js",
  "agent-v3.test.js",
  "architecture-boundaries.test.js",
  "backend-config.test.js",
  "bridge-paging.test.js",
  "bridge-protocol.test.js",
  "bridge-ssh.test.js",
  "catalog-cli.test.js",
  "catalog-cleanup.test.js",
  "catalog-config.test.js",
  "catalog-diagnostics.test.js",
  "catalog-drivers.test.js",
  "catalog-service.test.js",
  "catalog-store.test.js",
  "catalog-types.test.js",
  "catalog-worker.test.js",
  "contracts.test.js",
  "control-protocol.test.js",
  "editor-routing.test.js",
  "entry-cli.test.js",
  "entry-editor.test.js",
  "handler-history.test.js",
  "handler-inventory.test.js",
  "handler-mutations.test.js",
  "handler-shutdown.test.js",
  "handler-termination.test.js",
  "host-human-cli.test.js",
  "host-inventory.test.js",
  "host-router.test.js",
  "host-runtime.test.js",
  "host-session-cli.test.js",
  "host-session.test.js",
  "linux-platform.test.js",
  "live-process.test.js",
  "native-sessions.test.js",
  "paths.test.js",
  "permission-arbiter.test.js",
  "permission-write.test.js",
  "private-state.test.js",
  "reconcile.test.js",
  "run-scope.test.js",
  "runtime-bridge.test.js",
  "runtime-entry.test.js",
  "startup-lock-errors.test.js",
  "task-cli.test.js",
  "task-client.test.js",
  "task-endpoint.test.js",
  "task-mcp.test.js",
  "task-observation.test.js",
  "task-service.test.js",
  "task-store.test.js",
  "task-wait.test.js",
  "test-groups.test.js",
]
export const nativeFiles = [
  "acp-endpoint.test.js",
  "acp-fixtures.test.js",
  "acp-neovim.test.js",
  "acp-permissions.test.js",
  "acp-router.test.js",
  "agent-acp.test.js",
  "agent-environment.test.js",
  "agent-import.test.js",
  "agent-protocol.test.js",
  "bridge-bootstrap.test.js",
  "catalog-probes.test.js",
  "catalog-protocol.test.js",
  "catalog-recovery.test.js",
  "codex-acceptance.test.js",
  "control-cli.test.js",
  "darwin-identity.test.js",
  "darwin-platform.test.js",
  "fixture-channel.test.js",
  "run-boundary.test.js",
  "test-run.test.js",
  "git-worktree.test.js",
  "handler-agents.test.js",
  "handler-attachment.test.js",
  "handler-catalog.test.js",
  "handler-control-plane.test.js",
  "handler-daemon.test.js",
  "handler-host-controls.test.js",
  "handler-host-sessions.test.js",
  "handler-local-controls.test.js",
  "handler-retention.test.js",
  "handler-tasks.test.js",
  "neovim-acp.test.js",
  "owned-child.test.js",
  "permission-isolation.test.js",
  "qualification-config.test.js",
  "qualification-routes.test.js",
  "qualification-tasks.test.js",
  "singleton-ownership.test.js",
  "singleton.test.js",
]
export const stressNames = [
  "selects one generation across 32 contenders and reconciles all records before readiness",
  "converges 32 real lockf contenders and replaces an exactly dead Handler before retained classification",
  "32 concurrent clients select one real generation and observe the same readiness boundary",
]
export const stressFiles = ["singleton.test.js", "darwin-platform.test.js", "handler-control-plane.test.js"]
export const stressPattern = "^(?:" + stressNames.join("|") + ")$"
export type TestGroup = "deterministic" | "native" | "stress" | "all"
export function testFiles(group: TestGroup): string[] {
  return [...(group === "deterministic" ? deterministicFiles : group === "native" ? nativeFiles : group === "stress" ? stressFiles : [...deterministicFiles, ...nativeFiles])]
}
export function testArguments(group: TestGroup): string[] {
  const files = testFiles(group)
  const filter = group === "stress" ? ["--test-name-pattern=" + stressPattern] : group === "all" ? [] : ["--test-skip-pattern=" + stressPattern]
  return ["--import=" + new URL("../test/fixtures/run-boundary.js", import.meta.url).href, "--test", "--test-concurrency=1", ...filter, ...files.map(file => "dist/test/" + file)]
}
export function testExitCode(result: Pick<SpawnSyncReturns<Buffer>, "status" | "signal" | "error">): number {
  return result.error || result.signal ? 1 : result.status ?? 1
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const group = process.argv[2]
  if (!["deterministic", "native", "stress", "all"].includes(group ?? "")) throw new Error("Expected deterministic, native, stress, or all")
  const cwd = fileURLToPath(new URL("../../", import.meta.url))
  const manifest = JSON.parse(await readFile(new URL("../build-manifest.json", import.meta.url), "utf8"))
  const run = await runTests({ group: group as TestGroup, command: [process.execPath, ...testArguments(group as TestGroup)],
    workerFiles: testFiles(group as TestGroup).map(file => "dist/test/" + file), cwd, revision: manifest.sourceRevision,
    ...(process.env.AGENCY_TEST_EVIDENCE_PARENT ? { evidenceParent: process.env.AGENCY_TEST_EVIDENCE_PARENT } : {}) })
  process.stderr.write("test result: " + run.root + "/result.json (" + run.result.state + ")\n")
  process.exitCode = run.code
}