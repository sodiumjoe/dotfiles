import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const originalHash = "afffcfeb6ae3a82f2b359a7d3d6a1a3ceee43898b59c34335eb1760974cc4ff8";
const patchedHash = "865e8e60cf840e516333a0a86f6b48b2d312da359c2c1ee4111db444d2b4e718";
const replacements = [
  [
    `      threadResolvers.set(turnId, resolve);`,
    `      const resolvers = threadResolvers.get(turnId) ?? new Set();
      resolvers.add(resolve);
      threadResolvers.set(turnId, resolvers);`
  ],
  [
    `    const resolve = threadResolvers?.get(event.turn.id);
    if (resolve) {
      threadResolvers.delete(event.turn.id);
      if (threadResolvers.size === 0) {
        this.pendingTurnCompletionResolvers.delete(event.threadId);
      }
      resolve(event);
      return;
    }`,
    `    const resolvers = threadResolvers?.get(event.turn.id);
    if (resolvers) {
      threadResolvers.delete(event.turn.id);
      if (threadResolvers.size === 0) {
        this.pendingTurnCompletionResolvers.delete(event.threadId);
      }
      for (const resolve of resolvers) resolve(event);
    }`
  ]
];

export async function patchCodexAcp(packageRoot = fileURLToPath(new URL("node_modules/@agentclientprotocol/codex-acp/", import.meta.url))) {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.name !== "@agentclientprotocol/codex-acp" || metadata.version !== "1.7.0") {
    throw new Error("Unsupported codex-acp package: expected @agentclientprotocol/codex-acp 1.7.0");
  }
  const bundle = path.join(packageRoot, "dist/index.js");
  const source = await readFile(bundle, "utf8");
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash === patchedHash) return;
  if (hash !== originalHash) throw new Error("Unsupported codex-acp source: expected pristine 1.7.0 or the exact overlap patch");
  let patched = source;
  for (const [before, after] of replacements) {
    if (patched.split(before).length !== 2) throw new Error("Unsupported codex-acp source: ambiguous overlap patch");
    patched = patched.replace(before, after);
  }
  const temporary = bundle + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, patched, { flag: "wx", mode: 0o600 });
    await chmod(temporary, (await stat(bundle)).mode & 0o777);
    await rename(temporary, bundle);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (import.meta.main) {
  await patchCodexAcp();
}