# Agency

Agency owns persistent local agent processes and exposes them to native Agentic through ACP. Agentic owns the chat, context, configuration, tools, and permission UI. The Handler owns logical session identity, provider connections, process supervision, turn arbitration, command receipts, and explicit restoration. Multiple agents may run in the same directory, and multiple editors may attach to one agent.

## Getting started

Use Node 24.13.0 and the existing pinned lockfile. Build from `agency/` with `npm ci` and `npm run build`, or reuse an existing installation and run only the build. The existing dotfiles deployment provides `~/bin/agy`, which resolves the repository through its symlink chain and uses the pinned Node runtime. It never installs dependencies or builds implicitly.

The local Agency provider profile must already describe the installed Codex executable, ACP adapter package metadata, and declared configuration paths. Configuration lives beneath `${XDG_STATE_HOME:-$HOME/.local/state}/agency/hosts/<host-key>/catalog/`. The initial supported production adapter is `@agentclientprotocol/codex-acp` 1.7.0. Missing or incompatible dependencies produce an unavailable error; Agency does not install or upgrade them. Backend-native login remains outside Agency. Interactive ACP authentication is not implemented.

Run `agy status` to start or connect to the Handler. Neovim requires the built Agency package, `agy` on its inherited `PATH`, and the existing Agentic and Snacks plugins. The tested Agentic revision is `246feb4773923a10a6fedc40048657516bd05792`; the integration does not modify its installed files.

After deploying the source configuration through the normal dotfiles workflow, start a new editor in the intended project directory. `<leader>ac` opens the current native Agency conversation or creates a backend-default session when no matching agent exists. `<leader>an` selects a backend for another conversation. The editor has exactly one enabled ACP provider, `agency`, running `agy acp`; selecting a backend does not switch or enable a direct editor provider.

Source builds do not deploy configuration or restart existing editors, Handlers, or providers.

## Backend defaults and environment

Absent an explicit backend configuration, Agency uses the enabled Codex profile. Its default environment includes `CODEX_PATH=~/bin/acp-codex`, `INITIAL_AGENT_MODE=agent-full-access`, and `MODEL_PROVIDER=litellm`; its initial mode is `agent-full-access`. Caller environment values take precedence. Model and reasoning choices come from the provider rather than global Agentic overrides. The old read-only/high/deny-all editor policy is not imposed on ordinary ACP sessions.

An optional private `catalog/backends.json` overrides backend defaults. It uses this shape; paths in environment values must be actual absolute paths, not shell-expanded placeholders:

```json
{
  "version": 1,
  "defaultBackendId": "codex-acp",
  "backends": [{
    "id": "codex-acp",
    "args": [],
    "environmentDefaults": {},
    "initial": { "modeId": "agent-full-access" },
    "compatibilityId": "codex-acp-1.7"
  }]
}
```

Each native start samples the caller environment, and explicit restore captures it again. Environment values are transient and are not persisted in agent records or receipts. After merging backend defaults, the Handler overrides both `NVIM` and `NVIM_SOCKET_PATH` with a private editor RPC socket for that provider generation. Its path remains stable when editors attach or disconnect.

Only configured, enabled, technically compatible backends are available. Codex is the initial production backend. Claude saved-session entries can remain visible as unavailable; their presence does not enable Claude or load them into Codex. Two deterministic backend fixtures exercise routing without claiming production Claude support.

## Neovim commands

| Mapping | Command |
| --- | --- |
| `<leader>ac` | `AgencyCurrent` |
| `<leader>an` | `AgencyNew` |
| `<leader>ae` | `AgencySettings` |
| `<leader>af` | `Agency` active-agent picker |
| `<leader>as` | `AgencyStop` |
| `<leader>ao` | `AgencyOpen` |
| `<leader>aa` | Add file or selection |
| `<leader>ad` | Add line diagnostics |
| `<leader>aD` | Add buffer diagnostics |
| `<leader>ai` | Submit annotations |
| `<leader>ar` | Agency saved-session picker |
| `<leader>ap` | Project file picker |

Additional commands are `AgencyAttach <agent-id>`, `AgencyRestore <agent-id>`, `AgencyDetach`, `AgencyCancel`, and `AgencyInspect`. Current toggles the current native widget, selects exact-cwd active records, or creates a default session when inventory is genuinely empty. Transitional records and read failures do not count as empty inventory. New permits another agent in the same directory. Opening an already displayed logical session focuses its existing native manager; it does not create a competing subscriber. Different sessions can occupy different tabs on the same cached Agency client.

`<leader>ap` previews projects and opens the selected `project.md` without creating a session or changing the attached agent. `<leader>af` lists live agents across directories in the current Handler generation, including agents with active turns. Ready rows attach to the exact selected generation; Starting, restoring, and stopping rows are inspectable, including before process ownership and during cleanup. Stopped, historical, and legacy records belong in `<leader>ar`. Rows lead with the provider's conversation title or a title derived from the first request, followed by backend/model, working directory, activity, and editor connection. Full identifiers and environment metadata appear in the preview. Titles survive editor disconnects while the Handler retains the conversation. "Open in this tab" identifies the current editor connection; "Available to open" identifies other live agents. Cleanup evidence remains in diagnostics. Attachment waits until every picker window has closed. An empty active picker creates nothing. The active picker can stop the selected agent, but new-session creation and saved-session restoration use their separate entry points.

`<leader>an`, `agentic.switch_provider()`, and `agentic.new_session_with_provider()` select an Agency backend and model before creating a conversation. Effort and permissions use the backend’s configured defaults; creation does not prompt for them. Model selection displays configuration-matching catalog evidence. Cached models remain selectable after a discovery timeout or stale refresh and are labeled cached; the picker shows the discovery failure when available. Session creation validates the selected model and configured settings against the provider. An incompatible configured default reports an unsupported selection rather than silently substituting another value. Changed configuration or an absent catalog exposes only configured defaults, explicitly labeled when discovery is unavailable. Cancelling any selection preserves the existing conversation. Codex model and reasoning choices use ordinary ACP configuration options, and its modes include full access.

