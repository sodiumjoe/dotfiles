import { createHandlerBridge } from "../src/bridge/server.js"
import { attachTaskBridge } from "../src/bridge/task-server.js"

export async function createTaskHandlerBridge(input: Omit<Parameters<typeof attachTaskBridge>[0], "bridge"> & { root: string; sourceRevision?: string }) {
  const { hostId, handlerGeneration } = await input.host.snapshot()
  const identity = { hostId, handlerGeneration }
  const bridge = await createHandlerBridge({ root: input.root, identity, ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}) })
  try {
    const adapter = await attachTaskBridge({ ...input, bridge })
    return { ...bridge, coordinatorRequest: adapter.coordinatorRequest, async close() { await adapter.close(); await bridge.close() } }
  } catch (error) { await bridge.close(); throw error }
}