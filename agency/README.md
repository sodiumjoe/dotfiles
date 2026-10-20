# Agency

Agency owns persistent local agent processes and exposes them to native Agentic through ACP. Agentic owns the chat, context, configuration, tools, and permission UI. The Handler owns logical session identity, provider connections, process supervision, turn arbitration, command receipts, and explicit restoration. Multiple agents may run in the same directory, and multiple editors may attach to one agent.

## Getting started

Use Node 24.13.0 and the existing pinned lockfile. Build from `agency/` with `npm ci` and `npm run build`, or reuse an existing installation and run only the build. The existing dotfiles deployment provides `~/bin/agy`, which resolves the repository through its symlink chain and uses the pinned Node runtime. It never installs dependencies or builds implicitly.

The local Agency provider profile must already describe the installed Codex executable, ACP adapter package metadata, and declared configuration paths. Configuration lives beneath `${XDG_STATE_HOME:-$HOME/.local/state}/agency/hosts/<host-key>/catalog/`. The initial supported production adapter is `@agentclientprotocol/codex-acp` 1.7.0. Missing or incompatible dependencies produce an unavailable error; Agency does not install or upgrade them. Backend-native login remains outside Agency. Interactive ACP authentication is not implemented.

Neovim runs `agy status` before each ACP connection to start or connect to the Handler automatically. Successful status output is withheld from the ACP stream; startup failures are reported on stderr and prevent the connection attempt. Outside Neovim, run `agy status` before using `agy acp`. Neovim requires the built Agency package, `agy` on its inherited `PATH`, and the existing Agentic and Snacks plugins. The tested Agentic revision is `246feb4773923a10a6fedc40048657516bd05792`; the integration does not modify its installed files.

After a failed ACP connection exits, the next Agency request reconnects the cached client and discards stale readiness callbacks. Handler startup and ACP connection retries do not restore stopped provider sessions automatically.

After deploying the source configuration through the normal dotfiles workflow, start a new editor in the intended project directory. `<leader>ac` opens the current native Agency conversation or creates a backend-default session when no matching agent exists. `<leader>an` selects a backend for another conversation. The editor has exactly one enabled ACP provider, `agency`, running `agy status` followed by `agy acp`; selecting a backend does not switch or enable a direct editor provider.

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

`<leader>an`, `agentic.switch_provider()`, and `agentic.new_session_with_provider()` select an Agency backend and model before creating a conversation. Effort and permissions use the backend’s configured defaults; creation does not prompt for them. Model selection displays retained catalog evidence. Cached models remain selectable after a discovery timeout or stale refresh and are labeled cached; the picker shows the discovery failure when available. Session creation validates the selected model and configured settings against the provider. An incompatible configured default reports an unsupported selection rather than silently substituting another value. An absent catalog exposes only configured defaults, explicitly labeled when discovery is unavailable. Configuration edits apply to the next launch or explicit discovery refresh. Cancelling any selection preserves the existing conversation. Codex model and reasoning choices use ordinary ACP configuration options, and its modes include full access.

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

Model discovery captures worker and native stderr as private, mode-0600 files in `catalog/work/<attempt>/worker.stderr` and `native.stderr`. `diagnostic.json` binds the first failure stage, bounded exception/RPC details, observed process identities, native command, terminal code or signal, byte counts and capture completeness to the host, command, attempt, configuration fingerprint and Handler generation. These details remain private and do not replace the catalog's fixed public error messages. A recorded process observation does not authorize signaling; current cleanup uses the retained live group owner, while historical recovery checks exact launch records. The configured native command can itself be a wrapper, so this record does not establish the identity of an executable subsequently selected by that wrapper.

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

`agy help --json` lists exact flags and compatibility commands, including model catalog operations, explicit-selection start, scalar prompt, and NDJSON attachment. The CLI compatibility attachment uses the same provider core rather than a second chat runtime. Normal ACP creation does not require catalog qualification. Model discovery runs only through explicit `agy model refresh`; initialization, list, resume and elapsed time never start probes. Cached model offers remain advisory across TTL expiry and Handler generations. Native provider initialization validates the selected model and settings.

The active picker requests `agency/roster` over the cached Agentic ACP connection. This active-only query projects daemon memory without rereading retained files or waiting for their verification queue. Its cursors track changes to the projected records and diagnostics. Ordinary operations use initialized Handler state and check the addressed generation, ownership and mutation inputs. They do not inventory retained history. A cached display row does not authorize an action. The picker bounds readiness, requests, and full traversal, and reports connection failures without falling back to a fresh CLI process. An older running Handler must be restarted before it supports this endpoint.

