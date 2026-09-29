import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { type BigIntStats } from "node:fs"
import { lstat, mkdtemp, mkdir, open, readlink, realpath, rm, symlink, writeFile, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { test, type TestContext } from "node:test"
import { observeCodexUserSecurityState, parseCodexUserSecurityStatePolicy, pinCodexUserSecurityStatePolicy, type CodexUserSecurityStateIO, type CodexUserSecurityStateInput, type CodexUserSecurityStatePolicy } from "../src/agent/codex-user-security.js"

type IOOperation = "lstat" | "readlink" | "realpath" | "open" | "stat" | "read"
type IOOverrides = {
  lstat?: (path: string, count: number, next: () => Promise<BigIntStats>) => Promise<BigIntStats>
  readlink?: (path: string, count: number, next: () => Promise<string>) => Promise<string>
  realpath?: (path: string, count: number, next: () => Promise<string>) => Promise<string>
  open?: (path: string, count: number, next: () => Promise<FileHandle>) => Promise<FileHandle>
  stat?: (path: string, count: number, next: () => Promise<BigIntStats>) => Promise<BigIntStats>
  read?: (path: string, count: number, next: () => Promise<unknown>, args: unknown[]) => Promise<unknown>
}

function cloneStat(stat: BigIntStats, changes: Record<string, unknown>): BigIntStats {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes) as BigIntStats
}

function errno(code: string): Error { return Object.assign(new Error(code), { code }) }

function instrument(overrides: IOOverrides = {}) {
  const openedPaths: string[] = [], lstatPaths: string[] = [], readlinkPaths: string[] = []
  const counts = new Map<string, number>()
  const nextCount = (kind: IOOperation, path: string) => {
    const key = `${kind}:${path}`
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    return count
  }
  const io: CodexUserSecurityStateIO = {
    lstat: (async (path, options) => {
      const name = String(path)
      lstatPaths.push(name)
      const count = nextCount("lstat", name)
      const next = () => lstat(path, options as { bigint: true })
      return overrides.lstat ? overrides.lstat(name, count, next) : next()
    }) as typeof lstat,
    readlink: (async (path, options) => {
      const name = String(path)
      readlinkPaths.push(name)
      const count = nextCount("readlink", name)
      const next = () => readlink(path, options as { encoding: "utf8" })
      return overrides.readlink ? overrides.readlink(name, count, next) : next()
    }) as typeof readlink,
    realpath: (async (path, options) => {
      const name = String(path)
      const count = nextCount("realpath", name)
      const next = () => realpath(path, options as { encoding: "utf8" })
      return overrides.realpath ? overrides.realpath(name, count, next) : next()
    }) as typeof realpath,
    open: (async (path, flags, mode) => {
      const name = String(path)
      openedPaths.push(name)
      const count = nextCount("open", name)
      const next = () => open(path, flags, mode)
      const handle = overrides.open ? await overrides.open(name, count, next) : await next()
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat") return async (...args: unknown[]) => {
            const nth = nextCount("stat", name)
            const original = () => target.stat(...args as [{ bigint: true }]) as Promise<BigIntStats>
            return overrides.stat ? overrides.stat(name, nth, original) : original()
          }
          if (property === "read") return async (...args: unknown[]) => {
            const nth = nextCount("read", name)
            const original = () => Reflect.apply(target.read, target, args) as Promise<unknown>
            return overrides.read ? overrides.read(name, nth, original, args) : original()
          }
          const value = Reflect.get(target, property, target) as unknown
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    }) as typeof open,
  }
  return { io, openedPaths, lstatPaths, readlinkPaths }
}