`/new` inherits the current session's backend and uses its backend defaults for the new conversation. `<leader>ae` / `:AgencySettings` selects a setting and then one of the attached provider’s supported values, with current values shown first. It exposes native configuration options, including effort and permission mode, with legacy mode support when needed. It requires an attached agent and creates no conversation. Cancelled, superseded, or stale selections change nothing. Changes apply to the shared agent, while future sessions continue using backend defaults. Changes propagate to all attached editors and update restorable settings. Live attachment preserves current configuration rather than applying the reconnecting editor's defaults.

Native code selections, file references, and diagnostics own context capture. Structured ACP content is preserved. Annotation submission clears only the exact captured threads after accepted admission; busy or rejected admission leaves them intact, and subsequent annotation edits survive. Pending native context survives live loading. Changing the editor cwd does not retarget an attached session or its relative file links.

## Shared sessions and lifecycle

Every attached editor may submit while the session is idle. The Handler admits one turn at a time; a concurrent submission receives busy without replacing accepted input. The submitting editor displays its local input once, while other attachments and replay receive the same input. Retained transcript events are never prepended to another prompt. A lost response is not proof of rejection and never causes automatic redispatch.

Closing a tab, destroying a view, switching sessions, exiting Neovim, losing the endpoint, or `AgencyDetach` removes that attachment only. It does not cancel or stop the provider. A later attachment receives retained display history, current configuration, active-turn state, and subsequent updates. Truncated retained history has a visible marker.

`AgencyCancel` explicitly cancels the observed shared turn and leaves the provider available. Either attached editor can cancel. Cancellation is pinned to a turn ID, so a delayed request cannot cancel a later turn. An uncooperative provider can fail after the cancellation grace window; closing an editor does not invoke that policy.

`AgencyStop` confirms and stops the exact logical agent, Handler generation, and provider generation, then verifies owned-process cleanup. Stopped or recoverable sessions require explicit restore. Restore uses recorded cwd and native session identity with fresh caller environment. Logical identity remains stable; provider generation rotates. Old attachment mutations are rejected until an explicit live load binds the new generation. A failed restore never starts a replacement conversation.

## Editor RPC routing

Agency editors advertise their current `vim.v.servername` in `_meta.agency.editor` on new, load, and prompt requests. An accepted turn captures the submitting attachment and its current socket. Provider commands using `NVIM` or `NVIM_SOCKET_PATH` reach that editor through a transparent Unix stream proxy. Another editor attaching, retrying a duplicate submission, or submitting while busy cannot redirect the active turn. The proxy forwards RPC traffic in both directions without decoding it. A listener failure disables editor RPC while leaving conversation turns available. New connections use the active turn at connection time; background commands that outlive their turn require an explicit editor target.

Detach, disconnect, same-session reload, cancellation, turn completion, and provider termination close that turn's RPC connections. A replacement attachment cannot resume editor routing for an existing turn; its next accepted turn can use the same provider and proxy path. A failed command is not retried automatically. Commands outside a turn require an explicit editor target, e.g. setting `NVIM_SOCKET_PATH` to the real editor socket for that command. A prompt that omits editor metadata inherits its attachment’s registered address. An attachment without a registered editor address has no automatic route. Editor addresses remain transient and Agency metadata is stripped from provider requests and retained prompts.

Source builds do not alter existing provider environments. Activating routing for an existing provider requires deploying the updated Handler and editor configuration, then explicitly stopping and restoring that provider. Reloading a view alone cannot replace the inherited environment of a provider launched before this change.

## Shared permissions

The Handler forwards each provider permission request and its offered option IDs to every attached editor. The first valid selected option wins and reaches the provider once. Corresponding native permission UIs are withdrawn from all attachments. Provider-defined allow-once, allow-always, reject-once, and reject-always semantics remain provider-defined.

Closing an editor or clearing its callbacks is not a user rejection. If every editor disconnects, the provider keeps waiting. A later attachment receives the still-pending request. Explicit cancel, stop, provider failure, or generation replacement withdraws obsolete requests. Stale, malformed, superseded, or unoffered decisions cannot affect a replacement generation. There is no Agency human-deliberation timeout or automatic approval.

## Failure diagnostics

Permission option names retain provider text without a field-length cap. Titles and option IDs retain their existing bounds. Invalid Unicode and control characters remain rejected, and the existing 1 MiB whole-record capacity applies to offers and snapshots. The regression request in `test/fixtures/codex-long-permission.json` was generated by the pinned Codex ACP adapter using a synthetic app-server request; it is not the missing historical approval payload.

Agent failures retain their existing code and fixed message and may include an optional closed `diagnostic` object. `permission_request`, `acp_transport` and `provider_initialize` diagnostics retain a bounded machine `causeCode` or null. `provider_process` diagnostics additionally identify the event, exit code, signal, cumulative stderr byte count and `stderrTailBase64`. The tail is at most 2,048 raw bytes captured at the first failure, encoded as canonical base64; it can contain provider output and follows the existing private state access boundary. Raw exception messages and permission payloads are not copied into diagnostics. Cleanup and subsequent faults preserve the first failure, including when initialization rejects after a process observer has already failed.

Session providers and model-discovery workers drain stderr without a cumulative byte termination limit. Session failures retain only the bounded diagnostic tail, while actual process and stream errors retain their failure behavior. The serialized `limits.stderrBytes` field and historical `stderr_limit` diagnostic event remain readable for record compatibility; neither imposes a live stderr limit. Existing failures without diagnostics remain readable. Older strict readers reject failures containing the new field, so candidate Handlers and their clients must be upgraded together before using this revision across hosts.

## Native history import

The saved-session picker combines Agency inventory with bounded, read-only Codex metadata discovery. Ready logical sessions attach directly. Stopped sessions require confirmed restore. Supported unregistered Codex sessions require explicit import and restore. Import records backend, native session ID, and cwd without claiming ownership of an external direct-provider process. Reimporting an existing native identity resolves to its existing logical agent.

The CLI equivalent is `agy agent import --provider codex-acp --session <native-id> --cwd <absolute-path>`, followed by `agy agent restore <agent-uuid>`. Native IDs and logical IDs are separate namespaces; ACP uses `agency:<agent-uuid>`. Import does not submit transcript messages or signal an external provider. Provider-native session files are neither deleted nor rewritten. Unsupported backends remain unavailable. Saved-session rows and previews label unavailable entries explicitly. Version-1 retained records remain visible as unavailable history; selecting them cannot import, load, or restore a provider.

