import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseProfile } from "../catalog/config.js"
import { DiscoveryError } from "../catalog/diagnostics.js"
import { NativeFacade, type DriverContext, type RegisteredChild } from "../catalog/drivers/transport.js"
import type { Model, ProviderProfile } from "../catalog/types.js"
import { spawnOwnedChild } from "../runtime/owned-child.js"

const environment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(source).filter(([key]) => key !== "NODE_OPTIONS" && key !== "NODE_PATH" && !key.startsWith("AGENCY_") && !key.startsWith("GIT_")))

export async function listProviderModels(profile: ProviderProfile, signal: AbortSignal): Promise<Model[]> {
  const workPath = await mkdtemp(join(tmpdir(), "agency-models-")), children: RegisteredChild[] = []
  try {
    const spawnNative = (file: string, args: readonly string[]): RegisteredChild => {
      const owner = spawnOwnedChild({ launchAttemptId: randomUUID(), spawn: () => spawn(file, [...args], { cwd: workPath, env: environment(process.env), stdio: ["pipe", "pipe", "pipe"], detached: false, shell: false }) })
      owner.child.stderr?.resume()
      const child = new NativeFacade(owner, Promise.resolve(), () => { owner.child.kill("SIGTERM") })
      children.push(child)
      return child
    }
    const context: DriverContext = { signal, spawnNative, request: { profile, workPath } }
    const result = profile.id === "claude-agent-acp" ? await (await import("../catalog/drivers/claude.js")).discoverClaude(context) : await (await import("../catalog/drivers/codex.js")).discoverCodex(context)
    return result.models
  } finally {
    for (const child of children) child.requestCleanup()
    await rm(workPath, { recursive: true, force: true })
  }
}

export function describeDiscoveryFailure(error: unknown): string {
  if (error instanceof DiscoveryError) return error.message + " at " + error.detail.stage + (error.detail.method ? " (" + error.detail.method + ")" : "") + ": " + error.detail.message
  return error instanceof Error ? error.message : String(error)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const controller = new AbortController()
  process.once("SIGTERM", () => controller.abort())
  let reply: object
  try { reply = { ok: true, models: await listProviderModels(parseProfile(JSON.parse(Buffer.concat(chunks).toString("utf8"))), controller.signal) } }
  catch (error) { reply = { ok: false, message: describeDiscoveryFailure(error).slice(0, 2048) } }
  process.stdout.write(JSON.stringify(reply) + "\n", () => process.exit(0))
}