async function securityFixture(t: TestContext) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "agency-codex-security-")))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, "codex")
  const config = join(root, "config.toml")
  const target = join(parent, "config-target.toml")
  await mkdir(root, { mode: 0o700 })
  await mkdir(join(root, "sessions"))
  await writeFile(target, "model = \"fixture\"\n")
  const configLinkTarget = relative(dirname(config), target)
  await symlink(configLinkTarget, config)
  const input: CodexUserSecurityStateInput = { root, configPath: config, configLinkTarget, configTargetPath: target, absent: [join(root, "auth.json"), join(root, "requirements.toml")] }
  const declaredPaths = [root, config, target, ...input.absent]
  return {
    root, config, target, input, declaredPaths,
    async createDeclaredAbsent(name: "auth.json" | "requirements.toml", kind: "file" | "dangling-symlink") {
      const path = join(root, name)
      if (kind === "file") await writeFile(path, "authentication contents must remain private")
      else await symlink("missing-secret-target", path)
    },
    auditedIO: () => instrument(),
    ioWithOnlyRootPreconditionChanged(mutation: "root-symlink" | "root-file" | "foreign-owner" | "group-writable" | "world-writable") {
      const audit = instrument({ lstat: async (path, count, next) => {
        const stat = await next()
        if (path !== root || count !== 1) return stat
        if (mutation === "root-symlink") return cloneStat(stat, { isDirectory: () => false, isSymbolicLink: () => true })
        if (mutation === "root-file") return cloneStat(stat, { isDirectory: () => false, isFile: () => true })
        if (mutation === "foreign-owner") return cloneStat(stat, { uid: stat.uid + 1n })
        return cloneStat(stat, { mode: stat.mode | (mutation === "group-writable" ? 0o020n : 0o002n) })
      } })
      return Object.assign(audit.io, { audit })
    },
    ioWithOnlyIdentityChanged(kind: "root" | "config" | "target", field: keyof Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs" | "mode" | "uid" | "gid" | "nlink">) {
      const pathName = kind === "root" ? root : kind === "config" ? config : target
      return instrument({ lstat: async (path, count, next) => {
        const stat = await next()
        return path === pathName && count === 1 ? cloneStat(stat, { [field]: stat[field] + 1n }) : stat
      } }).io
    },
    ioWithDeclaredEntryPresent(entry: "auth" | "requirements") {
      const pathName = input.absent[entry === "auth" ? 0 : 1]
      return instrument({ lstat: async (path, _count, next) => path === pathName ? lstat(target, { bigint: true }) : next() }).io
    },
    ioFailing(operation: string, code: string) {
      const [kind, targetName, callText] = operation.split(":")
      const pathName = targetName === "root" ? root : targetName === "config" ? config : targetName === "target" ? target : targetName === "auth" ? input.absent[0] : input.absent[1]
      const call = Number(callText)
      const fail = (type: IOOperation, path: string, count: number) => { if (kind === type && path === pathName && count === call) throw errno(code) }
      return instrument({
        lstat: async (path, count, next) => { fail("lstat", path, count); return next() },
        readlink: async (path, count, next) => { fail("readlink", path, count); return next() },
        realpath: async (path, count, next) => { fail("realpath", path, count); return next() },
        open: async (path, count, next) => { fail("open", path, count); return next() },
        stat: async (path, count, next) => { fail("stat", path, count); return next() },
        read: async (path, count, next) => { fail("read", path, count); return next() },
      }).io
    },
    async observeIsolated(policy: CodexUserSecurityStatePolicy, mutation: string) {
      assert.equal((await observeCodexUserSecurityState(policy)).outcome, "match")
      const alternate = join(parent, "alternate.toml")
      if (mutation === "retarget-identical-bytes") await writeFile(alternate, "model = \"fixture\"\n")
      const io = instrument({
        lstat: async (path, count, next) => {
          if (mutation === "missing-link" && path === config && count === 1) throw errno("ENOENT")
          const stat = await next()
          if (count !== 1) return stat
          if (path === config && mutation === "wrong-link-kind") return cloneStat(stat, { isSymbolicLink: () => false, isFile: () => true })
          if (path === config && mutation === "same-text-link-replacement") return cloneStat(stat, { ino: stat.ino + 1n })
          if (path === target && mutation === "same-byte-target-replacement") return cloneStat(stat, { ino: stat.ino + 1n })
          if (path === target && mutation === "hard-linked-target") return cloneStat(stat, { nlink: stat.nlink + 1n })
          if (path === target && mutation === "oversized-target") return cloneStat(stat, { size: 1_048_577n })
          return stat
        },
        readlink: async (path, _count, next) => mutation === "retarget-identical-bytes" && path === config ? relative(dirname(config), alternate) : next(),
        read: async (_path, count, next, args) => {
          const result = await next() as { bytesRead: number; buffer: Buffer }
          if (mutation === "wrong-bytes-stable-identity" && count === 1) (args[0] as Buffer)[0] = 0x58
          if (mutation === "growing-during-read" && count === 2) return { ...result, bytesRead: 1 }
          return result
        },
      })
      return observeCodexUserSecurityState(policy, io.io)
    },
  }
}

test("Codex security state pins only the closed declared surface", async t => {
  const f = await securityFixture(t)
  const policy = await pinCodexUserSecurityStatePolicy(f.input)
  assert.deepEqual(await observeCodexUserSecurityState(policy), {
    outcome: "match",
    reason: null,
    observation: policy,
  })
  assert.deepEqual(Object.keys(policy), ["version", "root", "config", "absent"])
  assert.equal(JSON.stringify(policy).includes("sessions"), false)
})

