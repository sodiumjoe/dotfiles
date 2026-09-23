import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readHostId, type HostIdDependencies } from "../src/platform/host-id.js"
import { resolvePlatformPaths } from "../src/platform/paths.js"

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function rootFileStats(): Awaited<ReturnType<HostIdDependencies["lstat"]>> {
  return {
    mode: 0o100444,
    uid: 0,
    isFile: () => true,
    isSymbolicLink: () => false,
  }
}

test("derives Darwin host key from verified ioreg output", async () => {
  let invoked: readonly string[] | null = null
  const dependencies: HostIdDependencies = {
    lstat: async (path: string) => {
      assert.equal(path, "/usr/sbin/ioreg")
      return rootFileStats()
    },
    realpath: async (path: string) => path,
    readFile: async () => "",
    execFile: async (file: string, args: readonly string[]) => {
      invoked = [file, ...args]
      return { stdout: '    | |   "IOPlatformUUID" = "ABCDEF01-2345-6789-ABCD-EF0123456789"\n', stderr: "" }
    },
  }
  assert.equal(await readHostId("darwin", dependencies), digest("abcdef01-2345-6789-abcd-ef0123456789"))
  assert.deepEqual(invoked, ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
})

test("derives Linux host key from a verified machine id", async () => {
  const dependencies: HostIdDependencies = {
    lstat: async (path: string) => {
      assert.equal(path, "/etc/machine-id")
      return rootFileStats()
    },
    realpath: async (path: string) => path,
    readFile: async (path: string) => {
      assert.equal(path, "/etc/machine-id")
      return "ABCDEF0123456789ABCDEF0123456789\n"
    },
    execFile: async () => ({ stdout: "", stderr: "" }),
  }
  assert.equal(await readHostId("linux", dependencies), digest("abcdef0123456789abcdef0123456789"))
})

test("rejects untrusted host identity sources and malformed values", async () => {
  const base: HostIdDependencies = {
    lstat: async () => rootFileStats(),
    realpath: async (path: string) => path,
    readFile: async () => "not a machine id",
    execFile: async () => ({ stdout: "no uuid", stderr: "" }),
  }
  await assert.rejects(readHostId("linux", base), /machine|identity/i)
  await assert.rejects(readHostId("darwin", base), /IOPlatformUUID/i)
  await assert.rejects(readHostId("linux", { ...base, lstat: async () => ({ ...rootFileStats(), uid: 501 }) }), /root|owner/i)
  await assert.rejects(readHostId("linux", { ...base, lstat: async () => ({ ...rootFileStats(), mode: 0o100666 }) }), /writable|permission/i)
  await assert.rejects(readHostId("linux", { ...base, lstat: async () => ({ ...rootFileStats(), mode: 0o120777, isFile: () => false, isSymbolicLink: () => true }) }), /symlink|file/i)
})

test("resolves distinct private roots and a short socket path", async t => {
  const base = join(await realpath(tmpdir()), `agency-paths-${crypto.randomUUID()}`)
  await mkdir(base, { mode: 0o700 })
  t.after(async () => rm(base, { recursive: true, force: true }))
  const firstKey = "a".repeat(64)
  const secondKey = "b".repeat(64)
  const first = await resolvePlatformPaths({ platform: process.platform === "darwin" ? "darwin" : "linux", uid: process.getuid!(), hostKey: firstKey, home: base })
  const second = await resolvePlatformPaths({ platform: process.platform === "darwin" ? "darwin" : "linux", uid: process.getuid!(), hostKey: secondKey, home: base })
  t.after(async () => {
    await rm(first.runtimeRoot, { recursive: true, force: true })
    await rm(second.runtimeRoot, { recursive: true, force: true })
  })
  assert.equal(first.persistentRoot, join(base, ".local/state/agency/hosts", firstKey))
  assert.notEqual(first.persistentRoot, second.persistentRoot)
  assert.notEqual(first.runtimeRoot, second.runtimeRoot)
  assert.equal(first.handlerSocketPath, join(first.runtimeRoot, "handler.sock"))
  assert.ok(Buffer.byteLength(first.handlerSocketPath, "utf8") < 100)
  for (const path of [first.persistentRoot, first.runtimeRoot]) {
    const stats = await lstat(path)
    assert.equal(stats.mode & 0o777, 0o700)
    assert.equal(stats.uid, process.getuid!())
    assert.equal(await realpath(path), path)
  }
})

test("uses absolute XDG state home and rejects relative or symlink components", async t => {
  const base = join(await realpath(tmpdir()), `agency-paths-${crypto.randomUUID()}`)
  const state = join(base, "state")
  const linked = join(base, "linked")
  await mkdir(state, { recursive: true, mode: 0o700 })
  await symlink(state, linked)
  t.after(async () => rm(base, { recursive: true, force: true }))
  const common = { platform: process.platform === "darwin" ? "darwin" as const : "linux" as const, uid: process.getuid!(), hostKey: "c".repeat(64), home: base }
  await assert.rejects(resolvePlatformPaths({ ...common, xdgStateHome: "relative" }), /absolute/i)
  await assert.rejects(resolvePlatformPaths({ ...common, xdgStateHome: linked }), /symlink|canonical/i)
  const result = await resolvePlatformPaths({ ...common, xdgStateHome: state })
  t.after(async () => rm(result.runtimeRoot, { recursive: true, force: true }))
  assert.equal(result.persistentRoot, join(state, "agency/hosts", common.hostKey))
})