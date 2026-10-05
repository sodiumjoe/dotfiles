# Agency

Agency provides a persistent local Handler for starting, inspecting, prompting, stopping, and restoring ACP agents. A managed launch uses the caller's absolute current directory and a fresh snapshot of the caller's environment. Agency does not assign Git ownership, serialize agents by directory, manufacture a separate user environment, or impose an agent-count or concurrent-start limit.

The Handler owns durable agent identity, command receipts, provider-process supervision, ACP connections, and explicit restoration. Multiple agents may run in the same directory. One agent's malformed state, failed process cleanup, or failed restoration does not prevent unrelated launches.

## Build and commands

Agency requires Node 24.13.0 and the existing pinned lockfile. From `agency/`, run `npm ci` and `npm run build`. `home/bin/agy` is deployed by the existing dotfiles workflow as `~/bin/agy`; it resolves this repository through its symlink chain and invokes the pinned Node runtime. It never installs dependencies or builds implicitly.

```text
agy status [--json]
agy handler status [--json]
agy doctor [--json]
agy shutdown [--stop-agents] [--json]
agy shutdown --command-id <uuid> --handler-generation <uuid> [--stop-agents] [--json]
agy model list [--json]
agy model refresh [--command-id <uuid>] [--handler-generation <uuid>] [--json]
agy agent start --provider <id> --model <id> --reasoning <value|none> [--mode <id>] --permission-profile <id> [--command-id <uuid>] [--handler-generation <uuid>] [--json]
agy agent restore <agent-uuid> [--command-id <uuid>] [--handler-generation <uuid>] [--json]
agy agent current [--json]
agy agent list [--json]
agy agent choices [--json]
agy agent page --limit 100 [--cursor <cursor>] [--cwd <path>] [--active] [--json]
agy agent command <command-uuid> --handler-generation <uuid> [--json]
agy agent attach <agent-uuid> --handler-generation <uuid> --provider-generation <uuid> --format ndjson
agy agent prompt <agent-uuid> --text <text> --handler-generation <uuid> --provider-generation <uuid> [--json]
agy agent stop <agent-uuid> --handler-generation <uuid> --provider-generation <uuid> [--command-id <uuid>] [--json]
```

Status lazily starts or connects to one Handler. Doctor inspects local state without starting a Handler or performing cleanup. Shutdown never starts a Handler. Ordinary shutdown refuses active lifecycle work; `--stop-agents` explicitly stops known agents before the Handler exits. A shutdown result is complete only after the CLI observes the selected Handler generation's absence.

Command IDs and Handler generations make mutation retries exact. After an incomplete result, retry with the original command ID, generation, and input. Completed command receipts remain immutable, while current agent liveness is reported separately.

Prompt submission is single-delivery because an ambiguous disconnect can occur after the Handler accepted the turn. `agent prompt` therefore reports the transport failure without resubmitting. The current Codex prompt transport window is 95 seconds: the 90-second provider prompt deadline, one second for transport closure, and four seconds of client transport grace.

`agent choices` intersects fresh catalog evidence with configured launch contracts without discovery. `agent page` provides revision-bound traversal, including issue-only pages; a changed inventory invalidates its cursor. `agent command` inspects a retained receipt without resubmitting. Initial editor start/restore commands capture the Handler generation from status and use `--expected-handler-generation <uuid>` together with `--command-id`; `--handler-generation` retains replay-only semantics for those mutations. These two generation flags are mutually exclusive.

## Neovim integration

Neovim requires the built Agency package, deployed `agy` on its inherited `PATH`, and the existing Agentic and Snacks plugins. The tested Agentic revision is `246feb4773923a10a6fedc40048657516bd05792`; this integration does not modify it. Agency commands lazy-load the editor integration, and setup launches neither providers nor discovery.

