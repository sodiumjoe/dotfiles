import assert from "node:assert/strict"
import { chmod, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { beginProbeCapture, completeProbeCapture, DiscoveryError, initialProbeDiagnostic, parseProbeFailureDetail, probeFailureDetail, readProbeDiagnostic, retainProbeDiagnostic, PROBE_DIAGNOSTIC_TTL_MS, writeProbeDiagnostic } from "../src/catalog/diagnostics.js"
import { privateProbeDirectory } from "../src/catalog/probes.js"
import { syntheticProbeFixture } from "./catalog-support.js"

test("failure details preserve private machine facts behind a fixed public message", () => {
  const error = new DiscoveryError("rpc-rejection", { code: -32603, message: "private provider detail" }, "model/list")
  assert.equal(error.code, "PROBE_FAILED")
  assert.equal(error.message.includes("private provider detail"), false)
  assert.deepEqual(parseProbeFailureDetail(error.detail), { stage: "rpc-rejection", name: "Error", message: "private provider detail", code: "-32603", syscall: null, method: "model/list" })
  assert.equal(probeFailureDetail("cleanup", error), error.detail)
  assert.equal(probeFailureDetail("discovery", new Error("x".repeat(5000))).message.length, 4096)
  assert.throws(() => parseProbeFailureDetail({ ...error.detail, stage: "unknown" }))
  assert.throws(() => parseProbeFailureDetail({ ...error.detail, extra: true }))
})

test("private diagnostic reads require exact attempt binding, safe files and closed fields", async t => {
  const f = await syntheticProbeFixture(t), meta = f.request.meta
  const work = await privateProbeDirectory(f.catalog, "work")
  await privateProbeDirectory(work, meta.attemptId, true)
  const diagnostic = initialProbeDiagnostic(meta, 1000), path = join(meta.workPath, "diagnostic.json")
  await writeProbeDiagnostic(meta.workPath, diagnostic)
  assert.deepEqual(await readProbeDiagnostic(meta), diagnostic)
  for (const value of [{ ...diagnostic, commandId: "wrong" }, { ...diagnostic, fingerprint: "b".repeat(64) }, { ...diagnostic, finishedAt: 999 }, { ...diagnostic, extra: true }, { ...diagnostic, workerTerminal: { code: 1, signal: "secret" } }]) {
    await writeFile(path, JSON.stringify(value))
    await assert.rejects(readProbeDiagnostic(meta))
  }
  await writeFile(path, JSON.stringify(diagnostic))
  await chmod(path, 0o644)
  await assert.rejects(readProbeDiagnostic(meta))
  await chmod(path, 0o600)
  const { unlink } = await import("node:fs/promises")
  const outside = join(f.root, "outside.json")
  await writeFile(outside, JSON.stringify(diagnostic), { mode: 0o600 })
  await unlink(path); await symlink(outside, path)
  await assert.rejects(readProbeDiagnostic(meta))
  assert.equal(await readFile(outside, "utf8"), JSON.stringify(diagnostic))
})

test("diagnostic age starts at completion and incomplete captures never expire", async t => {
  const f = await syntheticProbeFixture(t), initial = initialProbeDiagnostic(f.request.meta, 1000), failed = { ...initial, failed: true, firstFailure: probeFailureDetail("discovery", new Error("fixture")), finishedAt: 2000, stderrComplete: true }
  assert.equal(retainProbeDiagnostic(failed, 2000 + PROBE_DIAGNOSTIC_TTL_MS - 1), true)
  assert.equal(retainProbeDiagnostic(failed, 2000 + PROBE_DIAGNOSTIC_TTL_MS), false)
  assert.equal(retainProbeDiagnostic(failed, 1999), true)
  assert.equal(retainProbeDiagnostic(initial, 2000 + PROBE_DIAGNOSTIC_TTL_MS), true)
  assert.equal(retainProbeDiagnostic({ ...failed, stderrComplete: false }, 2000 + PROBE_DIAGNOSTIC_TTL_MS), true)
  assert.equal(retainProbeDiagnostic({ ...failed, failed: false, firstFailure: null }, 2000), false)
})

test("pending capture markers require private files and exact attempt binding", async t => {
  const f = await syntheticProbeFixture(t), meta = f.request.meta
  const work = await privateProbeDirectory(f.catalog, "work")
  await privateProbeDirectory(work, meta.attemptId, true)
  const diagnostic = { ...initialProbeDiagnostic(meta, 1000), finishedAt: 2000, stderrComplete: true }
  await writeProbeDiagnostic(meta.workPath, diagnostic)
  await beginProbeCapture(meta.workPath, diagnostic)
  const path = join(meta.workPath, "capture-pending.json"), marker = JSON.parse(await readFile(path, "utf8"))
  assert.equal((await readProbeDiagnostic(meta))!.stderrComplete, false)
  for (const value of [{ ...marker, commandId: "wrong" }, { ...marker, handlerGeneration: "wrong" }, { ...marker, extra: true }]) {
    await writeFile(path, JSON.stringify(value))
    await assert.rejects(readProbeDiagnostic(meta))
  }
  await writeFile(path, JSON.stringify(marker)); await chmod(path, 0o644)
  await assert.rejects(readProbeDiagnostic(meta))
  await chmod(path, 0o600); await completeProbeCapture(meta.workPath)
  assert.deepEqual(await readProbeDiagnostic(meta), diagnostic)
})