## CLI and protocol boundaries

```text
agy status [--json]
agy doctor [--json]
agy acp
agy shutdown [--stop-agents] [--json]
agy agent list [--json]
agy agent current [--json]
agy agent page --limit 100 [--cursor <cursor>] [--cwd <path>] [--active] [--json]
agy agent import --provider codex-acp --session <native-id> --cwd <path> [--json]
agy agent restore <agent-uuid> [--json]
agy agent stop <agent-uuid> --handler-generation <uuid> --provider-generation <uuid> [--json]
agy agent command <command-uuid> --handler-generation <uuid> [--json]
```

`agy help --json` lists exact flags and compatibility commands, including model catalog operations, legacy explicit-selection start, scalar prompt, and NDJSON attachment. The CLI compatibility attachment uses the same provider core rather than a second chat runtime. Normal ACP creation does not require catalog qualification. Model discovery remains a separate explicit or background catalog operation.

The active picker requests `agency/roster` over the cached Agentic ACP connection. This active-only query projects daemon memory without rereading retained files or waiting for their verification queue. Its cursors track changes to the projected records and diagnostics. Attach, restore, stop, saved-session queries, and CLI inventory retain authoritative verification; a cached display row does not authorize an action. The picker bounds readiness, requests, and full traversal, and reports connection failures without falling back to a fresh CLI process. An older running Handler must be restarted before it supports this endpoint.

Status lazily starts or connects to one Handler. Doctor reads state without starting or cleaning up a Handler. Shutdown never starts one and ordinarily refuses active work; `--stop-agents` explicitly stops owned agents. Command IDs and Handler generations make lifecycle retries exact. Incomplete operations retain their original identities; inspection does not authorize a new mutation or prompt. Inventory cursors are revision-bound.

`agy acp` connects to the ready Handler's mode-0600 ACP socket inside its mode-0700 runtime directory. The endpoint owns no provider and emits only JSON-RPC on stdout. Initialization selects and starts no backend. Session load is live attachment, not implicit restoration. Authentication methods are not advertised. Client filesystem and terminal RPCs are not forwarded to an arbitrary editor; provider-owned tool execution is unaffected.

Control uses `agency-control/2`, agent lifecycle uses `agency-agent/3`, and the compatibility attachment stream uses `agency-attachment/1`. Exit codes are 0 for success, 64 for usage, 65 for invalid protocol, 69 for unavailable/stale targets, 70 for internal failure, and 75 for incomplete operations.

## Transport bounds and failures

ACP frames and queued writes have no byte quota. The endpoint relays bytes with stream backpressure, and the Handler inspects routing and control fields while retaining serialized tool payloads for forwarding and replay. Write deadlines still detect stalled connections. Launch records retain legacy frame and queued-write byte fields for compatibility; transport ignores those fields. Stderr capture remains bounded to 8 KiB. Healthy prompt turns and human permission waits have no qualification-era total-turn deadline or cumulative assistant-output quota.

The Handler retains at most 16 MiB and 8,192 display events per live generation. Eviction removes an oldest prefix and exposes truncation; it does not terminate the turn or erase authoritative configuration. Display history is volatile across Handler/provider replacement. Native Agentic controls its own rendered buffers. Per-client queue overflow disconnects that connection rather than failing a healthy provider or unrelated agent.

Submission receipts remain available for the provider generation, including after display eviction. They retain IDs, digests, and completion metadata, not duplicated transcript bodies. Receipt count can grow until generation retirement. Malformed client input and stale identifiers affect that connection. Provider protocol failure affects its session and pending requests. Neither provider failure nor Handler loss automatically restores or replays interrupted requests.

## Ownership and retention

Private agent, command, catalog, and launch records bind boot identity, PID generation, parent, process group, session, UID/GID, and per-launch markers. Cleanup revalidates ownership before signaling. Missing or replaced processes are not signaled, and ambiguous ownership remains visible rather than blocking unrelated launches. Provider helpers that detach from the recorded process group remain outside Agency ownership.

Automatic retention preserves logical native-session records, current-generation explicit receipts, and unresolved recovery evidence. Unreferenced retired history is removed only after reconciliation and verified process absence. Failed starts without a native session can become eligible after seven days. Quiet Handlers can defer age-based cleanup until another operation or restart. Retention never deletes provider-native sessions, credentials, logs, caches, or separately retained evidence. There is no fixed total-storage cap or supported archive/prune command.

The Handler does not persist an append-only transcript or environment values. Native providers retain their own state under caller configuration. Agentic debug logging is disabled; explicitly enabling it later can log ordinary ACP requests, including transient start metadata.

### Explicit probe recovery

`agy model recover-probe --attempt-id UUID --handler-generation UUID --sha256 HEX --json` is an offline maintenance operation for one quarantined managed V2 catalog probe. The digest identifies the original raw launch record, not a reserialized copy. The recorded Handler PID must be absent on the unchanged boot, and the startup lock is held throughout. Every retained provider PID must be absent and its group empty in two independent checks. Live or reused PIDs, observation failures, incomplete ownership, changed state, and conflicting archives reject recovery. Legacy V1 probes are unsupported.

Recovery preserves the original launch, metadata, command receipt, Handler record, and digest manifest under `agency/recovery/<host>/<attempt>/`, outside automatic-retention targets. It then publishes only a cleanup-verified derivative of that launch. Retries require the same digest and matching archived evidence. Failed archive writes leave quarantine intact; failures after replacement can be retried to establish durability. Recovery never signals processes, stops or starts the Handler, restores agents, or alters ordinary sticky quarantine. Stopping a live Handler is a separate, explicitly authorized maintenance action.

## Verification

Run `npm run build`, `test:acp`, `test:neovim-acp`, `test:agent`, `test:agent-integration`, `test:retention`, `test:catalog`, `test:catalog-integration`, `test:control`, `test:control-integration`, `test:attachment`, and `test:attachment-integration` from `agency/`. Additional foundation gates are `test:unit`, `test:darwin`, `test:import`, `test:recovery`, and `test:codex-acceptance`. Run `./test-nvim.sh` from the repository root.