| Mapping | Command |
| --- | --- |
| `<leader>ac` | `AgencyCurrent` |
| `<leader>an` | `AgencyNew` |
| `<leader>af` | `Agency` |
| `<leader>as` | `AgencyStop` |
| `<leader>ao` | `AgencyOpen` |
| `<leader>aa` | Add captured file or selection |
| `<leader>ad` | Add line diagnostics |
| `<leader>aD` | Add buffer diagnostics |
| `<leader>ai` | Submit annotations |
| `<leader>ar` | Existing native saved-session picker |

Additional commands are `AgencyAttach <agent-id>`, `AgencyRestore <agent-id>`, `AgencyDetach`, `AgencyCancel`, and `AgencyInspect`. Current toggles an existing pinned attachment. Without one, it captures the invoking cwd and selects from exact-directory active records: zero opens launch choices, one ready agent attaches, and multiple agents open a picker. Transitional records and read failures never count as zero. New permits another agent in the same directory. Open only displays an attachment. The local roster polls every five seconds while visible, with nonoverlapping reads and explicit refresh actions.

One editor process owns one attachment shared by its tab views. Hiding or closing a view, closing a tab, detaching, terminating a proxy, or exiting Neovim never cancels or stops the provider. Reattachment reconstructs retained display history and the current turn without replaying a prompt. Stop requires confirmation of the displayed ID, model, cwd, and both generations, then verifies cleanup of that exact target. Restore is explicit and requires verified cleanup; failure never starts a replacement conversation.

Input is captured text, including selections, diagnostics, unsaved named buffers, and annotations. Whole-file context references an absolute path. Context outside the agent's recorded cwd requires confirmation; unnamed selections use a buffer label. Binary/media context is rejected. Changing the editor cwd does not retarget an attachment or its relative chat links. Native Agentic sessions remain separate and retain their saved-session restore command.

An unknown submission keeps its ID and disables redispatch. `AgencyInspect` queries submission and lifecycle receipts; acceptance evidence settles only captured drafts/context/annotations, and never authorizes sending the same prompt again. Changed annotation threads remain intact. Disconnecting during a turn leaves it running. Cancel targets the observed submission and leaves a cooperative provider usable; an uncooperative provider fails after the five-second cancellation grace deadline. The production prompt deadline remains 90 seconds.

Launch choices show actual model, reasoning, mode, and permission metadata. Model discovery is demand-driven; the Agency picker refresh action explicitly launches discovery and rereads choices using the retained command identity. Stale, unsupported, or unconfigured choices do not fall back to native Agentic. The current production capability is Codex read-only with deny-all permission callbacks. This increment has no writable sessions, human permission routing, or remote roster.

## Conversation and transport bounds

Editor turns accept at most 256 KiB of raw UTF-8 input and 768 KiB of raw assistant answer. Each also has an independent 896-KiB JSON-encoded text budget, so heavily escaped text can reach that limit first. Legacy scalar `agent prompt` keeps its 4-KiB input/output limits. ACP validates text and fallback titles against a 1-MiB wire field bound, with a 1-MiB individual frame bound. Display titles are UTF-8-safe prefixes of at most 1,024 bytes with original-byte and truncation metadata; valid larger wire titles remain accepted.

Native Agency restore uses provider `session/load`, including complete replay messages, rather than an Agency transcript archive. Initialization/load has an 8-MiB total wire budget. Replay exceeding this budget or the individual frame limit fails visibly as `ACP_HISTORY_LIMIT` or `ACP_FRAME_LIMIT`, preserving the recorded native session identity without fallback `session/new`. Provider-native persistence can retain more history than Agency can restore in one bounded load.

The Handler and the one shared Lua projection retain at most 16 MiB and 8,192 display events per live generation. Metadata is bounded to 64 KiB. Eviction removes an oldest prefix and exposes `firstSeq` and `historyTruncated`; it does not forget pending delivery IDs. Receipts are not an answer archive. History is volatile across Handler/provider replacement; only native load replay reconstructs the next generation.

