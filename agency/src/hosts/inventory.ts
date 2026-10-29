import { absolutePath, hash, id, keys, object, text } from "../catalog/types.js"
import { createInventoryStore } from "./inventory-store.js"

export type HostEnrollment = { hostId: string; hostname: string }
export function parseHostEnrollment(raw: unknown): HostEnrollment {
  const v = object(raw); keys(v, ["hostId", "hostname"])
  const hostname = text(v.hostname)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(hostname)) throw new Error("INVALID_HOSTNAME")
  return { hostId: hash(v.hostId), hostname }
}
function storedEnrollment(raw: unknown): HostEnrollment {
  const value = object(raw)
  if (Object.hasOwn(value, "inventoryId")) {
    keys(value, ["inventoryId", "hostId", "hostname", "agyPath", "loginShell"])
    id(value.inventoryId); absolutePath(value.agyPath); absolutePath(value.loginShell)
    return parseHostEnrollment({ hostId: value.hostId, hostname: value.hostname })
  }
  return parseHostEnrollment(raw)
}
export function createHostInventory(root: string) {
  const storage = createInventoryStore(root)
  let pending: Promise<unknown> = Promise.resolve()
  const queue = { run<T>(action: () => Promise<T>): Promise<T> { const result = pending.then(action); pending = result.catch(() => undefined); return result } }
  async function list() {
    const hosts = await Promise.all((await storage.names()).map(async name => {
      const host = storedEnrollment(await storage.read(name))
      if (name.length === 69 && name !== `${host.hostId}.json`) throw new Error("HOST_IDENTITY_CHANGED")
      return host
    }))
    if (new Set(hosts.map(host => host.hostId)).size !== hosts.length || new Set(hosts.map(host => host.hostname)).size !== hosts.length) throw new Error("HOST_IDENTITY_CONFLICT")
    return hosts
  }
  return {
    list,
    enroll(raw: HostEnrollment) { return queue.run(async () => {
      const enrollment = parseHostEnrollment(raw), existing = await list(), prior = existing.find(value => value.hostname === enrollment.hostname)
      if (prior && prior.hostId !== enrollment.hostId) throw new Error("HOST_IDENTITY_CHANGED")
      if (existing.some(value => value.hostId === enrollment.hostId && value.hostname !== enrollment.hostname)) throw new Error("HOST_IDENTITY_CONFLICT")
      if (prior) return
      await storage.publish(`${enrollment.hostId}.json`, enrollment)
    }) }
  }
}