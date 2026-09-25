# Agency

Agency provides a host Handler control plane over its qualified Darwin and Linux platform layer. It implements lazy daemon startup, retained-launch reconciliation, status, diagnostics, and guarded shutdown. Platform records retain exact process identity and checkout-scoped quarantine.

It does not yet create agents or implement model discovery, checkout admission, ACP sessions, permissions, attachment/roster streams, Neovim integration, the Bureau, or cross-host coordination. Existing retained providers are reconciled only; surviving sessions are never adopted.

## Build and commands

Agency requires Node 24.13.0 and the existing pinned lockfile. From `agency/`, select that Node version and run `npm ci` followed by `npm run build`. `home/bin/agy` is the repository command, deployed by the existing dotfiles workflow as `~/bin/agy`. It resolves its own symlink chain to locate this repository's build and invokes `$HOME/.nodenv/versions/24.13.0/bin/node`. Missing runtime or build produces a stderr diagnostic and exit 69; it never installs or builds implicitly.

```text
agy status [--json]
agy handler status [--json]
agy doctor [--json]
agy shutdown [--stop-agents] [--json]
agy shutdown --command-id <uuid> --handler-generation <uuid> [--stop-agents] [--json]
```

Status lazily starts or connects to one Handler. Doctor inspects state without starting a Handler or performing cleanup. Path resolution may create empty qualified state/runtime directories. Neither command creates a model session.

Shutdown never starts a daemon. It refuses unverified launches unless `--stop-agents` is supplied, and even that flag cannot release ambiguous cleanup. Accepted shutdown persists an exact generation-bound receipt, closes client connections, and exits. The CLI independently observes the recorded Handler generation's absence before reporting `shutdown_complete`. A receipt alone or delivery of a signal is insufficient evidence.

On an uncertain result, retain the command ID and Handler generation. Retry with both flags and the original `--stop-agents` setting. A retry cannot select a replacement Handler. Receipts remain under the persistent `shutdown/` directory; automatic expiry is not implemented. A failed directory fsync can leave a visible receipt without completing shutdown; an explicit matching retry revalidates cleanup and republishes it before draining. SIGTERM/SIGINT use the same guarded path and are deferred while startup classifies records. Incomplete cleanup leaves the Handler available for status.

## Control protocol

JSON command output contains one `agency-control/1` envelope with `requestId`, selected `handlerGeneration` (null before selection), `ok`, and either `result` or `error`. Shutdown also returns `commandId`. Bootstrap failures before Node starts are stderr-only; subsequent diagnostics are bounded to 8 KiB on stderr. Exit codes are 0 for success, 64 for usage, 65 for invalid protocol, 69 for unavailable/stale targets, 70 for internal failure, and 75 for incomplete operations.

The internal Unix-socket protocol is separate from future attachment streams. Each connection carries one LF-terminated JSON request followed by a write-half close, and one LF-terminated reply followed by EOF. Frames are bounded to 8 MiB with strict UTF-8 and matching request/generation IDs. Duplicate frames are rejected before dispatch. Oversized status returns an explicit incomplete result. Future Neovim clients use the CLI rather than private socket framing.

The launcher may time out while a live Handler continues reconciliation. A later client waits for that same generation through the singleton protocol. Readiness requires classification of every committed retained record and a final inventory comparison. Changed inventory or malformed/unattributable records prevent readiness and preserve evidence. Recognized private atomic-write remnants remain on disk but do not count as committed launch records.

## Verification scope

Run `npm run test:unit`, `npm run test:darwin`, `AGENCY_LINUX_PROCFS_UNIT=1 node --test --test-concurrency=1 dist/test/linux-platform.test.js`, `npm run test:control`, and `npm run test:control-integration` with Node 24.13.0. Integration tests exercise production daemon/client modules with private fixture roots and owned local process identities. They launch no real provider or model prompt and perform no remote operation or production deployment.

The Handler composition is qualified locally on Darwin. Real Linux Handler execution remains unqualified until a separately bounded remote increment. The platform layer's retained Linux qualification remains valid; synthetic Linux tests do not substitute for a real Linux Handler trial.

## Qualified contract

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