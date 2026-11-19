import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { runTests } from "./test-run.js"

export type TestGroup = "workflows"
const files = ["models", "live-requests", "live-restore", "live-roster", "live-settings", "live-acp", "live-remote", "live-cli", "live-handoff", "editor-contract", "index-migration", "agent-index", "event-log", "session-files", "parent-watch", "live-state", "agent-startup", "agent-process", "claude-provider", "acp-startup-updates", "acp-endpoint", "acp-permissions", "input-json", "live-process", "turns", "build-digest", "restart", "excerpt", "host-router", "host-inventory", "remote-rosters", "remote-requests", "remote-listing", "pay-listing", "attention", "entry-editor", "delegation-outbox", "delegation-recorder", "delegation-checkout"]
const workerFiles = files.map(file => "dist/test/" + file + ".test.js")
const cwd = fileURLToPath(new URL("../../", import.meta.url))
const manifest = JSON.parse(await readFile(new URL("../build-manifest.json", import.meta.url), "utf8"))
const run = await runTests({ group: "workflows", cwd, workerFiles, revision: manifest.sourceRevision,
  command: [process.execPath, "--import=" + new URL("../test/fixtures/run-boundary.js", import.meta.url).href, "--test", "--test-concurrency=1", ...workerFiles],
  ...(process.env.AGENCY_TEST_EVIDENCE_PARENT ? { evidenceParent: process.env.AGENCY_TEST_EVIDENCE_PARENT } : {}) })
process.stderr.write("test result: " + run.root + "/result.json (" + run.result.state + ")\n")
process.exitCode = run.code