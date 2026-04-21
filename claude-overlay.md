# Claude Code

## Tool Usage

When available, prefer dedicated tools over shell commands:
- `Read` for reading files (not cat/head/tail)
- `Edit` for modifying files (not sed/awk)
- `Write` for creating files
- `Grep` for searching file contents
- `Glob` for finding files by pattern
- `Agent` for delegating complex tasks to subagents
- `TodoWrite` for tracking task progress

## Skill Invocation

Skills are invoked via the `Skill` tool with `skill: "work:<skill-name>"`:
- `work:brainstorming` — start new work (brainstorm + create project)
- `work:writing-plans` — create implementation plans within a project
- `work:executing-plans` — execute plans from any session

Before executing a plan, run the `plan-reviewer` agent (via `Agent` tool with `subagent_type: "work:plan-reviewer"`) to review it for completeness, accuracy, and risks. Share the review findings with the user before proceeding.

Before executing a plan, gather all permissions requirements and request them in a single batch.

After creating a new plan or project file, open it in neovim using `nvim-open` from the neovim skill.

## Neovim Integration

When the user asks to "open", "show", "view", or "go to" a file, invoke the `neovim` skill (via the Skill tool) and use `nvim-open` to open it in their running editor. This applies any time `$NVIM` or `$NVIM_SOCKET_PATH` is set. Do not just print the path — open it.

Similarly, use `nvim-diff` for diff/compare requests and `nvim-lua` for arbitrary neovim commands. The neovim skill provides the resolved paths to these scripts.

## External Integrations

### work-cli

Binary: `~/.dotfiles/work-cli/bin/work`

Access: `~/bin/work` symlink.

Also referenced by: `.claude/settings.local.json` (permission allowlist), `neovim/lua/sodium/plugins/agentic.lua` (work_bin variable).

### claude/ directory

- `claude/CLAUDE.md` — generated from shared base + claude overlay (do not edit directly)
- `claude/settings.json` — permissions, hooks, MCP servers
- `claude/agents/` — plan-reviewer, code-reviewer
- `claude/commands/` — note, name, archive-plans, etc.
- `claude/hooks/` — notify-on-stop.sh, session-project.sh
