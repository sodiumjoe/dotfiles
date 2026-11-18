export type RemoteListing = { at: number; complete: boolean; names: Map<string, string | null> }
export type RemoteListingSource = { latest(): RemoteListing | null; attemptedAt(): number | null; request(maxAgeMs: number): void }

export function parseRemoteListing(stdout: string, at: number): RemoteListing {
  let value: unknown
  try { value = JSON.parse(stdout) } catch { throw new Error("INVALID_LISTING") }
  if (!Array.isArray(value)) throw new Error("INVALID_LISTING")
  const names = new Map<string, string | null>()
  let complete = true
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("INVALID_LISTING")
    const { host, name, status } = entry as Record<string, unknown>
    if (typeof host !== "string" || !host) { if (status !== "scheduledfordeletion") complete = false; continue }
    const label = typeof name === "string" && name.trim() && !/[\x00-\x1f\x7f]/.test(name) ? name : null
    names.set(host, names.has(host) && names.get(host) !== label ? null : label)
  }
  return { at, complete, names }
}

export function createRemoteListing(input: { run(): Promise<string>; onFailure?(message: string): void; timeoutMs?: number }): RemoteListingSource {
  const timeoutMs = input.timeoutMs ?? 30000
  let latest: RemoteListing | null = null, attemptedAt: number | null = null, running = false
  return {
    latest: () => latest,
    attemptedAt: () => attemptedAt,
    request(maxAgeMs) {
      if (running || attemptedAt !== null && Date.now() - attemptedAt < maxAgeMs) return
      const at = Date.now()
      running = true; attemptedAt = at
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("LISTING_TIMEOUT")), timeoutMs); timer.unref() })
      void Promise.race([input.run(), deadline]).then(stdout => { latest = parseRemoteListing(stdout, at) })
        .catch(error => input.onFailure?.(error instanceof Error ? error.message : String(error)))
        .finally(() => { clearTimeout(timer); running = false })
    },
  }
}