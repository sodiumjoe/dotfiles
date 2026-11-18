import assert from "node:assert/strict"
import { access, chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runPayListing } from "../src/hosts/remote-listing.js"

async function fakePay(t: { after(fn: () => Promise<void>): void }, body: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agency-pay-")))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const command = join(directory, "pay")
  await writeFile(command, "#!/bin/sh\n" + body.replaceAll("$DIR", directory) + "\n")
  await chmod(command, 0o700)
  return { command, directory }
}

test("the listing asks pay for boxes in every state and returns its output", async t => {
  const { command } = await fakePay(t, `[ "$*" = "remote list -a --raw" ] || { echo "unexpected: $*" >&2; exit 64; }\nprintf '[{"name":"climate","host":"h1"}]'`)
  assert.equal(await runPayListing({ command }), '[{"name":"climate","host":"h1"}]')
})

test("a failing pay reports its exit code and the end of its stderr", async t => {
  const { command } = await fakePay(t, `echo "2FA required. Please manually run 'sc-2fa --force'" >&2\nexit 1`)
  await assert.rejects(runPayListing({ command }), /pay exited with 1: 2FA required/)
})

test("a pay whose helper holds its output open is killed with the helper at the deadline", async t => {
  const { command, directory } = await fakePay(t, `(sleep 2; touch "$DIR/survived") &\nexit 0`)
  await assert.rejects(runPayListing({ command, timeoutMs: 1000 }), /LISTING_TIMEOUT/)
  await new Promise(resolve => setTimeout(resolve, 2000))
  await assert.rejects(access(join(directory, "survived")), /ENOENT/)
})

test("output past the limit is refused, and a missing pay fails cleanly", async t => {
  const { command } = await fakePay(t, `head -c 4096 /dev/zero`)
  await assert.rejects(runPayListing({ command, maxBytes: 1024 }), /LISTING_TOO_LARGE/)
  await assert.rejects(runPayListing({ command: join(tmpdir(), "agency-no-such-pay") }), /ENOENT/)
})