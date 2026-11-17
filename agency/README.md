# Agency

Agency owns persistent local agent processes and exposes them to native Agentic through ACP. Agentic owns the chat, context, configuration, tools, and permission UI. The Handler owns logical session identity, provider connections, process supervision, turn arbitration, command receipts, and explicit restoration. Multiple agents may run in the same directory, and multiple editors may attach to one agent.

## Getting started

Use Node 24.13.0 and the existing pinned lockfile. Build from `agency/` with `npm ci` and `npm run build`, or reuse an existing installation and run only the build. The existing dotfiles deployment provides `~/bin/agy`, which resolves the repository through its symlink chain and uses the pinned Node runtime. It never installs dependencies or builds implicitly.

The production launch contracts qualify Codex ACP 2.6.0 and Claude ACP 0.102.0 with Claude Agent SDK 0.3.321. These dependencies are exactly pinned in `node-bin/`; other launch versions are rejected. Restore uses the current contract while preserving each recorded native session and its saved settings.

Agency derives enabled Codex and Claude provider configurations in memory when `catalog/providers.json` is absent. Codex uses this repository's `home/bin/acp-codex` wrapper and `~/.codex/config.toml`. Claude uses the pinned Agent SDK's platform-specific native executable, the installed Claude ACP and Agent SDK metadata, and `~/.claude/settings.json`. Direct native execution avoids shell-wrapper process-identity races during discovery. Both providers resolve deployed symlink targets to canonical paths. Discovery, launches, Restore, and backend defaults use the same reader. The runtime works without a prior bootstrap configuration step or a profile file. Declared Codex configuration may be absent; Agency detects its later creation through configuration evidence.

An optional private `catalog/providers.json` overrides the default completely. Its location is `${XDG_STATE_HOME:-$HOME/.local/state}/agency/hosts/<host-key>/catalog/providers.json`. Explicit empty or disabled configurations remain authoritative; `{"version":1,"providers":[]}` disables both standard providers. An existing Codex-only override must include an enabled `claude-agent-acp` profile to expose Claude. Malformed, symlinked, or insecure overrides produce an error and never fall back to defaults. Existing profiles from older bootstrap runs remain overrides. Agency and bootstrap do not generate or delete these files automatically.

Bootstrap validates the default backend's enabled provider and compatible installed files before starting the Handler. The validation command does not launch a provider, authenticate, refresh models, or write provider configuration.

Missing or incompatible dependencies produce an unavailable error; Agency does not install or upgrade them. Backend-native login remains outside Agency. Log in with `claude` before starting Claude sessions. Interactive ACP authentication is not implemented. Claude uses the named `claude-agent-acp` package binary rather than its library entry point.

After a manual build, the same optional validation check is available from the dotfiles repository root:

```bash
"${NODENV_ROOT:-$HOME/.nodenv}/versions/24.13.0/bin/node" agency/dist/scripts/setup-provider.js
```

A custom installation can supply its own private `catalog/providers.json`. Validation checks the resolved default backend and leaves explicit configuration unchanged.

Neovim runs `agy status` before each ACP connection to start or connect to the Handler automatically. Successful status output is withheld from the ACP stream; startup failures are reported on stderr and prevent the connection attempt. Outside Neovim, run `agy status` before using `agy acp`. Neovim requires the built Agency package, `agy` on its inherited `PATH`, and the existing Agentic and Snacks plugins. The tested Agentic revision is `246feb4773923a10a6fedc40048657516bd05792`; the integration does not modify its installed files.

After a failed ACP connection exits, the next Agency request reconnects the cached client and discards stale readiness callbacks. Handler startup and ACP connection retries do not restore stopped provider sessions automatically.

After deploying the source configuration through the normal dotfiles workflow, start a new editor in the intended project directory. `<leader>ac` opens the current native Agency conversation or creates a backend-default session when no matching agent exists. `<leader>an` selects a backend for another conversation. The editor has exactly one enabled ACP provider, `agency`, running `agy status` followed by `agy acp`; selecting a backend does not switch or enable a direct editor provider.

Source builds do not deploy configuration or restart existing editors, Handlers, or providers. An existing Handler needs a normal restart to load updated runtime code.

## Backend defaults and environment

Absent an explicit backend configuration, Agency offers the enabled resolved production providers, including the runtime defaults when no profile override exists. Codex remains the default when enabled; Claude becomes the default for a Claude-only installation. Its default environment includes `INITIAL_AGENT_MODE=agent-full-access` and `MODEL_PROVIDER=litellm`; its initial mode is `agent-full-access`. Caller environment values take precedence over backend defaults. For Codex startup and Restore, Agency derives `CODEX_PATH` from the resolved provider profile executable at the final adapter spawn, overriding any backend or caller value. Discovery uses that same profile executable. Existing `CODEX_PATH` settings remain readable but cannot select another Codex launcher. To use a wrapper such as `~/bin/acp-codex`, configure its actual absolute path as the profile executable. Paths containing spaces are passed intact without shell expansion. A wrapper can select a nested executable through PATH or bootstrap logic; that nested executable remains outside the `declared-config-v1` identity boundary. For Claude startup and Restore, Agency similarly binds `CLAUDE_CODE_EXECUTABLE` to the declared profile executable. Claude has no imposed initial settings and retains its native model, effort, and permission defaults. Model and reasoning choices come from the provider rather than global Agentic overrides. The old read-only/high/deny-all editor policy is not imposed on ordinary ACP sessions.