test("nested history growth is outside the security-state claim", async t => {
  const f = await securityFixture(t)
  const policy = await pinCodexUserSecurityStatePolicy(f.input)
  await writeFile(join(f.root, "sessions", "new-history.jsonl"), "runtime history")
  assert.equal((await observeCodexUserSecurityState(policy)).outcome, "match")
})

test("pre-existing auth and requirements entries prevent pinning", async t => {
  for (const name of ["auth.json", "requirements.toml"] as const) {
    for (const kind of ["file", "dangling-symlink"] as const) {
      const f = await securityFixture(t)
      const policy = await pinCodexUserSecurityStatePolicy(f.input)
      assert.equal((await observeCodexUserSecurityState(policy)).outcome, "match")
      await f.createDeclaredAbsent(name, kind)
      await assert.rejects(pinCodexUserSecurityStatePolicy(f.input), { code: "ADAPTER_UNQUALIFIED" })
    }
  }
})

test("root kind ownership and write permissions are independent pinning gates", async t => {
  for (const mutation of ["root-symlink", "root-file", "foreign-owner", "group-writable", "world-writable"] as const) {
    const f = await securityFixture(t)
    const policy = await pinCodexUserSecurityStatePolicy(f.input)
    assert.equal((await observeCodexUserSecurityState(policy)).outcome, "match")
    const io = f.ioWithOnlyRootPreconditionChanged(mutation)
    await assert.rejects(pinCodexUserSecurityStatePolicy(f.input, io), { code: "ADAPTER_UNQUALIFIED" })
    assert.equal(io.audit.openedPaths.length, 0)
  }
})

test("every root identity field and root replacement is checked independently", async t => {
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "uid", "gid", "nlink"] as const) {
    const f = await securityFixture(t)
    const policy = await pinCodexUserSecurityStatePolicy(f.input)
    assert.equal((await observeCodexUserSecurityState(policy)).outcome, "match")
    const check = await observeCodexUserSecurityState(policy, f.ioWithOnlyIdentityChanged("root", field))
    assert.deepEqual(check, { outcome: "mismatch", reason: "root_identity", observation: null })
  }
})

test("configuration link and target controls fail for their own reasons", async t => {
  const cases = [
    ["same-text-link-replacement", "config_identity"],
    ["retarget-identical-bytes", "config_link_target"],
    ["same-byte-target-replacement", "config_target_identity"],
    ["wrong-bytes-stable-identity", "config_target_hash"],
    ["missing-link", "config_missing"],
    ["wrong-link-kind", "config_kind"],
    ["hard-linked-target", "config_target_identity"],
    ["oversized-target", "config_target_identity"],
    ["growing-during-read", "config_target_identity"],
  ] as const
  for (const [mutation, reason] of cases) {
    const f = await securityFixture(t)
    const policy = await pinCodexUserSecurityStatePolicy(f.input)
    const check = await f.observeIsolated(policy, mutation)
    assert.deepEqual(check, { outcome: "mismatch", reason, observation: null }, mutation)
  }
})

test("declared absence mismatch is independent from root metadata", async t => {
  for (const [entry, reason] of [["auth", "auth_present"], ["requirements", "requirements_present"]] as const) {
    const f = await securityFixture(t)
    const policy = await pinCodexUserSecurityStatePolicy(f.input)
    assert.equal((await observeCodexUserSecurityState(policy)).outcome, "match")
    assert.deepEqual(await observeCodexUserSecurityState(policy, f.ioWithDeclaredEntryPresent(entry)), { outcome: "mismatch", reason, observation: null })
  }
})

function failableOperations(): readonly (readonly [string, string])[] {
  return [
    ["lstat:root:1", "root_unavailable"], ["realpath:root:1", "root_unavailable"], ["lstat:root:2", "root_unavailable"],
    ["lstat:config:1", "config_unavailable"], ["readlink:config:1", "config_unavailable"], ["realpath:config:1", "config_unavailable"], ["lstat:config:2", "config_unavailable"],
    ["lstat:target:1", "config_target_unavailable"], ["open:target:1", "config_target_unavailable"], ["stat:target:1", "config_target_unavailable"], ["read:target:1", "config_target_unavailable"], ["stat:target:2", "config_target_unavailable"], ["lstat:target:2", "config_target_unavailable"],
    ["lstat:auth:1", "auth_unavailable"], ["lstat:auth:2", "auth_unavailable"], ["lstat:requirements:1", "requirements_unavailable"], ["lstat:requirements:2", "requirements_unavailable"],
  ]
}

