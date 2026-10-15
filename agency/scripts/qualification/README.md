# Isolated Agency qualification preparation

This directory supplies a private launcher, a read-only host collector and an evidence freezer. Preparation does not execute an SSH command, discover a provider, submit a prompt, install a candidate or approve a permission. Generated example phases are marked **SYNTHETIC INPUT**. Their existence is not execution authorization or live acceptance evidence.

## Local preparation commands

Use the pinned Node 24.13.0 and build the candidate first. The emitted CLI has three modes:

```sh
node dist/scripts/qualification/runbook.js prepare-preflight --input-json-file FILE --output NEW_DIR
node dist/scripts/qualification/runbook.js freeze --input-json-file FILE --evidence-root DIR --output NEW_DIR
node dist/scripts/qualification/runbook.js verify-result --input-json-file FILE --evidence-root DIR --output NEW_DIR
```

All commands require a new output directory. Directories have mode 0700 and files have mode 0600. A partial write retains `incomplete-output.json`; never reuse that directory. `prepare-preflight` binds the exact request JSON and collector bytes to their hashes and records SSH argv and stdin without invoking SSH. `freeze` verifies addressable evidence, validates the phase and writes `phase.json` and `runbook.md`. It never marks execution passed. `verify-result` validates a supplied PhaseResult and its complete addressable artifact/evidence chain, including terminal real claims and cleanup readbacks, then writes `result.json` containing `{result, verifiedAt}`. It does not execute a phase. Treat raw argv as authoritative; shell quoting is only for display. A command kind describes the author's intent and does not prove its effects.

The preflight request contains an explicit request UUID, target intent, candidate binding and a 30-second window. Prepare it immediately before a separately authorized observation. The target contains actual HOME/XDG values, canonical Node and explicit provider/tool metadata paths; do not infer current provider locations or model offers from history. Claim absence is requested by including the derived `qualification/allowances/<operation UUID>.claim.json` in `toolFiles`. Only that pattern can be absent; other requested files must exist with unambiguous ownership and modes. Collector errors contain public refusal codes, without credential or environment dumps.

The request purpose is `install`, `observe` or `cleanup`. Installation observes absent allocations; observation requires the verified candidate build. Cleanup tolerates an absent or partial build and records a null candidate binding. A live owner without a verified binding permits read/export commands only. A slow collector read can delay failure beyond the 30-second window; its final expiry check still rejects late observations.

The collector runs from stdin and writes one JSON line to stdout. Its closed CommonJS registry includes the actual host identity and Darwin/Linux platform adapters. The local generator uses the pinned TypeScript 7 CLI and native AST API because this compiler version does not provide `transpileModule`. The registry embeds the complete source closure inventory and source hashes. Targets require Node and builtins only. No collector file is written remotely.

## Allocation and binding

The caller allocates a fresh source root, persistent root and runtime root. A source allocation contains this layout:

```text
allocation/
  agency/{src,test,scripts,package.json,package-lock.json,tsconfig.json,dist}
  home/.config/nvim/
  tests/neovim/
```

`packageRoot` is the allocation's `agency` directory. Both sibling trees participate in the source digest. Do not flatten an archive. Every endpoint must reproduce the same source revision, source/dist digests, Node version and bridge/2 protocol before mutation. A live ready Handler also retains its exclusive generation startup binding. A source change invalidates prior configs and observations. Every phase retains the same task UUID, archive set, source allocation, package, persistent and runtime roots. Non-installation passes preserve the exact candidate observations and binding; cleanup permits the original owner to disappear but cannot substitute another generation or allocation.

Production paths are derived from the observed host ID, actual uid, platform and verified HOME/XDG values without creating directories. Candidate sockets require a separate runtime root; changing XDG alone does not isolate them. Installation never overwrites `~/bin/agy`, ordinary provider profiles/configuration/authentication, existing plugins or historical roots.

## Finite qualification gates

1. Capture fresh read-only preflight observations for the laptop and both named hosts. Review the exact request, collector hash and argv before authorizing observation.
2. Prepare a separate isolated installation artifact from those observations. Require all three allocated roots absent. Freeze archive hashes, launcher/config/editor-init bytes and cleanup allocations.
3. Prepare the synthetic cross-host exercise from passed installation evidence. It has zero real discovery and paid prompts. Record candidate generation receipts before mutations.
4. Prepare per-host native discovery with separate numeric budgets and exact operation UUIDs. A failed invocation consumes its allowance. No login, logout, restore or additional discovery follows automatically.
5. Prepare at most two authored real texts: one supervisor submission and one worker task request. Bind complete native model/mode/reasoning tuples to each host's per-model offerings, public native transcript and reviewed policy. The guarded supervisor helper permits exactly the frozen worker create; worker helpers deny create. An end_turn does not establish completion. A lost reply permits original-reference inspection; it does not permit another submission or create.
6. Export private reports, diagnostics and spend records, then prepare exact cleanup. Use ordinary exact-session stop and exact-generation shutdown with `--stop-agents`. Close only the owned private editor/tmux. Require two independent boot/birth/process-group absence observations per registered identity. Preserve ambiguous roots and report incomplete cleanup.