Submission receipts have a separate lifetime from display history. The Handler retains one in-memory receipt per accepted turn for the provider generation, including after that turn's display events are evicted. Each receipt contains the submission ID, prompt digest, state, and completion metadata, not duplicate prompt or answer bodies. The 16-MiB display bound does not cap receipt storage; receipt count grows with accepted turns until generation retirement releases it. Expiring receipts while that generation remains usable would permit a previously accepted submission ID to dispatch again.

Each visible view retains at most 4 MiB of transcript text, 20,000 lines, 512 tool trackers, and 4 MiB of tracker strings. It rebuilds from a bounded recent suffix with a truncation marker when history or rendering budgets require compaction. Oversized events become bounded summaries; multi-file diffs use complete labelled before/after text. Rebuilds do not submit prompts or run acceptance/completion hooks. Hidden views release transcript/tracker state while retaining draft/context and widget identity, then rebuild on show.

The private `attachment.sock` carries `agency-attachment/1` NDJSON independently of the EOF-delimited control socket. Neovim only invokes the CLI; it neither inspects nor opens sockets. Attachment frames are bounded to 2 MiB, peer queued writes and scheduled Lua delivery to 4 MiB, raw snapshot staging to 17 MiB, and outstanding requests to 64. Snapshot chunks target 128 KiB, with a larger valid event in its own frame. Handshake and acknowledgment deadlines are five seconds; a live stream has no idle timeout. Overflow, sequence gaps, conflicting duplicates, stale tuples, and invalid UTF-8 disconnect only the attachment, which must obtain a fresh snapshot. Overflow may produce EOF instead of a fault when the peer cannot drain a terminal frame.

## Control protocols

Control commands return an `agency-control/2` envelope containing the request ID, selected Handler generation, success state, and result or bounded error. Agent operations use the separate `agency-agent/2` protocol. Internal sockets accept one bounded LF-terminated JSON request and return one bounded reply. Request IDs, command IDs, Handler generations, and provider generations are validated at the boundary.

Exit codes are 0 for success, 64 for usage, 65 for invalid protocol, 69 for unavailable or stale targets, 70 for internal failure, and 75 for incomplete operations. Bootstrap failures before Node starts are stderr-only.

## Production ACP contracts

Production launch authority comes from static code-owned ACP capability declarations. A declaration specifies the provider ID, adapter package and supported version, ACP option IDs, selectable mode and reasoning values, permission profiles, deadlines, permission evidence, and whether `session/load` is supported. It contains no executable path, generated evidence, or mutable runtime authorization.

The Codex declaration supports `@agentclientprotocol/codex-acp` 1.7.0, model option `model`, reasoning option `reasoning_effort`, mode option `mode`, `high`, `read-only`, `deny-all`, and `session/load`. Start and restore use this same declaration.

The configured provider profile supplies the ambient native executable, adapter package metadata, and declared configuration paths. Agency requires the adapter package name and version to match the declaration, resolves the package's relative `main`, and observes one stable canonical regular entrypoint. The configured launch contract and its fingerprint bind both the adapter entrypoint and the profile's native executable. Missing, escaping, absolute, symlinked, or replaced entrypoints fail the affected launch before provider startup.

A currently valid profile, catalog snapshot, and matching static declaration are sufficient to attempt a launch. Runtime failures do not revoke or mutate the declaration. Unsupported selections, unavailable profiles, and configuration drift fail only the command that encountered them.

## Agent lifecycle

`agent start` snapshots the invoking CLI's environment and passes it to the provider without merging the long-running Handler's environment. This includes `HOME`, XDG paths, credentials, cache paths, Git variables, and provider-specific configuration. At adapter spawn, Agency sets `CODEX_PATH` to the selected profile's native executable so `codex-acp` uses the same authenticated executable as catalog discovery; every other caller environment value remains unchanged. Durable state stores only a deterministic environment digest, so exact retries can reject changed input without retaining environment values.

The working directory is persisted as launch metadata but is not an ownership boundary. `agent current` returns every live agent whose stored directory string exactly equals the invoking CLI's absolute directory. `agent list` includes stopped, failed, interrupted, recoverable, cleanup-uncertain, and legacy records.

