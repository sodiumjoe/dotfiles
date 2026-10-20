import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { historyDiagnostic, incompleteHistory } from "../src/handler/history.js"
import { privateRoot } from "./control-support.js"

for (const malformed of [false, true]) test(`historical retirement diagnostic is read-only with ${malformed ? "malformed" : "partial"} evidence`, async t => {
  const root = await privateRoot(t), marker = join(root, "retention/pending.json")
  await mkdir(join(root, "retention"), { mode: 0o700 })
  const bytes = malformed ? "{" : JSON.stringify({ version: 1, entries: [{ path: "agents/records/saved.json" }, { path: "catalog/work/old" }] })
  await writeFile(marker, bytes, { mode: 0o600 })
  const diagnose = await historyDiagnostic(root)
  assert.match(diagnose("agents/records/saved.json")!, /INCOMPLETE_HISTORY/)
  assert.match(diagnose("catalog/work/old/missing")!, /INCOMPLETE_HISTORY/)
  assert.equal(diagnose("agents/records/fresh.json") === null, !malformed)
  assert.equal(await readFile(marker, "utf8"), bytes)
})

test("missing retirement intent leaves historical reads available", async t => {
  assert.equal(await incompleteHistory(await privateRoot(t), "agents/records/saved.json"), null)
})