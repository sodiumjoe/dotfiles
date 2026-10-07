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

This file cannot supply `NVIM`: each native start samples the editor environment and current server address. Explicit restore likewise captures fresh caller environment. Environment values are transient, not persisted in agent records or receipts. Reattachment cannot change a running provider's launch environment, including its `NVIM` address. A provider launched from an editor retains that address until explicit restoration launches a replacement generation. Dynamic editor routing is separate work.

Only configured, enabled, technically compatible backends are available. Codex is the initial production backend. Claude saved-session entries can remain visible as unavailable; their presence does not enable Claude or load them into Codex. Two deterministic backend fixtures exercise routing without claiming production Claude support.

## Neovim commands

| Mapping | Command |
| --- | --- |
| `<leader>ac` | `AgencyCurrent` |
| `<leader>an` | `AgencyNew` |
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

`<leader>ap` previews projects and opens the selected `project.md` without creating a session or changing the attached agent. `<leader>af` lists live agents across directories in the current Handler generation, including agents with active turns. Ready rows attach to the exact selected generation; live starting, restoring, and stopping rows are inspectable. Stopped, historical, and legacy records belong in `<leader>ar`. An empty active picker creates nothing. The active picker can stop the selected agent, but new-session creation and saved-session restoration use their separate entry points.

`<leader>an`, `agentic.switch_provider()`, and `agentic.new_session_with_provider()` select an Agency backend, model, and supported settings before creating a conversation. Model discovery uses fresh configuration-matching catalog evidence. When discovery is unavailable, the picker explicitly offers configured defaults. Cancelling any selection preserves the existing conversation. Codex model and reasoning choices use ordinary ACP configuration options, and its modes include full access.

`/new` inherits the current session's backend and uses its backend defaults for the new conversation. Session-specific model, mode, and reasoning selections are exposed through native Agentic configuration. Changes propagate to all attached editors and update restorable settings. Live attachment preserves current configuration rather than applying the reconnecting editor's defaults.

Native code selections, file references, and diagnostics own context capture. Structured ACP content is preserved. Annotation submission clears only the exact captured threads after accepted admission; busy or rejected admission leaves them intact, and subsequent annotation edits survive. Pending native context survives live loading. Changing the editor cwd does not retarget an attached session or its relative file links.

## Shared sessions and lifecycle

Every attached editor may submit while the session is idle. The Handler admits one turn at a time; a concurrent submission receives busy without replacing accepted input. The submitting editor displays its local input once, while other attachments and replay receive the same input. Retained transcript events are never prepended to another prompt. A lost response is not proof of rejection and never causes automatic redispatch.

Closing a tab, destroying a view, switching sessions, exiting Neovim, losing the endpoint, or `AgencyDetach` removes that attachment only. It does not cancel or stop the provider. A later attachment receives retained display history, current configuration, active-turn state, and subsequent updates. Truncated retained history has a visible marker.

`AgencyCancel` explicitly cancels the observed shared turn and leaves the provider available. Either attached editor can cancel. Cancellation is pinned to a turn ID, so a delayed request cannot cancel a later turn. An uncooperative provider can fail after the cancellation grace window; closing an editor does not invoke that policy.

`AgencyStop` confirms and stops the exact logical agent, Handler generation, and provider generation, then verifies owned-process cleanup. Stopped or recoverable sessions require explicit restore. Restore uses recorded cwd and native session identity with fresh caller environment. Logical identity remains stable; provider generation rotates. Old attachment mutations are rejected until an explicit live load binds the new generation. A failed restore never starts a replacement conversation.

## Shared permissions

The Handler forwards each provider permission request and its offered option IDs to every attached editor. The first valid selected option wins and reaches the provider once. Corresponding native permission UIs are withdrawn from all attachments. Provider-defined allow-once, allow-always, reject-once, and reject-always semantics remain provider-defined.

Closing an editor or clearing its callbacks is not a user rejection. If every editor disconnects, the provider keeps waiting. A later attachment receives the still-pending request. Explicit cancel, stop, provider failure, or generation replacement withdraws obsolete requests. Stale, malformed, superseded, or unoffered decisions cannot affect a replacement generation. There is no Agency human-deliberation timeout or automatic approval.

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

Status lazily starts or connects to one Handler. Doctor reads state without starting or cleaning up a Handler. Shutdown never starts one and ordinarily refuses active work; `--stop-agents` explicitly stops owned agents. Command IDs and Handler generations make lifecycle retries exact. Incomplete operations retain their original identities; inspection does not authorize a new mutation or prompt. Inventory cursors are revision-bound.

`agy acp` connects to the ready Handler's mode-0600 ACP socket inside its mode-0700 runtime directory. The endpoint owns no provider and emits only JSON-RPC on stdout. Initialization selects and starts no backend. Session load is live attachment, not implicit restoration. Authentication methods are not advertised. Client filesystem and terminal RPCs are not forwarded to an arbitrary editor; provider-owned tool execution is unaffected.

Control uses `agency-control/2`, agent lifecycle uses `agency-agent/3`, and the compatibility attachment stream uses `agency-attachment/1`. Exit codes are 0 for success, 64 for usage, 65 for invalid protocol, 69 for unavailable/stale targets, 70 for internal failure, and 75 for incomplete operations.

## Transport bounds and failures

Individual ACP frames and queued provider writes are bounded to 1 MiB. Startup/load wire input is bounded to 8 MiB, and stderr capture to 8 KiB. A native load exceeding those technical bounds fails visibly without fallback creation. Healthy prompt turns and human permission waits have no qualification-era total-turn deadline or cumulative assistant-output quota.

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