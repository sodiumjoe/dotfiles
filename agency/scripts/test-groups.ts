import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { runTests } from "./test-run.js"

export type TestGroup = "workflows"
const files = ["handler-agents", "acp-router", "acp-endpoint", "acp-permissions", "handler-host-sessions", "live-process"]
const workerFiles = files.map(file => "dist/test/" + file + ".test.js")
const cwd = fileURLToPath(new URL("../../", import.meta.url))
const manifest = JSON.parse(await readFile(new URL("../build-manifest.json", import.meta.url), "utf8"))
const run = await runTests({ group: "workflows", cwd, workerFiles, revision: manifest.sourceRevision,
  command: [process.execPath, "--import=" + new URL("../test/fixtures/run-boundary.js", import.meta.url).href, "--test", "--test-concurrency=1", ...workerFiles],
  ...(process.env.AGENCY_TEST_EVIDENCE_PARENT ? { evidenceParent: process.env.AGENCY_TEST_EVIDENCE_PARENT } : {}) })
process.stderr.write("test result: " + run.root + "/result.json (" + run.result.state + ")\n")
process.exitCode = run.code