The shared `acp-codex` wrapper launches `/deploy/codex-wrapper-hosts/current/bin/codex` on hosts with that deployment root and uses `codex` from PATH elsewhere. Keep the profile pointed at the wrapper's actual file path, so new launches follow deployment updates instead of retaining a resolved deployment path.

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
    "compatibilityId": "codex-acp-2.6"
  }]
}
```

Each native start samples the caller environment, and explicit restore captures it again. Environment values are transient and are not persisted in agent records or receipts. After merging backend defaults, the Handler overrides both `NVIM` and `NVIM_SOCKET_PATH` with a private editor RPC socket for that provider generation. Its path remains stable when editors attach or disconnect.

Only configured, enabled, technically compatible backends are available. Codex and Claude are production backends. A Claude entry requires its enabled profile, backend, and exact compatible dependencies; saved history alone does not enable it. An existing explicit Codex-only `backends.json` must also include Claude with compatibility ID `claude-agent-acp-0.102`. Source builds do not restart a running Handler; stop its live sessions normally before restarting to load a newly added contract.

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

When several active conversations match the current directory, `<leader>ac` shows their titles, backend/model, working directory, and activity. The preview includes the full title, agent identity, and available branch, plan, and environment metadata. Selecting a conversation waits for the picker windows to close before attaching; cancelling preserves the existing agents. A single match opens directly, and an already attached conversation still toggles its panel.

`<leader>ap` previews projects and opens the selected `project.md` without creating a session or changing the attached agent. `<leader>af` lists live agents across directories in the current Handler generation, including agents with active turns. Ready rows attach to the exact selected generation; Starting, restoring, and stopping rows are inspectable, including before process ownership and during cleanup. Stopped and recoverable Agency sessions belong in `<leader>ar`. The list uses aligned columns for a bracketed devbox label, conversation title, and compact status. Local rows use `[local]`; remote labels come from `pay remote list --raw`, matched by the enrolled SSH hostname. Labels and titles shorten to fit the list width while full titles, names, backend/model, working directory, activity, and editor connection remain in the preview and searchable metadata. Reachable hosts without a resolved name use `[unnamed remote]`. Connection diagnostics appear below sessions, including while filtering. Unavailable hosts without a resolved name are grouped into one `[unlisted remotes]` row; its preview retains every hostname, host ID, and error code. Hostnames stay in previews rather than filling the list. Name lookup has an independent three-second deadline. Full identifiers and environment metadata appear in the preview. Titles survive editor disconnects while the Handler retains the conversation. "Open in this tab" identifies the current editor connection; "Available to open" identifies other live agents. Cleanup evidence remains in diagnostics. Attachment waits until every picker window has closed. Each opening queries each source once. Local rows appear as soon as the local read finishes; remote rows and diagnostics are added once the host and remote-name reads finish. This final addition preserves the highlighted item and search text; Attach and Stop pause briefly while the list is rebuilt. The completed snapshot stays fixed. Reopen `<leader>af` to fetch a fresh snapshot. An empty active picker creates nothing. The active picker can stop the selected agent, but new-session creation and saved-session restoration use their separate entry points.

`<leader>an`, `agentic.switch_provider()`, and `agentic.new_session_with_provider()` select an Agency backend and model before creating a conversation. Effort and permissions use the backend’s configured defaults; creation does not prompt for them. Model selection displays retained catalog evidence. Cached models remain selectable after a discovery timeout or stale refresh and are labeled cached; the picker shows the discovery failure when available. Session creation validates the selected model and configured settings against the provider. An incompatible configured default reports an unsupported selection rather than silently substituting another value. An absent catalog exposes only configured defaults, explicitly labeled when discovery is unavailable. Configuration edits apply to the next launch or explicit discovery refresh. Cancelling any selection preserves the existing conversation. Codex and Claude model and reasoning choices use ordinary ACP configuration options. Claude uses `model`, `effort`, and `mode`; available values come from the native session. Codex modes include full access.

`/new` inherits the current session's backend and uses its backend defaults for the new conversation. `<leader>ae` / `:AgencySettings` selects a setting and then one of the attached provider’s supported values, with current values shown first. It exposes native configuration options, including effort and permission mode, with legacy mode support when needed. It requires an attached agent and creates no conversation. Cancelled, superseded, or stale selections change nothing. Changes apply to the shared agent, while future sessions continue using backend defaults. Changes propagate to all attached editors and update restorable settings. Live attachment preserves current configuration rather than applying the reconnecting editor's defaults.

Native code selections, file references, and diagnostics own context capture. Structured ACP content is preserved. Annotation submission clears only the exact captured threads after accepted admission; busy or rejected admission leaves them intact, and subsequent annotation edits survive. Pending native context survives live loading. Changing the editor cwd does not retarget an attached session or its relative file links.

## Shared sessions and lifecycle

Both pickers open at once and show "(loading…)" in the title until their data arrives. `<leader>af` lists running agents on this machine and on enrolled devboxes. `<leader>ar` lists stopped and recoverable local sessions, reading them through `agent page` and omitting legacy version 1 records, which cannot be restored. When there are no sessions, the restore picker shows an empty list. Each row shows the host, the title, the backend and model, the time since the last activity, and the status, with the most recently active session first. The Handler records that activity time, and the conversation title, on each agent record when a turn is submitted and when it finishes. It does not record them when an editor attaches, so reloading or restarting the editor does not reorder sessions, and it skips the write while a mode or configuration change is in progress. When the Handler starts, it fills in a missing title and activity time for stopped and recoverable sessions from their history files: the title is the first real prompt and the time is the file's last modification. Records it can't fill in sort after those that have a time. Selecting a stopped session still restores its logical Agency identity.

The preview ends with the last few turns of the conversation, at most 8 turns of about 600 characters each, and the editor requests 4. `agy excerpt AGENT_UUID` or `agy roster excerpt AGENT_UUID --host HOST_ID` returns them. A running agent's turns come from the Handler's retained conversation, and a stopped agent's turns come from the provider's history file on the Handler's machine, reading its last 1 MiB, and further back up to 16 MiB when that tail contains no prompt. Codex files are under `CODEX_HOME/sessions` (default `~/.codex/sessions`). Claude files are under `CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`). Injected instruction blocks such as `<system-reminder>` and `<environment_info>` are dropped from the turns. A devbox serves excerpts and activity times only after it is redeployed with this build. Until then, its rows have no age and the preview says "Excerpt unavailable: update this devbox". Update the laptop before any devbox: records that carry the new fields can't be read by older Agency code, and downgrading after records have them makes those records unreadable.

Every attached editor may submit ordinary ACP prompts during ongoing work. The Handler forwards each distinct submission once, without automatic cancellation, steering conversion, or a scheduling queue. The provider determines how additional input affects its work and can return a request error without terminating the session. Responses remain associated with their requests; the session stays working until all outstanding prompt requests settle. The legacy bounded text API remains exclusive because the shared output stream does not identify which request produced each chunk. The submitting editor displays its local input once, while other attachments and replay receive the same input. Retained transcript events are never prepended to another prompt. A lost response is not proof of rejection and never causes automatic redispatch.

Closing a tab, destroying a view, switching sessions, exiting Neovim, losing the endpoint, or `AgencyDetach` removes that attachment only. It does not cancel or stop the provider. A later attachment receives retained display history, current configuration, active-turn state, and subsequent updates. Truncated retained history has a visible marker.

`AgencyCancel` sends the provider’s session-wide cancellation and leaves the provider available. Either attached editor can cancel. The request references an observed outstanding submission; a completed submission cannot authorize cancellation of later work. Cancellation grace tracks only requests outstanding when cancellation was sent. An uncooperative provider can fail after the cancellation grace window; closing an editor does not invoke that policy.

`AgencyStop` confirms and stops the exact logical agent, Handler generation, and provider generation, then verifies owned-process cleanup. After the owned leader exits, cleanup waits within its existing absence budget for lingering members and transient platform observations to settle, then requires two consecutive complete group and captured-generation absence checks. This waiting stage sends no further signals. Confirmed process absence and settled prompt callbacks release live conversation, turn, editor, and native-session resources even if record publication remains incomplete. Stop and Handler shutdown still require durable launch, session, and command records. A publication failure requires explicit retry; receipt inspection does not retry it, and publication retry reuses physical cleanup evidence without signaling again. Stopped or recoverable sessions require explicit restore. Restore uses recorded cwd and native session identity with fresh caller environment. Logical identity remains stable; provider generation rotates. Old attachment mutations are rejected until an explicit live load binds the new generation. A failed restore never starts a replacement conversation.

## Reloading after code changes

`:AgencyReload` applies Agency changes from the main checkout. It runs these steps:

1. Build Agency.
2. Compare the running Handler's `distDigest` in `agy status` with `agency/dist/build-manifest.json`. When they differ, or when the Handler reports no `distDigest`, run `agy restart`.
3. Reload the editor's Agency Lua, rolling back to the previous modules if the new ones fail to load. If the rollback also fails, the summary says so and Neovim must be restarted.
4. Rebind each Agency tab to its agent in place. The restart handed the live agents to the new Handler, so their tabs find them live. A tab is counted as rebound only once its session load succeeds; a failed or timed-out load is named in the summary.

`:AgencyReload!` always restarts the Handler. While it restarts the Handler, it hides the editor's expected "Agency Handler connection ended" error. It also names any Lua file in `home/.config/nvim` that bootstrap hasn't linked into the live config yet, because the editor can't load a new file until it is linked. A second `:AgencyReload` while one is running is refused with a notification.

`agy restart [--timeout SECONDS]` hands the live agents to a new Handler. It sends `agy shutdown --stop-agents --require-idle`, which the Handler refuses with `BUSY` while any agent is running a turn, starting, stopping or changing a setting; `agy restart` repeats it every second for up to 300 seconds by default. When the Handler accepts, it writes `handoff.json` in its state directory, listing each prompted live agent with its index fields (backend, native session ID, directory) and its current model and mode, plus the boot ID and the time, then stops the agents and exits. If the shutdown fails after it has begun stopping agents, the file is kept so the next start restores them. The next Handler reads the file at startup and deletes it. It uses the file only when it was written in the same boot and at most ten minutes ago; otherwise it logs `handoff_ignored` with the reason. It drops and logs any entry that is not valid, writes each listed agent's index entry if it is missing, reports ready, and then restores the agents in the background with their model and mode. A request for one of those agents while it is being restored waits for that same restore. An agent that cannot be restored is logged as `handoff_restore_failed` and stays stopped. `agy agents` reports the handoff's progress in `handoff` (`fromGeneration`, `agents`, `pending`, `failed`), and `agy restart` waits on it, up to its timeout, before it replies: the result lists each handed-off agent in `agents` with `outcome` `restored`, `failed` with its failure, or `restoring` if the timeout passed first. This works even when another client started the new Handler first. Running `agy shutdown --stop-agents --require-idle` by hand hands off the same way. An agent that was never prompted has no session file and is not handed off. `--resume` is accepted for editors that predate this behavior and does nothing. A `restart-pending.json` left by an older build is deleted.

The first start against an index that has never been migrated waits for that migration before it reports ready, so the first `agy agents` lists every migrated agent. An agent stopped some other way, for example by a reboot, is restored when an editor loads it or `agy prompt` addresses it. That restore re-applies the last model and mode recorded in the provider's session file: `model` and `permissionMode` in a Claude transcript, and `model` with the approval and sandbox policy in a Codex rollout's `turn_context`. A setting the file does not record comes back as the provider default, and a recorded value the provider no longer offers is logged as `setting_not_restored`.

### Upgrading from a Handler that predates live requests

A Handler built before the live requests closes their sockets unanswered, and every new `agy` request against it fails with `UNAVAILABLE` naming this step. Upgrade once: run `:AgencyReload` in one Neovim, then restart any other Neovim windows. The old Handler accepts the same shutdown request, but it writes no handoff, so its agents come back stopped and are restored when an editor loads them or a prompt addresses them.

When `agy restart` fails, the `:AgencyReload` summary names the error. The failures are:

- `BUSY`: an agent was still working when the timeout expired. Nothing was stopped and the editor reloads nothing. Run `:AgencyReload` again after the turn ends.
- `UNAVAILABLE`: the old Handler stopped but the new one failed to start. Fix the cause, then run `agy status` or `:AgencyReload` again.
- `INCOMPLETE`: the shutdown did not complete and the old Handler is still running, or the new Handler runs a different build than `dist`.

Except for a plain `BUSY`, these failures can leave the Handler or its agents changed, so the editor checks `agy status` again. When the Handler runs the new build, or no Handler answers, the editor reloads its Lua and rebinds each tab. When the old Handler is still running, the editor rebinds the tabs with the Lua it already has and says that the Lua was not reloaded, because new editor code must not talk to an old Handler.

A rebind redraws the conversation from the Handler's retained history, so the chat loses its scroll position and manual folds. A tab whose agent is no longer known to the Handler keeps its view and is counted in the summary. The digest covers all of `dist`, including compiled tests and scripts, so an edit to Agency tests also triggers a Handler restart. Agency tabs in other Neovim instances reconnect the usual way. Changes in worktrees take effect only after they are merged into `~/.dotfiles`, because `agy` runs from there.

## Editor RPC routing

Agency editors advertise their current `vim.v.servername` in `_meta.agency.editor` on new, load, and prompt requests. The first outstanding submission captures its submitting attachment and current socket until every outstanding request settles. Provider commands using `NVIM` or `NVIM_SOCKET_PATH` reach that editor through a transparent Unix stream proxy. Another editor attaching, retrying a duplicate submission, or submitting during work cannot redirect those callbacks. The proxy forwards RPC traffic in both directions without decoding it. A listener failure disables editor RPC while leaving conversation turns available. New connections use the pinned editor at connection time; background commands that outlive all outstanding requests require an explicit editor target.

Detach, disconnect, same-session reload, cancellation, settlement of all outstanding requests, and provider termination close the pinned RPC connections. A replacement attachment cannot resume editor routing for an existing turn; its next accepted turn can use the same provider and proxy path. A failed command is not retried automatically. Commands outside a turn require an explicit editor target, e.g. setting `NVIM_SOCKET_PATH` to the real editor socket for that command. A prompt that omits editor metadata inherits its attachment’s registered address. An attachment without a registered editor address has no automatic route. Editor addresses remain transient and Agency metadata is stripped from provider requests and retained prompts.

Source builds do not alter existing provider environments. Activating routing for an existing provider requires deploying the updated Handler and editor configuration, then explicitly stopping and restoring that provider. Reloading a view alone cannot replace the inherited environment of a provider launched before this change.

## Shared permissions

The Handler forwards each provider permission request and its offered option IDs to every attached editor. The first valid selected option wins and reaches the provider once. Corresponding native permission UIs are withdrawn from all attachments. Provider-defined allow-once, allow-always, reject-once, and reject-always semantics remain provider-defined.

Closing an editor or clearing its callbacks is not a user rejection. If every editor disconnects, the provider keeps waiting. A later attachment receives the still-pending request. Explicit cancel, stop, provider failure, or generation replacement withdraws obsolete requests. Stale, malformed, superseded, or unoffered decisions cannot affect a replacement generation. There is no Agency human-deliberation timeout or automatic approval.

## Failure diagnostics

Permission option names retain provider text without a field-length cap. Titles and option IDs retain their existing bounds. Invalid Unicode and control characters remain rejected, and the existing 1 MiB whole-record capacity applies to offers and snapshots.

Agent failures retain their existing code and fixed message and may include an optional closed `diagnostic` object. `permission_request`, `acp_transport` and `provider_initialize` diagnostics retain a bounded machine `causeCode` or null. `provider_process` diagnostics additionally identify the event, exit code, signal, cumulative stderr byte count and `stderrTailBase64`. The tail is at most 2,048 raw bytes captured at the first failure, encoded as canonical base64; it can contain provider output and follows the existing private state access boundary. Raw exception messages and permission payloads are not copied into diagnostics. Cleanup and subsequent faults preserve the first failure, including when initialization rejects after a process observer has already failed.

Session providers and model-discovery workers drain stderr without a cumulative byte termination limit. Session failures retain only the bounded diagnostic tail, while actual process and stream errors retain their failure behavior. The serialized `limits.stderrBytes` field and historical `stderr_limit` diagnostic event remain readable for record compatibility; neither imposes a live stderr limit. Existing failures without diagnostics remain readable. Older strict readers reject failures containing the new field, so candidate Handlers and their clients must be upgraded together before using this revision across hosts.

Model discovery captures worker and native stderr as private, mode-0600 files in `catalog/work/<attempt>/worker.stderr` and `native.stderr`. `diagnostic.json` binds the first failure stage, bounded exception/RPC details, observed process identities, native command, terminal code or signal, byte counts and capture completeness to the host, command, attempt, configuration fingerprint and Handler generation. These details remain private and do not replace the catalog's fixed public error messages. A recorded process observation does not authorize signaling; current cleanup uses the retained live group owner, while historical recovery checks exact launch records. The configured native command can itself be a wrapper, so this record does not establish the identity of an executable subsequently selected by that wrapper.

## Native history import

The saved-session picker lists only stopped or recoverable logical Agency sessions, with bounded, read-only Codex metadata discovery used to enrich matching entries. Live and transitional agents use the active picker. Unregistered native sessions are excluded. Selecting an available saved session requires confirmed logical restore.

Restore rows show a shortened conversation title, directory, backend, and update date. The visible preview shows the full title, directory, state, availability, and session identifiers. Untitled Codex logs use the first user request found within the first 1 MiB, skipping injected instructions and environment context; requests beyond that limit retain a directory and short-ID fallback. Matching native metadata fills missing logical-session titles and dates while preserving the logical restore identity.

Native IDs and logical IDs are separate namespaces; ACP uses `agency:<agent-uuid>`. Provider-native session files are neither deleted nor rewritten. Unsupported backends remain unavailable. Saved-session rows and previews label unavailable entries explicitly.

## Requests

`agy start`, `restore`, `stop`, `set`, `prompt` and `cancel` ask the Handler for a state and reply when that state is reached or has failed. Nothing about a request is stored; if a reply is lost, `agy agents` shows the current state. Agent IDs are the only target.

```text
agy start [--backend ID] [--agent UUID] [--cwd PATH] [--model ID] [--mode ID] [--json]
agy restore AGENT_UUID [--json]
agy stop AGENT_UUID [--json]
agy set AGENT_UUID SETTING VALUE [--json]
agy prompt AGENT_UUID [--submission-id UUID] [--json] < prompt.txt
agy cancel AGENT_UUID [--json]
agy agents [--json]
agy excerpt AGENT_UUID [--turns N] [--json]
agy transcript AGENT_UUID [--json]
agy models [--json]
agy permissions [--json]
agy permissions decide --input-json JSON [--json]
agy forget AGENT_UUID [--json]
agy log [--agent UUID] [--since ISO_TIME] [--limit N] [--json]
```

`start` makes a new agent with the given ID, or with a new ID when `--agent` is omitted, and replies when it is ready. Repeating it with the same ID returns the existing agent; a different backend or directory fails with `INVALID`. Concurrent starts of one ID share one launch. An agent is kept in the index once its first prompt is accepted, so an agent that was never prompted is gone after a Handler restart. `restore` makes a stopped agent live with the caller's environment. `prompt` reads the prompt from stdin and restores a stopped agent first. `set` changes `model`, `mode` or a provider option through the live provider, and the reply shows what the provider reports. `forget` deletes a stopped agent's index entry. `agents`, `excerpt`, `transcript`, `stop`, `forget` and `log` work without a running Handler; `start`, `restore`, `prompt` and `models` start it.

Every reply uses the `agency-request/1` envelope. A failure carries `{ code, message }` with one of five codes, and the message is also printed on stderr:

| Code | Meaning | Exit |
|---|---|---|
| `NOT_FOUND` | The agent is not known on this host, or its session file is gone so it cannot be restored | 66 |
| `BUSY` | A turn or a setting change is running | 75 |
| `INVALID` | The request is malformed or conflicts with the agent | 64 |
| `UNAVAILABLE` | The Handler, backend or provider is unreachable, with the reason | 69 |
| `FAILED` | The provider refused or failed, with its message | 70 |

Every failure is also appended to the event log, which `agy log` reads. Remote hosts keep using `agy roster`, `agy session` and `agy permission` with `--host` until cross-host requests change in phase C.

## CLI and protocol boundaries

Every public `--input-json` flag accepts either inline JSON or `-` to read JSON from stdin. For example, `agy session submit --host HOST_ID --input-json - --json < submission.json` keeps the payload out of the process command line. Stdin must be noninteractive, contain valid UTF-8 JSON, and reach EOF within five seconds. Raw stdin is limited to 1 MiB; existing operation-specific schemas and limits still apply. Neovim's Agency command client sends its JSON this way while retaining the original payload for receipt validation.

```text
agy status [--json]
agy doctor [--json]
agy acp
agy shutdown [--stop-agents [--require-idle]] [--json]
agy restart [--timeout SECONDS] [--json]
```

`agy help --json` lists the exact commands and flags. `agy models` lists each backend's models, read once per Handler through the provider's own listing call and kept in memory. Native provider initialization validates the selected model and settings.

The active picker requests `agency/roster` over the cached Agentic ACP connection. This active-only query projects daemon memory without rereading retained files or waiting for their verification queue. Its cursors track changes to the projected records and diagnostics. Ordinary operations use initialized Handler state and check the addressed generation, ownership and mutation inputs. They do not inventory retained history. A cached display row does not authorize an action. The picker bounds readiness, requests, and full traversal, and reports connection failures without falling back to a fresh CLI process. An older running Handler must be restarted before it supports this endpoint.

Status lazily starts or connects to one Handler. Doctor reads state without starting or cleaning up a Handler. Shutdown never starts one and ordinarily refuses active work; `--stop-agents` explicitly stops owned agents. Command IDs and Handler generations make lifecycle retries exact. Incomplete operations retain their original identities; inspection does not authorize a new mutation or prompt. Inventory cursors are revision-bound.

`AgencyCancel` cancels the current turn while retaining the session. `AgencyStop` stops the selected session and verifies its owned-process cleanup. `agy shutdown` drains the Handler only after verifying current ownership and publishing its durable receipt; refusal leaves services available. Agent and catalog drains are both attempted even if either fails. Explicit shutdown shares one 15-second monotonic budget across drains, verification, mutation-queue acquisition, receipt reads and receipt publication, subject to Node event-loop scheduling. Duplicate requests share the original deadline. Expiry returns incomplete and cannot accept shutdown or move runtime state to draining. An issued receipt write may become visible later; a fresh explicit retry must reverify cleanup and republish durability.

A timed-out shutdown retains its command identity and excludes other shutdown commands until its guarded orchestration settles. Same-command requests remain incomplete after the shared deadline. Settlement clears that pending slot and resumes services only if shutdown was not accepted and the Handler is still ready. Nested catalog calls can report their own bounded failure before outstanding filesystem work settles; that work retains mutation-queue ownership. Unsettled orchestration can exclude shutdown admissions indefinitely. Signal termination and manual recovery remain separate.

SIGTERM and SIGINT instead begin one bounded termination attempt, including during startup. The Handler attempts service discharge and endpoint closure under a single 15-second budget, subject to Node event-loop scheduling. It exits 0 after successful discharge and closure, or 70 on failure or deadline expiry. Startup interruption exits 70. Repeated signals do not restart the budget. Failure diagnostics are best effort and do not delay exit. Exit 70 can leave owned processes or unresolved cleanup evidence; it does not certify cleanup and does not trigger automatic restoration or replay. Signal termination does not publish a shutdown receipt.

`agy acp` connects to the ready Handler's mode-0600 ACP socket inside its mode-0700 runtime directory. The endpoint owns no provider and emits only JSON-RPC on stdout. Initialization selects and starts no backend. Session load is live attachment, not implicit restoration. Authentication methods are not advertised. Client filesystem and terminal RPCs are not forwarded to an arbitrary editor; provider-owned tool execution is unaffected.

Command inspection only reads retained receipts. `agy session command` does not launch providers, retry record publication, or resume a failed Stop. An incomplete operation remains incomplete until its owner progresses or an explicit mutation retry resumes it. Local agent Start, Restore, and Stop retries use the original command ID and matching input; inspection never performs that retry on the caller's behalf.

Control uses `agency-control/2`, and agent lifecycle uses `agency-agent/3`. Exit codes are 0 for success, 64 for usage, 65 for invalid protocol, 69 for unavailable/stale targets, 70 for internal failure, and 75 for incomplete operations.

Codex Restore accepts a saved `fast-mode=off` (or boolean `false`) when the provider explicitly returns configuration options without fast mode. This reflects a model that no longer supports the feature. Enabled fast mode, missing model/mode/effort settings, unknown configuration, and unresolved fast-mode changes still require input. Settings the loaded provider continues to expose retain their native values.

## Transport bounds and failures

Startup remains bounded to 30 seconds. ACP startup timeout diagnostics include the pending phase (`initialize`, `session/new`, `session/load`, or `configuration`), elapsed milliseconds since ACP initialization, and the number of validated load-time session updates received. Zero updates means no replay notification was received; a positive count means load-time updates began arriving, which may include metadata as well as history. This does not identify the exact native loading stage or establish that a longer deadline would succeed. No transcript content is stored in these fields. Older strict readers cannot parse receipts containing this new diagnostic object; activation requires matching readers, and rollback must account for those receipts.

Established-session ACP frames and queued writes have no byte quota. Before a `session/new` response confirms native identity, Agency buffers valid `session/update` notifications without publishing them or changing configuration. This startup buffer accepts at most 128 frames, 1 MiB per frame and 8 MiB total, counting wire bytes including each newline. All queued session IDs must match each other and the response before any notification is published. Agency applies the response configuration first, then processes buffered updates in order. Startup failure or close discards the unpublished buffer. Load-time replay uses its already known session identity and retains its existing behavior. The endpoint relays bytes with stream backpressure, and the Handler inspects routing and control fields while retaining serialized tool payloads for forwarding and replay. Write deadlines still detect stalled connections. Launch records retain legacy frame and queued-write byte fields for compatibility; transport ignores those fields. Stderr capture remains bounded to 8 KiB. Healthy prompt turns and human permission waits have no qualification-era total-turn deadline or cumulative assistant-output quota.

The Handler retains at most 16 MiB and 8,192 display events per live generation. Eviction removes an oldest prefix and exposes truncation; it does not terminate the turn or erase authoritative configuration. Display history is volatile across Handler/provider replacement. Native Agentic controls its own rendered buffers. Per-client queue overflow disconnects that connection rather than failing a healthy provider or unrelated agent.

Submission receipts remain available for the provider generation, including after display eviction. They retain IDs, digests, and completion metadata, not duplicated transcript bodies. Receipt count can grow until generation retirement. Malformed client input and stale identifiers affect that connection. Provider protocol failure affects its session and pending requests. Neither provider failure nor Handler loss automatically restores or replays interrupted requests.

## Ownership and retention

Private agent, command, catalog, and launch records bind boot identity, PID generation, parent, process group, session, UID/GID, and per-launch markers. Cleanup revalidates the exact group leader and current boot, owner, group and session before signaling. Helpers may change executables while that leader remains verified. Each durable evidence update is followed by a fresh authorization snapshot. Leaderless cleanup requires exact retained-member continuity, and final absence checks remain strict. Missing or replaced groups are not signaled, and ambiguous ownership remains visible rather than blocking unrelated launches. Provider helpers that detach from the recorded process group remain outside Agency ownership.

Live sessions retain the actual Node child and register its error, exit, and close events synchronously. Startup performs one bounded logical identity capture, with bounded retries for transient unavailable identity reads. Cleanup of an already captured live group begins before waiting for preparation or launch-history writes. It waits for terminal events, reauthorizes each group signal against the registered live leader, discharges transport, and verifies final absence before publishing the exact launch record as cleanup verified. A failed or held history publication still returns incomplete cleanup, even after physical absence is established. An explicit durability retry reuses retained successful physical evidence without signaling or repeating absence observations. An already-issued filesystem write may settle after the caller times out; it cannot authorize subsequent readiness or work admission. A child error after PID allocation is nonterminal, and child exit alone does not prove descendant absence. Shutdown bounds its wait for admitted operations and reports incomplete cleanup if settlement remains unresolved. Late owned settlement may continue. Fatal loss of the owner can leave descendants; it never establishes verified cleanup.

The singleton Handler is the sole writer of runtime records and retains initialized state in memory. Stop it before manually editing those records. Each admitted launch captures provider configuration once; later edits affect subsequent launches. Startup expiry fails that operation and retains unresolved cleanup without terminating the Handler or unrelated sessions. Late callbacks cannot publish readiness.

Publications check the addressed record, write and sync a temporary file, rename it atomically, and sync the parent directory. They do not audit unrelated retained files. Startup and shutdown use only current-generation owners and receipts. Historical agent inspection is lazy and read-only; active phases without a current owner display interrupted with unknown cleanup. Explicit restore reads the saved identity and configuration and creates a new generation without signaling the old one. Catalog tests retain their small fixture roots after physical cleanup, including successful roots, so failed test bodies cannot erase diagnostics.

Runtime history is retained until explicit maintenance. Handler startup and session completion do not replay pending retirement intents or delete historical records. Provider-native state remains on disk. There is no supported archive/prune command or total-storage cap. Existing pending retirement intents are preserved; reads of affected history report incompleteness without disabling fresh sessions.

Old Bureau/orchestration workflow files remain available for manual inspection and cleanup. Startup and retention neither resume nor rewrite them. Live or ambiguous owners are never unlinked.

The Handler does not persist an append-only transcript or environment values. Native providers retain their own state under caller configuration. Agentic debug logging is disabled; explicitly enabling it later can log ordinary ACP requests, including transient start metadata.

## Verification

Ordinary real-provider smoke acceptance checks editor/ACP behavior and lifecycle: prompt delivery, cancellation/reuse, Stop/Restore continuity, and owned cleanup. A targeted native diagnostic declares its required protocol events and executable evidence separately. Report those outcomes independently; missing native capture leaves the diagnostic incomplete and does not replace observed lifecycle results. Preserve original failed cohorts and their original acceptance contracts.

Before a separately authorized paid diagnostic, preflight the observer against the actual launch shape, including direct, bundled and wrapper app-server invocations as applicable. Verify byte forwarding, callback/return behavior, backpressure and error paths without a paid provider. Bind evidence to the declared launcher and adapter, and record any nested-executable identity limit. A lifecycle smoke alone does not establish native event coverage.

Run `npm test` from `agency/` for seven workflow scenarios. These cover start/stop/restore, ACP prompting and replay, endpoint detach during active work, shared permission decisions, remote session start/prompt/cancel/stop, and refusal to signal a reused PID. Providers and the remote transport use local fixtures; no credentials or live SSH are used.

Run `bash test.sh` from the repository root for all retained repository workflows. It builds Agency once. `npm test` from `node-bin/` checks the installed provider against a fake app-server with overlapping prompts and checks model discovery's partial failure behavior. `bash test-nvim.sh` loads the real configuration and native Agentic classes, then checks the primary Agency new-session mapping, submission/detach and ordered rendering through tool, permission and completion events.

The Agency runner prints a private `run-*/result.json` path. Set `AGENCY_TEST_EVIDENCE_PARENT` to choose its parent. Owned process fixtures retain bounded teardown and verify physical absence; missing or unresolved worker cleanup fails the run. Roots and failure evidence remain on disk for inspection.

Exhaustive protocol/schema, historical receipt, singleton contention and injected failure matrices have been removed. Synthetic Linux assertion matrices have been removed. Real-provider acceptance and remote qualification require separate invocation and authorization.

## Local controls

Local agents are read and controlled with the request commands (`agy agents`, `agy excerpt`, `agy permissions`, `agy permissions decide`, `agy start`, `agy stop`, `agy restore`, `agy prompt`). Permission refs come from the owner snapshot and identify the exact Handler and provider generation.


Core readiness covers local ACP sessions and controls. Failed optional startup appears in status and doctor runtime diagnostics. Global commands read each configured session owner through the host client. Local watch is not available in this increment; use explicit list and inspect.

Permission offers, callbacks and decision receipts exist only in the owning Handler process. A valid decision claims the request before invoking its callback. Concurrent identical command IDs share one completion; conflicting reuse is rejected. Inspection can report `claimed` while the callback is pending. Success becomes `applied`, and a failed callback becomes `uncertain` without reopening the request. Other valid decisions return `withdrawn` until exact-session invalidation removes the offer metadata. Invalid options leave a pending request available.

Restart clears pending permissions and receipts. Old refs are stale, and inspection of an old command returns null unless the current owner has recorded a new refusal for that command. The retained `throughSeq` field is a process-local change counter that resets with each Handler generation. It is never a journal cursor. Reconnecting views refresh current state; neither clients nor the owner reload or resend old decisions.

## Host controls

The Handler owns the host bridge before it publishes readiness. Ordinary roster and permission commands read the session owner directly. Configure destinations with `agy host enroll --input-json '{"hostname":"devbox","hostId":"HOST_ID"}' --json` and inspect configuration with `agy host list --json`. The host ID is the destination's 64-character lowercase hex identity from `agy status --json`. Enrollment requires only the SSH hostname and expected host ID. Both remote entry and the control bridge invoke bare `agy` using the SSH session's PATH, so `ssh HOST 'agy doctor --json'` must work without an additional login shell.

New enrollment records contain those two fields at `<persistentRoot>/bureau/hosts/<hostId>.json`. Existing UUID-named records remain readable and return the same two-field view without rewriting their bytes. The retained `bureau/hosts` directory does not load Bureau settings or workflow state. Repeating the same enrollment is a no-op; a changed identity or a different hostname for an enrolled identity is refused.

`agy roster list --json` and `agy permission list --json` return `agency-host/1` aggregates with an available or unavailable observation per host. Roster aggregation reads every page from each owner; an unavailable observation is not a failed session. Use `--host HOST_ID` for a single owner, where roster limit/cursor filters are supported. Explicit `--local` roster and permission commands retain `agency-agent/3` output.

A permission decision uses its exact host, Handler and provider generations. Supply a stable command ID in the JSON or through `--command-id`. Inspect with `agy permission inspect COMMAND_ID --host HOST_ID --json`; inspection requires an explicit owner. `OUTCOME_UNKNOWN` retains the owner and command reference and requires explicit inspection before another decision. Connections do not resend mutations. Ordinary permission/roster watch commands are excluded; the editor refreshes owner views explicitly.

The host client does not mirror permission history or replay previous mutations.

The bridge protocol is `agency-bridge/2`, with hello, request, reply and cancellation frames only. A version-1 peer fails explicitly with `UNSUPPORTED_BRIDGE_PROTOCOL` before any operation is dispatched. Both endpoints require a coordinated upgrade and explicit Handler restart; there is no alternate legacy helper or automatic mutation retry. SSH remains noninteractive and uses the local authentication agent without forwarding its socket path to the destination. The SSH shell and `agy` must reserve stdout for the protocol and write diagnostics to stderr.

## Host sessions

Ordinary session operations use the owning runtime. Select the host with `--host HOST_ID`; the local Handler's own host ID selects it. These commands require an already running Handler and never start one or poll automatically. JSON replies use `agency-host/1`.

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

Submission and cancellation inputs use `{target, submissionId}`. Stop takes `{commandId, agentId, handlerGeneration, providerGeneration}`. Submit returns its live receipt immediately. Identical submission ID/content can return the existing live receipt; different content conflicts, and another active turn returns `BUSY`. Submission inspection returns status, stop reason and failure. Existing attachments provide model output.

Admission and cancellation acknowledgements exit 0. Command inspections exit 75 while pending or failed/interrupted, and 0 for a completed successful start/stop. Submission inspection exits 75 while accepted/running or failed, and 0 when completed, including cancellation. Null session/command/submission observations and unavailable or stale owners exit 69. Usage and oversized input exit 64. `BUSY`, command conflicts and unknown mutation outcomes exit 75.

A lost or malformed mutation reply includes the original reference and is never resent automatically. For start/stop, use `session command` with the reference's command ID and original Handler generation. For submit/cancel, use `session submission` with the reference's target and submission ID. A null read or missing live tuple does not prove the earlier operation failed. Live submission state is unavailable after retirement or Handler restart; inspect state manually before choosing another operation.

New starts use the filtered destination Handler process environment plus backend defaults. Caller environment is not transmitted, and a fresh login shell is not run per start. Credentials or shell environment changed after Handler startup require an explicit Handler restart or backend configuration edit. Local runtime command persistence/recovery is transitional; this host path adds no durable routing, mutation replay or automatic supervisor wakeups.

## Entry

`agy entry open --input-json '{"commandId":"UUID","hostId":"HASH","target":{"agentId":"UUID","handlerGeneration":"UUID","providerGeneration":"UUID"}}' --json` opens an editor for an exact live session. `agy entry inspect COMMAND_UUID --host HOST_ID --json` inspects its current attachment. Commands exist only in the owner Handler process. Identical concurrent opens share one action; inspection never creates or activates an editor. A restart clears command observations, so an unknown command leaves a lost open outcome unknown. Uncertain or stale entry does not launch a terminal. Inspect the owner and command before taking another action. Neovim's owner picker uses the same live entry path.