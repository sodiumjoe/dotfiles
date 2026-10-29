# Codex CLI

## Tool Usage

Use the tools exposed by the current session. Prefer `rg` for shell searches and the available patch or editing tools for file changes. Tool availability varies between Codex clients; do not assume a capability is absent because an older client lacked it.

## Skill Invocation

Skills are discovered from `home/.agents/skills/<name>/SKILL.md`. Invoke them by name when the task matches the skill description.

Available work skills:
- `brainstorming` — start new work (brainstorm + create project)
- `writing-plans` — create implementation plans within a project
- `executing-plans` — execute plans from any session

Before executing a plan, review it for completeness, accuracy, and risks.

## Client-specific capabilities

Claude command names and agent definitions are not automatically available in Codex. Use `work` for work-tracking operations. For review or delegation, follow the shared workflow and the tools actually available in this session. If a required capability is unavailable, state the limitation and use an appropriate local alternative.

## External Integrations

### work-cli

Binary: `~/bin/work`

### Deployed agent files

- `home/.codex/AGENTS.md` — generated from shared base + codex overlay (do not edit directly)
- `home/.codex/config.toml` — model, sandbox, MCP servers, approval policy
- `home/.agents/skills/` — canonical shared skills