Status lazily starts or connects to one Handler. Doctor reads state without starting or cleaning up a Handler. Shutdown never starts one and ordinarily refuses active work; `--stop-agents` explicitly stops owned agents. Command IDs and Handler generations make lifecycle retries exact. Incomplete operations retain their original identities; inspection does not authorize a new mutation or prompt. Inventory cursors are revision-bound.

`agy acp` connects to the ready Handler's mode-0600 ACP socket inside its mode-0700 runtime directory. The endpoint owns no provider and emits only JSON-RPC on stdout. Initialization selects and starts no backend. Session load is live attachment, not implicit restoration. Authentication methods are not advertised. Client filesystem and terminal RPCs are not forwarded to an arbitrary editor; provider-owned tool execution is unaffected.

Control uses `agency-control/2`, agent lifecycle uses `agency-agent/3`, and the compatibility attachment stream uses `agency-attachment/1`. Exit codes are 0 for success, 64 for usage, 65 for invalid protocol, 69 for unavailable/stale targets, 70 for internal failure, and 75 for incomplete operations.

## Transport bounds and failures

ACP frames and queued writes have no byte quota. The endpoint relays bytes with stream backpressure, and the Handler inspects routing and control fields while retaining serialized tool payloads for forwarding and replay. Write deadlines still detect stalled connections. Launch records retain legacy frame and queued-write byte fields for compatibility; transport ignores those fields. Stderr capture remains bounded to 8 KiB. Healthy prompt turns and human permission waits have no qualification-era total-turn deadline or cumulative assistant-output quota.

The Handler retains at most 16 MiB and 8,192 display events per live generation. Eviction removes an oldest prefix and exposes truncation; it does not terminate the turn or erase authoritative configuration. Display history is volatile across Handler/provider replacement. Native Agentic controls its own rendered buffers. Per-client queue overflow disconnects that connection rather than failing a healthy provider or unrelated agent.

Submission receipts remain available for the provider generation, including after display eviction. They retain IDs, digests, and completion metadata, not duplicated transcript bodies. Receipt count can grow until generation retirement. Malformed client input and stale identifiers affect that connection. Provider protocol failure affects its session and pending requests. Neither provider failure nor Handler loss automatically restores or replays interrupted requests.

## Ownership and retention

Private agent, command, catalog, and launch records bind boot identity, PID generation, parent, process group, session, UID/GID, and per-launch markers. Cleanup revalidates the exact group leader and current boot, owner, group and session before signaling. Helpers may change executables while that leader remains verified. Each durable evidence update is followed by a fresh authorization snapshot. Leaderless cleanup requires exact retained-member continuity, and final absence checks remain strict. Missing or replaced groups are not signaled, and ambiguous ownership remains visible rather than blocking unrelated launches. Provider helpers that detach from the recorded process group remain outside Agency ownership.

Live sessions retain the actual Node child and register its error, exit, and close events synchronously. Startup performs one bounded logical identity capture, with bounded retries for transient unavailable identity reads. Cleanup waits for terminal events, reauthorizes each group signal against the registered live leader, discharges transport, and verifies final absence before publishing the exact launch record as cleanup verified. A child error after PID allocation is nonterminal, and child exit alone does not prove descendant absence. Shutdown bounds its wait for admitted operations and reports incomplete cleanup if settlement remains unresolved. Late owned settlement may continue. Fatal loss of the owner can leave descendants; it never establishes verified cleanup.

Discovery retains the Handler-owned worker and the worker-owned native child at their actual spawn boundaries. The worker remains the process-group leader, and the native child stays in its group. Native observations extend final absence checks without granting the Handler direct grandchild signaling authority. Signals remain authorized by the platform group boundary. A settled worker keeps its leader alive until platform termination or IPC loss, so cooperative native shutdown cannot race group authorization.

A discovery result remains provisional until the final native settlement report, worker terminal and actual close, IPC discharge, absence of the group and retained members, and exact durable launch publication have all settled. A visible cleanup record whose directory fsync failed cannot publish fresh discovery evidence. An explicit verification may retry that publication from retained cleanup evidence without signaling or rediscovering; it cannot revive the original failed result. Worker loss or a forced group SIGKILL that prevents the final native report leaves cleanup unknown, even when the group is subsequently empty.

