import { normalizeCodex } from "../normalize.js"
import type { ProbeResult } from "../probes.js"
import { CatalogError, invalid, object, text } from "../types.js"
import { jsonRpc, type DriverContext } from "./transport.js"

export async function discoverCodex(context: DriverContext): Promise<ProbeResult> {
  if (context.signal.aborted) throw new CatalogError("PROBE_FAILED")
  const child = context.spawnNative(context.request.profile.executable, ["app-server"]), rpc = jsonRpc(child, context.signal)
  try {
    const initialized = object(await rpc.request("initialize", { clientInfo: { name: "agency-catalog", title: "Agency model catalog", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } }))
    const providerVersion = initialized.serverInfo === undefined || object(initialized.serverInfo).version === undefined ? null : text(object(initialized.serverInfo).version)
    rpc.notify("initialized")
    const rows: unknown[] = [], cursors = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < 16; page++) {
      const result = object(await rpc.request("model/list", { cursor, limit: 100 }))
      if (!Array.isArray(result.data) || rows.length + result.data.length > 512) invalid()
      rows.push(...result.data)
      if (result.nextCursor === null) {
        await new Promise<void>(resolve => setImmediate(resolve))
        rpc.check()
        return { models: normalizeCodex(rows), providerVersion, providerVersionSource: providerVersion === null ? "unknown" : "reported" }
      }
      cursor = text(result.nextCursor, 1024)
      if (cursors.has(cursor)) invalid()
      cursors.add(cursor)
    }
    return invalid()
  } catch (error) { if (error instanceof CatalogError) throw error; throw new CatalogError("PROBE_FAILED") }
  finally { rpc.close() }
}