A successful start records the logical `agentId`, provider session ID, provider generation, launch-attempt ID, selection, contract fingerprint, and exact owned process identity. A client disconnect does not terminate a ready agent. Prompts are serialized per agent, bounded, and never replayed automatically.

`agent stop` targets an exact agent, Handler generation, and provider generation. Agency cancels active work, revalidates the recorded process group, signals only that owned group, verifies absence, and retains the logical definition and provider session ID. Ambiguous identity or surviving owned processes leave that agent cleanup-uncertain.

`agent restore` is explicit. It uses the stored working directory and a fresh environment snapshot from the restoring CLI, starts a new provider process, verifies ACP `session/load`, and loads the recorded provider session ID. The logical agent ID and provider session ID remain stable, while provider generation and launch-attempt ID rotate. Authentication failure, missing session state, protocol failure, timeout, or configuration drift remains visible on that agent and does not block another start.

After a Handler or devbox restart, a previously ready agent with an absent provider and recorded session ID becomes recoverable. Agency does not resurrect processes, adopt orphaned ACP streams, persist old environments, or replay in-flight prompts. Legacy version-1 records are retained for historical reconciliation but do not authorize new launches.

## Optional Codex acceptance

The live Codex acceptance command exercises the ordinary production Handler and public lifecycle. Run it from `agency/` only after obtaining separate authorization:

```text
npm run accept:codex -- --evidence-parent /absolute/private/directory
```

This command starts the real provider and submits two paid prompts. It must not be run as part of deterministic testing or without explicit authorization for that live execution.

The check starts an agent in the actual invocation directory with a fresh ambient environment, asks it to read that directory's `package.json`, stops it with verified owned-process cleanup, snapshots a second fresh environment, restores the same provider session, asks it to recall the prior nonce, and stops it again. It uses the configured profile and the normal production contract registry. It does not stop or replace an unrelated Handler.

The private `agency-codex-acceptance/1` report contains the working directory, environment digests, lifecycle steps, prompt answers, logical and provider generations, session continuity, launch-attempt identities, and verified owned-process cleanup. It does not contain environment values and cannot authorize, revoke, register, or otherwise modify production launch behavior. A failed check retains its diagnostic report, attempts an ordinary targeted stop when an agent is still active, and records the exact unresolved target when cleanup cannot be verified.

`npm run test:codex-acceptance` uses deterministic local providers and isolated private control roots. It submits no paid prompt and does not run the native Codex executable.

## Model catalog

The catalog is configured through `persistentRoot/catalog/providers.json`, a user-owned private regular file with shape `{ "version": 1, "providers": [...] }`. An absent file configures no providers. Agency does not search `PATH` or infer provider configuration.

Each profile declares `id`, `enabled`, `executable`, `adapterPackageJson`, `sdkPackageJson`, and `configurationFiles`. Codex uses its configured executable for bounded model discovery and requires no SDK package. Claude discovery loads the explicitly configured SDK inside an owned worker. Discovery does not submit a model prompt, but native startup may still exercise authentication or provider-specific side effects.

Catalog evidence is current-generation and time-bounded. Successful refresh replaces a provider's advertised model set. Failed refresh preserves prior data as stale. A launch revalidates the profile, configuration evidence, selected model and options, and configured contract before provider spawn and before readiness.

## Process ownership and persistent state

Agency stores Handler, command, agent, catalog, and launch records beneath a canonical user-owned mode-0700 state root. Records use bounded strict schemas and private atomic publication with file and directory durability barriers. Runtime sockets live in a user-owned mode-0700 temporary root and have mode 0600.

Handler and provider leaders are detached direct children whose PID equals their process-group and session IDs. Records bind the boot identity, PID generation, parent, group, session, UID, GID, and an exact per-launch marker. Reconciliation revalidates that evidence before signaling. A missing or replaced process is not signaled.

