import { isDeepStrictEqual } from "node:util"
import { object, keys } from "../catalog/types.js"
import { createStorage, storageQueue, defaultFileSystem } from "./storage.js"
import { fail, parseAgentRef, parseLineage, type AgentRef, type Lineage } from "./types.js"

export function createLineageStore(root: string, filesystem = defaultFileSystem) {
  const storage = createStorage(root, "orchestration", filesystem), queue = storageQueue(root)
  const key = (agent: AgentRef) => { const ref = parseAgentRef(agent); return `lineage/${ref.hostId}-${ref.agentId}.json` }
  const read = async (agent: AgentRef): Promise<Lineage | null> => {
    const raw = await storage.read(key(agent)); if (raw === null) return null
    const v = object(raw); keys(v, ["agent", "lineage"])
    if (!isDeepStrictEqual(parseAgentRef(v.agent), agent)) fail()
    return parseLineage(v.lineage)
  }
  return {
    read,
    async publish(agent: AgentRef, lineage: Lineage, expected: Lineage | null): Promise<void> {
      const ref = parseAgentRef(agent), value = parseLineage(lineage)
      if (isDeepStrictEqual(ref, value.parent)) fail("LINEAGE_CYCLE")
      await queue.run(async () => {
        const previous = await read(ref)
        if (previous && !isDeepStrictEqual(previous, value)) fail("COMMAND_CONFLICT")
        if (!isDeepStrictEqual(previous, expected) && !isDeepStrictEqual(previous, value)) fail("COMMAND_CONFLICT")
        const seen = new Set<string>([key(ref)])
        let parent: AgentRef | null = value.parent
        while (parent !== null) {
          const parentKey = key(parent); if (seen.has(parentKey)) fail("LINEAGE_CYCLE"); seen.add(parentKey)
          const edge = await read(parent)
          if (edge && edge.runId !== value.runId) fail("CROSS_RUN_PARENT")
          parent = edge?.parent ?? null
        }
        await storage.publish(key(ref), { agent: ref, lineage: value }, previous ? { agent: ref, lineage: previous } : null, true)
      })
    }
  }
}
export type LineageStore = ReturnType<typeof createLineageStore>