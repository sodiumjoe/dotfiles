import type { Readable, Writable } from "node:stream"
import { id } from "../catalog/types.js"
import { serveMcp as serve, type ToolResult } from "../mcp/server.js"
export { toolResult, type ToolResult } from "../mcp/server.js"
const uuid = { type: "string", format: "uuid" }, string = { type: "string" }, scope = { runId: uuid, bindingEpoch: uuid }, command = { ...scope, commandId: uuid }
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false })
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [{ type: "null" }, schema] })
const gitInput = closed({ remote: string, repository: string, baseOid: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" } })
const git = nullable(gitInput)
const gitReport = nullable(closed({ ...gitInput.properties, branch: string, resultOid: gitInput.properties.baseOid, published: { type: "boolean" }, publicationCommandId: uuid }, ["remote", "repository", "baseOid", "branch", "resultOid", "published"]))
const agent = closed({ hostId: { type: "string", pattern: "^[a-f0-9]{64}$" }, agentId: uuid })
const overrides = closed({ modeId: string, configValues: { type: "object", additionalProperties: { type: ["string", "boolean"] } } }, [])
const report = closed({ status: { enum: ["completed", "blocked", "failed"] }, summary: string, issues: { type: "array", items: string, maxItems: 128 }, validation: { type: "array", items: closed({ argv: { type: "array", items: string }, cwd: string, exitCode: { type: "integer" }, result: string }), maxItems: 128 }, git: gitReport })
export const agencyToolSchemas = [
  { name: "agency_context", description: "Discover the current execution, run epoch, report attempt and effective settings.", inputSchema: closed({}) },
  { name: "agency_inspect", description: "Inspect the current run or a descendant assignment. Continue pages using the returned cursor.", inputSchema: closed({ runId: uuid, assignmentId: uuid, attemptId: uuid, after: uuid, reportAfter: { type: "integer", minimum: 0 } }, ["runId"]) },
  { name: "agency_delegate", description: "Delegate an assignment to an enrolled host. Retain commandId before calling; reuse it only for an exact retry. Backend/model are explicit; overrides can be empty for configured defaults.", inputSchema: closed({ ...command, description: string, hostId: string, cwd: string, backendId: { enum: ["codex-acp", "claude-agent-acp"] }, modelId: string, overrides, git }) },
  { name: "agency_wait", description: "Wait for descendant reports. Retain waitId for reconnect and exact retry; cancellation ends this route. Large results contain summaries and assignment/attempt references for paged inspection.", inputSchema: closed({ ...scope, waitId: uuid, assignmentIds: { type: "array", items: uuid, minItems: 1, maxItems: 128 }, after: { type: "integer", minimum: 0 }, timeoutMs: { type: "integer", minimum: 0, maximum: 2147483647 } }) },
  { name: "agency_publish", description: "Publish the exact current result OID to this attempt's authorized generated ref. Human run configuration must grant publication. Retain commandId and expectedRemoteOid for exact retry; inspect uncertain replies.", inputSchema: closed({ ...command, resultOid: gitInput.properties.baseOid, expectedRemoteOid: nullable(gitInput.properties.baseOid as Record<string, unknown>) }) },
  { name: "agency_report", description: "Retain one terminal report for this execution's assigned attempt using a stable commandId. Completed code requires a retained published receipt from agency_publish; supply its commandId as publicationCommandId. Unpublished code results must be blocked.", inputSchema: closed({ ...command, assignmentId: uuid, attemptId: uuid, report }) },
  { name: "agency_stop", description: "Gracefully stop a same-run descendant using a stable commandId. This cannot stop an ancestor or unrelated agent.", inputSchema: { ...closed({ ...command, agent, agentId: uuid }, Object.keys(command)), oneOf: [{ required: ["agent"], not: { required: ["agentId"] } }, { required: ["agentId"], not: { required: ["agent"] } }] } }
]
export async function serveMcp(input: { input: Readable; output: Writable; call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>; cancel(waitId: string): Promise<void> }): Promise<void> {
  return serve({ ...input, schemas: agencyToolSchemas, serverInfo: { name: "agency", version: "1.0.0" }, async onCancel(name, args) { if (name === "agency_wait" && typeof args.waitId === "string") await input.cancel(id(args.waitId)) } })
}