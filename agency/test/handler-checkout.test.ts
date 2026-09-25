import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { productionControlDependencies, runControl } from "../src/cli/control.js"
import { resolveCheckout } from "../src/checkout/identity.js"
import { readAdmission, writeAdmission } from "../src/checkout/records.js"
import { readLaunchRecordForReconciliation, writeLaunchRecord } from "../src/platform/private-state.js"
import { controlFixture, launch, until, type AdmissionFixtureOperation } from "./control-support.js"
import { gitFixture } from "./checkout-support.js"

const operation = (checkoutPath: string, action: AdmissionFixtureOperation["action"] = "reserve"): AdmissionFixtureOperation => ({ checkoutPath, action, agentId: randomUUID(), leaseId: randomUUID(), launchAttemptId: randomUUID() })
async function results(root: string): Promise<Array<{ ok: boolean; code?: string }>> { return JSON.parse(await readFile(join(root, "admission-result.json"), "utf8")) }
function client(f: Awaited<ReturnType<typeof controlFixture>>, cwd: string) {
  const out: string[] = []
  const dependencies = { ...productionControlDependencies(), environment: async () => ({ paths: f.paths, adapter: f.adapter }), cwd: () => cwd, start: async () => { assert.fail("doctor/shutdown must not start Handler") }, stdout: (value: string) => { out.push(value) }, stderr: () => undefined }
  return { run: (args: string[]) => runControl([...args, "--json"], dependencies), result: () => JSON.parse(out.at(-1)!) }
}

test("real Handler reservations appear in status and doctor; only verified cleanup permits shutdown", { timeout: 20000 }, async t => {
  const git = await gitFixture(t), op = operation(git.repo), f = await controlFixture(t, { admissionOperations: [op] })
  await f.start()
  assert.equal((await results(f.root))[0]!.ok, true)
  const status = await f.call()
  assert.ok(status.ok && "launches" in status.result)
  assert.equal(status.result.launches[0]!.launchAttemptId, op.launchAttemptId)
  const path = join(f.paths.persistentRoot, "launches", `${op.launchAttemptId}.json`)
  assert.equal((await readLaunchRecordForReconciliation(path)).phase, "launch_pending")
  assert.equal((await readAdmission(f.paths.persistentRoot, op.launchAttemptId))!.checkout.root.path, git.repo)
  const cli = client(f, git.repo)
  assert.equal(await cli.run(["doctor"]), 0)
  assert.equal(cli.result().result.checkout.admission.state, "leased")
  assert.equal(cli.result().result.checkout.authoritative, false)
  assert.equal(await cli.run(["shutdown"]), 75)
  assert.equal(cli.result().error.code, "ACTIVE_AGENTS")
  assert.equal(await cli.run(["shutdown", "--stop-agents"]), 0)
  assert.equal((await readLaunchRecordForReconciliation(path)).phase, "cleanup_verified")
})

test("abrupt Handler death releases an unattempted lease on restart without reviving its attempt", { timeout: 20000 }, async t => {
  const git = await gitFixture(t), old = operation(git.repo), fresh = operation(git.repo), f = await controlFixture(t, { admissionOperations: [old] })
  const first = await f.start()
  assert.equal((await results(f.root))[0]!.ok, true)
  const path = join(f.paths.persistentRoot, "launches", `${old.launchAttemptId}.json`)
  const metadata = await readAdmission(f.paths.persistentRoot, old.launchAttemptId)
  await f.signal(first.record.process!, "SIGKILL")
  await until(async () => await f.observe(first.record.process!.pid) === null ? true : undefined)
  assert.deepEqual(await f.adapter.readGroup(first.record.process!.pid), [])
  assert.equal(await f.observe(first.record.process!.pid), null)
  assert.equal((await readLaunchRecordForReconciliation(path)).phase, "launch_pending")
  await writeFile(f.configPath, JSON.stringify({ paths: f.paths, admissionOperations: [old, fresh] }))
  const second = await f.start()
  assert.notEqual(second.record.generation, first.record.generation)
  assert.deepEqual((await results(f.root)).map(({ ok, code }) => ({ ok, code })), [{ ok: false, code: "ATTEMPT_RELEASED" }, { ok: true, code: undefined }])
  assert.equal((await readLaunchRecordForReconciliation(path)).phase, "cleanup_verified")
  assert.deepEqual(await readAdmission(f.paths.persistentRoot, old.launchAttemptId), metadata)
  const next = await readLaunchRecordForReconciliation(join(f.paths.persistentRoot, "launches", `${fresh.launchAttemptId}.json`))
  assert.equal(next.handlerGeneration, second.record.generation)
  assert.equal(next.phase, "launch_pending")
})

