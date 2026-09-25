import { homedir } from "node:os"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createDarwinAdapter } from "../platform/darwin.js"
import { createLinuxAdapter } from "../platform/linux.js"
import { readHostId } from "../platform/host-id.js"
import { resolvePlatformPaths, type PlatformPaths } from "../platform/paths.js"
import { assertPrivateDirectory } from "../platform/private-state.js"
import type { PlatformAdapter } from "../platform/types.js"
import { ControlError } from "../control/protocol.js"

export type HandlerEnvironment = { paths: PlatformPaths; adapter: PlatformAdapter }

export function assertRuntime(version: string, platform: string): asserts platform is "darwin" | "linux" {
  if (version !== "24.13.0") throw new ControlError("UNAVAILABLE", "Agency requires Node 24.13.0")
  if (platform !== "darwin" && platform !== "linux") throw new ControlError("UNAVAILABLE", "unsupported platform")
}

export async function ensurePrivateChild(parent: string, name: string): Promise<string> {
  await assertPrivateDirectory(parent)
  if (name !== "launches" && name !== "shutdown" && name !== "admissions") throw new Error("unsupported state directory")
  const path = join(parent, name)
  try { await mkdir(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
  await assertPrivateDirectory(path)
  return path
}

export async function productionEnvironment(): Promise<HandlerEnvironment> {
  const platform = process.platform
  assertRuntime(process.versions.node, platform)
  const adapter = platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
  const hostKey = await readHostId(platform)
  const paths = await resolvePlatformPaths({ platform, uid: process.getuid!(), hostKey, home: process.env.HOME ?? homedir(), ...(process.env.XDG_STATE_HOME === undefined ? {} : { xdgStateHome: process.env.XDG_STATE_HOME }) })
  await ensurePrivateChild(paths.persistentRoot, "launches")
  return { paths, adapter }
}