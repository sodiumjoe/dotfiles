import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { ControlError } from "../control/protocol.js"
import type { HandlerEnvironment } from "../handler/environment.js"
import { assertPrivateDirectory, parseLaunchRecord, readHandlerRecord, writeLaunchRecordExpected, type PrivateStateFileSystem } from "../platform/private-state.js"
import { withStartupLock } from "../platform/singleton.js"
import { processBirthStart, type ManagedLaunchRecord, type ProcessIdentity } from "../platform/types.js"
import { decodeJson, digest, readBoundedFile } from "./config.js"
import { createCatalogStore } from "./store.js"
import { hash, id, MAX_CATALOG_BYTES } from "./types.js"

export type ProbeRecoveryRequest = { attemptId: string; handlerGeneration: string; sha256: string }
export type ProbeRecoveryResult = { state: "cleanup_verified"; attemptId: string; archivePath: string; sha256: string }
type RecoveryFileSystem = PrivateStateFileSystem & { mkdir: typeof mkdir }
export type ProbeRecoveryDependencies = { filesystem?: RecoveryFileSystem; boundary?: (name: string) => Promise<void> }
function refuse(message: string): never { throw new ControlError("INCOMPLETE", message) }
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

export async function recoverCatalogProbe(env: HandlerEnvironment, request: ProbeRecoveryRequest, dependencies: ProbeRecoveryDependencies = {}): Promise<ProbeRecoveryResult> {
  id(request.attemptId); id(request.handlerGeneration); hash(request.sha256); hash(env.paths.hostKey)
  const paths = env.paths, state = paths.persistentRoot, hosts = dirname(state), base = dirname(hosts)
  if (basename(state) !== paths.hostKey || basename(hosts) !== "hosts" || basename(base) !== "agency") refuse("recovery state path is not a qualified host root")
  for (const path of [base, hosts, state, paths.runtimeRoot]) await assertPrivateDirectory(path)
  return withStartupLock({ root: paths.runtimeRoot, adapter: env.adapter }, async lock => {
    const filesystem = dependencies.filesystem ?? { open, rename, rm, mkdir }
    const launchPath = join(state, "catalog/probe-launches", request.attemptId + ".json")
    const archiveParent = join(base, "recovery", paths.hostKey), archivePath = join(archiveParent, request.attemptId)
    async function read(path: string): Promise<Buffer> {
      await assertPrivateDirectory(dirname(path))
      const bytes = await readBoundedFile(path, MAX_CATALOG_BYTES, true)
      if (bytes === null) refuse("recovery evidence is missing")
      return bytes
    }
    const current = await read(launchPath)
    let original = current, retry = false
    if (digest(current) !== request.sha256) {
      original = await read(join(archivePath, "launch.json"))
      if (digest(original) !== request.sha256) refuse("original recovery digest does not match")
      retry = true
    }
    const parsed = parseLaunchRecord(decodeJson(original), true)
    if (parsed.version !== 2 || parsed.owner.kind !== "catalog-probe") refuse("recovery requires a managed catalog probe")
    const record: ManagedLaunchRecord = parsed, owner = parsed.owner
    if (record.launchAttemptId !== request.attemptId || record.handlerGeneration !== request.handlerGeneration || record.phase !== "quarantined" || !record.launchAttempted || record.provider === null) refuse("recovery target is not a complete quarantined probe")
    const replacement = { ...record, phase: "cleanup_verified" as const, reason: null }
    if (retry && !current.equals(Buffer.from(JSON.stringify(replacement)))) refuse("current record is not the archived recovery derivative")
    const handlerPath = join(paths.runtimeRoot, "handler.json"), handlerBytes = await read(handlerPath), handler = await readHandlerRecord(handlerPath)
    if (!isDeepStrictEqual(decodeJson(handlerBytes), handler) || handler.hostId !== paths.hostKey || handler.generation !== request.handlerGeneration || handler.launchBootId !== record.launchBootId || handler.process === null || !handler.launchAttempted || handler.socketPath !== join(paths.runtimeRoot, "handler.sock")) refuse("Handler evidence does not match recovery target")
    const handlerProcess = handler.process, group = record.provider!.group, leader = group.leader
    function owned(identity: ProcessIdentity): boolean { return identity.bootId === record.launchBootId && identity.uid === process.getuid!() && identity.gid === process.getgid!() && processBirthStart(identity.birth) !== null }
    const handlerStart = processBirthStart(handlerProcess.birth), leaderStart = processBirthStart(leader.birth)
    if (!owned(handlerProcess) || handlerProcess.birth !== `${handlerStart}:agy-handler:${handler.launchAttemptId}` || handlerProcess.pid !== handlerProcess.processGroupId || handlerProcess.pid !== handlerProcess.sessionId) refuse("Handler ownership is incomplete")
    if (!owned(leader) || leader.birth !== `${leaderStart}:agy-provider:${record.launchAttemptId}` || leader.pid !== leader.processGroupId || leader.pid !== leader.sessionId || leader.parentPid !== handlerProcess.pid || leader.pid === handlerProcess.pid) refuse("probe ownership is incomplete")
    if (!group.observed.some(identity => isDeepStrictEqual(identity, leader)) || new Set(group.observed.map(identity => identity.pid)).size !== group.observed.length) refuse("retained process evidence omits the leader or repeats a PID")
    const identities = new Map<number, ProcessIdentity>()
    for (const identity of [leader, ...group.observed]) {
      if (!owned(identity) || identity.processGroupId !== leader.pid || identity.sessionId !== leader.pid || identity.pid === handlerProcess.pid || (identities.has(identity.pid) && !isDeepStrictEqual(identities.get(identity.pid), identity))) refuse("retained process ownership is incomplete")
      identities.set(identity.pid, identity)
    }
    const inventory = await createCatalogStore(state).inventory()
    if (inventory.issues.length !== 0) refuse("catalog inventory is invalid")
    const metadata = inventory.metadata.find(meta => meta.attemptId === request.attemptId)
    if (!metadata || metadata.version === 1 || metadata.hostId !== paths.hostKey || metadata.handlerGeneration !== request.handlerGeneration || metadata.providerId !== owner.providerId || metadata.commandId !== owner.commandId) refuse("probe metadata does not match recovery target")
    const receiptKind = metadata.version === 3 && metadata.receiptKind === "automatic" ? "automatic" : "commands"
    const command = inventory[receiptKind].find(command => command.commandId === metadata.commandId)
    if (!command || command.state === "pending") refuse("probe command is incomplete")
    const evidence = new Map<string, { path: string; bytes: Buffer }>([
      ["launch.json", { path: launchPath, bytes: original }],
      ["metadata.json", { path: join(state, "catalog/probe-meta", request.attemptId + ".json"), bytes: Buffer.alloc(0) }],
      ["command.json", { path: join(state, "catalog", receiptKind, metadata.commandId + ".json"), bytes: Buffer.alloc(0) }],
      ["handler.json", { path: handlerPath, bytes: handlerBytes }],
    ])
    for (const name of ["metadata.json", "command.json"]) { const entry = evidence.get(name)!; entry.bytes = await read(entry.path) }
    if (!isDeepStrictEqual(decodeJson(evidence.get("metadata.json")!.bytes), metadata) || !isDeepStrictEqual(decodeJson(evidence.get("command.json")!.bytes), command)) refuse("catalog evidence changed during validation")
    const manifest = Buffer.from(JSON.stringify({ version: 1, hostId: paths.hostKey, attemptId: request.attemptId, handlerGeneration: request.handlerGeneration, bootId: record.launchBootId, files: Object.fromEntries([...evidence].map(([name, entry]) => [name, digest(entry.bytes)])), derivativeSha256: digest(JSON.stringify(replacement)) }))
    const archived = new Map([...evidence].map(([name, entry]) => [name, entry.bytes]))
    archived.set("manifest.json", manifest)
    async function unchanged(launchBytes = current): Promise<void> {
      for (const [name, entry] of evidence) if (!(await read(entry.path)).equals(name === "launch.json" ? launchBytes : entry.bytes)) refuse("recovery evidence changed")
    }
    async function absence(): Promise<void> {
      if (await env.adapter.bootId() !== record.launchBootId) refuse("boot changed during recovery")
      if (await env.adapter.readProcess(handlerProcess.pid) !== null) refuse("Handler PID is not absent")
      for (const identity of identities.values()) if (await env.adapter.readProcess(identity.pid) !== null) refuse("retained provider PID is not absent")
      if ((await env.adapter.readGroup(leader.pid)).length !== 0) refuse("retained provider group is not empty")
    }
    async function sync(path: string, directory: boolean): Promise<void> {
      lock.assertHeld()
      const handle = await filesystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : constants.O_NONBLOCK))
      try { await handle.sync() } finally { await handle.close() }
      lock.assertHeld()
    }
    async function verifyArchive(): Promise<void> {
      await assertPrivateDirectory(archivePath)
      if (!isDeepStrictEqual((await readdir(archivePath)).sort(), [...archived.keys()].sort())) refuse("recovery archive conflicts")
      for (const [name, bytes] of archived) {
        const path = join(archivePath, name)
        if (!(await read(path)).equals(bytes)) refuse("recovery archive conflicts")
        await sync(path, false)
      }
      await sync(archivePath, true)
      await sync(archiveParent, true)
    }
    await absence()
    await unchanged()
    for (const path of [join(base, "recovery"), archiveParent]) {
      lock.assertHeld()
      try { await filesystem.mkdir(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
      await assertPrivateDirectory(path)
      await sync(dirname(path), true)
    }
    let exists = true
    try { await assertPrivateDirectory(archivePath) } catch (error) { if (!absent(error)) throw error; exists = false }
    if (!exists) {
      if (retry) refuse("recovery derivative has no archive")
      const stage = join(archiveParent, `.${request.attemptId}.${randomUUID()}.tmp`)
      lock.assertHeld()
      await filesystem.mkdir(stage, { mode: 0o700 })
      await assertPrivateDirectory(stage)
      for (const [name, bytes] of archived) {
        lock.assertHeld()
        const handle = await filesystem.open(join(stage, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      }
      await sync(stage, true)
      lock.assertHeld()
      await filesystem.rename(stage, archivePath)
    }
    await verifyArchive()
    await dependencies.boundary?.("archive_durable")
    await dependencies.boundary?.("before_publish")
    await unchanged()
    await verifyArchive()
    await writeLaunchRecordExpected(launchPath, replacement, current, filesystem, {
      assertHeld: lock.assertHeld,
      async validate() {
        lock.assertHeld()
        await unchanged()
        await absence()
        await verifyArchive()
        await unchanged()
        lock.assertHeld()
      },
    })
    await dependencies.boundary?.("record_published")
    await unchanged(Buffer.from(JSON.stringify(replacement)))
    await verifyArchive()
    return { state: "cleanup_verified", attemptId: request.attemptId, archivePath, sha256: request.sha256 }
  })
}