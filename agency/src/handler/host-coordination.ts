import { createBureauPermissions } from "../bureau/permissions.js"
import { parseHumanControl } from "../bureau/human-controls.js"
import { object, keys } from "../catalog/types.js"
import { storageQueue } from "../orchestration/storage.js"
import { isDeepStrictEqual } from "node:util"
import { join } from "node:path"
import type { AgentService } from "../agent/service.js"
import { createHostInventory, type HostEnrollment } from "../bureau/hosts.js"
import { createBureauService } from "../bureau/service.js"
import { createBureauStore } from "../bureau/store.js"
import { createLocalOrigins, createRemoteOrigins, type OriginSource } from "../bureau/origins.js"
import { createRemoteHost } from "../bureau/remote-host.js"
import { createRoutedToolOutbox, createToolRouter } from "../bureau/tool-routing.js"
import type { BridgeConnection } from "../bridge/ssh.js"
import { createJournalPool } from "../orchestration/journal.js"
import { createLineageStore } from "../orchestration/lineage.js"
import { createOrchestrationService } from "../orchestration/service.js"
import { createToolBindings } from "../orchestration/tool-bindings.js"
import { parseAcceptedReport } from "../orchestration/reports.js"

export async function createHostCoordination(input: { root: string; runtimeRoot: string; hostId: string; agents: AgentService; coordinator(payload: unknown, signal?: AbortSignal): Promise<unknown>; connect?(enrollment: HostEnrollment): Promise<BridgeConnection> }) {
  const origins = createJournalPool(input.root, undefined, Date.now, "origin"), journals = createJournalPool(input.root), store = createBureauStore(input.root)
  let bureau: ReturnType<typeof createBureauService>, origin: ReturnType<typeof createOrchestrationService>, router: ReturnType<typeof createToolRouter>
  const outbox = createRoutedToolOutbox({ root: input.root, send: input.coordinator })
  const tools = createToolBindings({ socketPath: join(input.runtimeRoot, "orchestration.sock"), journals: origins, bureau: () => bureau, host: () => origin, route: outbox.call, cancelRoute: async request => { const result = await outbox.call({ kind: "cancel", ...request }); if (result.isError) throw new Error(result.content[0]!.text) } })
  origin = createOrchestrationService({ root: input.root, hostId: input.hostId, agents: input.agents, journals: origins, lineage: createLineageStore(input.root), tools, async relay(envelope) {
    if ((await bureau.list()).some(run => run.runId === envelope.input.runId)) return bureau.acceptReport(envelope)
    const receipt = await input.coordinator({ kind: "report", envelope })
    return parseAcceptedReport({ ...envelope, receipt }).receipt
  } })
  const localSource = createLocalOrigins(input.hostId, origins), sources: OriginSource[] = [{ ...localSource, async list() { const keys = await localSource.list(); const owned = await Promise.all(keys.map(async key => await ownsRun(key.runId) ? key : null)); return owned.filter((key): key is NonNullable<typeof key> => key !== null) } }]
  const inventory = createHostInventory(input.root), remote: ReturnType<typeof createRemoteHost>[] = [], hosts = [origin] as import("../bureau/host.js").OrchestrationHost[]
  const ownsRun = (runId: string) => storageQueue(input.root).run(async () => !!await store.readRun(runId))
  const attach = (enrollment: HostEnrollment) => {
    const mirror = createRemoteOrigins(input.root, enrollment.hostId)
    const host = createRemoteHost({ enrollment, onHuman: async payload => { const v = object(payload); keys(v, ["kind", "operation"]); if (v.kind !== "human") throw new Error("UNSUPPORTED_HUMAN_CONTROL"); return human(v.operation) }, origins: mirror, managed: true, ownsRun, ...(input.connect ? { connect: () => input.connect!(enrollment) } : {}), onTool: (payload, signal) => router.dispatch(payload, signal, enrollment.hostId), async onReady(peer) {
      if (!(await bureau.status()).enabled) return
      await bureau.reconcile()
      if (peer.hello.capabilities.includes("replay")) await peer.request("replay", {}, { timeoutMs: 0 })
    } })
    const source = host.originSource!
    sources.push({ ...source, async list() { const owned = []; for (const key of await source.list()) if (await ownsRun(key.runId)) owned.push(key); return owned } })
    remote.push(host); hosts.push(host)
    return host
  }
  for (const enrollment of await inventory.list()) attach(enrollment)
  const ownedOrigins = { ...origins, async list() { return (await sources[0]!.list()).map(key => key.runId) } }
  bureau = createBureauService({ store, journals, origins: ownedOrigins, originSources: sources, hosts, notifications: true, enrollment: {
    async enroll(value) {
      const prior = (await inventory.list()).find(entry => entry.inventoryId === value.inventoryId)
      await inventory.enroll(value)
      if (prior && isDeepStrictEqual(prior, value)) return
      if (prior) {
        const index = remote.findIndex(host => host.hostId === prior.hostId), host = remote[index]!
        await host.close(); remote.splice(index, 1); hosts.splice(hosts.indexOf(host), 1); sources.splice(sources.findIndex(source => source.hostId === prior.hostId), 1)
      }
      attach(value)
    },
    async list() { return (await inventory.list()).map(enrollment => ({ enrollment, observation: remote.find(host => host.hostId === enrollment.hostId)!.observation() })) }
  } })
  let humanEnabled = false
  const permissions = createBureauPermissions({ root: input.root, hosts, enabled: () => humanEnabled })
  async function human(raw: unknown): Promise<unknown> {
    const operation = parseHumanControl(raw), status = await bureau.status()
    humanEnabled = status.enabled && status.ready && status.writeAvailable
    if (!humanEnabled) return input.coordinator({ kind: "human", operation })
    switch (operation.op) {
      case "permission_snapshot": return permissions.snapshot()
      case "permission_decide": return permissions.decide(operation.commandId, operation.ref, operation.optionId)
      case "permission_inspect": return permissions.inspect(operation.commandId)
    }
  }
  router = createToolRouter({ root: input.root, bureau, hosts, origins: sources, journals: origins })
  await bureau.initialize().catch(() => undefined)
  return { bureau, origin, origins, tools, remote, human, async replay() { try { await outbox.replay() } finally { await origin.replay() } }, async close() { await bureau.close(); tools.close(); await Promise.all(remote.map(host => host.close())) } }
}