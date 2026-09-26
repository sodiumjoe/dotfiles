# Agency

Agency provides a host Handler control plane over its qualified Darwin and Linux platform layer. It implements lazy daemon startup, retained-launch reconciliation, internal checkout admission, model discovery, status, diagnostics, and guarded shutdown. Platform records retain exact process identity and checkout-scoped quarantine.

It does not yet create agents or implement ACP sessions, permissions, attachment/roster streams, Neovim integration, the Bureau, or cross-host coordination. Existing retained providers are reconciled only; surviving sessions are never adopted. Checkout reservation/cancellation is an internal Handler API, not a public reserve command or an agent-start interface.

## Build and commands

Agency requires Node 24.13.0 and the existing pinned lockfile. From `agency/`, select that Node version and run `npm ci` followed by `npm run build`. `home/bin/agy` is the repository command, deployed by the existing dotfiles workflow as `~/bin/agy`. It resolves its own symlink chain to locate this repository's build and invokes `$HOME/.nodenv/versions/24.13.0/bin/node`. Missing runtime or build produces a stderr diagnostic and exit 69; it never installs or builds implicitly.

```text
agy status [--json]
agy handler status [--json]
agy doctor [--json]
agy shutdown [--stop-agents] [--json]
agy shutdown --command-id <uuid> --handler-generation <uuid> [--stop-agents] [--json]
agy model list [--json]
agy model refresh [--json]
agy model refresh --command-id <uuid> --handler-generation <uuid> [--json]
```

Status lazily starts or connects to one Handler. Doctor inspects state without starting a Handler or performing cleanup. Path resolution may create empty qualified state/runtime directories. Neither command creates a model session.

Shutdown never starts a daemon. It refuses unverified launches unless `--stop-agents` is supplied, and even that flag cannot release ambiguous cleanup. Accepted shutdown persists an exact generation-bound receipt, closes client connections, and exits. The CLI independently observes the recorded Handler generation's absence before reporting `shutdown_complete`. A receipt alone or delivery of a signal is insufficient evidence.

On an uncertain result, retain the command ID and Handler generation. Retry with both flags and the original `--stop-agents` setting. A retry cannot select a replacement Handler. Receipts remain under the persistent `shutdown/` directory; automatic expiry is not implemented. A failed directory fsync can leave a visible receipt without completing shutdown; an explicit matching retry revalidates cleanup and republishes it before draining. SIGTERM/SIGINT use the same guarded path and are deferred while startup classifies records. Incomplete cleanup leaves the Handler available for status.

## Control protocol

JSON command output contains one `agency-control/1` envelope with `requestId`, selected `handlerGeneration` (null before selection), `ok`, and either `result` or `error`. Shutdown also returns `commandId`. Bootstrap failures before Node starts are stderr-only; subsequent diagnostics are bounded to 8 KiB on stderr. Exit codes are 0 for success, 64 for usage, 65 for invalid protocol, 69 for unavailable/stale targets, 70 for internal failure, and 75 for incomplete operations.

The internal Unix-socket protocol is separate from future attachment streams. Each connection carries one LF-terminated JSON request followed by a write-half close, and one LF-terminated reply followed by EOF. Frames are bounded to 8 MiB with strict UTF-8 and matching request/generation IDs. Duplicate frames are rejected before dispatch. Oversized status returns an explicit incomplete result. Future Neovim clients use the CLI rather than private socket framing.

The launcher may time out while a live Handler continues reconciliation. A later client waits for that same generation through the singleton protocol. Readiness requires classification of every committed retained record and a final inventory comparison. Changed inventory or malformed/unattributable records prevent readiness and preserve evidence. Recognized private atomic-write remnants remain on disk but do not count as committed launch records.

## Verification scope