These tests use deterministic providers and isolated temporary roots. Fresh-process coverage loads the installed native Agentic classes in independent Neovim processes with private home/state/cache, explicit repository runtime paths, fixture-only endpoints, and no user startup configuration. `NVIM_TEST_EXECUTABLE` selects the binary; Darwin defaults to `/opt/homebrew/bin/nvim`. Teardown reports and independently verifies editor, endpoint, Handler, and provider absence.

The test scripts do not invoke a real model, paid prompt, login, deployment, or `accept:codex`. Real-provider acceptance remains separate and requires an explicit prompt count, target directory, allowed edits, and exact cleanup targets. Historical plans and qualification evidence remain immutable descriptions of earlier architectures, not runtime inputs.

### Local orchestration storage

The delegation core stores orchestration envelopes separately from native sessions. The journal publishes private immutable events under a serialized mutation queue, fsyncs files and parent directories before returning receipts, and rejects conflicting event IDs. Per-event recipient acknowledgements advance only a contiguous watermark. Seven-day acknowledged report compaction publishes a hashed summary and durable checkpoint before deleting the replay prefix. A cursor below that checkpoint returns `CURSOR_EXPIRED`; exact event replies remain retained for retry. Missing unexpired events, changed bytes, replaced files and unsafe state fail closed.

Records are bounded to 1 MiB, transport queues to 2 MiB and pages to 256 entries. Description, summary and validation output fields are bounded to 64 KiB; arrays to 128 entries; arguments and paths to 4096 bytes. Creation lineage is immutable and separate from provider generation. These storage primitives support the Bureau and scoped tools described below.

### Local Bureau core

The Bureau retains runs, assignment attempts and exact command replies in per-run journals. Root and child identities are published before host dispatch. A lost launch reply is inspected under its original command ID; startup never redispatches a prompt. Commands with an uncertain outcome expose their reserved target and launch IDs through command inspection. Replacement retry allocates a new child and uses current configured defaults. Restore retry retains the logical child and saved settings.

Run inspection uses bounded assignment pages with a continuation cursor. Run closure rotates relationship authority and leaves providers running. Cancellation ends orchestration attempts without stopping providers. Git assignments are rejected before launch in this local milestone. The local CLI and Handler compose this service; core socket tests also use deterministic fake hosts.

### Local launch and report integration

Orchestrated launches reserve their logical agent and execution before provider creation. Immutable child lineage and a durable origin launch record precede dispatch. The injected tool definition is prepared against that reserved execution and activates only after provider readiness. Preparation, publication failure, stop and retirement revoke the binding. Generated credentials and invocation environments remain transient. Restore preserves child lineage and saved settings; replacement uses the current backend defaults. Origin receipt inspection cannot repair or dispatch a pending provider launch.

Report retention and host snapshot replay fences share the Handler mutation queue. Reports are retained in the origin journal before Bureau relay; visible records from a failed publication reverify fsync before relay. Offline reports remain replayable after the reporting generation retires. Recovery relays retained reports before deriving interruptions from host snapshots. Each attempt accepts one immutable terminal report; completed reports complete the attempt, while blocked and failed reports retain their category and fail it. Reports for superseded attempts remain late evidence. Origin event identity, digest and historical execution are checked before acknowledgment.

Bootstrap loads orchestration pins before resuming cleanup intents. Unresolved dispatch and unacknowledged report evidence prevents retirement. Unreadable references pause cleanup while ordinary local agents remain available. Reobserving a cleaned launch preserves its file identity so a blocked cleanup intent retains valid witnesses. No conversation archive is added. Operational scoped tools and delivery scheduling use these publication and retention contracts.

### Durable waits and parent inbox

An accepted report and its parent inbox entry derive from one journal event. Wait registration retains the exact parent execution, run epoch, deadline and input digest. A response is returned after its result and delivery marker are durable; retrying the same wait ID repeats that result and cursor. A transport disconnect detaches the response transport while preserving the route. Explicit cancellation or execution retirement ends the route and releases its delivery claim without stopping descendants. An ancestor can read descendant reports while the immediate parent keeps notification authority. Overlapping waits may read the same report, but only one claim suppresses unsolicited delivery.

Wait deadlines use server timers. Timeout preserves reports that arrive afterward. Inbox report pages have a continuation cursor and bounded payloads. Run closure refuses unresolved attempts, pending reports and live wait routes. Saved waits and deliveries pin their parent and source evidence before ordinary retention sweeps.

Terminal acknowledged runs can compact after seven days. Public replay cursors below the checkpoint expire, while internal recovery reads retained exact receipts. Explicit forget first publishes identifier tombstones and confirms the sealed run, then erases its orchestration payloads. Interrupted erasure resumes from that seal; old run, command, assignment and wait IDs return `FORGOTTEN`. Native provider records, lineage and processes remain subject to their existing lifecycle.

### Idle report notifications

The local scheduler batches pending reports through the normal Handler submission coordinator. Busy parents retain the same delivery ID until admission succeeds. Live waits claim reports first. Admission awaits a durable origin receipt before ACP dispatch, and a failed publication leaves the turn lock and editor routing available. Parent settlement and new report arrival trigger scheduling without polling a model.

A lost control reply is reconciled against the same live execution's submission receipt. Provider retirement interrupts attempted notifications; explicit restoration does not replay them. Explicit notification retry creates a new delivery and submission ID while retaining the original target and outcome. Never-dispatched batches can follow the logical parent to a new execution. Automatic scheduling remains opt-in until operational composition enables it.

### Local delegation tools and commands

The Handler composes an optional local Bureau, disabled by default. Start the Handler with `agy status`, then enable orchestration with `agy bureau enable --json`. `agy bureau status --json` reports readiness and write availability. A Bureau initialization failure leaves ordinary Agency sessions available. Bureau and tool sockets are private companions of the Handler socket; stale-generation cleanup covers all companions.

Create a supervisor with an explicit backend and model:

```sh
agy run start --command-id <uuid> --input-json '{"objective":"Review the local changes","backendId":"codex-acp","modelId":"<advertised-model-id>","overrides":{}}' --json
agy run list --json
agy run inspect <run-uuid> --json
agy assignment inspect <assignment-uuid> --json
```

