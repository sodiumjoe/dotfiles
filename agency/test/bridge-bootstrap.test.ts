import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { destinationShellCommand, posixQuote, sanitizedBootstrapEnvironment } from "../src/bridge/bootstrap.js"
import { privateRoot } from "./control-support.js"

const enrollment = { hostId: "a".repeat(64), hostname: "devbox-a" }
test("bridge resolves bare agy through the SSH shell PATH without a login shell", async t => {
  const root = await privateRoot(t)
  await writeFile(join(root, "agy"), `#!/bin/sh
printf '%s' "$1"
printf 'diagnostic' >&2`, { mode: 0o700 })
  const command = destinationShellCommand(enrollment, "internal-runtime-bridge")
  const result = await promisify(execFile)("/bin/sh", ["-c", command], { timeout: 15000, env: { HOME: root, PATH: root + ":/usr/bin:/bin" } })
  assert.equal(result.stdout, "internal-runtime-bridge")
  assert.equal(result.stderr, "diagnostic")
})

test("bridge reports missing agy without attempting another shell or installation", async t => {
  const root = await privateRoot(t)
  await assert.rejects(promisify(execFile)("/bin/sh", ["-c", destinationShellCommand(enrollment, "internal-runtime-bridge")], { env: { PATH: root } }), { code: 127 })
})

test("bootstrap forwards only the explicit environment allowlist", () => {
  assert.deepEqual(sanitizedBootstrapEnvironment({ HOME: "/tmp/home", PATH: "/bin", SOURCE_TOKEN: "secret", NVIM: "/editor", AGENCY_TASK_REF: "private", SSH_AUTH_SOCK: "/agent" }), { HOME: "/tmp/home", PATH: "/bin" })
  for (const value of ["bad\0value", "bad\nvalue", "\ud800"]) assert.throws(() => posixQuote(value), /INVALID_SHELL_ARGUMENT/)
})