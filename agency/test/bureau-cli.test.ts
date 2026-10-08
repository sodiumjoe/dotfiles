import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { runBureauClient } from "../src/bureau/cli.js"
import { agentHandlerFixture } from "./agent-support.js"
import { productionControlDependencies } from "../src/cli/control.js"

test("Bureau CLI enables, inspects and disables the composed service", async t => {
  const f = await agentHandlerFixture(t), output: string[] = []
  const deps = { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: process.platform === "darwin" ? (await import("../src/platform/darwin.js")).createDarwinAdapter() : (await import("../src/platform/linux.js")).createLinuxAdapter() }), stdout: (value: string) => { output.push(value) }, stderr: () => {} }
  assert.equal(await runBureauClient(["bureau", "enable", "--json"], deps), 0)
  assert.equal(JSON.parse(output.at(-1)!).result.enabled, true)
  assert.equal(await runBureauClient(["run", "list", "--json"], deps), 0)
  assert.deepEqual(JSON.parse(output.at(-1)!).result, [])
  assert.equal(await runBureauClient(["bureau", "disable", "--json"], deps), 0)
  assert.equal(JSON.parse(output.at(-1)!).result.enabled, false)
  assert.equal(await runBureauClient(["run", "start", "--command-id", randomUUID(), "--input-json", "{}"], deps), 64)
})