The singleton Handler is the sole writer of runtime records and retains initialized state in memory. Stop it before manually editing those records. Each admitted launch captures provider configuration once; later edits affect subsequent launches. Startup expiry fails that operation and retains unresolved cleanup without terminating the Handler or unrelated sessions. Late callbacks cannot publish readiness.

Publications check the addressed record, write and sync a temporary file, rename it atomically, and sync the parent directory. They do not audit unrelated retained files. Startup and shutdown use only current-generation owners and receipts. Historical agent inspection is lazy and read-only; active phases without a current owner display interrupted with unknown cleanup. Explicit restore reads the saved identity and configuration and creates a new generation without signaling the old one. Catalog and private qualification tests retain their small fixture roots after physical cleanup, including successful roots, so failed test bodies cannot erase diagnostics. Qualification uses direct private invocations; build hashes are captured once at the build boundary rather than per command. See `scripts/qualification/README.md`.

Runtime history is retained until explicit maintenance. Handler startup and session completion do not replay pending retirement intents or delete historical records. Task reports and provider-native state remain on disk. There is no supported archive/prune command or total-storage cap. Existing pending retirement intents are preserved; reads of affected history report incompleteness without disabling fresh sessions.

Old Bureau/orchestration workflow files remain available for manual inspection and cleanup. Startup and retention neither resume nor rewrite them, and task records do not pin runtime history or worktrees. Companion names `bureau.sock` and `orchestration.sock` remain only in existing private-socket validation and proven-dead-generation cleanup. Live or ambiguous owners are never unlinked.

Failed discovery diagnostics retain their work directory, metadata, launch record, owning receipt and snapshot for seven days after diagnostic completion, including historical automatic-discovery receipts. Successful discovery follows ordinary retirement. Unfinished, unreadable or incomplete captures remain retained; a worker killed before native stderr drain cannot establish complete capture. Historical probes without a diagnostic record follow the previous policy. Retirement hashes large private work files incrementally without a stderr size limit. Evidence required for investigation must be exported before eligible retirement.

The Handler does not persist an append-only transcript or environment values. Native providers retain their own state under caller configuration. Agentic debug logging is disabled; explicitly enabling it later can log ordinary ACP requests, including transient start metadata.

### Explicit probe recovery

`agy model recover-probe --attempt-id UUID --handler-generation UUID --sha256 HEX --json` is an offline maintenance operation for one quarantined managed V2 catalog probe. The digest identifies the original raw launch record, not a reserialized copy. The recorded Handler PID must be absent on the unchanged boot, and the startup lock is held throughout. Every retained provider PID must be absent and its group empty in two independent checks. Retained helper executable changes are accepted only when their process generation and all other identity fields agree; the leader identity must remain exact. Live or reused PIDs, observation failures, incomplete ownership, changed state, and conflicting archives reject recovery. Legacy V1 probes are unsupported.

Recovery preserves the original launch, metadata, command receipt, Handler record, and digest manifest under `agency/recovery/<host>/<attempt>/`, separately from runtime history. It then publishes only a cleanup-verified derivative of that launch. Retries require the same digest and matching archived evidence. Failed archive writes leave quarantine intact; failures after replacement can be retried to establish durability. Recovery never signals processes, stops or starts the Handler, restores agents, or alters ordinary sticky quarantine. Stopping a live Handler is a separate, explicitly authorized maintenance action.

## Verification

Run `npm test` from `agency/` for deterministic tests with injected process ownership. Run `npm run test:native` for the complete normal process, lock, Handler, and editor fixture group. Mixed files belong to the native group. Both commands exclude the three large contention cases; the normal native group retains a two-client singleton smoke test. Run `npm run test:stress` for those contention cases, or `npm run test:all` to include every group and stress case. Each command builds once, uses a 30-minute group watchdog, and preserves a known nonzero Node runner exit status. Existing targeted scripts remain available for affected tests.

Each group invocation allocates a private `run-*` directory and prints its `result.json` path. Set `AGENCY_TEST_EVIDENCE_PARENT` to choose the parent directory; consecutive invocations always allocate separate roots. The compact result records the revision, command, outcome, worker fixture results, unresolved cleanup and artifact locations. Every selected worker must report, including workers whose tests are wholly filtered. Body failure and cleanup failure are retained independently. Missing, malformed, duplicate or foreign worker boundaries make the run incomplete.

Fixture children register their actual handles in memory. Declared spawners report directly to their test worker, so later provider launches remain visible after a submitting command exits. Signal requests require a registered current-run identity and a fresh exact observation. Worker results are evidence and never authorize signals. The finite test controller, Node workers, platform observation commands, native lock helper, Git commands and Neovim remote-expr clients form the trusted infrastructure boundary; they have bounded execution and are awaited rather than recursively inventoried.