Run `npm run test:unit`, `npm run test:darwin`, `AGENCY_LINUX_PROCFS_UNIT=1 node --test --test-concurrency=1 dist/test/linux-platform.test.js`, `npm run test:control`, `npm run test:control-integration`, `npm run test:checkout`, `npm run test:checkout-integration`, `npm run test:catalog`, and `npm run test:catalog-integration` sequentially with Node 24.13.0. Integration tests exercise production daemon/client modules with private fixture roots and owned local process identities. They launch no real provider or model prompt and perform no remote operation or production deployment.

The Handler composition is qualified locally on Darwin. Real Linux Handler execution remains unqualified until a separately bounded remote increment. The platform layer's retained Linux qualification remains valid; synthetic Linux tests do not substitute for a real Linux Handler trial.

## Qualified contract

### Model catalog

The catalog is opt-in through `persistentRoot/catalog/providers.json`, a user-owned private regular file with one link and exact shape `{ "version": 1, "providers": [...] }`. An absent manifest configures no providers and launches no discovery. Agency does not create this file, search PATH, or discover provider settings automatically. Each profile has exactly `id`, `enabled`, `executable`, `adapterPackageJson`, `sdkPackageJson`, and `configurationFiles`. Paths are canonical absolute paths. IDs are `claude-agent-acp` and `codex-acp`; Claude requires SDK package metadata, while Codex requires `sdkPackageJson: null`. Configuration files are an ordered, duplicate-free list of at most 16 declared paths.

Enabling a live profile causes discovery subprocesses on Handler startup, cache expiry, configuration changes, and explicit refresh, even without a model prompt. Do not enable live profiles before separately qualifying the executable, dependency versions, authentication surface, and managed-policy behavior. Local qualification uses only deterministic fake SDKs and native executables. Real-provider discovery and real Linux Handler/catalog composition remain unqualified.

Claude discovery loads the explicitly configured `@anthropic-ai/claude-agent-sdk` version `0.3.232` only inside an owned worker, calls `supportedModels()` with an empty prompt stream, disables setting sources, tools, MCP servers, and session persistence, and routes native spawning through the registration gate. Other SDK versions are rejected. Codex uses only `initialize`, `initialized`, and bounded `model/list` pagination. Adapter versions come from the declared `@agentclientprotocol/<provider-id>` package metadata, not the native binary. A native version is reported only when supplied by native discovery; otherwise it is unknown. These restrictions do not establish that native startup has no authentication or other side effects.

`agy model list` reads the cache and reports provider state, freshness, discovery status, and `launchAuthorized: false`. Model IDs retain advertised alias semantics; resolved model IDs and ACP modes remain unknown. Reasoning capabilities distinguish unknown evidence, explicit absence, and advertised values. Every later agent launch must revalidate model, mode, reasoning, permissions, checkout, and effective configuration.

Freshness requires the current Handler's per-provider verification, unchanged declared-input fingerprint, successful cleanup/publication, and an age below ten minutes. The fingerprint binds profile values, executable and SDK entry filesystem identity, declared package metadata, and declared configuration contents, including missing files. It does not cover undeclared settings, environment changes, credentials, or arbitrary files imported by the SDK. Configuration is polled every 30 seconds; failed automatic refreshes back off for 60 seconds. Failures preserve previously verified models as stale. Successful refresh replaces a provider's complete advertised set, including removals. A wall-clock rollback preserves historical verification timestamps; future-dated evidence is not fresh.

Refresh IDs are durable and generation-bound. Concurrent callers coalesce bounded work; an exact completed retry returns its original immutable snapshot even after newer refreshes. A disconnected CLI does not cancel discovery. JSON output uses `agency-catalog/1` and includes retry IDs for refresh. Polling is bounded to 60 seconds; on incomplete output retain both IDs and retry with the original generation. A restarted Handler interrupts pending commands and refuses new work under old IDs. A running pre-catalog Handler is not automatically restarted or replaced by a catalog client.

