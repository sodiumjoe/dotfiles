import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdtemp, mkdir, open, rename, rm, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestContext } from "node:test"
import { createJournal } from "../src/orchestration/journal.js"
import { createBureauStore } from "../src/bureau/store.js"
import { createLineageStore } from "../src/orchestration/lineage.js"
import type { StorageFileSystem } from "../src/orchestration/storage.js"

export async function coreFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-orchestration-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  let lastRename = ""
  let time = 1000, fault: { operation: string; match: string; after: boolean } | null = null
  const trip = (operation: string, path: string, after: boolean) => {
    if (fault?.operation !== operation || !path.includes(fault.match) || fault.after !== after) return
    fault = null
    throw Object.assign(new Error("ENOSPC injected " + operation), { code: "ENOSPC" })
  }
  const filesystem: StorageFileSystem = {
    mkdir,
    async open(path, flags, mode) {
      trip("open", path, false)
      const handle = await open(path, flags, mode)
      return new Proxy(handle, { get(target, key) {
        if (key === "writeFile" || key === "sync") return async (...args: unknown[]) => {
          const operation = key === "writeFile" ? "write" : (flags & constants.O_DIRECTORY) ? "directory-sync" : "file-sync"
          if (operation === "directory-sync" && lastRename.endsWith("/checkpoint.json")) trip("checkpoint-sync", path, false)
          trip(operation, path, false)
          const result = await (target[key] as (...values: unknown[]) => Promise<unknown>).apply(target, args)
          trip(operation, path, true)
          if (operation === "directory-sync" && lastRename.endsWith("/checkpoint.json")) trip("checkpoint-sync", path, true)
          return result
        }
        const value = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      } })
    },
    async rename(from, to) { trip("rename", String(to), false); await rename(from, to); lastRename = String(to); trip("rename", String(to), true) },
    async rm(path, options) { trip("remove", String(path), false); await rm(path, options); trip("remove", String(path), true) }
  }
  const agent = { hostId: "a".repeat(64), agentId: randomUUID() }
  const input = { eventId: randomUUID(), runId: randomUUID(), assignmentId: randomUUID(), agent, report: { status: "completed" as const, summary: "Finished\nChecks passed.", issues: [], validation: [], git: null } }
  let journal = createJournal(root, filesystem, () => time)
  const store = createBureauStore(root, filesystem), lineage = createLineageStore(root, filesystem)
  return {
    root, input, filesystem, store, lineage,
    get journal() { return journal },
    clock: { advance(ms: number) { time += ms }, now: () => time },
    failAt(operation: string, match = "", after = false) { fault = { operation, match, after } },
    restart() { fault = null; journal = createJournal(root, filesystem, () => time) }
  }
}