The runner writes `running` before spawning. Abrupt interruption leaves that state incomplete; it does not reconstruct descendants from old files. A watchdog requests cancellation only for the registered direct controller and bounds its close wait. Unexpected source loss remains incomplete even if later physical absence is observed. Roots and failure evidence remain on disk and require manual removal after inspection, so repeated runs consume temporary storage.

Editor fixtures qualify physical endpoint/group absence and application behavior. If the installed transport discards its native exit callback by closing the handle, the result marks that callback unavailable and independently verifies absence; it does not qualify libuv callback delivery or pipe-close timing.

Run retained Agency/Agentic specs with `./test-nvim.sh tests/neovim/<spec>.lua` from the repository root, including `agency_replay_spec.lua` for ordinary history rendering.

These tests use deterministic providers and isolated temporary roots. Fresh-process coverage loads the installed native Agentic classes in independent Neovim processes with private home/state/cache, explicit repository runtime paths, fixture-only endpoints, and no user startup configuration. `NVIM_TEST_EXECUTABLE` selects the binary; Darwin defaults to `/opt/homebrew/bin/nvim`. Teardown reports and independently verifies editor, endpoint, Handler, and provider absence.

The test scripts do not invoke a real model, paid prompt, login, deployment, or `accept:codex`. Live SSH, Linux and real-provider qualification remain separate. Real-provider acceptance requires an explicit prompt count, target directory, allowed edits, and exact cleanup targets. Historical plans and qualification evidence remain immutable descriptions of earlier architectures, not runtime inputs.

## Local human controls

Local controls require the updated Handler and a live, unambiguous, ready generation. They use the existing runtime socket. They do not start a Handler or read the caller's working directory.

```bash
agy roster list --local [--limit 100] [--cursor CURSOR] [--cwd ABSOLUTE_PATH] [--json]
agy permission list --local [--json]
agy permission decide --local --input-json '{"commandId":"UUID","ref":<permission-ref>,"optionId":"OPTION"}' [--json]
agy permission inspect COMMAND_UUID --local [--json]
```

The roster contains active local sessions, including sessions still starting. A starting row can have `live: false`. Permission refs come from the owner snapshot and identify the exact Handler and provider generation. Select the command UUID before sending a decision. A decision is submitted once. If the reply is lost or cannot be validated, the client exits 75 with `INCOMPLETE` and that command ID. Inspect the command before deciding how to recover; a null inspection does not prove that the earlier decision failed. An `applied` decision exits 0, while `claimed`, `uncertain`, `stale` and `withdrawn` exit 75. Inspection is a read and returns current-generation receipts as observations.

Core readiness covers local ACP sessions and controls. Task services initialize afterward in one background attempt, so their endpoints can be unavailable after the Handler becomes ready. Failed optional startup appears in status and doctor runtime diagnostics. Global commands read each configured session owner through the host client. Local watch is not available in this increment; use explicit list and inspect.

Permission offers, callbacks and decision receipts exist only in the owning Handler process. A valid decision claims the request before invoking its callback. Concurrent identical command IDs share one completion; conflicting reuse is rejected. Inspection can report `claimed` while the callback is pending. Success becomes `applied`, and a failed callback becomes `uncertain` without reopening the request. Other valid decisions return `withdrawn` until exact-session invalidation removes the offer metadata. Invalid options leave a pending request available.

Restart clears pending permissions and receipts. Old refs are stale, and inspection of an old command returns null unless the current owner has recorded a new refusal for that command. The retained `throughSeq` field is a process-local change counter that resets with each Handler generation. It is never a journal cursor. Reconnecting views refresh current state; neither clients nor the owner reload or resend old decisions.

## Host controls

The Handler owns the host bridge before it publishes readiness. Ordinary roster and permission commands read the session owner directly, even when optional task coordination is unavailable. Configure destinations with `agy host enroll --input-json JSON --json` and inspect configuration with `agy host list --json`. Enrollment remains at `<persistentRoot>/bureau/hosts/<inventoryId>.json`. The directory name is retained for existing enrollments; it does not load Bureau settings or workflow state. Enrollment preserves trusted host/hostname identities and refuses conflicting replacements without rewriting existing bytes.

