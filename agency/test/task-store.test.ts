import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { privateRoot } from "./control-support.js"
import { sampleTaskRecord, taskHost } from "./task-test-support.js"
import { createTaskStore } from "../src/tasks/store.js"
import { parseTaskRecord, parseTaskReport } from "../src/tasks/types.js"

test("task storage publishes private readable files and retains independent reports", async t => {
  const root = await privateRoot(t), store = createTaskStore({ root, hostId: taskHost }), record = sampleTaskRecord()
  await store.initialize()
  assert.equal(await store.read(record.ref.taskId), null)
  await store.reserve(record)
  await store.writeReport(record.ref.taskId, { outcome: "completed", summary: "verified" })
  assert.deepEqual(await store.read(record.ref.taskId), record)
  assert.deepEqual(await store.readReport(record.ref.taskId), { outcome: "completed", summary: "verified" })
  const directory = join(root, "tasks", record.ref.taskId)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(directory, "record.json"))).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(join(directory, "report.json"), "utf8")), { outcome: "completed", summary: "verified" })
  assert.deepEqual((await readdir(directory)).sort(), ["record.json", "report.json"])
})

test("exclusive reservations reject identical, concurrent and incomplete duplicates", async t => {
  const root = await privateRoot(t), store = createTaskStore({ root, hostId: taskHost }), record = sampleTaskRecord()
  await store.initialize()
  const results = await Promise.allSettled([store.reserve(record), store.reserve(record)])
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1)
  const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult
  assert.equal(failed.reason.code, "TASK_EXISTS")
  await assert.rejects(store.reserve(record), { code: "TASK_EXISTS" })
  const taskId = randomUUID()
  await mkdir(join(root, "tasks", taskId), { mode: 0o700 })
  await assert.rejects(store.read(taskId), { code: "TASK_INCOMPLETE" })
  await assert.rejects(store.reserve(sampleTaskRecord({ hostId: taskHost, taskId })), { code: "TASK_EXISTS" })
})

test("publication failure preserves the old complete file and removes temporary files", async t => {
  const root = await privateRoot(t)
  let fail = false
  const store = createTaskStore({ root, hostId: taskHost, filesystem: { rename: async (from, to) => {
    if (fail) throw new Error("injected rename failure")
    await rename(from, to)
  } } }), record = sampleTaskRecord()
  await store.initialize(); await store.reserve(record)
  await store.writeReport(record.ref.taskId, { outcome: "blocked", summary: "old" })
  fail = true
  await assert.rejects(store.writeReport(record.ref.taskId, { outcome: "completed", summary: "new" }), { code: "TASK_INCOMPLETE" })
  assert.equal((await store.readReport(record.ref.taskId))!.summary, "old")
  assert.deepEqual((await readdir(join(root, "tasks", record.ref.taskId))).sort(), ["record.json", "report.json"])
})

test("storage rejects owner/path mismatches, malformed records and missing report owners", async t => {
  const root = await privateRoot(t), store = createTaskStore({ root, hostId: taskHost }), record = sampleTaskRecord()
  await store.initialize()
  await assert.rejects(store.reserve({ ...record, ref: { ...record.ref, hostId: "b".repeat(64) } }), { code: "INVALID_INPUT" })
  await assert.rejects(store.reserve({ ...record, resultPath: "../report.json" }), { code: "INVALID_INPUT" })
  await assert.rejects(store.read("../escape"), { code: "INVALID_INPUT" })
  await assert.rejects(store.writeReport(record.ref.taskId, { outcome: "completed", summary: "missing" }), { code: "TASK_NOT_FOUND" })
  await store.reserve(record)
  await writeFile(join(root, "tasks", record.ref.taskId, "record.json"), "{")
  await assert.rejects(store.read(record.ref.taskId), { code: "TASK_INCOMPLETE" })
})

test("task validators reject transient fields, invalid identities and ill-formed Unicode", () => {
  const record = sampleTaskRecord()
  for (const field of ["environment", "text", "nativeParams", "credentials"]) {
    assert.throws(() => parseTaskRecord({ ...record, [field]: "secret" }), { code: "INVALID_INPUT" })
  }
  assert.throws(() => parseTaskRecord({ ...record, description: "\ud800" }), { code: "INVALID_INPUT" })
  assert.throws(() => parseTaskRecord({ ...record, ref: { ...record.ref, taskId: record.ref.taskId.toUpperCase() } }), { code: "INVALID_INPUT" })
  assert.throws(() => parseTaskReport({ outcome: "completed", summary: "" }), { code: "INVALID_INPUT" })
  assert.throws(() => parseTaskReport({ outcome: "completed", summary: "ok", git: { repository: "/repo", baseOid: "a".repeat(40), resultOid: "b".repeat(64) } }), { code: "INVALID_INPUT" })
  assert.throws(() => parseTaskReport({ outcome: "completed", summary: "ok", issues: Array(129).fill("issue") }), { code: "INVALID_INPUT" })
})

test("serialized report limits count escaped UTF-8 bytes and allow the maximum complete report", async t => {
  const root = await privateRoot(t), store = createTaskStore({ root, hostId: taskHost }), record = sampleTaskRecord()
  await store.initialize(); await store.reserve(record)
  const header = Buffer.byteLength(JSON.stringify({ outcome: "completed", summary: "" }))
  const summary = "🌑" + "\"".repeat(Math.floor((256 * 1024 - header - 4) / 2))
  const report = { outcome: "completed" as const, summary }
  assert.equal(Buffer.byteLength(JSON.stringify(report)), 256 * 1024)
  await store.writeReport(record.ref.taskId, report)
  assert.deepEqual(await store.readReport(record.ref.taskId), report)
  await assert.rejects(store.writeReport(record.ref.taskId, { ...report, summary: summary + "x" }), { code: "INPUT_TOO_LARGE" })
  assert.throws(() => parseTaskRecord({ ...record, description: "é".repeat(8193) }), { code: "INPUT_TOO_LARGE" })
})

test("per-task serialization survives rejection and isolates different task queues", async t => {
  const root = await privateRoot(t), store = createTaskStore({ root, hostId: taskHost }), first = randomUUID(), second = randomUUID()
  const gate = Promise.withResolvers<void>(), events: string[] = []
  const held = store.serialize(first, async () => { events.push("held"); await gate.promise; throw new Error("failure") })
  const rejected = assert.rejects(held, /failure/)
  const next = store.serialize(first, async () => { events.push("next") })
  await store.serialize(second, async () => { events.push("other") })
  assert.deepEqual(events, ["held", "other"])
  gate.resolve(); await rejected; await next
  assert.deepEqual(events, ["held", "other", "next"])
})