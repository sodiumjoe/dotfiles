# Agent Instructions

## Repository Links

### personal-marketplace

Location: `~/stripe/work/personal-marketplace/work/bin/work`

Integration: Hard-coded filesystem path (not git submodule or symlink)

Used by:
- neovim/lua/sodium/plugins/agentic.lua:1 (work_bin variable)
- .claude/settings.local.json:34-65 (permission allowlist)
- launchd/com.moon.work-tick.plist:9 (via ~/bin/work symlink)

Provides work management CLI. Neovim keybindings:
- `<leader>ap` — pick task from work queue
- `<leader>aP` — create new project
- `<leader>at` — add task to project

Background sync: launchd runs `work tick` hourly to maintain work state.

Work vault configured at `~/stripe/work` (see work/config.json).

### devbox

Referenced in: zsh/.p10k.zsh:851 (prompt context)

Integration: Shell prompt displays devbox context when in remote development environment. No other filesystem integration.

## Changelog Maintenance

When completing work in this repository, maintain changelog entries per CLAUDE.md guidelines.

Format: `- [x] Description ✅ YYYY-MM-DD`

Location depends on context:
- If working under a project: update project file's `## Changelog` section
- If working standalone: update plan file's `## Changelog` section

Use `work complete <file> <description>` command (not manual editing):
- Marks item complete in source file
- Adds entry to daily note log with metadata
- Handles project/plan context automatically

Example:
```bash
work complete ~/stripe/work/projects/dotfiles.md "Document agent integration"
```

Do not call `work check-off` or `work append-log` separately. Always use `work complete`.

## Integration Notes

Repository acts as configuration hub:
- Symlinks configs via bootstrap.sh to `$XDG_CONFIG_HOME` and `~/`
- Integrates with personal-marketplace through filesystem paths
- Runs background sync via launchd
- Provides neovim keybindings for work CLI access

No git submodules or version control relationship with external repos. All integration is through shell commands and file paths.