The command uses the caller's cwd, host, home and environment. Empty overrides use configured effort and permission defaults. Starting the run creates its supervisor without submitting the objective as a prompt. Submit work through the existing attached conversation. Multiple agents can share a directory.

An orchestrated provider receives an `agency` stdio MCP server bound to its reserved execution. Initialization and tool discovery work during bootstrap, while side effects require the normal provider ready transition. Its six tools expose context, run/assignment inspection, local delegation, durable waits, terminal reports and graceful descendant stop. Tool callers cannot provide a different sender or report execution, stop an ancestor or unrelated agent, or resolve human permission requests.

Call `agency_context` to obtain the current run ID, binding epoch and assigned attempt. Retain a UUID command ID before delegate/report/stop calls and reuse it only for an exact retry. A wait uses its own retained wait ID. JSON-RPC request IDs only correlate exchanges. Helper restart preserves the execution credential and exact command receipts; provider restart requires explicit restore and rotates that credential. A supervisor can begin another run after its old run closes; old-epoch calls remain invalid.

`agency_inspect` returns bounded assignment pages. Assignment inspection includes one report body or, for a large report, `reportPage` with a UTF-8 byte offset, JSON text fragment and `nextCursor`. Continue with `reportAfter`; concatenate fragments before parsing the report JSON. Pass `attemptId` to inspect a historical attempt. Notifications contain bounded summaries and report references, so inspection supplies long issue and validation details.

An explicit MCP cancellation ends the durable wait route. Helper EOF or socket loss detaches the caller and retains the wait for reconnect. Reports remain retained at the local origin if Bureau relay is unavailable; new delegation, waits and stops require Bureau availability. Notifications enter normal Handler admission when the parent is idle. Interrupted delivery requires explicit human retry rather than automatic prompt replay.

Human lifecycle commands are `agy run restore <run-uuid>`, `agy assignment retry <assignment-uuid> --mode restore|replace`, `agy run cancel <run-uuid>`, `agy run close <run-uuid>` and `agy run forget <run-uuid>`. Mutating commands accept `--command-id`; `agy bureau command <command-uuid>` inspects a retained Bureau command. Run cancellation releases logical orchestration without stopping providers. Closing requires resolved assignments, routes and scoped stop intents; forgetting a closed run erases orchestration payloads while retaining identifier tombstones for retry classification.

Pass caller-owned external MCP definitions with `--mcp-servers-json`. Restore reconstructs the internal Agency server, preserves saved settings, and requires any previously required external definitions again. Environment values, editor addresses and generated credentials remain transient; only digests and server-name requirements are retained. Changing external definitions under the same command ID conflicts. Restoration submits no saved prompt.

`agy bureau retry-notification <delivery-uuid> --command-id <uuid> --target-json '<execution-ref>' --binding-epoch <uuid>` creates a fresh delivery for an interrupted or uncertain notification. Inspect the parent execution and current run epoch before invoking it. The prior receipt and delivery evidence remain retained.

This milestone supports local delegation only. Cross-host transport, devbox provisioning, remote permission routing, Git preparation/publication and Neovim orchestration UI remain separate work. Local acceptance uses fake providers that launch the injected helper; it does not qualify live provider delegation. Run `npm run test:orchestration-tools` for the scoped tool and operational fixtures.

Inspect retained reports with `agy bureau inbox <run-uuid> --parent-id <agent-uuid> --json`. A cancelled run or a historical parent can retain reports that no provider will consume. `agy bureau acknowledge-reports <run-uuid> --command-id <uuid> --input-json '[<exact-source-ref>]'` records an explicit human acknowledgment of selected source references. It suppresses their notification obligation and releases retention pins while preserving the full report and historical delivery receipts. It does not record provider delivery or end an active wait. Close the run after all waits and unresolved commands have been settled; forget remains a separate explicit erasure operation.

`agy bureau recover-stop <run-uuid> --command-id <original-stop-uuid>` resolves a retained scoped-stop intent after its sender retires. It reuses the original complete command and exact target. An existing stop receipt is reconfirmed; a retired target returns a retained stale result without stopping a replacement execution. Lost publication remains retryable. These recovery operations are human CLI authority and are absent from the model tool surface.

Wait admission checks the calling credential's execution and binding epoch under the Bureau mutation queue. A queued request from a retired execution cannot register against its replacement. Large MCP wait responses contain bounded summaries with `reportTruncated: true`; inspect their run, assignment and attempt references for the full report. Exact wait retry returns the same bounded response while the complete report remains in the durable result. Turn settlement and durable provider retirement trigger assignment reconciliation, and inspection/wait/retry admission refresh observations without replaying work. Retained origin reports are replayed before an unfinished attempt is classified as interrupted.

### Current Linux stack acceptance

`npm run build` publishes `dist/build-manifest.json` after compilation. The manifest hashes the current TypeScript source, lockfile, compiler configuration, editor fixtures, Neovim configuration and compiled files. Acceptance independently verifies those bytes, Git HEAD and the Node executable. Dirty source remains identified by its content digests and is reported as dirty.

Run `npm run accept:linux-stack -- --revision <full-oid> --node <absolute-node> --fixtures <private-directory> --evidence <private-directory> --scenario deterministic` on Linux with Node 24.13.0. The fixture and evidence directories must be canonical, private and disjoint. Keep the fixture directory path at most 37 UTF-8 bytes so native Unix socket paths fit. Set `NVIM_TEST_EXECUTABLE` to the destination Neovim executable and `AGENCY_FIXTURE_PLUGIN_ROOT` to its installed agentic.nvim checkout. The runner starts private production Handler compositions and native fixture providers; it does not contact a model service. `live` is rejected until a reviewed configuration is supplied by the later cross-host acceptance flow.

| Case | Coverage |
| --- | --- |
| root-tools-report-wait | MCP bootstrap, offline report, replayed wait |
| notification-admission | Durable acceptance before notification dispatch |
| headless-permission | Pending permission and later human attachment |
| shared-observers-detach-cancel | Shared session, detach and explicit cancellation |
| handler-reconcile-restore | Handler death, cleanup and explicit native restore |
| editor-replacement | Editor replacement preserves provider identity |