test("mapped same-boot quarantine survives restart while a separate worktree admits", { timeout: 20000 }, async t => {
  const git = await gitFixture(t), denied = operation(git.repo), allowed = operation(git.linked), f = await controlFixture(t, { admissionOperations: [denied, allowed] })
  const checkout = await resolveCheckout(git.repo, f.paths.hostKey), op = operation(git.repo)
  const record = launch({ checkoutId: checkout.checkoutId, agentId: op.agentId, leaseId: op.leaseId, launchAttemptId: op.launchAttemptId, launchBootId: await f.adapter.bootId() })
  const path = join(f.paths.persistentRoot, "launches", `${record.launchAttemptId}.json`)
  await writeLaunchRecord(path, record)
  await writeAdmission(f.paths.persistentRoot, { version: 1, checkout, agentId: record.agentId, leaseId: record.leaseId, handlerGeneration: record.handlerGeneration, launchAttemptId: record.launchAttemptId })
  await f.start()
  const observed = await results(f.root)
  assert.equal(observed[0]!.code, "CHECKOUT_QUARANTINED")
  assert.equal(observed[1]!.ok, true)
  assert.equal((await readLaunchRecordForReconciliation(path)).phase, "quarantined")
  assert.ok((await f.call()).ok)
  assert.equal(await client(f, git.repo).run(["shutdown", "--stop-agents"]), 75)
})

for (const evidence of ["legacy", "orphan", "malformed"]) {
  test(`${evidence} evidence disables admission without disabling Handler status`, { timeout: 20000 }, async t => {
    const git = await gitFixture(t), op = operation(git.repo), f = await controlFixture(t, { admissionOperations: [op] })
    if (evidence === "legacy") {
      const record = launch({ launchBootId: await f.adapter.bootId() })
      await writeLaunchRecord(join(f.paths.persistentRoot, "launches", `${record.launchAttemptId}.json`), record)
    } else if (evidence === "orphan") {
      await writeAdmission(f.paths.persistentRoot, { version: 1, checkout: await resolveCheckout(git.repo, f.paths.hostKey), agentId: randomUUID(), leaseId: randomUUID(), handlerGeneration: randomUUID(), launchAttemptId: randomUUID() })
    } else {
      await mkdir(join(f.paths.persistentRoot, "admissions"), { mode: 0o700 })
      await writeFile(join(f.paths.persistentRoot, "admissions", `${randomUUID()}.json`), "{", { mode: 0o600 })
    }
    await f.start()
    assert.equal((await results(f.root))[0]!.code, "ADMISSION_UNAVAILABLE")
    assert.ok((await f.call()).ok)
    const cli = client(f, git.repo)
    assert.equal(await cli.run(["doctor"]), 0)
    assert.equal(cli.result().result.checkout.admission.state, "unavailable")
    assert.equal(await cli.run(["shutdown", "--stop-agents"]), evidence === "legacy" ? 75 : 0)
  })
}

test("real Handler cancellation retains evidence and permits ordinary shutdown", { timeout: 20000 }, async t => {
  const git = await gitFixture(t), op = operation(git.repo, "reserve_cancel"), f = await controlFixture(t, { admissionOperations: [op] })
  await f.start()
  assert.equal((await results(f.root))[0]!.ok, true)
  assert.equal((await readLaunchRecordForReconciliation(join(f.paths.persistentRoot, "launches", `${op.launchAttemptId}.json`))).phase, "cleanup_verified")
  assert.notEqual(await readAdmission(f.paths.persistentRoot, op.launchAttemptId), null)
  assert.equal(await client(f, git.repo).run(["shutdown"]), 0)
})