import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { fixtureBridgeSpawner } from "./fixtures/fixture-bridge.js"
import { until } from "./control-support.js"
import { liveHandlerFixture } from "./live-support.js"
import { connectBridge } from "../src/bridge/ssh.js"
import { normalizeRemote } from "../src/delegation/checkout.js"
import { createOutboxStore, type Outbox } from "../src/delegation/outbox.js"
import { unwrapReply } from "../src/delegation/reply.js"
import { RequestError } from "../src/live/errors.js"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim()
async function repos(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agency-box-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const origin = join(root, "origin.git"), work = join(root, "src", "mint")
  git(root, "init", "-q", "--bare", origin)
  git(root, "clone", "-q", origin, work)
  await writeFile(join(work, "a.txt"), "one"); git(work, "add", "a.txt"); git(work, "commit", "-qm", "one"); git(work, "push", "-q", "origin", "HEAD:master")
  const first = git(work, "rev-parse", "HEAD")
  await writeFile(join(work, "a.txt"), "two"); git(work, "commit", "-qam", "two"); git(work, "push", "-q", "origin", "HEAD:feature")
  git(work, "reset", "-q", "--hard", first)
  return { root, origin, work, first }
}

async function connect(t: import("node:test").TestContext, f: Awaited<ReturnType<typeof liveHandlerFixture>>) {
  const record = await f.handler(), hostId = f.paths.hostKey, spawnBridge = await fixtureBridgeSpawner()
  const transport = await connectBridge({ hostId, hostname: "fixture" }, { action: "internal-runtime-bridge", requiredCapabilities: ["live-read", "live-wait"], processFactory: () => spawnBridge(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-remote.js", import.meta.url)), JSON.stringify({ root: f.paths.runtimeRoot, hostId, handlerGeneration: record.generation })], { stdio: ["pipe", "pipe", "pipe"] }) })
  t.after(() => transport.close())
  return transport
}

async function box(t: import("node:test").TestContext) {
  const repo = await repos(t), f = await liveHandlerFixture(t, { delegationRoots: [join(repo.root, "src", "*")] })
  let transport = await connect(t, f)
  const call = async (op: string, payload: Record<string, unknown> = {}) => unwrapReply(await transport.request("live-request", { op, ...payload }, { timeoutMs: 10000 }))
  const children = async () => (await call("children")).children as Array<Outbox & { live: { activity: string } | null; moved: boolean }>
  const start = (childId: string, extra: Record<string, unknown> = {}) => call("child-start", { childId, parent: { hostId: "laptop", agentId: randomUUID() }, depth: 0, task: "do the work", ref: "feature", remote: normalizeRemote(repo.origin), path: ".", ...extra })
  const failure = async (operation: Promise<unknown>) => { try { await operation } catch (error) { if (error instanceof RequestError) return { code: error.code, message: error.message }; throw error } throw new Error("expected failure") }
  const answered = async (count: number) => until(async () => { const [child] = await children(); return child && child.entries.filter(entry => entry.state === "answer").length >= count ? child : undefined }, 15000)
  return { repo, f, call, children, start, failure, answered, reconnect: async () => { transport = await connect(t, f) } }
}

test("a started child runs in the checkout at the ref, and its first answer lands in its outbox", { timeout: 90000 }, async t => {
  const { repo, f, call, children, start, failure } = await box(t), childId = randomUUID()
  const started = Date.now()
  assert.deepEqual(await start(childId), { state: "accepted", childId })
  assert.ok(Date.now() - started < 2000)
  const child = await until(async () => (await children())[0]?.entries.find(entry => entry.state === "answer") ? (await children())[0] : undefined, 15000)
  assert.equal(child.entries[0]!.text, "answer:do the work")
  const row = (await f.agents()).find(value => value.agentId === childId)
  assert.equal(row?.cwd, repo.work)
  assert.equal(git(repo.work, "rev-parse", "HEAD"), git(repo.origin, "rev-parse", "feature"))
  const busy = await failure(start(randomUUID()))
  assert.equal(busy.code, "BUSY")
  assert.match(busy.message, /already running a child/)
  assert.equal((await call("children")).state, "children")
  await f.verifyZeroSurvivors()
})

test("a missing repository is a failure answer and frees the box", { timeout: 90000 }, async t => {
  const { f, children, start } = await box(t)
  const childId = randomUUID()
  await start(childId, { remote: "example.com/none" })
  const child = await until(async () => { const [value] = await children(); return value?.entries.some(entry => entry.state === "failed") ? value : undefined }, 15000)
  assert.ok(child.entries[0]!.text.includes("no checkout"))
  assert.equal(child.stopped, true)
  assert.deepEqual(await start(randomUUID()), { state: "accepted", childId: (await children()).find(value => !value.stopped)!.childId })
  await f.verifyZeroSurvivors()
})

test("a follow-up adds a second answer, a busy child refuses one, and stop then mark empties the outbox", { timeout: 90000 }, async t => {
  const { f, call, children, start, failure, answered } = await box(t), childId = randomUUID()
  await start(childId)
  await answered(1)
  await until(async () => (await children())[0]?.live?.activity === "idle" ? true : undefined, 15000)
  assert.deepEqual(await call("child-ask", { childId, text: "held" }), { state: "accepted" })
  await until(async () => (await f.providerRequests()).some(frame => JSON.stringify(frame).includes("held")) ? true : undefined, 15000)
  const busy = await failure(call("child-ask", { childId, text: "more" }))
  assert.equal(busy.code, "BUSY")
  assert.match(busy.message, /busy/)
  await f.releasePrompts()
  const child = await answered(2)
  assert.deepEqual(await call("child-stop", { childId }), { state: "stopped" })
  assert.deepEqual(await call("child-mark", { childId, submissionIds: child.entries.map(entry => entry.submissionId) }), { state: "marked" })
  assert.deepEqual(await children(), [])
  await f.verifyZeroSurvivors()
})

test("deliver submits once into an idle parent, refuses a busy one with BUSY, and recognizes a repeat", { timeout: 90000 }, async t => {
  const { f, call, failure } = await box(t), parent = await f.start()
  const request = { parentAgentId: parent.agentId, childId: randomUUID(), submissionId: randomUUID(), label: "[child]", text: "the answer" }
  assert.deepEqual(await call("deliver", request), { state: "delivered" })
  assert.deepEqual(await call("deliver", request), { state: "delivered" })
  const excerpt = await f.excerpt(parent.agentId) as { turns: Array<{ role: string; text: string }> }
  assert.deepEqual(excerpt.turns.filter(turn => turn.role === "user"), [{ role: "user", text: "[child] the answer" }])
  const held = f.prompt(parent.agentId, "held")
  await until(async () => (await f.providerRequests()).some(frame => JSON.stringify(frame).includes("held")) ? true : undefined, 15000)
  const refused = await failure(call("deliver", { ...request, childId: randomUUID(), submissionId: randomUUID() }))
  assert.equal(refused.code, "BUSY")
  assert.match(refused.message, /is busy/)
  await f.releasePrompts()
  await held
  await f.verifyZeroSurvivors()
})

test("the startup sweep turns an open turn of a child that is not live into an interrupted entry", { timeout: 90000 }, async t => {
  const { f, children, reconnect } = await box(t), childId = randomUUID(), turn = randomUUID()
  const outbox = createOutboxStore(f.paths.persistentRoot)
  await outbox.create({ childId, parent: { hostId: "laptop", agentId: randomUUID() }, depth: 0, ref: "feature" })
  await outbox.update(childId, value => { value.open = turn })
  await f.stopHandler()
  await f.restart()
  await reconnect()
  const child = await until(async () => { const [value] = await children(); return value?.stopped ? value : undefined }, 15000)
  assert.equal(child.entries.length, 1)
  assert.equal(child.entries[0]!.state, "interrupted")
  assert.equal(child.entries[0]!.submissionId, turn)
  assert.equal(child.open, null)
  await f.verifyZeroSurvivors()
})