Every launched Handler, provider, MCP helper, editor and ACP endpoint has retained fixture ownership evidence. The acceptance parent independently reobserves exact process identities and owned process groups after cleanup. Failed observations, missing evidence, skipped cases, changed builds and survivors fail acceptance. Reports, test output and ownership records remain in a unique evidence directory after fixture state is deleted. No unverified process is signaled by the runner. Darwin can run the same fixtures for development; it cannot establish Linux acceptance. Historical `qualify-linux.ts` remains unchanged.

### Enrolled-host transport boundaries

An enrollment records an inventory UUID, trusted Agency host ID, SSH hostname, absolute Agency executable and absolute login shell. Enrollment is immutable; observing another host ID at the same hostname fails the handshake. Identical agent UUIDs on different hosts retain distinct full AgentRef identities. Host readiness records independent cwd, model, tools and Git checks with their source observation time. Unknown checks do not establish dispatch readiness.

The bridge uses SSH without a terminal, with batch authentication, strict host-key checking, a ten-second connect timeout and keepalives. Protocol frames are bounded UTF-8 NDJSON. Retained inbound and outbound work is bounded to 2 MiB per peer, with at most 64 concurrent inbound work items. Overload closes the connection, aborts pending request handlers and leaves operation outcomes for reconciliation. The local SSH process retains access to its SSH authentication agent; that socket path is absent from the remote command and destination bootstrap environment. Hello binds the connection to the enrolled host, exact Handler generation, protocol, runtime, revision and capabilities. A fresh snapshot precedes requests. Historical executions remain in snapshots for later fenced reconciliation. Invalid framing, an unsupported runtime or a changed identity closes the transport before dispatch.

The configured destination login shell runs the registered executable. Its startup output goes to stderr; retained SSH diagnostics are bounded. Output emitted by the SSH server's outer command shell before the wrapper runs fails framing and requires a quiet outer shell configuration. Prompt text, cwd, assignments and source environment values are absent from the SSH command. Each start or restore invokes a new destination login shell and passes a structured request on stdin. Only the short-lived destination CLI sends its current environment to its local Handler, after removing Agency credentials and stale editor addresses. Bridge reconnect never makes the old bridge environment fresh.

Duplex admission binds publication to the connection, exact execution, submission ID and prompt digest. Destination dispatch waits for the laptop's durable publication callback. Publication failure, timeout or EOF before confirmation releases admission without invoking ACP. An accepted reply cannot bypass that callback. Loss after confirmation remains an uncertain outcome for origin reconciliation. Closing a helper or SSH session closes coordination channels; it has no Handler shutdown or provider stop authority.

`internal-host-bridge` and `internal-host-call` are internal helper entrypoints. They use a private generation-bound `bridge.sock` connection. The codec, client and helper foundation is implemented here; production Handler endpoint composition, routed model tools and durable remote-origin replay are the following transport task. This foundation alone does not enable cross-host delegation or establish live SSH/Linux acceptance. Run the three `bridge-protocol`, `bridge-ssh` and `bureau-hosts` test files for its deterministic checks.

## Remote host coordination

The private Handler bridge owns `bridge.sock` alongside the control, attachment and orchestration sockets. One persistent coordinator connection routes authenticated model tools over the laptop-initiated duplex bridge. The destination validates its local tool credential before forwarding execution, run, binding epoch and structured arguments. Credentials and process environments remain local; explicitly supplied session parameters are transient.

Remote reports are retained before relay. The laptop imports each origin stream with its original sequence, event ID and digest, then verifies the captured snapshot fence before classifying retired executions. Historical reports complete their original unsuperseded attempt. A disconnected host preserves the last observed attempt phase. A recovered launch whose prompt admission is unobserved remains uncertain; reconnect does not send that prompt.

Offline delegation and stop calls retain stable intents and return pending. Reconnect can replay them while their transient session parameters remain available. After Handler restart, an exact explicit retry supplies those parameters again. Wait transport detachment preserves the durable waiter and leaves shared transport usable; explicit cancellation ends the stored wait route separately.

Code assignments prepare an owned `moon/agency/` worktree from a fetchable immutable base. Restore validates the retained preparation and existing worktree, records HEAD and preserves partial edits. Replacement allocates a distinct branch and path. This transport increment grants no result-publication capability. Completed code reports are rejected until that capability exists; unpublished code results can be reported blocked.

### Enrollment and recovery

Enroll each existing destination using its exact inventory ID, Agency host ID, hostname, executable and login shell. `agy bureau enroll --input-json '<enrollment JSON>'` persists the endpoint without discovery. `agy bureau hosts --json` reads cached observations while disabled. Enable starts the enrolled bridges; disable closes those bridges and preserves the destination providers.

A managed bridge has one active or connecting peer. Reconnect uses exponential delay with jitter, capped at thirty seconds, and resets after a validated snapshot. Dispatch requires a fresh imported origin fence. Cached phases and observation times remain visible during outages. A changed host identity rejects the connection, and a replaced Handler generation fences stale actions without automatic restore or prompt replay. Provider failure marks an assignment failed; loss of SSH alone preserves its last observed state.

Reconnect first reconciles the coordinating Bureau's owned streams, then requests the remote control/report outbox replay. Unrelated local runs on the enrolled Handler do not enter that Bureau's mirror or acquire its acknowledgment. Remote BUSY errors keep notification delivery queued; settlement triggers one delivery with the same retained identity.

### Bounded cross-host acceptance

`node dist/scripts/accept-cross-host.js --check --config /absolute/reviewed-config.json` validates the proposed live configuration. It requires laptop/A/B identities and inventory IDs, exact source revision and source/build digests, Node v24.13.0, destination executable/shell/cwd paths, explicit Codex models and settings, stable command IDs, two exact prompt texts, editor detach/reattach, one bridge interruption and two scoped stop/readback passes. The closed schema rejects inferred targets, extra prompt budget, Git publication, restore, reboot and installation authority. `test/cross-host-acceptance.test.ts` contains the configuration shape.