The synthetic exercise covers private remote launch/inspect, attachment/detachment without provider termination, shared admission, one owner permission answer with two converging views, caller-selected task create, explicit worker reporting while laptop links are closed, reconnect/repeated inspect/wait, timeout/cancel leaving the worker alive and lost-reply inspection without replay. Local deterministic coverage does not establish Linux, cross-host, real model, picker or provider behavior.

Cleanup can follow a failed installation, a synthetic-only exercise, or failed/ambiguous later phases. It requires the available installation history, not successful discovery or real execution. Fresh cleanup observations must retain the original allocations. Ambiguous ownership allows only read/export commands. A cleanup pass requires all candidate owners absent and two independent absence readbacks for each registered process.

A permission decision is a separate annex during the real window. It binds an exported ordinary pending PermissionSnapshot to the parent real artifact digest, exact owner tuple, decision UUID and offered option. The parent can remain in progress. Its task, allocations, archives, binding and candidate observations must match the annex. A worker annex supplies `permission.ownerFile`, an addressable exported ordinary TaskRecord parsed with `parseTaskRecord`; its task ref, session tuple, launch generation and description must match the parent worker allowance and the observed offer. A supervisor annex uses `ownerFile: null` and must match the parent supervisor prompt command's exact target. Unknown, withdrawn, mismatching or expired offers refuse the annex. Report automation and genuine user picker interaction separately. Missing/unexpected human offers, host drift, expired deadlines or ambiguous mutations end the exercise. No automatic approval, provider restore, new prompt or replay is implied.

## Evidence files

All predecessor artifact/evidence files, command stdout/stderr, public native transcripts, policy files and offer snapshots are relative to an explicit evidence root. Reject traversal and symlink components. Hashes bind exact bytes. Predecessor artifacts recursively verify their own evidence. Outcome labels alone do not pass a gate. Every planned command requires exactly one receipt, with its original reference and finite ordered timestamps. Repeated before/after arrays must agree; production identity cannot change. Terminal result verification reads the artifact named by `artifactFile` and checks its digest, evidence bytes and recursive predecessors. Claims, receipts and readbacks cannot be later than verification time; predecessor evidence cannot be later than its successor artifact. Failed/ambiguous evidence is retained and may support cleanup, but cannot pass an execution gate.

Export the generated public TaskAllowance and supervisor config bytes as `files/<sha256>` below the evidence root. The allowance/config FileObservations retain their original absolute target paths; their exported bytes must parse to the frozen allowance and matching private config. This convention does not export provider configuration or credentials. Export the one consumed claim into its own directory as `<operation UUID>.claim.json`. The verifier requires its bytes, full task input, host, Handler generation and allowance hash to match, and refuses another claim in that directory. Keep the claim directory export complete; a partial export does not establish exclusive execution.

Cleanup evidence contains two ordered independent readbacks for every registered expected identity/group, after command completion and before the finite cleanup deadline. Same-generation metadata drift is ambiguous. A reused PID is classified by boot/birth identity and does not authorize terminating its replacement. Unreadable groups or unknown ownership preserve the allocation. No historical root is a cleanup target.

## Historical request expectations

These values identify earlier intended targets. They are request expectations, not current observations:

- A: `qa-mydev--0377faf5627fe1339.northwest.stripe.io`, host ID `b9f5c87016af14a3038f02a031e9d5dc4e173b1b3729f34c93713e9d1378b7bf`.
- B: `qa-mydev--04e7da77c266cbac8.northwest.stripe.io`, host ID `ed5630d360d78ea58541fb727f019705ba508d1dad11f77d15a61df35db89325`.
- Remote Node: `/usr/stripe/nodenv/versions/24.13.0/bin/node`.
- Laptop Node: `/Users/moon/.nodenv/versions/24.13.0/bin/node`.

A different host or path needs a revised request. Current boot IDs, provider paths, native model offers and permission IDs must come from fresh evidence. The next live authorization can cover only the concrete read-only preflight artifact. Git review, commit, integration and activation remain independent ordinary operations.

Collector request JSON is split into arguments of at most 512 UTF-8 bytes and concatenated by the bootstrap. This avoids the observed local SIGKILL on a single long Node argument while preserving the exact request bytes. A single request argument remains accepted.