test("unavailable evidence remains distinct from mismatch", async t => {
  for (const [operation, reason] of failableOperations()) {
    const f = await securityFixture(t)
    const policy = await pinCodexUserSecurityStatePolicy(f.input)
    assert.equal((await observeCodexUserSecurityState(policy)).outcome, "match")
    assert.deepEqual(await observeCodexUserSecurityState(policy, f.ioFailing(operation, "EACCES")), { outcome: "unavailable", reason, observation: null }, operation)
  }
})

function invalidPolicies(policy: CodexUserSecurityStatePolicy): unknown[] {
  const changedIdentity = [...policy.root.identity]
  changedIdentity[0] = "01"
  return [
    { ...policy, version: 2 }, { ...policy, extra: true }, { ...policy, root: { ...policy.root, extra: true } },
    { ...policy, config: { ...policy.config, extra: true } }, { ...policy, config: { ...policy.config, target: { ...policy.config.target, extra: true } } },
    { ...policy, root: { ...policy.root, path: `${policy.root.path}/../codex` } }, { ...policy, root: { ...policy.root, path: `${policy.root.path}\n` } },
    { ...policy, root: { ...policy.root, identity: changedIdentity } }, { ...policy, root: { ...policy.root, identity: policy.root.identity.slice(0, 8) } },
    { ...policy, config: { ...policy.config, linkTarget: "" } }, { ...policy, config: { ...policy.config, linkTarget: policy.config.target.path } },
    { ...policy, config: { ...policy.config, linkTarget: "bad\u0000name" } },
    { ...policy, config: { ...policy.config, target: { ...policy.config.target, sha256: "A".repeat(64) } } },
    { ...policy, config: { ...policy.config, target: { ...policy.config.target, identity: policy.config.target.identity.map((value, index) => index === 2 ? "1048577" : value) } } },
    { ...policy, absent: [...policy.absent].reverse() }, { ...policy, absent: [policy.absent[0], policy.absent[0]] }, { ...policy, absent: [...policy.absent, policy.root.path] },
  ]
}

function validButDifferentPolicies(policy: CodexUserSecurityStatePolicy): unknown[] {
  const withField = (field: "root" | "config" | "target", index: number) => {
    const identity = [...(field === "root" ? policy.root.identity : field === "config" ? policy.config.identity : policy.config.target.identity)]
    identity[index] = String(BigInt(identity[index]!) + 1n)
    return field === "root" ? { ...policy, root: { ...policy.root, identity } } : field === "config" ? { ...policy, config: { ...policy.config, identity } } : { ...policy, config: { ...policy.config, target: { ...policy.config.target, identity } } }
  }
  return [withField("root", 0), withField("config", 1), withField("target", 3), { ...policy, config: { ...policy.config, target: { ...policy.config.target, sha256: "0".repeat(64) } } }]
}

test("policy parsing and fingerprinting reject every field mutation", async t => {
  const f = await securityFixture(t)
  const policy = await pinCodexUserSecurityStatePolicy(f.input)
  assert.equal((await observeCodexUserSecurityState(policy)).outcome, "match")
  const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(parseCodexUserSecurityStatePolicy(value))).digest("hex")
  for (const value of invalidPolicies(policy)) assert.throws(() => parseCodexUserSecurityStatePolicy(value), { code: "ADAPTER_UNQUALIFIED" })
  for (const value of validButDifferentPolicies(policy)) {
    assert.notDeepEqual(value, policy)
    assert.notEqual(fingerprint(value), fingerprint(policy))
  }
})

test("operation audit reads only declared paths and no directory contents", async t => {
  const f = await securityFixture(t)
  const audit = f.auditedIO()
  const policy = await pinCodexUserSecurityStatePolicy(f.input, audit.io)
  const check = await observeCodexUserSecurityState(policy, audit.io)
  assert.equal(check.outcome, "match")
  assert.deepEqual(audit.openedPaths, [f.target, f.target])
  assert.ok(audit.lstatPaths.every(path => f.declaredPaths.includes(path)))
  assert.deepEqual(audit.readlinkPaths, [f.config, f.config])
  assert.equal(Object.hasOwn(audit.io, "readdir"), false)
  const serialized = JSON.stringify(check)
  for (const secret of ["model = \"fixture\"", "new-history.jsonl", "authentication contents must remain private"]) assert.equal(serialized.includes(secret), false)
  await f.createDeclaredAbsent("auth.json", "file")
  const fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "uid", "gid", "nlink"] as const
  const isolated = instrument({ lstat: async (path, _count, next) => {
    const stat = await next()
    return path === f.root ? cloneStat(stat, Object.fromEntries(fields.map((field, index) => [field, BigInt(policy.root.identity[index]!)]))) : stat
  } }).io
  const mismatch = await observeCodexUserSecurityState(policy, isolated)
  assert.deepEqual(mismatch, { outcome: "mismatch", reason: "auth_present", observation: null })
  assert.equal(JSON.stringify(mismatch).includes("authentication contents must remain private"), false)
})