This command performs configuration validation only. Its result sets `acceptanceVerified: false`; it does not run SSH, start providers or establish live acceptance. The actual live milestone remains a separately reviewed operation batch after concrete targets and staging details are supplied. Retain the observed run, assignment and exact execution refs from that batch, current Linux qualification evidence on both destinations, prompt/report/wait receipts, editor observations, interruption observations and independent cleanup readback. Deterministic Handler generation replacement is a recovery simulation, not a physical reboot result.

## Local human controls

Local controls require the updated Handler and a live, unambiguous, ready generation. They use the existing runtime socket. They do not start a Handler, read the caller's working directory or contact Bureau.

```bash
agy roster list --local [--limit 100] [--cursor CURSOR] [--cwd ABSOLUTE_PATH] [--json]
agy permission list --local [--json]
agy permission decide --local --input-json '{"commandId":"UUID","ref":<permission-ref>,"optionId":"OPTION"}' [--json]
agy permission inspect COMMAND_UUID --local [--json]
```

The roster contains active local sessions, including sessions still starting. A starting row can have `live: false`. Permission refs come from the owner snapshot and identify the exact Handler and provider generation. Select the command UUID before sending a decision. A decision is submitted once. If the reply is lost or cannot be validated, the client exits 75 with `INCOMPLETE` and that command ID. Inspect the command before deciding how to recover; a null inspection does not prove that the earlier decision failed. An `applied` decision exits 0, while `claimed`, `uncertain`, `stale` and `withdrawn` exit 75. Inspection itself is a read and returns historical receipts as observations.

Core readiness covers local ACP sessions and controls. Task services initialize afterward in one background attempt, so their endpoints can be unavailable after the Handler becomes ready. Failed optional startup appears in status and doctor runtime diagnostics. Global commands without `--local` remain dependent on task coordination during migration. Local watch is not available in this increment; use explicit list and inspect.

The owner still uses the existing durable permission arbiter because remote consumers read its history. Owner permission-storage failure can therefore disable local permissions while ordinary sessions remain usable. Moving that arbiter to memory and replacing remote consumers are later migration steps. Legacy task mutation-publication hooks also remain coupled to the runtime queue; task snapshot consumers now run outside it.

## Routed human approvals

`agy permission list --json` returns pending origin offers and unavailable hosts. `agy permission watch --json` streams complete replacement snapshots with consecutive sequence numbers and a stream generation. Disconnects withdraw decision freshness; stream gaps require a new initial snapshot. Neovim exposes this collection through `:AgencyPermissions`, including full origin identities, origin directory, opaque tool subject and the provider's advertised options in the preview. Attachment replacement closes the collection and its watch process.

Use `agy permission decide --command-id <uuid> --input-json '{"ref":<permission-ref>,"optionId":"<advertised-id>"}' --json` for an exact human decision. `agy permission inspect <command-uuid> --json` reads its retained routing receipt. Remote parent editors route this human command through their Handler to the coordinating Bureau; the parent provider's native permission channel is independent.

The origin durably claims one option before initiating one bounded provider response write. `applied` establishes completion of the local IPC write. It does not establish that the provider executed the tool. A write failure, lost routing reply or failed receipt publication can remain `uncertain`; inspect the same command ID before deciding how to recover. Exact retries reconcile retained origin receipts without sending another provider response. Cancellation and generation retirement invalidate pending references, and historical journal replay cannot recreate them. Permission-store initialization or read failure leaves ordinary agent inventory, attachment and explicit restoration available, while permission decisions fail closed with `PERMISSIONS_UNAVAILABLE`. Origin snapshots preserve ordinary agent observations; the permission collection reports an unavailable origin. Permission evidence currently remains retained without compaction; disk usage and scan cost grow with its history.

## Bureau roster and remote entry

`agy roster --json` reads host-qualified agents. `agy roster watch --json` and `agy roster watch --format ndjson` emit complete replacement snapshots with consecutive stream sequence numbers. Provider phase, attempt state and host connectivity are independent. Last observations survive disconnects, but disconnected or stale-generation rows cannot authorize entry. Model, tool and Git qualification are reported as unknown until separately checked.

The active Neovim picker uses the Bureau roster when available and falls back to the local inventory on stream loss. Compact rows show task/provider, directory, host and connectivity. The preview retains full execution, lineage, assignment, permission count and observation evidence. Selection preserves local editor splits. Remote rows cannot use the local stop operation.

Remote selection prepares an expiring stable-ID handoff at the origin Handler. It binds enrollment, host identity and exact Handler/provider generations. After SSH, `internal-entry` verifies the actual host, consumes the intent locally and attaches only the recorded Agency-owned tmux/editor target. Neovim sockets remain on their host. Reused foreign tmux names are rejected. Interrupted creation or attachment remains uncertain; exact attached-editor readback can reconcile it without recreating or reactivating the editor. Retained receipts alone cannot authorize terminal entry after provider retirement.

Inside local tmux, remote entry opens a new window. Outside tmux, configure `vim.g.agency_remote_terminal_argv` with an argv prefix that launches a terminal and accepts the appended SSH argv. Entry reuses the private `~/.ssh/devbox-control/%C` ControlMaster/ControlPersist workflow. It neither attaches arbitrary remote sessions nor changes work synchronization ownership. `agy entry inspect <command-uuid> --input-json '<entry-ref>' --json` reads the retained origin intent through the Bureau.

### Immutable code results and human integration

A human can grant publication once in `agy run start --input-json` by adding `publication: {"destinations":[{"hostId":"<full-host-id>","repository":"/absolute/source/repository","remote":"origin"}]}`. Each destination must match the code assignment exactly. Dispatch derives authority for that attempt, execution, worktree, repository, resolved remote and generated `moon/agency/<run>/<assignment>/<attempt>` ref before provider activation. Models cannot widen the grant. Runs without the field retain no publication authority.

`agency_publish` accepts a stable command ID, the current immutable result OID and expected remote OID (null for ref creation). It verifies base ancestry and permits only creation or fast-forward updates. The exact-ref lease is a compare-and-swap condition; it does not authorize history replacement. A changed source path, repository identity, remote configuration, execution or remote ref rejects publication. A lost reply remains uncertain until the exact ref/OID can be read back. A completed code report supplies the retained publication command as `git.publicationCommandId`; the origin adds its actual published receipt, and the Bureau verifies the run grant and assignment binding. A worker's `published` boolean grants nothing.

