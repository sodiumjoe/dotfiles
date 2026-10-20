import type { Readable, Writable } from "node:stream"
import { productionControlDependencies, type ControlDependencies } from "../cli/control.js"
import { openHostAccess } from "../hosts/cli.js"
import { serveMcp } from "../mcp/server.js"
import { createHostTaskClient } from "./client.js"
import { createTaskToolBindings, taskToolSchemas } from "./mcp.js"
import { invalidTask, parseTaskRef, type TaskRef } from "./types.js"
export async function runTaskToolsCli(argv: readonly string[], input: { input: Readable; output: Writable; control: ControlDependencies; defaultRef?: TaskRef }): Promise<void> {
  if (argv.length) invalidTask()
  const defaultRef = input.defaultRef === undefined ? undefined : parseTaskRef(input.defaultRef)
  const access = await openHostAccess(input.control), client = createHostTaskClient({ localHostId: access.env.paths.hostKey, route: access.route })
  try {
    const bindings = createTaskToolBindings({ client, ...(defaultRef ? { defaultRef } : {}) })
    await serveMcp({ input: input.input, output: input.output, schemas: taskToolSchemas, call: bindings.call, serverInfo: { name: "agency_tasks", version: "1.0.0" } })
  } finally { client.close(); access.close() }
}
export async function runProductionTaskTools(argv: readonly string[]): Promise<void> {
  const raw = process.env.AGENCY_TASK_REF, defaultRef = raw === undefined ? undefined : parseTaskRef(JSON.parse(raw))
  await runTaskToolsCli(argv, { input: process.stdin, output: process.stdout, control: productionControlDependencies(), ...(defaultRef ? { defaultRef } : {}) })
}