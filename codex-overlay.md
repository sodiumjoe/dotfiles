# Codex CLI

## Tool Usage

Codex CLI operates primarily through shell commands. There are no dedicated file manipulation tools — use standard Unix commands:
- `cat`, `head`, `tail` for reading files
- Direct file editing via the agent's built-in capabilities
- `grep`, `rg` for searching file contents
- `find`, `fd` for finding files by pattern

## Skill Invocation

Skills are discovered from `.codex/skills/<name>/SKILL.md`. Invoke them by name when the task matches the skill description.

Available work skills:
- `brainstorming` — start new work (brainstorm + create project)
- `writing-plans` — create implementation plans within a project
- `executing-plans` — execute plans from any session

Before executing a plan, review it for completeness, accuracy, and risks.

## Limitations

The following Claude Code features are not available in Codex:
- Agents (plan-reviewer, code-reviewer) — review manually or adapt to Codex's capabilities
- Commands (/note, /name, /archive-plans, etc.) — use the `work` CLI directly
- Hooks (SessionStart, PostToolUse) — configure in config.toml if equivalents exist

## External Integrations

### work-cli

Binary: `~/.dotfiles/work-cli/bin/work`

Access: `~/bin/work` symlink.

### codex/ directory

- `codex/AGENTS.md` — generated from shared base + codex overlay (do not edit directly)
- `codex/config.toml` — model, sandbox, MCP servers, approval policy