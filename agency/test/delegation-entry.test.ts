import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { normalizeRemote } from "../src/delegation/checkout.js"
import type { Coordinator, DelegateRequest } from "../src/delegation/coordinator.js"
import { createDelegateEntry } from "../src/delegation/entry.js"
import { createOutboxStore } from "../src/delegation/outbox.js"
import type { LiveCore } from "../src/live/core.js"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim()
const CALLER = "11111111-1111-4111-8111-111111111111", HOST = "a".repeat(64)

async function setup(t: { after(fn: () => Promise<void>): void }, options: { laptop?: boolean; owners?: number; depth?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agency-entry-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, "repo"), outside = join(root, "outside")
  await mkdir(join(repo, "sub", "dir"), { recursive: true }); await mkdir(outside)
  git(repo, "init", "-q"); git(repo, "remote", "add", "origin", "git@github.com:acme/repo.git")
  const outbox = createOutboxStore(join(root, "state"))
  if (options.depth !== undefined) await outbox.create({ childId: CALLER, parent: { hostId: "b".repeat(64), agentId: "22222222-2222-4222-8222-222222222222" }, depth: options.depth, ref: "main" })
  const calls: DelegateRequest[] = [], upward: unknown[] = []
  const coordinator: Coordinator = { handle: async request => { calls.push(request); return { state: "coordinated" } }, changed: () => undefined, tick: () => undefined }
  const core = { liveAgents: () => [{ agentId: CALLER, phase: "ready" }] } as unknown as LiveCore
  const entry = createDelegateEntry({ core, outbox, hostId: HOST, isLaptop: () => options.laptop ?? true, coordinator, upward: async payload => { upward.push(payload); return { ok: true, result: { state: "forwarded" } } }, owners: () => options.owners ?? 0 })
  return { repo, outside, entry, calls, upward }
}
const start = (cwd: string, callerAgentId = CALLER) => ({ op: "delegate" as const, action: "start" as const, callerAgentId, cwd, task: "do it", ref: "main" })

test("a caller that is not a live agent on this host is refused", async t => {
  const f = await setup(t)
  await assert.rejects(f.entry(start(f.repo, "33333333-3333-4333-8333-333333333333")), { code: "INVALID", message: "agy delegate must run inside an Agency agent" })
  assert.equal(f.calls.length, 0)
})

test("a caller whose outbox has depth 1 cannot start a child, and the coordinator is never called", async t => {
  const f = await setup(t, { depth: 1 })
  await assert.rejects(f.entry(start(f.repo)), { code: "INVALID", message: "children cannot start children (depth limit 1)" })
  assert.equal(f.calls.length, 0)
})

test("a start from a subdirectory forwards the normalized remote, the relative path, the parent and depth 1", async t => {
  const f = await setup(t)
  assert.deepEqual(await f.entry(start(join(f.repo, "sub", "dir"))), { state: "coordinated" })
  assert.deepEqual(f.calls, [{ op: "start", parent: { hostId: HOST, agentId: CALLER }, parentName: "", depth: 1, task: "do it", ref: "main", remote: normalizeRemote("git@github.com:acme/repo.git"), path: "sub/dir" }])
})

test("a directory outside any repository is refused", async t => {
  const f = await setup(t)
  await assert.rejects(f.entry(start(f.outside)), { code: "INVALID", message: f.outside + " is not in a git repository with an origin remote" })
  assert.equal(f.calls.length, 0)
})

test("a devbox not connected to the laptop refuses, and a connected one forwards upward", async t => {
  const refused = await setup(t, { laptop: false, owners: 0 })
  await assert.rejects(refused.entry({ op: "delegate", action: "list", callerAgentId: CALLER, cwd: refused.repo }), { code: "UNAVAILABLE", message: "this devbox is not connected to the laptop" })
  const connected = await setup(t, { laptop: false, owners: 1 })
  assert.deepEqual(await connected.entry({ op: "delegate", action: "list", callerAgentId: CALLER, cwd: connected.repo }), { state: "forwarded" })
  assert.deepEqual(connected.upward, [{ op: "list", parent: { hostId: HOST, agentId: CALLER } }])
  assert.equal(connected.calls.length, 0)
})
