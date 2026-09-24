# Codex Tool Mapping

Skills speak in actions; Codex tool names vary by harness and release, so
the actual tool list is authoritative. The common mappings are:

| Action skills request | Codex equivalent |
|----------------------|------------------|
| Read or search files | Shell execution with `rg`, `sed`, `head`, or `tail` |
| Create, edit, or delete a file | `apply_patch` |
| Run a shell command | The harness's shell execution tool |
| Search the web | `web_search`, when available |
| Invoke a skill | Load and follow the matching `SKILL.md` through the harness's skill mechanism |
| Dispatch a subagent | `spawn_agent` |
| Resume a subagent | `followup_task` |
| Wait for subagent activity | `wait_agent` |
| Inspect live subagents | `list_agents` |
| Task tracking | The harness's plan or todo tool, when available |

## Instructions file

When a skill mentions "your instructions file", on Codex this is
**`AGENTS.md`**. Codex also reads `~/.codex/AGENTS.md` for global context,
and an `AGENTS.override.md` takes precedence when present. It walks from the
project root to the current working directory and combines the applicable
instruction files.

## Personal skills directory

User-level skills live at **`$CODEX_HOME/skills/`** (default
`~/.codex/skills/`). Codex also reads **`~/.agents/skills/`** as a
cross-runtime catalog. Each skill is a subdirectory containing a `SKILL.md`
and optional support files.

## Subagent dispatch requires multi-agent support

Add to your Codex config (`~/.codex/config.toml`):

```toml
[features]
multi_agent = true
```

This enables the multi-agent tools that skills like
`dispatching-parallel-agents` and `subagent-driven-development` use.
Which tools you get depends on the multi-agent version your model
preset selects (current presets run V2; older ones run V1). Trust your
actual tool list over any table — including this one — when they
disagree.

- **Spawning:** give children a clean context with
  `spawn_agent {fork_turns: "none"}`; the default `"all"` copies your
  entire transcript into the child. A full-history fork inherits the
  parent's model and reasoning effort and rejects `model` and
  `reasoning_effort` overrides. To override either value, set `fork_turns`
  to `"none"` or a positive bounded-history value and set both values
  deliberately. On Codex 0.145+, role files under `~/.codex/agents/`
  attach to isolated forks via `agent_type`.
- **Fix rounds:** resume the implementer with `followup_task` — it
  delivers your message, triggers a turn, and transparently reloads a
  child the harness evicted. Never dispatch a fresh implementer on the
  theory that a spawned agent cannot be messaged again; on V2 it
  always can.
- **Lifecycle:** V2 has no `close_agent`. Finished children are
  evicted automatically when slots are needed; leaving them unclosed
  costs nothing. Only V1 sessions have `close_agent` — there, close
  reviewers when their review returns, and close each implementer
  after its task's review passes.
- **Model names:** never copy a model name from a skill, table, or old
  session into `spawn_agent` without checking it against your current
  spawn allowlist — V2 accepts only V2-capable presets and hard-errors
  on the rest.

## Waiting on children

`wait_agent` is an event subscription, not a poll: a long wait wakes
the moment a child produces mailbox activity, with the same latency as
a short one. Short-timeout polling buys nothing and costs a tool call —
and a context rebill — per poll. In measured sessions, roughly
two-thirds of all wait calls were short polls that timed out.

- While you still have local work, do not wait at all. A completed
  child's final answer is pushed into your mailbox and arrives with
  your next turn.
- When you are genuinely idle with children outstanding, wait in
  bounded stretches: `wait_agent` with `timeout_ms` 300000-600000
  (5-10 minutes). After each stretch — wake or timeout — post one
  status line, run `list_agents`, and chase any child that finished
  without reporting. Never stack polls shorter than five minutes; the
  event subscription wakes a bounded stretch just as fast as a short
  one.
- Completion mail cannot wake an idle controller (it is delivered
  without triggering a turn); covering that idle window is
  `wait_agent`'s only job. A stretch that times out with no activity
  is your cue to reconcile, not to shorten the next stretch.

## Model routing on spawns

When a child needs different routing from its parent, every `spawn_agent`
you issue — including from a spawned child running a fan-out — uses
`fork_turns: "none"` or a positive bounded-history value and sets `model`
AND `reasoning_effort` explicitly, per the Model Selection rules of the
skill you are executing. Setting `model` alone is a trap: the child's
effort silently resets to that model's default, not to yours. With
`fork_turns: "all"`, omit both overrides and accept the inherited routing.

Ask your human partner to add a machine-level backstop to
`~/.codex/config.toml` so any spawn that slips through still routes to
a deliberate tier instead of silently inheriting the session's most
expensive model:

```toml
[agents]
default_subagent_model = "<a mid-tier model from your spawn allowlist>"
default_subagent_reasoning_effort = "medium"
```

## Environment Detection

Skills that create worktrees or finish branches should detect their
environment with read-only git commands before proceeding:

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
```

- `GIT_DIR != GIT_COMMON` → already in a linked worktree (skip creation)
- `BRANCH` empty → detached HEAD (cannot branch/push/PR from sandbox)

See `using-git-worktrees` Step 0 and `finishing-a-development-branch`
Step 1 for how each skill uses these signals.

## Codex App Finishing

When the sandbox blocks branch/push operations (detached HEAD in an
externally managed worktree), the agent commits all work and informs
the user to use the App's native controls:

- **"Create branch"** — names the branch, then commit/push/PR via App UI
- **"Hand off to local"** — transfers work to the user's local checkout

The agent can still run tests, stage files, and output suggested branch
names, commit messages, and PR descriptions for the user to copy.