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
  const localSource = createLocalOrigins(input.hostId, origins), sources: OriginSource[] = [{ ...localSource, async list() { const keys = await localSource.list(); const owned = await Promise.all(keys.map(async key => await store.readRun(key.runId) ? key : null)); return owned.filter((key): key is NonNullable<typeof key> => key !== null) } }]
  const remote = (await createHostInventory(input.root).list()).map(enrollment => {
    const mirror = createRemoteOrigins(input.root, enrollment.hostId)
    const host = createRemoteHost({ enrollment, origins: mirror, ...(input.connect ? { connect: () => input.connect!(enrollment) } : {}), onTool: (payload, signal) => router.dispatch(payload, signal, enrollment.hostId) })
    sources.push(host.originSource!)
    return host
  })
  const hosts = [origin, ...remote], ownedOrigins = { ...origins, async list() { return (await sources[0]!.list()).map(key => key.runId) } }
  bureau = createBureauService({ store, journals, origins: ownedOrigins, originSources: sources, hosts, notifications: true })
  router = createToolRouter({ root: input.root, bureau, hosts, origins: sources, journals: origins })
  await bureau.initialize().catch(() => undefined)
  return { bureau, origin, origins, tools, remote, async replay() { await outbox.replay(); await origin.replay() }, async close() { await bureau.close(); tools.close(); await Promise.all(remote.map(host => host.close())) } }
}