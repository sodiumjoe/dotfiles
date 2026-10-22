import assert from "node:assert/strict"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { readAcpRequestLog } from "./acp-support.js"

async function requestLog(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-request-log-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, "requests.jsonl")
}

test("missing request log has no observed frames", async t => {
  assert.deepEqual(await readAcpRequestLog(await requestLog(t)), [])
})

test("empty request log has no observed frames", async t => {
  const path = await requestLog(t)
  await writeFile(path, "")
  assert.deepEqual(await readAcpRequestLog(path), [])
})

test("complete request log preserves frame order", async t => {
  const path = await requestLog(t)
  await writeFile(path, '{"method":"first"}\n{"method":"second"}\n')
  assert.deepEqual(await readAcpRequestLog(path), [{ method: "first" }, { method: "second" }])
})

test("valid JSON without a newline is not an observed frame", async t => {
  const path = await requestLog(t)
  await writeFile(path, '{"method":"first"}')
  assert.deepEqual(await readAcpRequestLog(path), [])
})

test("partial-only request log has no observed frames", async t => {
  const path = await requestLog(t)
  await writeFile(path, '{"method":"first')
  assert.deepEqual(await readAcpRequestLog(path), [])
})

test("complete frames remain observable before a partial record", async t => {
  const path = await requestLog(t)
  await writeFile(path, '{"method":"first"}\n{"method":"second')
  assert.deepEqual(await readAcpRequestLog(path), [{ method: "first" }])
})

test("appending the newline-completed suffix makes the next frame observable", async t => {
  const path = await requestLog(t)
  await writeFile(path, '{"method":"first"}\n{"method":"second')
  assert.deepEqual(await readAcpRequestLog(path), [{ method: "first" }])
  await appendFile(path, '"}\n')
  assert.deepEqual(await readAcpRequestLog(path), [{ method: "first" }, { method: "second" }])
})

test("malformed completed request record rejects", async t => {
  const path = await requestLog(t)
  await writeFile(path, '{"method":}\n')
  await assert.rejects(readAcpRequestLog(path), SyntaxError)
})

test("completed blank record rejects after a valid frame", async t => {
  const path = await requestLog(t)
  await writeFile(path, '{"method":"first"}\n\n')
  await assert.rejects(readAcpRequestLog(path), SyntaxError)
})

test("directory read failure propagates", async t => {
  const path = await requestLog(t)
  await assert.rejects(readAcpRequestLog(join(path, "..")), { code: "EISDIR" })
})