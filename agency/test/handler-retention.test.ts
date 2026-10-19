import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createCatalogStore } from "../src/catalog/store.js"
import { controlFixture } from "./control-support.js"

test("startup preserves pending retirement without replaying deletion", { timeout: 20000 }, async t => {
  const f = await controlFixture(t), generation = randomUUID(), snapshotId = randomUUID()
  const store = createCatalogStore(f.paths.persistentRoot)
  await store.writeSnapshot({ version: 1, hostId: f.paths.hostKey, handlerGeneration: generation, snapshotId, createdAt: 100, providers: [] })
  const retainedPath = join(f.paths.persistentRoot, "catalog/snapshots", snapshotId + ".json")
  const marker = join(f.paths.persistentRoot, "retention/pending.json")
  await mkdir(join(f.paths.persistentRoot, "retention"), { mode: 0o700 })
  await writeFile(marker, JSON.stringify({ version: 1, hostId: f.paths.hostKey, handlerGeneration: generation, intentId: randomUUID(), entries: [{ path: "catalog/snapshots/" + snapshotId + ".json" }] }), { mode: 0o600 })
  const bytes = await readFile(marker), retained = await readFile(retainedPath)
  await f.start()
  assert.deepEqual(await readFile(marker), bytes)
  assert.deepEqual(await readFile(retainedPath), retained)
})