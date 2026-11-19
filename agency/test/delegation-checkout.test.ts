import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { findCheckout, normalizeRemote, prepareCheckout } from "../src/delegation/checkout.js"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim()
async function repos(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agency-checkout-")))
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

test("remote URLs of every common form normalize to host and path", () => {
  for (const url of ["git@github.com:sodiumjoe/dotfiles.git", "ssh://git@github.com/sodiumjoe/dotfiles", "https://user@github.com/sodiumjoe/dotfiles.git/"]) assert.equal(normalizeRemote(url), "github.com/sodiumjoe/dotfiles")
})

test("the checkout whose origin matches is found among root patterns", async t => {
  const { root, origin, work } = await repos(t)
  assert.equal(await findCheckout(normalizeRemote(origin), [join(root, "missing"), join(root, "src", "*")]), work)
  assert.equal(await findCheckout("example.com/other", [join(root, "src", "*")]), null)
})

test("a branch is fetched and checked out detached, local edits are stashed with the label, and a missing ref fails clearly", async t => {
  const { work } = await repos(t)
  await writeFile(join(work, "a.txt"), "local edit")
  assert.deepEqual(await prepareCheckout(work, "feature", "agency child 0001"), { stashed: true })
  assert.equal(git(work, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
  assert.equal(git(work, "show", "HEAD:a.txt"), "two")
  assert.match(git(work, "stash", "list"), /agency child 0001/)
  assert.deepEqual(await prepareCheckout(work, "master", "agency child 0002"), { stashed: false })
  await assert.rejects(prepareCheckout(work, "no-such-branch", "agency child 0003"), /fetch failed/)
})

test("a ref that git could read as an option is refused before any git command runs", async t => {
  const { work } = await repos(t)
  const head = git(work, "rev-parse", "HEAD")
  const stashes = git(work, "stash", "list")
  await writeFile(join(work, "a.txt"), "local edit")
  await assert.rejects(prepareCheckout(work, "--upload-pack=touch /tmp/x", "label"), /invalid ref/)
  assert.equal(git(work, "rev-parse", "HEAD"), head)
  assert.equal(git(work, "stash", "list"), stashes)
  assert.equal(git(work, "status", "--porcelain"), "M a.txt")
})