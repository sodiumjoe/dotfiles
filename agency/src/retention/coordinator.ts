import { lstat, opendir } from "node:fs/promises"
import { join, relative } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { parseAgentCommand, parseAgentRecord, tupleOfRecord } from "../agent/types.js"
import type { AgentService } from "../agent/service.js"
import type { AgentStore } from "../agent/store.js"
import { decodeJson, readBoundedFile } from "../catalog/config.js"
import { id, parseCommand, parseRetainedProbeMeta } from "../catalog/types.js"
import type { CatalogService } from "../catalog/service.js"
import type { CatalogStore } from "../catalog/store.js"
import { inventoryLaunchState, type InventoryEntry } from "../handler/inventory.js"
import { forgetRemovedLaunch, type HandlerMutations, type MutationQueue } from "../handler/mutations.js"
import { readShutdownInventory } from "../handler/receipt.js"
import { assertPrivateDirectory, parseLaunchRecord } from "../platform/private-state.js"
import { sameProcessGeneration, type PlatformAdapter, type ProcessIdentity } from "../platform/types.js"
import { expiredFailure, reclaimable, type RetentionNode } from "./policy.js"
import type { CleanupIntent, RemovalEvidence, RetentionStore, RetirementView } from "./store.js"

export type RetentionCoordinator = { initialize(): Promise<void>; sweepLocked(): Promise<void>; request(): void; diagnostics(): readonly string[] }
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const agentPath = (id: string) => "agents/records/" + id + ".json"
const commandPath = (id: string) => "agents/commands/" + id + ".json"
const launchPath = (id: string) => "launches/" + id + ".json"
const snapshotPath = (id: string) => "catalog/snapshots/" + id + ".json"
const cleanupError = (): never => { throw new Error("cleanup authorization is unverified") }
export function authorizedRetirementView(store: RetentionStore, authorize: (intent: CleanupIntent) => Promise<void>): RetirementView {
  const view = store.view
  let authorized = false
  return { async validate() {
    authorized = false
    await view.validate()
    const intent = await store.pending()
    if (intent) await authorize(intent)
    authorized = true
  }, hides: path => authorized && view.hides(path) }
}
export async function verifyRetirementAbsence(adapter: PlatformAdapter, launches: readonly InventoryEntry[], handlers: readonly ProcessIdentity[]): Promise<void> {
  const boot = await adapter.bootId()
  const groups: Array<{ boot: string; leader: ProcessIdentity; observed: readonly ProcessIdentity[] }> = []
  for (const { record } of launches) {
    if (record.phase !== "cleanup_verified") cleanupError()
    if (!record.provider) { if (record.launchAttempted) cleanupError(); continue }
    groups.push({ boot: record.launchBootId, ...record.provider.group })
  }
  for (const handler of handlers) groups.push({ boot: handler.bootId, leader: handler, observed: [handler] })
  for (let n = 0; n < 2; n++) {
    if (await adapter.bootId() !== boot) cleanupError()
    for (const group of groups) {
      if (group.boot !== boot) continue
      for (const expected of group.observed) {
        const observed = await adapter.readProcess(expected.pid)
        if (observed && sameProcessGeneration(expected, observed)) cleanupError()
      }
      if ((await adapter.readGroup(group.leader.pid)).some(value => value.bootId === boot)) cleanupError()
    }
  }
  if (await adapter.bootId() !== boot) cleanupError()
}

