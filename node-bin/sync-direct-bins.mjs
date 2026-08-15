import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? scriptDir);
const packageJsonPath = path.join(root, "package.json");
const nodeModulesDir = path.join(root, "node_modules");
const binDir = path.join(root, "bin");

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const packageJson = await readJson(packageJsonPath);
const dependencyNames = Object.keys({
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.devDependencies ?? {}),
  ...(packageJson.optionalDependencies ?? {}),
}).sort();

const binaryNameForPackage = (packageName) => packageName.split("/").at(-1);

const entries = [];
for (const dependencyName of dependencyNames) {
  const dependencyRoot = path.join(nodeModulesDir, dependencyName);
  const dependencyPackageJson = await readJson(path.join(dependencyRoot, "package.json"));
  const bin = dependencyPackageJson.bin;

  if (!bin) continue;

  if (typeof bin === "string") {
    entries.push([binaryNameForPackage(dependencyPackageJson.name ?? dependencyName), dependencyRoot, bin]);
    continue;
  }

  for (const [binaryName, binaryPath] of Object.entries(bin).sort(([a], [b]) => a.localeCompare(b))) {
    entries.push([binaryName, dependencyRoot, binaryPath]);
  }
}

await fs.rm(binDir, { recursive: true, force: true });
await fs.mkdir(binDir, { recursive: true });

for (const [binaryName, dependencyRoot, binaryPath] of entries) {
  const source = path.join(dependencyRoot, binaryPath);
  const destination = path.join(binDir, binaryName);
  const linkTarget = path.relative(binDir, source);
  await fs.symlink(linkTarget, destination);
}
