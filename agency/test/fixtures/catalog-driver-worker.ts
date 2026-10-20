import { runWorker } from "../../src/catalog/worker.js"
import { fixtureSpawner, finishFixtureSource } from "./fixture-spawn.js"
const launch = await fixtureSpawner()
await runWorker(async context => {
  if (context.request.profile.id === "claude-agent-acp") return (await import("../../src/catalog/drivers/claude.js")).discoverClaude(context)
  return (await import("../../src/catalog/drivers/codex.js")).discoverCodex(context)
}, { spawn: ((file, args, options) => launch("catalog-native", file, args ?? [], options ?? {})) as typeof import("node:child_process").spawn })
await finishFixtureSource()