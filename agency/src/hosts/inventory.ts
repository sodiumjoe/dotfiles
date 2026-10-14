import { absolutePath, hash, id, keys, object, text } from "../catalog/types.js"
import { createInventoryStore } from "./inventory-store.js"

export type HostEnrollment = { inventoryId: string; hostId: string; hostname: string; agyPath: string; loginShell: string }
export function parseHostEnrollment(raw: unknown): HostEnrollment {
  const v = object(raw); keys(v, ["inventoryId", "hostId", "hostname", "agyPath", "loginShell"])
  const hostname = text(v.hostname)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(hostname)) throw new Error("INVALID_HOSTNAME")
  return { inventoryId: id(v.inventoryId), hostId: hash(v.hostId), hostname, agyPath: absolutePath(v.agyPath), loginShell: absolutePath(v.loginShell) }
}
export function createHostInventory(root: string) {
  const storage = createInventoryStore(root)
  let pending: Promise<unknown> = Promise.resolve()
  const queue = { run<T>(action: () => Promise<T>): Promise<T> { const result = pending.then(action); pending = result.catch(() => undefined); return result } }
  async function list() { return Promise.all((await storage.names()).map(async name => parseHostEnrollment(await storage.read(name)))) }
  return {
    list,
    enroll(raw: HostEnrollment) { return queue.run(async () => {
      const enrollment = parseHostEnrollment(raw), existing = await list(), prior = existing.find(value => value.inventoryId === enrollment.inventoryId)
      if (prior && prior.hostId !== enrollment.hostId) throw new Error("HOST_IDENTITY_CHANGED")
      if (existing.some(value => value.inventoryId !== enrollment.inventoryId && value.hostname === enrollment.hostname)) throw new Error("HOSTNAME_CONFLICT")
      if (existing.some(value => value.inventoryId !== enrollment.inventoryId && value.hostId === enrollment.hostId)) throw new Error("HOST_IDENTITY_CONFLICT")
      await storage.publish(`${enrollment.inventoryId}.json`, enrollment)
    }) }
  }
}