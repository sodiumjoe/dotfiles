# Agency platform foundation

This package is the qualified platform layer for Agency. It defines durable launch and Handler records, host-scoped private paths, lazy singleton startup, private Unix sockets, process identity, and conservative restart reconciliation on Darwin and Linux.

It does not implement the production Handler daemon, `agy`, the Bureau, provider adapters, ACP persistence, model selection, Neovim attachment, authentication, or cross-host coordination.

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