`agy roster list --json` and `agy permission list --json` return `agency-host/1` aggregates with an available or unavailable observation per host. Roster aggregation reads every page from each owner; an unavailable observation is not a failed session. Use `--host HOST_ID` for a single owner, where roster limit/cursor filters are supported. Explicit `--local` roster and permission commands retain `agency-agent/3` output.

A permission decision uses its exact host, Handler and provider generations. Supply a stable command ID in the JSON or through `--command-id`. Inspect with `agy permission inspect COMMAND_ID --host HOST_ID --json`; inspection requires an explicit owner. `OUTCOME_UNKNOWN` retains the owner and command reference and requires explicit inspection before another decision. Connections do not resend mutations. Ordinary permission/roster watch commands are excluded; the editor refreshes owner views explicitly.

The host client does not mirror permission history or replay previous mutations.

The bridge protocol is `agency-bridge/2`, with hello, request, reply and cancellation frames only. A version-1 peer fails explicitly with `UNSUPPORTED_BRIDGE_PROTOCOL` before any operation is dispatched. Both endpoints require a coordinated upgrade and explicit Handler restart; there is no alternate legacy helper or automatic mutation retry. SSH remains noninteractive, preserves destination login-shell quoting and protocol stdout isolation, and uses the local authentication agent without forwarding its socket path to the destination.

## Host sessions

Ordinary session operations use the owning runtime and remain available without task coordination. Select exactly one `--host HOST_ID` or `--local`. The latter selects the local Handler. These commands require an already running Handler and never start one or poll automatically. JSON replies use `agency-host/1`.

```text
agy session start --host HOST_ID --input-json JSON --json
agy session inspect AGENT_UUID --host HOST_ID --json
agy session command COMMAND_UUID --host HOST_ID --input-json '{"commandGeneration":"HANDLER_UUID"}' --json
agy session submit --host HOST_ID --input-json JSON --json
agy session submission --host HOST_ID --input-json JSON --json
agy session cancel --host HOST_ID --input-json JSON --json
agy session stop --host HOST_ID --input-json JSON --json
```

Start takes a caller-selected command UUID and expected Handler generation, an absolute destination cwd, an explicit backend, and optional native settings and session parameters:

```json
{"commandId":"CALLER_COMMAND_UUID","handlerGeneration":"HANDLER_UUID","cwd":"/workspace/project","backendId":"codex-acp","settings":{"modelId":"MODEL_ID"},"nativeParams":{"mcpServers":[]}}
```

Start returns an admission receipt immediately. Inspect the command until its outcome is `started` to obtain the live `{agentId, handlerGeneration, providerGeneration}` target. `commandGeneration` is the generation of the original start or stop, even when inspection uses a connection to a newer Handler. A used start command ID is rejected, including identical input; choose a new ID for an explicit new attempt. Submit accepts that exact target and a caller-selected submission UUID:

```json
{"target":{"agentId":"AGENT_UUID","handlerGeneration":"HANDLER_UUID","providerGeneration":"PROVIDER_UUID"},"submissionId":"CALLER_SUBMISSION_UUID","text":"Inspect the current implementation."}
```

Submission and cancellation inputs use `{target, submissionId}`. Stop takes `{commandId, agentId, handlerGeneration, providerGeneration}`. Submit returns its live receipt immediately. Identical submission ID/content can return the existing live receipt; different content conflicts, and another active turn returns `BUSY`. Submission inspection returns status, stop reason and failure. Existing attachments provide model output. A completed submission does not imply a task completion report.

Admission and cancellation acknowledgements exit 0. Command inspections exit 75 while pending or failed/interrupted, and 0 for a completed successful start/stop. Submission inspection exits 75 while accepted/running or failed, and 0 when completed, including cancellation. Null session/command/submission observations and unavailable or stale owners exit 69. Usage and oversized input exit 64. `BUSY`, command conflicts and unknown mutation outcomes exit 75.

A lost or malformed mutation reply includes the original reference and is never resent automatically. For start/stop, use `session command` with the reference's command ID and original Handler generation. For submit/cancel, use `session submission` with the reference's target and submission ID. A null read or missing live tuple does not prove the earlier operation failed. Live submission state is unavailable after retirement or Handler restart; inspect state manually before choosing another operation.

New starts use the filtered destination Handler process environment plus backend defaults. Caller environment is not transmitted, and a fresh login shell is not run per start. Credentials or shell environment changed after Handler startup require an explicit Handler restart or backend configuration edit. Local runtime command persistence/recovery is transitional; this host path adds no durable routing, mutation replay or automatic supervisor wakeups.

## Entry and worktrees

