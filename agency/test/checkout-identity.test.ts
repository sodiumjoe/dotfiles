import assert from "node:assert/strict"
import { ChildProcess } from "node:child_process"
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { checkoutIdFor, checkoutsOverlap, resolveCheckout, observeGitChild, verifyGitExit } from "../src/checkout/identity.js"
import { gitFixture, testHostId } from "./checkout-support.js"

test("aliases converge but separate worktrees do not", { timeout: 20000 }, async t => {
  const f = await gitFixture(t)
  const root = await resolveCheckout(f.repo, testHostId), alias = await resolveCheckout(f.alias, testHostId), linked = await resolveCheckout(f.linked, testHostId)
  assert.deepEqual(alias, root)
  assert.notEqual(root.checkoutId, linked.checkoutId)
  assert.deepEqual(root.commonDirectory, linked.commonDirectory)
  assert.equal(checkoutsOverlap(root, linked), false)
  assert.equal(checkoutsOverlap(root, await resolveCheckout(f.nested, testHostId)), true)
  await mkdir(join(f.repo, "sub"))
  assert.deepEqual(await resolveCheckout(join(f.alias, "sub"), testHostId), root)
})

test("physical ancestry and retained paths preserve conflicts after rename or replacement", { timeout: 20000 }, async t => {
  const f = await gitFixture(t), parent = await resolveCheckout(f.repo, testHostId), nested = await resolveCheckout(f.nested, testHostId)
  const moved = join(f.root, "moved")
  await rename(f.repo, moved)
  assert.equal(checkoutsOverlap(parent, await resolveCheckout(join(moved, "nested"), testHostId)), true)
  assert.equal(checkoutsOverlap(nested, await resolveCheckout(moved, testHostId)), true)
  await f.git(["init", "-q", f.repo])
  assert.equal(checkoutsOverlap(parent, await resolveCheckout(f.repo, testHostId)), true)
})

test("Git environment redirection cannot select a different repository or modify dirty files", { timeout: 20000 }, async t => {
  const f = await gitFixture(t)
  await writeFile(join(f.repo, "dirty"), "uncommitted")
  const env = { ...process.env, GIT_DIR: join(f.linked, ".git"), GIT_WORK_TREE: f.linked, GIT_COMMON_DIR: f.linked, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true", GIT_CEILING_DIRECTORIES: f.root }
  assert.equal((await resolveCheckout(f.repo, testHostId, { env })).root.path, f.repo)
  assert.equal(await readFile(join(f.repo, "dirty"), "utf8"), "uncommitted")
})

test("non-Git, bare, invalid cwd, and unavailable executable are diagnostic failures", { timeout: 20000 }, async t => {
  const f = await gitFixture(t)
  await assert.rejects(resolveCheckout(f.root, testHostId), { code: "NOT_CHECKOUT" })
  const bare = join(f.root, "bare")
  await f.git(["init", "--bare", "-q", bare])
  await assert.rejects(resolveCheckout(bare, testHostId), { code: "UNSUPPORTED_CHECKOUT" })
  await assert.rejects(resolveCheckout(f.repo + "\n", testHostId), { code: "UNSUPPORTED_CHECKOUT" })
  await assert.rejects(resolveCheckout(f.repo, testHostId, { gitExecutable: join(f.root, "missing") }), { code: "IDENTITY_UNAVAILABLE" })
})

test("case aliases follow physical filesystem behavior without lossy inode conversion", { timeout: 20000 }, async t => {
  const f = await gitFixture(t), upper = join(f.root, "MAIN REPO")
  const original = await resolveCheckout(f.repo, testHostId)
  let same = false
  try { same = (await stat(upper, { bigint: true })).ino.toString() === original.root.inode } catch {}
  if (same) assert.equal((await resolveCheckout(upper, testHostId)).checkoutId, original.checkoutId)
  else {
    await f.git(["init", "-q", upper])
    assert.notEqual((await resolveCheckout(upper, testHostId)).checkoutId, original.checkoutId)
  }
  const one = { path: "/one", device: "1", inode: "9007199254740992" }, two = { ...one, inode: "9007199254740993" }
  assert.notEqual(checkoutIdFor(testHostId, one, one), checkoutIdFor(testHostId, two, one))
})

test("separate Git directory files resolve without merging sibling roots", { timeout: 20000 }, async t => {
  const f = await gitFixture(t), repo = join(f.root, "separate"), git = join(f.root, "git-data")
  await f.git(["init", "-q", `--separate-git-dir=${git}`, repo])
  const result = await resolveCheckout(repo, testHostId)
  assert.equal(result.gitDirectory.path, git)
  assert.equal(checkoutsOverlap(result, await resolveCheckout(f.repo, testHostId)), false)
})

for (const mode of ["oversized", "invalid", "wait", "changed"]) {
  test(`Git ${mode} failure closes its owned direct child`, { timeout: 20000 }, async t => {
    const f = await gitFixture(t), executable = fileURLToPath(new URL("./fixtures/checkout-git.js", import.meta.url))
    await chmod(executable, 0o700)
    await mkdir(join(f.repo, "other-git"))
    await assert.rejects(resolveCheckout(f.repo, testHostId, { gitExecutable: executable, env: { ...process.env, AGENCY_CHECKOUT_GIT_FIXTURE: mode } }), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error)
      assert.equal(error.code, mode === "changed" ? "IDENTITY_CHANGED" : "IDENTITY_UNAVAILABLE")
      if (mode === "wait" || mode === "oversized") {
        assert.ok("child" in error)
        assert.deepEqual({ ...(error.child as object), pid: null }, { pid: null, exited: true, closed: true, signal: "SIGKILL" })
      }
      return true
    })
  })
}

test("unverified child termination remains an explicit cleanup failure", async () => {
  const child = new ChildProcess(), observation = observeGitChild(child)
  await assert.rejects(verifyGitExit(observation, 5), /cleanup unverified/)
  assert.equal(observation.evidence.closed, false)
  child.emit("error", new Error("synthetic spawn failed"))
  child.emit("close", -1, null)
  await verifyGitExit(observation, 5)
})