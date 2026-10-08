import type { RoutedToolCall } from "../bureau/tool-routing.js"
import { randomBytes, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { fileURLToPath } from "node:url"
import { id, keys, object } from "../catalog/types.js"
import { MutationQueue } from "../handler/mutations.js"
import type { BureauService } from "../bureau/service.js"
import type { Invocation } from "../bureau/host.js"
import { captureInvocation } from "../bureau/service.js"
import { parseWaitInput } from "../bureau/waits.js"
import type { JsonObject } from "../agent/session-config.js"
import type { JournalPool } from "./journal.js"
import { parseStopCommand, parseStopReceipt, type StopCommand, type OriginLaunch } from "./receipts.js"
import { journalEntries } from "./reports.js"
import type { createOrchestrationService } from "./service.js"
import { toolResult, type ToolResult } from "./mcp.js"
import { canonicalDigest, fail, OrchestrationError, parseAssignmentSpec, parseAgentRef, parseExecutionRef, parseReport, type AgentRef, type AttemptRef, type ExecutionRef } from "./types.js"

type Binding = { execution: ExecutionRef; runId: string; bindingEpoch: string; attempt: AttemptRef | null; active: boolean; invocation: Invocation }
export function createToolBindings(input: { socketPath: string; journals: JournalPool; bureau(): BureauService | undefined; host(): Pick<ReturnType<typeof createOrchestrationService>, "snapshot" | "stop" | "report"> & Partial<Pick<ReturnType<typeof createOrchestrationService>, "publish">>; route?(request: RoutedToolCall, signal?: AbortSignal): Promise<ToolResult>; cancelRoute?(request: { execution: ExecutionRef; runId: string; bindingEpoch: string; waitId: string }): Promise<void> }) {
  const bindings = new Map<string, Binding>(), stopQueue = new MutationQueue()
  let closed = false
  const logical = (execution: ExecutionRef): AgentRef => ({ hostId: execution.hostId, agentId: execution.agentId })
  function binding(token: string): Binding { const result = bindings.get(token); if (!result) fail("INVALID_CREDENTIAL"); return result }
  async function synchronize(value: Binding): Promise<Binding> {
    if (value.attempt || !value.active) return value
    const core = input.bureau()
    if (!core) return value
    const runs = (await core.list()).filter(run => isDeepStrictEqual(run.root, logical(value.execution)) && isDeepStrictEqual(run.execution, value.execution) && run.state === "active")
    if (runs.length === 1) { value.runId = runs[0]!.runId; value.bindingEpoch = runs[0]!.bindingEpoch }
    return value
  }
  async function authorized(value: Binding, args: Record<string, unknown>, allowOffline = false) {
    if (!value.active) fail("NOT_READY")
    await synchronize(value)
    if (id(args.runId) !== value.runId || id(args.bindingEpoch) !== value.bindingEpoch) fail("STALE_BINDING")
    const core = input.bureau()
    if (!core) { if (allowOffline) return undefined; return fail("BUREAU_UNAVAILABLE") }
    if (allowOffline && input.route && !(await core.list()).some(run => run.runId === value.runId)) return undefined
    await core.assertBinding(value.runId, value.bindingEpoch, logical(value.execution))
    return core
  }
  async function descendant(core: BureauService, value: Binding, target: AgentRef): Promise<void> {
    await core.assertDescendant(value.runId, logical(value.execution), target)
  }
  return {
    definition(execution: ExecutionRef, launch: OriginLaunch, invocation: Invocation): JsonObject {
      if (closed) fail("TOOLS_UNAVAILABLE")
      parseExecutionRef(execution)
      if (!isDeepStrictEqual(execution, launch.execution) || !isDeepStrictEqual(logical(execution), launch.agent)) fail("INVALID_CREDENTIAL")
      for (const [token, previous] of bindings) if (previous.execution.agentId === execution.agentId) bindings.delete(token)
      const token = randomBytes(32).toString("hex")
      bindings.set(token, { execution: structuredClone(execution), runId: launch.runId, bindingEpoch: launch.bindingEpoch, attempt: launch.attempt, active: false, invocation: captureInvocation(invocation) })
      return { name: "agency", command: process.execPath, args: [fileURLToPath(new URL("../main.js", import.meta.url)), "internal-agency-tools"], env: [{ name: "AGENCY_TOOLS_SOCKET", value: input.socketPath }, { name: "AGENCY_TOOLS_TOKEN", value: token }] }
    },
    activate(execution: ExecutionRef) { for (const value of bindings.values()) if (isDeepStrictEqual(value.execution, execution)) value.active = true },
    revoke(execution: ExecutionRef) { for (const [token, value] of bindings) if (isDeepStrictEqual(value.execution, execution)) bindings.delete(token) },
    tokenFor(execution: ExecutionRef) { for (const [token, value] of bindings) if (isDeepStrictEqual(value.execution, execution)) return token; return null },
    async cancel(token: string, waitId: string) {
      const current = structuredClone(binding(token))
      if (!current.active) fail("NOT_READY")
      const value = await synchronize(current), core = input.bureau()
      if (input.cancelRoute && (!core || !(await core.list()).some(run => run.runId === value.runId))) { if (!value.active) fail("NOT_READY"); return input.cancelRoute({ execution: value.execution, runId: value.runId, bindingEpoch: value.bindingEpoch, waitId: id(waitId) }) }
      if (!core) fail("BUREAU_UNAVAILABLE")
      const wait = await core.waitRecord(id(waitId))
      if (!wait || !isDeepStrictEqual(wait.target, value.execution) || wait.input.runId !== value.runId) fail("INVALID_WAIT")
      await core.cancelWait(waitId)
    },
    async call(token: string, name: string, raw: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const value = structuredClone(binding(token)), args = object(raw), sender = logical(value.execution)
        if (name === "agency_context") {
          keys(args, []); await synchronize(value)
          const observed = value.active ? (await input.host().snapshot()).agents.find(agent => isDeepStrictEqual(agent.execution, value.execution)) : null
          return toolResult({ execution: value.execution, runId: value.runId, bindingEpoch: value.bindingEpoch, attempt: value.attempt, ready: value.active, effective: observed?.settings ?? null })
        }
        if (!value.active) fail("NOT_READY")
        if (input.route && name !== "agency_report" && name !== "agency_publish") {
          const core = input.bureau(), local = core && (await core.list()).some(run => run.runId === value.runId)
          if (!local) {
            if (!value.active) fail("NOT_READY")
            if (id(args.runId) !== value.runId || name !== "agency_inspect" && id(args.bindingEpoch) !== value.bindingEpoch) fail("STALE_BINDING")
            if (!(await input.host().snapshot()).agents.some(agent => agent.phase === "ready" && isDeepStrictEqual(agent.execution, value.execution))) fail("STALE_EXECUTION")
            return await input.route({ kind: "call", execution: value.execution, runId: value.runId, bindingEpoch: value.bindingEpoch, name, args, nativeParams: value.invocation.nativeParams }, signal)
          }
        }
        if (name === "agency_delegate") {
          keys(args, ["commandId", "runId", "bindingEpoch", "description", "hostId", "cwd", "backendId", "modelId", "overrides", "git"])
          const core = (await authorized(value, args))!, spec = parseAssignmentSpec({ parent: sender, description: args.description, hostId: args.hostId, cwd: args.cwd, backendId: args.backendId, modelId: args.modelId, overrides: args.overrides, git: args.git })
          return toolResult(await core.delegate(id(args.commandId), value.runId, spec, value.invocation, { execution: value.execution, bindingEpoch: value.bindingEpoch }))
        }
        if (name === "agency_publish") {
          keys(args, ["commandId", "runId", "bindingEpoch", "resultOid", "expectedRemoteOid"])
          await authorized(value, args, true)
          if (!value.attempt || !input.host().publish) fail("GIT_PUBLICATION_UNAUTHORIZED")
          return toolResult(await input.host().publish!(id(args.commandId), value.execution, args.resultOid as string, args.expectedRemoteOid as string | null))
        }
        if (name === "agency_report") {
          keys(args, ["commandId", "runId", "bindingEpoch", "assignmentId", "attemptId", "report"])
          await authorized(value, args, true)
          if (!value.attempt || id(args.assignmentId) !== value.attempt.assignmentId || id(args.attemptId) !== value.attempt.attemptId) fail("INVALID_REPORT")
          return toolResult(await input.host().report({ ...value.attempt, execution: value.execution, commandId: id(args.commandId), report: parseReport(args.report) }))
        }
        if (name === "agency_wait") {
          keys(args, ["waitId", "runId", "bindingEpoch", "assignmentIds", "after", "timeoutMs"])
          const core = (await authorized(value, args))!
          const request = parseWaitInput({ waitId: args.waitId, runId: value.runId, parent: sender, assignmentIds: args.assignmentIds, after: args.after, timeoutMs: args.timeoutMs })
          const result = await core.wait(request, signal, { execution: value.execution, bindingEpoch: value.bindingEpoch }), full = toolResult(result)
          if (Buffer.byteLength(JSON.stringify(full)) <= 256 * 1024) return full
          return toolResult({ ...result, reports: result.reports.map(entry => ({ ...entry, reportTruncated: true, report: { ...entry.report, report: { status: entry.report.report.status, summary: entry.report.report.summary.slice(0, 512), summaryTruncated: entry.report.report.summary.length > 512, issueCount: entry.report.report.issues.length, validationCount: entry.report.report.validation.length } } })) })
        }
        if (name === "agency_inspect") {
          keys(args, ["runId", ...["assignmentId", "attemptId", "after", "reportAfter"].filter(key => Object.hasOwn(args, key))])
          if (args.assignmentId === undefined && (args.attemptId !== undefined || args.reportAfter !== undefined)) fail("INVALID_TOOL_INPUT")
          await synchronize(value); if (id(args.runId) !== value.runId) fail("STALE_BINDING")
          const core = input.bureau(); if (!core) fail("BUREAU_UNAVAILABLE")
          if (args.assignmentId !== undefined) {
            const assignment = await core.assignment(id(args.assignmentId))
            await descendant(core, value, assignment.agent)
            const evidence = await core.assignmentEvidence(assignment.assignmentId, args.attemptId === undefined ? undefined : id(args.attemptId))
            const report = evidence?.input.report ?? null, serialized = Buffer.from(JSON.stringify(report))
            if (args.reportAfter !== undefined || serialized.length > 32768) {
              const offset = args.reportAfter ?? 0
              if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > serialized.length || offset < serialized.length && (serialized[offset]! & 0xc0) === 0x80) fail("INVALID_CURSOR")
              let end = Math.min(offset + 32768, serialized.length)
              while (end < serialized.length && (serialized[end]! & 0xc0) === 0x80) end--
              return toolResult({ ...assignment, reportAttemptId: evidence?.input.attemptId ?? null, origin: evidence?.origin ?? null, reportPage: { offset, text: serialized.subarray(offset, end).toString("utf8"), nextCursor: end === serialized.length ? null : end } })
            }
            return toolResult({ ...assignment, reportAttemptId: evidence?.input.attemptId ?? null, report, origin: evidence?.origin ?? null })
          }
          const page = await core.inspect(value.runId, args.after === undefined ? null : id(args.after))
          return toolResult(page)
        }
        if (name === "agency_stop") {
          keys(args, ["commandId", "runId", "bindingEpoch", ...(Object.hasOwn(args, "agent") ? ["agent"] : ["agentId"])])
          const core = (await authorized(value, args))!, commandId = id(args.commandId), agent = Object.hasOwn(args, "agent") ? parseAgentRef(args.agent) : await core.agentRef(value.runId, id(args.agentId))
          return await stopQueue.run(async () => {
            await descendant(core, value, agent)
            const journal = input.journals.forRun(value.runId), events = await journalEntries(journal), prior = events.find(entry => entry.eventId === commandId)
            const retained = await core.reserveScopedStop(value.runId, value.bindingEpoch, value.execution, async () => {
              let command: StopCommand
              if (prior) {
                if (prior.kind !== "scoped-stop") fail("COMMAND_CONFLICT")
                command = parseStopCommand(prior.payload)
                if (!isDeepStrictEqual(command.sender, value.execution) || command.bindingEpoch !== value.bindingEpoch || !isDeepStrictEqual(logical(command.target), agent)) fail("COMMAND_CONFLICT")
                await journal.append(prior.eventId, prior.kind, prior.payload)
                const receipt = events.find(entry => entry.kind === "scoped-stop-receipt" && isDeepStrictEqual(parseStopReceipt(entry.payload).command, command))
                if (receipt) { await journal.append(receipt.eventId, receipt.kind, receipt.payload); return { command, receipt: parseStopReceipt(receipt.payload).receipt } }
              } else {
                const target = await core.executionFor(agent)
                const payload = { commandId, runId: value.runId, bindingEpoch: value.bindingEpoch, sender: value.execution, target }
                command = { ...payload, digest: canonicalDigest(payload) }
                await journal.append(commandId, "scoped-stop", command)
              }
              return { command, receipt: null }
            })
            if (retained.receipt) return toolResult(retained.receipt)
            const command = retained.command, receipt = await core.stopExecution(commandId, command.target)
            await journal.append(randomUUID(), "scoped-stop-receipt", { command, receipt })
            return toolResult(receipt)
          })
        }
        return fail("UNKNOWN_TOOL")
      } catch (error) { return toolResult({ code: error instanceof OrchestrationError ? error.code : error instanceof Error && "code" in error ? error.code : "INVALID_TOOL_INPUT" }, true) }
    },
    close() { closed = true; bindings.clear() }
  }
}