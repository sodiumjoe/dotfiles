import { spawn } from "node:child_process"
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

export function runPayListing(options: { command?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 20000, maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const child = spawn(options.command ?? "pay", ["remote", "list", "-a", "--raw"], { detached: true, stdio: ["ignore", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let size = 0, stderr = "", settled = false
    const finish = (error: Error | null, stdout = "") => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (!error) { resolve(stdout); return }
      try { if (child.pid) process.kill(-child.pid, "SIGKILL") } catch {}
      child.stdout.destroy(); child.stderr.destroy()
      reject(error)
    }
    const timer = setTimeout(() => finish(new Error("LISTING_TIMEOUT")), timeoutMs)
    timer.unref()
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) finish(new Error("LISTING_TOO_LARGE")); else chunks.push(chunk) })
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-512) })
    child.on("error", error => finish(error))
    child.on("close", code => finish(code === 0 ? null : new Error(`pay exited with ${code}: ${stderr.trim()}`), Buffer.concat(chunks).toString()))
  })
}