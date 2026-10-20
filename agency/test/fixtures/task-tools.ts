import { fileURLToPath } from "node:url"
import { runTaskToolsCli } from "../../src/tasks/tools-cli.js"
import { parseTaskRef } from "../../src/tasks/types.js"
import { productionControlDependencies } from "../../src/cli/control.js"
import type { PlatformPaths } from "../../src/platform/paths.js"
import { createDarwinAdapter } from "../../src/platform/darwin.js"
import { createLinuxAdapter } from "../../src/platform/linux.js"
if (process.argv[2] !== fileURLToPath(new URL("../../src/main.js", import.meta.url)) || process.argv[3] !== "internal-task-tools" || process.argv.length !== 5) throw new Error("unexpected task helper descriptor")
const paths = JSON.parse(process.argv[4]!) as PlatformPaths, raw = process.env.AGENCY_TASK_REF
const defaultRef = raw === undefined ? undefined : parseTaskRef(JSON.parse(raw))
const adapter = process.platform === "darwin" ? createDarwinAdapter() : createLinuxAdapter()
await runTaskToolsCli([], { input: process.stdin, output: process.stdout, control: { ...productionControlDependencies(), environment: async () => ({ paths, adapter }) }, ...(defaultRef ? { defaultRef } : {}) })