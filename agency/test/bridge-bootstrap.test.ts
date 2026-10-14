import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { chmod, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { promisify } from "node:util"
import { destinationShellCommand, posixQuote, sanitizedBootstrapEnvironment } from "../src/bridge/bootstrap.js"
import { privateRoot } from "./control-support.js"

test("login-shell noise and apostrophes cannot corrupt protocol stdout", async t => {
  const root = await privateRoot(t), shell = join(root, "login's shell"), agy = join(root, "agy's command")
  await writeFile(shell, '#!/bin/sh\nprintf "login noise\\n"\nexec /bin/sh "$@"')
  await chmod(shell, 0o700)
  await writeFile(agy, `#!/bin/sh\nprintf '{"protocol":"agency-bridge/2"}\\n'`)
  await chmod(agy, 0o700)
  const command = destinationShellCommand({ inventoryId: randomUUID(), hostId: "a".repeat(64), hostname: "devbox-a", agyPath: agy, loginShell: shell }, "internal-runtime-bridge")
  const result = await promisify(execFile)("/bin/sh", ["-c", command], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
  assert.equal(result.stdout, '{"protocol":"agency-bridge/2"}\n')
  assert.match(result.stderr, /login noise/)
})

test("bootstrap forwards only the explicit environment allowlist", () => {
  assert.deepEqual(sanitizedBootstrapEnvironment({ HOME: "/tmp/home", PATH: "/bin", SOURCE_TOKEN: "secret", NVIM: "/editor", AGENCY_TASK_REF: "private", SSH_AUTH_SOCK: "/agent" }), { HOME: "/tmp/home", PATH: "/bin" })
  for (const value of ["bad\0value", "bad\nvalue", "\ud800"]) assert.throws(() => posixQuote(value), /INVALID_SHELL_ARGUMENT/)
})