On restart, Agency classifies each retained launch independently. Exact owned process groups are cleaned and verified absent; ambiguous records remain visible without creating a Handler-wide launch latch. Pending commands become interrupted because their transient environments are intentionally unavailable.

## Retention and cleanup

Persistent state lives under `${XDG_STATE_HOME:-$HOME/.local/state}/agency/hosts/<host-key>`. Agent definitions, lifecycle command receipts, launch records, shutdown receipts, catalog snapshots, probe metadata, and probe work directories are retained without automatic age-based pruning. Individual records are bounded, but accumulated history is not. Completing a turn does not stop its agent, and stopping an agent preserves its native session identity for explicit restore. Neither inactivity nor catalog staleness authorizes session deletion or process termination.

Catalog retention also has an availability consequence. Newly accepted refresh commands are refused once 4,096 command receipts are retained, and catalog directory inventories reject more than 4,096 entries. The Handler automatically refreshes stale configured catalog evidence while running, so this history can accumulate without editor refresh actions. The ten-minute catalog freshness window is not a storage-retention policy.

Agency does not write an append-only production transcript or log file. Handler stdout/stderr are discarded, and provider/probe output is consumed through bounded transports rather than copied into Agency log files. Native providers inherit the caller's home and configuration, so their own sessions, logs, and caches remain provider-owned; Agency neither rotates nor deletes them. Acceptance and qualification reports are separately retained in their selected evidence directories.

There is currently no supported archive or prune command. Do not delete individual state files by age: agent recovery requires linked creation commands and launch evidence, catalog receipts reference snapshots and probes, and a running Handler checks retained state for unexpected removal. Any future cleanup must preserve active and cleanup-uncertain targets, retain receipt evidence or explicit expired-command rejection, and remove related history consistently. Forgetting a stopped session must be an explicit operation because it removes Agency's restore entry point; deleting its provider-native history requires separate ownership and retention rules.

## Verification

Use Node 24.13.0 and run the package scripts sequentially:

```text
npm run test:agent
npm run test:agent-integration
npm run test:attachment
npm run test:attachment-integration
npm run test:neovim-integration
npm run test:unit
npm run test:darwin
npm run test:catalog
npm run test:catalog-integration
npm run test:control
npm run test:control-integration
npm run test:codex-acceptance
```

These suites use deterministic fixtures, private temporary roots, and owned local process groups. They do not run `accept:codex`, invoke a real model, submit a paid prompt, or deploy production state.

Run `./test-nvim.sh` from the repository root for the editor suite. Node-owned Neovim integration tests explicitly supply a private fixture CLI, cwd, fake provider, and dedicated evidence file. They use the pinned UI plugin with `-u NONE`, disable swap/shada, and load no user hooks or native providers. `AGENCY_NVIM_EXECUTABLE` can select the binary; its Darwin default is `/opt/homebrew/bin/nvim`. Fixture teardown independently verifies provider/process-group absence.

## Limits

Providers run with the normal devbox user's filesystem and socket access. The `deny-all` permission profile governs ACP permission callbacks; it is not an operating-system sandbox. Provider helpers that detach from the recorded process group are outside Agency's cleanup ownership.

Agency does not impose an agent-count or launch-count admission limit. Agent record and command inventory has no fixed entry-count limit, but other protocol and catalog payloads remain bounded. Durable histories are not automatically pruned; agent inventory cost and storage grow with retained history, and operating-system resource exhaustion is reported explicitly.

Provider restoration depends on native persisted session state and ACP `session/load`. It cannot restore an in-flight RPC, repair deleted provider state, or guarantee that a provider version can read state created by another version.

Darwin process identity remains subject to second-resolution start-time and numeric process-group reuse constraints. Linux retains a procfs-read-to-`killpg` reuse window because it uses no pidfd helper.

## Historical evidence

Historical design plans and retained evidence describe earlier architectures and remain immutable; they are not production inputs. The platform foundation report remains at `~/stripe/work/projects/devbox-agent-orchestration/agency-platform-foundation-20260923/report.md`.