`agy entry open --input-json '{"commandId":"UUID","hostId":"HASH","target":{"agentId":"UUID","handlerGeneration":"UUID","providerGeneration":"UUID"}}' --json` opens an editor for an exact live session. `agy entry inspect COMMAND_UUID --host HOST_ID --json` (or `--local`) inspects its current attachment. Commands exist only in the owner Handler process. Identical concurrent opens share one action; inspection never creates or activates an editor. A restart clears command observations, so an unknown command leaves a lost open outcome unknown. Uncertain or stale entry does not launch a terminal. Inspect the owner and command before taking another action. Neovim's owner picker uses the same live entry path.

`agy git prepare --input-json '{"repository":"/absolute/repo","cwd":"/absolute/new-worktree","branch":"moon/custom","baseOid":"IMMUTABLE_COMMIT_OID","remote":"origin"}' --json` prepares an ordinary Git worktree and returns its cwd. The remote is optional. Existing destinations and branches are refused, and an interrupted Git operation leaves its state for inspection. Pass the returned cwd to ordinary session startup. No Agency record, publication grant, or integration receipt is involved.

Use ordinary Git for collaboration: `git fetch origin COMMIT_OID`, `git show COMMIT_OID`, and `git merge COMMIT_OID` or `git cherry-pick COMMIT_OID` after review. The Bureau, run and assignment commands, old task tools, report-based Git commands, and durable entry prepare/consume are removed. Ordinary entry uses open/inspect, and Git preparation remains independent. Existing run/attempt IDs are not task IDs.

## Worker-owned tasks

Select a task UUID and a destination before dispatch. The task adapter starts one ordinary session and submits the initial text once. Admission returns before provider readiness. A lost create or report reply returns `OUTCOME_UNKNOWN` with the original task reference; reconnect and inspect that reference before taking another action. Creates never replay, and a repeated task UUID is rejected even when its input is identical.

```sh
agy task create --host HASH --input-json '{"taskId":"UUID","description":"Run checks","cwd":"/repo","backendId":"codex-acp","text":"Run checks and report the result"}' --json
agy task inspect UUID --host HASH --json
agy task wait UUID --host HASH --input-json '{"timeoutMs":10000}' --json
agy task report UUID --local --input-json '{"outcome":"completed","summary":"Checks passed"}' --json
```

Each command also accepts `--local` in place of `--host HASH`. Reports explicitly declare `completed`, `blocked`, or `failed`; ordinary `end_turn` remains pending. A report replaces the entire previous report. Inspect and wait repeatedly return the same retained result without consuming it. Waits run only in the caller, last at most 60 seconds, and cancellation leaves the worker running. Timeout zero performs one inspection, bounded by the ordinary 10-second read limit. A deadline with no observation returns unavailable; a deadline after an observation returns pending. Missing tasks and incomplete storage remain typed errors. A missing or replaced runtime session establishes an unknown outcome.

Records and reports remain under `<persistentRoot>/tasks/<taskId>/` until explicit maintenance. The report takes precedence if the record status update failed. Cleanup and repair are manual while the task service is inactive; tasks pin neither runtime history nor Git worktrees. There is no automatic replay, completion notification, or supervisor prompt.

Inspection reads the retained record and live runtime separately. The runtime can be running while the returned record still has a null session, because startup may advance between those reads. A caller that needs a running worker and its recorded session must require both a running runtime and a non-null session in the same returned observation. Inspection does not rewrite the record or replay launch or submission.

### Task MCP configuration

Task workers receive one ordinary stdio MCP entry named `agency_tasks`. Its command is the Handler's absolute Node executable, its args are `["/absolute/agency/dist/src/main.js", "internal-task-tools"]`, and its environment contains `AGENCY_TASK_REF` as the JSON host/task reference. Existing caller MCP entries are preserved. A caller entry named `agency_tasks` is rejected before admission. This default reference is a convenience binding in the trusted local environment. An explicit report reference must match it.

An ordinary supervisor session can use the same `agency_tasks` entry with `env: []`. `agency_task_create({hostId,input})` requires a destination and preselected task UUID; input has the same shape as the public CLI. `agency_task_inspect({ref})` and `agency_task_wait({ref,timeoutMs})` read explicit references. `agency_task_report({ref?,report})` replaces the owner report; a worker can omit ref when configured with its default. Reporting resolves locally before host inventory or relay routing, so it remains available with the laptop disconnected. A reported failed/blocked outcome is a successful tool response. Transport or storage failures set `isError` and retain the task reference when known.