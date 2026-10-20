import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

export type BuildManifest = { version: 1; nodeVersion: string; sourceDigest: string; distDigest: string; sourceRevision?: string }
async function digest(root: string, entries: string[]): Promise<string> {
  const hash = createHash("sha256")
  async function visit(path: string): Promise<void> {
    if (relative(root, path) === "dist/build-manifest.json") return
    const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error })
    if (info === null) return
    if (info.isSymbolicLink()) throw new Error("BUILD_SYMLINK")
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry))
    } else if (info.isFile()) {
      const bytes = await readFile(path), name = relative(root, path)
      hash.update(JSON.stringify([name, bytes.length]) + "\0").update(bytes)
    } else throw new Error("BUILD_FILE_TYPE")
  }
  for (const entry of entries) await visit(join(root, entry))
  return hash.digest("hex")
}
export async function captureBuildManifest(root: string): Promise<BuildManifest> {
  return { version: 1, nodeVersion: process.version, sourceDigest: await digest(root, ["src", "test", "scripts", "package.json", "package-lock.json", "tsconfig.json", "../tests/neovim", "../home/.config/nvim"]), distDigest: await digest(root, ["dist"]) }
}
export async function publishBuildManifest(root: string, manifest: BuildManifest): Promise<void> {
  await writeFile(join(root, "dist/build-manifest.json"), JSON.stringify(manifest), { mode: 0o600 })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  if (process.version !== "v24.13.0") throw new Error("NODE_VERSION")
  const sourceRevision = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5000 })).stdout.trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceRevision)) throw new Error("BUILD_REVISION")
  await publishBuildManifest(root, { ...await captureBuildManifest(root), sourceRevision })
}