Configure the Bureau-local destination and validation argv with `agy git configure --input-json '{"destinationCwd":"/absolute/destination","remote":"origin","validations":[["node","--test"]]}'`. `agy git verify <attempt-id> --destination /absolute/destination` fetches the reported base/result OIDs, checks common ancestry and creates an immutable content-addressed proposal. Validation commands run in a private detached worktree at the exact result revision. Worker validation text remains a claim and is never executed. Failed fetches, ancestry checks or validations remain visible issues and cannot authorize integration.

`agy git integrate <proposal-id> --command-id <stable-uuid> --expected-head <destination-oid> --strategy merge` performs an explicit merge of the reported OID. `cherry-pick` replays every validated source commit oldest first; merge commits or nonlinear histories require `merge`. The controller rechecks filesystem/repository/ref identity, configuration, HEAD, clean index/worktree and absence of another Git operation before mutation. It persists applying intent and records each resulting cherry-pick commit. `agy git inspect <command-id>` reads the retained receipt; an exact `integrate` retry only reconciles ambiguous application and does not repeat Git mutations. Terminal receipts release only their own retained destination fence, including recovery after a crash between receipt publication and fence deletion. After inspecting the destination and any surviving Git process, a human who has aborted or abandoned an operation can use `agy git abandon <original-command-id> <proposal-id> --expected-head <observed-destination-oid>`. It requires the original repository/worktree/ref identity, exact observed HEAD, clean index/worktree, no active Git operation and matching fence ownership. It records `abandoned` and releases that fence without resetting, aborting or applying Git. The original command remains terminal; any later integration uses a new proposal and command ID.

Conflicts preserve the destination and any partial progress. Agency does not reset, resolve or abort them. Recovery accepts an exact merge parent pair, or the complete ordered cherry-pick lineage with matching source trailers and patches. Incomplete or ambiguous recovery stays uncertain and fences a different integration command. Resolve retained conflicts explicitly in Git; an exact retry can establish completion only when its resulting lineage proves it. Unrelated external Git writers can race Agency's final check, so use a dedicated destination checkout. Agency's serialization does not lock other tools out of that checkout.

`:AgencyGitVerify <attempt-id>` prompts for the Bureau-local destination, verifies the report and shows the immutable commits, destination HEAD/ref, worker claims and configured validation results in the picker preview. Integration requires explicit strategy and confirmation. Configure `vim.g.agency_git_destination` for its initial destination value. Reverse human routing lets a parent editor use the laptop Bureau's destination without treating a remote path as a local checkout.

The controls have deterministic fixture coverage only until the separate live acceptance batch is approved. These commands do not grant deployment, provisioning, reboot, retirement or shared-checkout integration authority to an agent.

The controls acceptance proposal uses the separate `agency-controls-acceptance/1` schema. `node dist/scripts/accept-cross-host.js --check --config PATH` validates its pending approval, observed host identities, candidate source/build, isolated deployment paths, two-prompt budget, exact common Git remote identity, immutable base, stable initial/advance publication commands, receipt-derived worker submission and publication ref, editor paths and scoped cleanup. This is configuration-only; it executes no live operation. The earlier transport schema continues to reject installation, publication and Git integration. Live controls acceptance requires its own reviewed approval batch and fresh candidate generation readback before any provider submission.

### Independent host controls

The Handler owns the host bridge before it publishes readiness. Ordinary roster and permission commands read the session owner directly, even when optional task coordination is unavailable. Configure destinations with `agy host enroll --input-json JSON --json` and inspect configuration with `agy host list --json`. Enrollment uses the existing host configuration files.

`agy roster list --json` and `agy permission list --json` return `agency-host/1` aggregates with an available or unavailable observation per host. Roster aggregation reads every page from each owner; an unavailable observation is not a failed session. Use `--host HOST_ID` for a single owner, where roster limit/cursor filters are supported. Explicit `--local` roster and permission commands retain `agency-agent/3` output.

A permission decision uses its exact host, Handler and provider generations. Supply a stable command ID in the JSON or through `--command-id`. Inspect with `agy permission inspect COMMAND_ID --host HOST_ID --json`; inspection requires an explicit owner. `OUTCOME_UNKNOWN` retains the owner and command reference and requires explicit inspection before another decision. Connections do not resend mutations. Ordinary permission/roster watch commands are excluded; the editor refreshes owner views explicitly.

The task bridge, durable permission history and report-based Git commands remain compatibility APIs during migration. Owner permission history still depends on owner storage because legacy readers consume it. The host client does not mirror or replay that history.

### Independent entry and worktrees

`agy entry open --input-json '{"commandId":"UUID","hostId":"HASH","target":{"agentId":"UUID","handlerGeneration":"UUID","providerGeneration":"UUID"}}' --json` opens an editor for an exact live session. `agy entry inspect COMMAND_UUID --host HOST_ID --json` (or `--local`) inspects its current attachment. Commands exist only in the owner Handler process. Identical concurrent opens share one action; inspection never creates or activates an editor. A restart clears command observations, so an unknown command leaves a lost open outcome unknown. Uncertain or stale entry does not launch a terminal. Inspect the owner and command before taking another action. Neovim's owner picker uses this path without enabling Bureau.

`agy git prepare --input-json '{"repository":"/absolute/repo","cwd":"/absolute/new-worktree","branch":"moon/custom","baseOid":"IMMUTABLE_COMMIT_OID","remote":"origin"}' --json` prepares an ordinary Git worktree and returns its cwd. The remote is optional. Existing destinations and branches are refused, and an interrupted Git operation leaves its state for inspection. Pass the returned cwd to ordinary session startup. No Agency record, publication grant, or integration receipt is involved.

Use ordinary Git for collaboration: `git fetch origin COMMIT_OID`, `git show COMMIT_OID`, and `git merge COMMIT_OID` or `git cherry-pick COMMIT_OID` after review. The report/proposal-based `git verify`, `git inspect`, and `git integrate` commands remain transitional task conveniences. Durable entry prepare/consume is retained only by the internal task compatibility adapter; ordinary entry uses open/inspect.