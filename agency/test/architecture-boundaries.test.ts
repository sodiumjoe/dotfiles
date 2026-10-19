import assert from "node:assert/strict"
import test from "node:test"
import { access, readdir, readFile, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { privateRoot } from "./control-support.js"

async function assertNoLegacyImports(root: URL, extension: string) {
  for (const path of await readdir(root, { recursive: true })) {
    if (!path.endsWith(extension)) continue
    const source = await readFile(new URL(path, root), "utf8")
    assert.doesNotMatch(source, /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'][^"']*(?:bureau|orchestration)\//, path)
    assert.doesNotMatch(source, /\b(?:startTaskServices|createHostCoordination|AgentLaunchHooks|orchestrationSnapshot|loadOrchestrationPins|prepareAdmission|outboxCursor)\b/, path)
  }
}

test("production modules have no legacy coordination imports, adapters or directories", async () => {
  for (const root of [new URL("../../src/", import.meta.url), new URL("../src/", import.meta.url)]) {
    const extension = root.pathname.includes("/dist/") ? ".js" : ".ts"
    for (const path of ["bureau", "orchestration", ...["host-coordination", "task-services"].map(name => "handler/" + name + extension), ...["invocation", "remote", "replay", "task-server", "task-ssh"].map(name => "bridge/" + name + extension)]) {
      await assert.rejects(access(new URL(path, root)), { code: "ENOENT" })
    }
    await assertNoLegacyImports(root, extension)
  }
})

test("the import guard detects forbidden dependencies and permits current task imports", async t => {
  const root = await privateRoot(t), url = pathToFileURL(root + "/")
  for (const source of ['import {x} from "../bureau/service.js"', 'import("../orchestration/service.js")', 'import "../bureau/service.js"']) {
    await writeFile(join(root, "probe.ts"), source)
    await assert.rejects(assertNoLegacyImports(url, ".ts"))
  }
  await writeFile(join(root, "probe.ts"), 'import {x} from "../tasks/service.js"')
  await assertNoLegacyImports(url, ".ts")
})

function assertNoHistoricalImports(source: string): void {
  assert.doesNotMatch(source, /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'][^"']*\/(?:reconcile|inventory)(?:\.js)?["']/)
}

test("live child owners do not import historical reconciliation or inventory", async () => {
  for (const root of [new URL("../../src/", import.meta.url), new URL("../src/", import.meta.url)]) {
    const extension = root.pathname.includes("/dist/") ? ".js" : ".ts"
    for (const path of ["agent/process", "runtime/owned-child", "platform/live-process"]) {
      assertNoHistoricalImports(await readFile(new URL(path + extension, root), "utf8"))
    }
  }
})

test("live ownership guard rejects sibling, dynamic and side-effect historical imports", () => {
  for (const source of ['import { x } from "./reconcile.js"', 'import("../handler/inventory.js")', 'import "./inventory.js"']) {
    assert.throws(() => assertNoHistoricalImports(source))
  }
  assertNoHistoricalImports('import { x } from "../platform/live-process.js"')
})