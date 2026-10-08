import { createHash } from "node:crypto"
import { lstat, readFile, readdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

export type BuildManifest = { version: 1; nodeVersion: string; sourceDigest: string; distDigest: string }
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
export async function verifyBuildManifest(root: string): Promise<boolean> {
  try {
    const recorded = JSON.parse(await readFile(join(root, "dist/build-manifest.json"), "utf8")), current = await captureBuildManifest(root)
    return recorded.version === 1 && recorded.nodeVersion === current.nodeVersion && recorded.sourceDigest === current.sourceDigest && recorded.distDigest === current.distDigest
  } catch { return false }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  if (process.version !== "v24.13.0") throw new Error("NODE_VERSION")
  await publishBuildManifest(root, await captureBuildManifest(root))
}