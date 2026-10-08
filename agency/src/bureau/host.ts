import type { PublicationDestination } from "./publication-policy.js"
import type { PublicationReceipt } from "../orchestration/git-publication.js"
import type { EntryRef, EntryIntent } from "./entry.js"
import type { PermissionRef, PermissionReceipt, PermissionSnapshot } from "../orchestration/permission-routing.js"
import type { EventRef, JournalPage } from "../orchestration/types.js"
import type { GitPreparation } from "../orchestration/git-worktree.js"
import type { LaunchEnvironment } from "../agent/environment.js"
import type { JsonObject, RequestedSettings } from "../agent/session-config.js"
import type { AcpSubmissionRequest, SubmissionReceipt } from "../agent/turns.js"
import type { AgentRef, AssignmentSpec, AttemptRef, ExecutionRef, GitExchange, Lineage } from "../orchestration/types.js"
import type { ProviderId } from "../catalog/types.js"

export type Invocation = { environment: LaunchEnvironment; nativeParams: JsonObject }
export type HostAgent = { backendId?: ProviderId; title?: string; agent: AgentRef; execution: ExecutionRef | null; phase: string; toolsEnabled: boolean; lineage: Lineage | null; membership: { runId: string; bindingEpoch: string } | null; cwd: string; settings: RequestedSettings }
export type ReplayFence = { streamId: string; runId: string; throughSeq: number; checkpoint: number }
export type HostSnapshot = { permissions?: PermissionSnapshot; hostId: string; handlerGeneration: string; backendChoices: ProviderId[]; agents: HostAgent[]; receipts: LaunchReceipt[]; replayFences: ReplayFence[] }
export type RootLaunch = { commandId: string; runId: string; agent: AgentRef; handlerGeneration: string; bindingEpoch: string; cwd: string; backendId: ProviderId; modelId: string; overrides: AssignmentSpec["overrides"]; retryMode?: "restore" }
export type LaunchAssignment = { commandId: string; runId: string; ref: AttemptRef; agent: AgentRef; handlerGeneration: string; bindingEpoch: string; spec: AssignmentSpec; lineage: Lineage; git: GitExchange | null; retryMode: "new" | "restore" | "replace"; savedSettings: RequestedSettings | null; savedGit?: GitPreparation | null; publication?: PublicationDestination }
export type LaunchReceipt = { commandId: string; execution: ExecutionRef | null; effective: RequestedSettings | null; state: "accepted" | "started" | "failed" | "interrupted" | "uncertain"; git?: GitPreparation | null }
export type StopReceipt = { commandId: string; execution: ExecutionRef; state: "stopped" | "uncertain" | "stale" }
export type OrchestrationHost = { publicationInspect?(commandId: string): Promise<PublicationReceipt | null>; entryPrepare?(commandId: string, ref: EntryRef): Promise<EntryIntent>; entryInspect?(commandId: string): Promise<EntryIntent | null>; permissionDecide?(commandId: string, ref: PermissionRef, optionId: string): Promise<PermissionReceipt>; permissionInspect?(commandId: string): Promise<PermissionReceipt | null>; permissionRead?(after: number, limit: number): Promise<JournalPage>; permissionAcknowledge?(event: EventRef): Promise<void>; hostId?: string; setEnabled?(enabled: boolean): void; observation?(): unknown; snapshot(): Promise<HostSnapshot>; onSettled?(listener: (parent: AgentRef) => void): () => void; launch(command: LaunchAssignment, invocation: Invocation): Promise<LaunchReceipt>; launchRoot(command: RootLaunch, invocation: Invocation): Promise<LaunchReceipt>; restoreRoot?(command: Pick<RootLaunch, "commandId" | "runId" | "agent" | "handlerGeneration" | "bindingEpoch">, invocation: Invocation): Promise<LaunchReceipt>; inspectCommand(commandId: string, handlerGeneration: string): Promise<LaunchReceipt | null>; submission(target: ExecutionRef, submissionId: string): Promise<SubmissionReceipt | null>; submit(target: ExecutionRef, request: AcpSubmissionRequest, beforeAccepted?: () => Promise<void>): Promise<SubmissionReceipt>; stop(commandId: string, target: ExecutionRef): Promise<StopReceipt> }