Each probe uses a fresh private non-Git scratch directory, one detached gated Node worker, and at most one non-detached native child. Independent platform observation and durable registration precede native protocol work. Discovery is bounded to 20 seconds per provider, followed by qualified TERM/KILL cleanup and direct-worker terminal observation. Probe records live under `catalog/probe-launches` with separate metadata, commands, snapshots, and a hash-bound current pointer. They never acquire checkout leases. Snapshots support two bounded 1-MiB provider payloads plus a bounded envelope; command and metadata files retain their 1-MiB limit. Retained evidence is not automatically pruned. If cancellation occurs before the live owner invokes spawn, it can durably restore provably unattempted evidence before normal reconciliation. A crash before that restoration or any uncertainty after spawn invocation retains the conservative cleanup boundary.

Ordinary shutdown cancels and drains discovery without `--stop-agents`. Checkout-related refusal resumes healthy discovery. Unverified probe cleanup blocks all new discovery and successful shutdown while preserving readable historical catalog data and independent checkout admission. A restart reconciles the exact retained probe groups before starting replacements; an attempted launch without attributable identity remains quarantined. PID alone, worker messages, EOF, a missing record, or a valid model response never authorize cleanup or fresh publication. No force-cleanup operation is provided.

### Checkout admission

Checkout identity binds the host, canonical root, device/inode strings, common Git directory, worktree-specific Git directory, and physical ancestors. The stable ID hashes the host and root/worktree-Git-directory physical identities. Symlink and case aliases converge, while separate non-overlapping linked worktrees remain independent despite sharing a common Git directory. Nested repositories and submodules conflict with a leased parent. Dirty files are neither reset nor deleted.

The resolver uses `/usr/bin/git rev-parse` with argument vectors, neutralized inherited Git redirection, bounded output, and repeated snapshots. Each direct Git child has a two-second execution limit and SIGKILL timeout/overflow policy; cleanup requires observed terminal state. Missing Git, unsupported paths, bare repositories, unstable filesystem mappings, and unverified subprocess cleanup fail closed. These observations are not a filesystem lock against hostile same-user mutation. Provider launch will require renewed validation in its later increment.

Only the qualified Handler creates leases. Reservation, unattempted cancellation, and shutdown share one mutation queue. Generation and readiness checks run inside it; pending shutdown prevents new reservations, and duplicate shutdown requests retain their existing coalescing behavior. Internal retries carry immutable agent, lease, attempt, Handler-generation, and checkout identities. A released attempt can never be revived; a new reservation needs fresh IDs.

Reservation first publishes the unchanged version-1 unattempted LaunchRecord, then immutable `admissions/<launchAttemptId>.json` checkout evidence. Success requires both durable publications, exact readback, complete inventory checks, and renewed checkout validation. Every metadata retry repeats file and directory durability barriers, including the persistent parent. A failed publication may leave visible blocking records. Exact matching unattempted retries may complete publication; uncertain evidence is never deleted to free a checkout. Cancellation uses qualified reconciliation only for a pinned, provably unattempted record. Metadata remains after verified release.

Mapped unresolved launches block overlapping checkouts. Unmapped legacy launches, orphan or malformed metadata, inconsistent identities, or unexpected changes to the accepted launch inventory make admission globally unavailable while status and guarded shutdown remain usable. Every unresolved retained checkout mapping is checked before and after new publication. A moved/replaced mapping also blocks all new reservations because historical paths cannot locate arbitrary relocation. Exact unattempted cancellation or qualified restart/shutdown cleanup can discharge the affected launch; metadata alone is never release authority. Unexpected launch-inventory changes latch admission unavailable until a new qualified Handler generation.

`agy doctor` adds a current-checkout diagnostic without starting the Handler, reserving a lease, reconciling processes, or creating admission metadata. It reports observed identity/occupancy with `authoritative: false`, or an explicit not-checkout/unavailable condition. The observation cannot authorize a writer and may become stale immediately after it returns. Existing environment initialization may still create empty state/runtime directories. The strict socket protocol and status capabilities remain unchanged.