export async function authorizeRetirement(input: { root: string; hostId: string; generation: string; adapter: PlatformAdapter; pins?: readonly string[] }, intent: CleanupIntent): Promise<void> {
  const targets = new Set(intent.entries.map(entry => entry.path)), witnesses = new Map(intent.launches.map(entry => [entry.record.launchAttemptId, entry]))
  const lifecycleTargets = [...targets].some(path => path.startsWith("agents/") || path.startsWith("launches/")), catalogTargets = [...targets].some(path => path.startsWith("catalog/"))
  if (intent.hostId !== input.hostId || input.pins?.some(path => targets.has(path))) cleanupError()
  await verifyRetirementAbsence(input.adapter, intent.launches, intent.handlers)
  const references: string[] = []
  async function records(directory: string, consume: (raw: unknown) => void): Promise<void> {
    const path = join(input.root, directory)
    await assertPrivateDirectory(input.root)
    if (directory.includes("/")) { try { await assertPrivateDirectory(join(input.root, directory.split("/")[0]!)) } catch (error) { if (absent(error)) return; throw error } }
    try { await assertPrivateDirectory(path) } catch (error) { if (absent(error)) return; throw error }
    for await (const entry of await opendir(path)) {
      const key = directory + "/" + entry.name
      if (targets.has(key)) continue
      if (entry.name.startsWith(".")) continue
      if (!entry.name.endsWith(".json")) cleanupError()
      id(entry.name.slice(0, -5))
      const raw = await readBoundedFile(join(input.root, key), 1048576, true)
      if (!raw) return cleanupError()
      consume(decodeJson(raw))
    }
  }
  if (lifecycleTargets) await records("agents/records", raw => {
    const value = parseAgentRecord(raw)
    if (value.definition.hostId !== input.hostId) cleanupError()
    references.push(commandPath(value.definition.createdCommandId), commandPath(value.launch.commandId), launchPath(value.launch.launchAttemptId))
  })
  if (lifecycleTargets) await records("agents/commands", raw => {
    const value = parseAgentCommand(raw)
    if (value.hostId !== input.hostId) cleanupError()
    if (!value.target) return
    references.push(agentPath(value.target.agentId))
    for (const entry of witnesses.values()) if (entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === value.target.agentId && entry.record.owner.providerGeneration === value.target.providerGeneration && entry.record.handlerGeneration === value.target.handlerGeneration) references.push(entry.path)
  })
  if (catalogTargets) for (const kind of ["commands", "automatic"]) await records("catalog/" + kind, raw => {
    const value = parseCommand(raw)
    if (value.hostId !== input.hostId) cleanupError()
    if (value.snapshotId) references.push(snapshotPath(value.snapshotId))
    if (value.state === "pending") for (const attempt of value.attempts) references.push("catalog/probe-meta/" + attempt.attemptId + ".json", "catalog/probe-launches/" + attempt.attemptId + ".json", "catalog/work/" + attempt.attemptId)
  })
  if (catalogTargets) await records("catalog/probe-meta", raw => {
    const value = parseRetainedProbeMeta(raw)
    if (value.hostId !== input.hostId) cleanupError()
    references.push("catalog/" + (value.version === 3 && value.receiptKind === "automatic" ? "automatic" : "commands") + "/" + value.commandId + ".json", "catalog/probe-launches/" + value.attemptId + ".json")
  })
  for (const kind of [...(lifecycleTargets ? ["launches"] : []), ...(catalogTargets ? ["catalog/probe-launches"] : [])]) await records(kind, raw => {
    const record = parseLaunchRecord(raw, false)
    if (record.version !== 2) { if ([...targets].some(path => path.startsWith("agents/") || path.startsWith("launches/"))) cleanupError(); return }
    if (record.owner.kind === "agent") references.push(agentPath(record.owner.agentId))
    else references.push("catalog/probe-meta/" + record.launchAttemptId + ".json")
  })
  const current = catalogTargets ? await readBoundedFile(join(input.root, "catalog/current.json"), 1048576, true) : null
  if (current) references.push(snapshotPath(id((decodeJson(current) as { snapshotId: unknown }).snapshotId)))
  if (references.some(path => targets.has(path))) cleanupError()
  const covered = new Set(intent.launches.map(entry => entry.path))
  if (intent.entries.some(entry => (entry.path.startsWith("launches/") || entry.path.startsWith("catalog/probe-launches/")) && !covered.has(entry.path))) cleanupError()
}

