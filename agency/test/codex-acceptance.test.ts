import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { parseCodexAcceptanceReport, runCodexAcceptance, type AcceptanceLifecycle } from "../scripts/accept-codex.js"
import { productionLaunchContracts } from "../src/agent/contracts.js"
import { launchEnvironmentDigest } from "../src/agent/environment.js"
import { agentHandlerFixture } from "./agent-support.js"

async function fixture(t: Parameters<typeof agentHandlerFixture>[0], failure = "") {
  const handler = await agentHandlerFixture(t), environments: Record<string, string>[] = [], steps: string[] = []
  await writeFile(join(handler.git.root, "package.json"), JSON.stringify({ name: "@moon/agency", engines: { node: "24.13.0" } }))
  let snapshots = 0, prompts = 0, stops = 0
  const lifecycle: AcceptanceLifecycle = {
    cwd: () => handler.git.root,
    snapshot: () => { const value = { ...process.env, ACCEPTANCE_SNAPSHOT: String(++snapshots), SECRET_TOKEN: "must-not-appear" } as Record<string, string>; environments.push(value); return value },
    async start(cwd, _environment) { steps.push("start"); return handler.waitCompleted(await handler.startAt(cwd)) },
    async prompt(target, text) { steps.push("prompt"); prompts++; if (failure === `prompt-${prompts}`) throw new Error(failure); return handler.prompt(target, text) },
    async stop(target) { steps.push("stop"); stops++; if (failure === `stop-${stops}`) throw new Error(failure); return handler.waitCompleted(await handler.stop(target)) },
    async restore(agentId, _environment) { steps.push("restore"); if (failure === "restore") throw new Error(failure); return handler.waitCompleted(await handler.restore(agentId)) },
    list: () => handler.list(),
  }
  return { handler, lifecycle, environments, steps }
}

test("diagnostic acceptance uses the ordinary lifecycle without creating authority", async t => {
  const f = await fixture(t), contracts = JSON.stringify(productionLaunchContracts()), config = await readFile(f.handler.configPath)
  const result = await runCodexAcceptance({ evidenceParent: f.handler.root }, f.lifecycle), report = parseCodexAcceptanceReport(result.report)
  assert.equal(report.success, true)
  assert.equal(report.failure, null)
  assert.deepEqual(report.steps, ["start", "prompt", "stop", "restore", "prompt", "stop"])
  assert.deepEqual(f.steps.slice(0, 6), report.steps)
  assert.equal(report.first!.sessionId, report.restored!.sessionId)
  assert.equal(report.first!.agentId, report.restored!.agentId)
  assert.notEqual(report.first!.providerGeneration, report.restored!.providerGeneration)
  assert.equal(f.environments.length, 2)
  assert.equal(report.startEnvironmentDigest, launchEnvironmentDigest(f.environments[0]!))
  assert.equal(report.restoreEnvironmentDigest, launchEnvironmentDigest(f.environments[1]!))
  assert.equal(JSON.stringify(report).includes("must-not-appear"), false)
  assert.equal(report.cleanup.length, 2)
  assert.ok(report.cleanup.every(entry => entry.cleanup === "verified" && entry.processGroupId > 1))
  for (const key of ["candidate", "manifest", "promotion", "registration", "sourceContract", "transientAuthorization"]) assert.equal(Object.hasOwn(report, key), false)
  assert.equal(JSON.stringify(productionLaunchContracts()), contracts)
  assert.deepEqual(await readFile(f.handler.configPath), config)
  assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")), report)
})

test("diagnostic acceptance rejects restored session discontinuity", async t => {
  const f = await fixture(t), restore = f.lifecycle.restore
  f.lifecycle.restore = async (agentId, environment) => {
    const view = structuredClone(await restore(agentId, environment))
    assert.equal(view.command.state, "completed")
    assert.ok(view.command.result?.session)
    view.command.result.session.sessionId = "different-session"
    return view
  }
  const result = await runCodexAcceptance({ evidenceParent: f.handler.root }, f.lifecycle)
  assert.equal(result.report.success, false)
  assert.notEqual(result.report.failure, null)
  assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")), result.report)
})

for (const failure of ["prompt-1", "stop-1", "restore", "prompt-2", "stop-2"])
  test(`diagnostic acceptance retains failure report for ${failure}`, async t => {
    const f = await fixture(t, failure), contracts = JSON.stringify(productionLaunchContracts()), config = await readFile(f.handler.configPath)
    const result = await runCodexAcceptance({ evidenceParent: f.handler.root }, f.lifecycle)
    assert.equal(result.report.success, false)
    assert.notEqual(result.report.failure, null)
    assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")), result.report)
    assert.equal(JSON.stringify(productionLaunchContracts()), contracts)
    assert.deepEqual(await readFile(f.handler.configPath), config)
    for (const key of ["candidate", "manifest", "promotion", "registration", "sourceContract", "transientAuthorization"]) assert.equal(Object.hasOwn(result.report, key), false)
  })