### Platform records

Agency stores versioned Handler and launch records below a canonical user-owned 0700 persistent root. Records are validated before use and published through a 0600 temporary file, file `fsync`, atomic rename, and parent-directory `fsync`. Invalid, oversized, symlinked, non-private, or semantically inconsistent records fail closed.

The persistent root is `${XDG_STATE_HOME:-realpath(HOME)/.local/state}/agency/hosts/<host-key>`. The runtime root is `/private/tmp/agy-<uid>-<host-prefix>` on Darwin and `/tmp/agy-<uid>-<host-prefix>` on Linux. Runtime roots are user-owned mode 0700, and `handler.sock` must remain below the 100-byte Unix-socket path limit and have mode 0600.

Lazy startup uses the qualified system `lockf` on Darwin or `flock` on Linux. A launcher publishes a pending Handler generation, starts one detached marker-bound Handler, publishes its exact identity, releases the launch gate, and waits for readiness. The Handler binds the private socket, inventories every retained launch record, publishes a complete reconciliation summary, and becomes ready only when every record has been classified. A restarted Handler never adopts or restores a surviving provider.

Each Handler or provider leader is detached with PID equal to process-group ID and session ID and with an exact per-launch `argv[0]` marker: `agy-handler:<uuid>` or `agy-provider:<uuid>`. Group signals reject numeric targets less than or equal to one.

Darwin identity combines the Apple boot-session UUID, PID, second-resolution UTC start time, exact marker, process group, parent, UID, and GID. Reads use only canonical root-owned `/usr/sbin/sysctl` and `/bin/ps`, by absolute path without a shell under `LANG=C` and `TZ=UTC`. Process and group observations require stable repeated complete snapshots.

Linux identity combines the procfs boot ID, PID, starttime tick, exact byte-zero `argv[0]`, process group, session, parent, UID, and GID. Process observations repeat stat, status, and cmdline reads. Group observations require two equal complete `/proc` scans. A zombie is not absence until procfs confirms reaping.

Restart reconciliation persists `cleanup_pending` before signaling and immediately revalidates exact boot, leader generation, marker, group, session, ownership, and retained-member evidence. It sends SIGTERM, polls for at most one second, reauthorizes continuity, sends SIGKILL if required, polls for at most three seconds, and requires independent empty-group and recorded-generation absence evidence before `cleanup_verified`. Missing, unstable, changed, or incomplete evidence quarantines only the affected checkout.

## Crash classification

- Before provider spawn: release the provably unattempted launch without signaling.
- After spawn was attempted but before identity publication: quarantine without production signaling.
- After identity publication, during readiness, or while active: clean only the exact verified process group; otherwise quarantine.
- Prior boot or conclusive PID-generation replacement: release without signaling the replacement.

## Limits

Darwin start time is second-resolution. Marker visibility and same-user observation are trusted. Session identity is derived from detached PID/process-group ownership, and a numeric `ps`-snapshot-to-`killpg` reuse race remains.

Linux retains a numeric procfs-read-to-`killpg` reuse race because this increment adds no pidfd or native helper. `argv[0]` is visible and may be mutable by the process. A same-boot provider-null record can correspond to an unmanaged provider and remains quarantined until manual cleanup or a verified boot transition.

Neither platform has automatic provider death coupling. Providers have the normal devbox user's filesystem and socket access. Cleanup covers exact recorded process-group members; a descendant that deliberately creates a new session and escapes before observation is outside the guarantee. Provider compatibility must be qualified separately before a provider can rely on this contract.

## Handler-plan gate

Darwin: qualified. Linux: qualified. The subsequent Handler plan may consume this platform contract without expanding it. The qualification report is retained at `~/stripe/work/projects/devbox-agent-orchestration/agency-platform-foundation-20260923/report.md`.