export function createRetentionCoordinator(input: { root: string; hostId: string; generation: string; queue: MutationQueue; adapter: PlatformAdapter; store: RetentionStore; catalogStore: CatalogStore; agentStore: AgentStore; mutations: HandlerMutations; catalog: CatalogService; agents: AgentService; now?: () => number }): RetentionCoordinator {
  const issues = new Set<string>()
  let requested = false
  const note = (error: unknown) => { const message = String(error); issues.add(/^[\x20-\x7e]+$/.test(message) ? message.slice(0, 480) : "unsafe cleanup evidence") }
  const pins = () => [...input.catalog.retentionPins().paths, ...input.agents.retentionPins().paths]
  const removed = (entry: RemovalEvidence) => { input.catalogStore.forgetRemoved(entry); input.agentStore.forgetRemoved(entry); input.catalog.forgetRemoved(entry); input.agents.forgetRemoved(entry); forgetRemovedLaunch(input.mutations, entry) }
  const resume = () => input.store.resume({ authorize: intent => authorizeRetirement({ ...input, pins: pins() }, intent), removed })
  async function sweepLocked(): Promise<void> {
    issues.clear()
    try { await resume() } catch (error) { note(error); return }
    try {
      const [catalog, agents, launches, shutdown] = await Promise.all([input.catalogStore.inventory(), input.agentStore.inventory(), inventoryLaunchState(join(input.root, "launches"), input.store.view, input.root), readShutdownInventory(input.root, input.store.view)])
      if (agents.issues.length || launches.issues.length || shutdown.issues.length || input.mutations.issues?.length || agents.legacyAgents.length) { note("unresolved lifecycle inventory prevents cleanup"); return }
      const nodes = new Map<string, RetentionNode>(), allLaunches = [...launches.records, ...catalog.launches]
      const add = (path: string, references: string[], retained: boolean, removable = true) => { if (nodes.has(path)) cleanupError(); nodes.set(path, { path, references, retained, removable }) }
      const retainedLaunches = new Set<string>()
      for (const entry of allLaunches) {
        const path = relative(input.root, entry.path)
        let safe = false
        try { await verifyRetirementAbsence(input.adapter, [entry], []); safe = true } catch { retainedLaunches.add(path) }
        add(path, [], !safe, safe && entry.record.version === 2)
      }
      const agentCommands = new Map(agents.commands.map(command => [command.commandId, command]))
      for (const agent of agents.agents) {
        if (agent.definition.hostId !== input.hostId) cleanupError()
        const associated = agents.commands.filter(command => command.target?.agentId === agent.definition.agentId)
        const related = allLaunches.filter(entry => entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === agent.definition.agentId)
        const terminal = associated.every(command => command.state !== "pending") && related.every(entry => !retainedLaunches.has(relative(input.root, entry.path)))
        const times = terminal ? await input.agentStore.terminalTimes(agent.definition.agentId, associated.map(command => command.commandId)) : null
        const expired = !agent.session && ["failed", "interrupted"].includes(agent.phase) && times !== null && expiredFailure((input.now ?? Date.now)(), times)
        const creation = agentCommands.get(agent.definition.createdCommandId), latest = agentCommands.get(agent.launch.commandId)
        if (!creation || creation.op !== "start" || creation.target?.agentId !== agent.definition.agentId || !latest || !isDeepStrictEqual(latest.target, tupleOfRecord(agent))) cleanupError()
        const references = [commandPath(agent.definition.createdCommandId), commandPath(agent.launch.commandId)]
        if (nodes.has(launchPath(agent.launch.launchAttemptId))) references.push(launchPath(agent.launch.launchAttemptId))
        else if (agent.session) cleanupError()
        add(agentPath(agent.definition.agentId), references, !expired)
      }
      for (const command of agents.commands) {
        if (command.hostId !== input.hostId) cleanupError()
        const references: string[] = []
        if (command.target) {
          if (nodes.has(agentPath(command.target.agentId))) references.push(agentPath(command.target.agentId))
          else if (command.state === "completed") cleanupError()
          const matches = launches.records.filter(entry => entry.record.version === 2 && entry.record.owner.kind === "agent" && entry.record.owner.agentId === command.target!.agentId && entry.record.owner.providerGeneration === command.target!.providerGeneration && entry.record.handlerGeneration === command.target!.handlerGeneration)
          if (matches.length > 1) cleanupError()
          references.push(...matches.map(entry => relative(input.root, entry.path)))
          if (!matches.length && command.target && command.state === "completed" && command.result?.outcome !== "failed") cleanupError()
        }
        add(commandPath(command.commandId), references, command.handlerGeneration === input.generation || command.state === "pending")
      }
      for (const entry of launches.records) if (retainedLaunches.has(relative(input.root, entry.path)) && entry.record.version === 2 && entry.record.owner.kind === "agent" && nodes.has(agentPath(entry.record.owner.agentId))) nodes.get(relative(input.root, entry.path))!.references = [agentPath(entry.record.owner.agentId)]
      const catalogUnsafe = catalog.issues.length > 0
      if (catalogUnsafe) note("unresolved catalog inventory prevents catalog cleanup")
      const current = await input.catalogStore.readCurrent()
      for (const snapshot of catalog.snapshots) add(snapshotPath(snapshot.snapshotId), [], catalogUnsafe || current?.snapshotId === snapshot.snapshotId)
      const metas = new Map(catalog.metadata.map(meta => [meta.attemptId, meta]))
      for (const kind of ["commands", "automatic"] as const) for (const command of catalog[kind]) {
        if (command.hostId !== input.hostId) cleanupError()
        const references = command.snapshotId ? [snapshotPath(command.snapshotId)] : []
        if (command.state === "pending") for (const attempt of command.attempts) for (const path of ["catalog/probe-meta/" + attempt.attemptId + ".json", "catalog/probe-launches/" + attempt.attemptId + ".json"]) if (nodes.has(path) || metas.has(attempt.attemptId)) references.push(path)
        add("catalog/" + kind + "/" + command.commandId + ".json", references, catalogUnsafe || command.state === "pending" || kind === "commands" && command.handlerGeneration === input.generation)
      }
      for (const meta of catalog.metadata) {
        const path = "catalog/probe-meta/" + meta.attemptId + ".json", launch = "catalog/probe-launches/" + meta.attemptId + ".json", work = "catalog/work/" + meta.attemptId
        const references = ["catalog/" + (meta.version === 3 && meta.receiptKind === "automatic" ? "automatic" : "commands") + "/" + meta.commandId + ".json"]
        if (nodes.has(launch)) { references.push(launch); nodes.get(launch)!.references = [path] }
        else if (!catalogUnsafe) cleanupError()
        try { await lstat(join(input.root, work)); add(work, [path], catalogUnsafe); references.push(work) } catch (error) { if (!absent(error)) throw error }
        add(path, references, catalogUnsafe || retainedLaunches.has(launch))
      }
      for (const entry of catalog.launches) if (!metas.has(entry.record.launchAttemptId)) { const node = nodes.get(relative(input.root, entry.path))!; node.retained = true; node.removable = false }
      for (const receipt of shutdown.receipts) {
        if (receipt.hostId !== input.hostId) cleanupError()
        let safe = false
        try { await verifyRetirementAbsence(input.adapter, [], [receipt.handlerIdentity]); safe = true } catch { }
        add("shutdown/" + receipt.commandId + ".json", [], receipt.handlerGeneration === input.generation || !safe, safe)
      }
      const knownPins = pins().filter(path => nodes.has(path))
      const candidates = new Set(reclaimable([...nodes.values()], knownPins)), neighbors = new Map([...candidates].map(path => [path, new Set<string>()]))
      for (const path of candidates) for (const ref of nodes.get(path)!.references) if (candidates.has(ref)) { neighbors.get(path)!.add(ref); neighbors.get(ref)!.add(path) }
      while (candidates.size) {
        const group: string[] = [], pending = [candidates.values().next().value!]
        while (pending.length) { const path = pending.pop()!; if (!candidates.delete(path)) continue; group.push(path); pending.push(...neighbors.get(path)!) }
        const groupSet = new Set(group), witnesses = allLaunches.filter(entry => groupSet.has(relative(input.root, entry.path))), handlers = shutdown.receipts.filter(receipt => groupSet.has("shutdown/" + receipt.commandId + ".json")).map(receipt => receipt.handlerIdentity)
        try { await input.store.prepare({ paths: group, launches: witnesses, handlers }); await resume() }
        catch (error) { note(error); if (await input.store.pending()) return }
      }
    } catch (error) { note(error) }
  }
  return { diagnostics: () => [...issues].sort().slice(0, 32), sweepLocked, initialize: () => input.queue.run(sweepLocked), request() {
    if (requested) return
    requested = true
    void input.queue.run(async () => { try { await sweepLocked() } finally { requested = false } }).catch(note)
  } }
}