test("mutation at each observation boundary is detected independently", async t => {
  const f = await securityFixture(t)
  const policy = await pinCodexUserSecurityStatePolicy(f.input)
  assert.equal((await observeCodexUserSecurityState(policy)).outcome, "match")
  for (const [kind, call, reason] of [["lstat", 1, "config_target_identity"], ["stat", 1, "config_target_identity"], ["stat", 2, "config_target_identity"], ["lstat", 2, "config_target_identity"]] as const) {
    const io = instrument({
      lstat: async (path, count, next) => { const stat = await next(); return kind === "lstat" && path === f.target && count === call ? cloneStat(stat, { ino: stat.ino + 1n }) : stat },
      stat: async (path, count, next) => { const stat = await next(); return kind === "stat" && path === f.target && count === call ? cloneStat(stat, { ino: stat.ino + 1n }) : stat },
    }).io
    assert.deepEqual(await observeCodexUserSecurityState(policy, io), { outcome: "mismatch", reason, observation: null }, `${kind}:${call}`)
  }
  const changedRead = instrument({ read: async (_path, count, next, args) => { const result = await next(); if (count === 1) (args[0] as Buffer)[0] = 0x58; return result } }).io
  assert.deepEqual(await observeCodexUserSecurityState(policy, changedRead), { outcome: "mismatch", reason: "config_target_hash", observation: null })
  const changedRoot = instrument({ lstat: async (path, count, next) => { const stat = await next(); return path === f.root && count === 2 ? cloneStat(stat, { ino: stat.ino + 1n }) : stat } }).io
  assert.deepEqual(await observeCodexUserSecurityState(policy, changedRoot), { outcome: "mismatch", reason: "root_identity", observation: null })
  for (const [index, reason] of [[0, "auth_present"], [1, "requirements_present"]] as const) {
    const changedAbsence = instrument({ lstat: async (path, count, next) => path === f.input.absent[index] && count === 2 ? lstat(f.target, { bigint: true }) : next() }).io
    assert.deepEqual(await observeCodexUserSecurityState(policy, changedAbsence), { outcome: "mismatch", reason, observation: null })
  }
})

test("indeterminate I/O values are unavailable at their own stage", async t => {
  const f = await securityFixture(t)
  const policy = await pinCodexUserSecurityStatePolicy(f.input)
  assert.equal((await observeCodexUserSecurityState(policy)).outcome, "match")
  const cases: readonly (readonly [CodexUserSecurityStateIO, string])[] = [
    [instrument({ realpath: async (path, _count, next) => path === f.root ? Buffer.from("invalid") as unknown as string : next() }).io, "root_unavailable"],
    [instrument({ readlink: async (path, _count, next) => path === f.config ? Buffer.from("invalid") as unknown as string : next() }).io, "config_unavailable"],
    [instrument({ realpath: async (path, _count, next) => path === f.config ? Buffer.from("invalid") as unknown as string : next() }).io, "config_unavailable"],
    [instrument({ lstat: async (path, _count, next) => path === f.target ? {} as BigIntStats : next() }).io, "config_target_unavailable"],
    [instrument({ read: async () => ({ bytesRead: undefined }) }).io, "config_target_unavailable"],
  ]
  for (const [io, reason] of cases) assert.deepEqual(await observeCodexUserSecurityState(policy, io), { outcome: "unavailable", reason, observation: null }, reason)
})

test("unexpected metadata failures retain the affected stage", async t => {
  const f = await securityFixture(t)
  const policy = await pinCodexUserSecurityStatePolicy(f.input)
  assert.equal((await observeCodexUserSecurityState(policy)).outcome, "match")
  for (const [pathName, method, reason] of [[f.config, "isSymbolicLink", "config_unavailable"], [f.target, "isFile", "config_target_unavailable"]] as const) {
    const io = instrument({ lstat: async (path, _count, next) => {
      const stat = await next()
      return path === pathName ? cloneStat(stat, { [method]: () => { throw new Error("indeterminate metadata") } }) : stat
    } }).io
    assert.deepEqual(await observeCodexUserSecurityState(policy, io), { outcome: "unavailable", reason, observation: null }, method)
  }
})