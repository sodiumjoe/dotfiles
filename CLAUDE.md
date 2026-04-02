# Agent Instructions

Dotfiles repo. Manages shell, neovim, tmux, git, and other tool configs via symlinks. Install with `./bootstrap.sh`.

## Symlink Strategy

`bootstrap.sh` creates symlinks in two categories:

**Root files** → `~/.<file>`: `curlrc`, `cvimrc`, `gitconfig`, `ignore`, `inputrc`, `zshenv`

**XDG directories** → `~/.config/<dir>`: `alacritty`, `ghostty`, `hammerspoon`, `karabiner`, `rg`, `tmux`, `vivid`, `work`, `zsh`

**Special cases:**
- `init.lua` → `~/.config/nvim/init.lua`
- `tmux/tmux.conf` → `~/.tmux.conf`
- `claude/settings.json` → `~/.claude/settings.json`
- `claude/hooks/*` → `~/.claude/hooks/*`
- `claude/agents/*` → `~/.claude/agents/*`
- `claude/commands/*` → `~/.claude/commands/*`
- `skills/*/` → `~/.claude/skills/*/` AND `~/.codex/skills/*/`
- `codex/config.toml` → `~/.codex/config.toml`
- `work-cli/bin/work` → `~/bin/work`
- `bin/*` → `~/bin/*`

**Generated files** (by `bootstrap.sh`, not edited directly):
- `claude/CLAUDE.md` → `~/.claude/CLAUDE.md` (from `shared/*.md` + `claude-overlay.md`)
- `codex/AGENTS.md` → `~/.codex/AGENTS.md` (from `shared/*.md` + `codex-overlay.md`)

**Not symlinked:** `stripe-gitconfig` (included via gitconfig `[include]`)

When adding new config: add the file or directory, then add it to the appropriate list in `bootstrap.sh` (`files` array for home dotfiles, `xdg_files` array for XDG configs, or a new `ln -s` for special cases).

## Agent Instruction Architecture

Both Claude Code and Codex CLI receive instructions generated from a shared base with agent-specific overlays:

```
shared/base-instructions.md  ─┐
shared/work-tracking.md      ─┼─→ claude/CLAUDE.md  (+ claude-overlay.md)
shared/neovim.md             ─┤
                              └─→ codex/AGENTS.md   (+ codex-overlay.md)
```

`bootstrap.sh` runs the concatenation before creating symlinks. The generated files are gitignored — edit the source files in `shared/` or the overlay files, never the generated output.

`shared/` contains agent-agnostic content: communication style, code conventions, work tracking, neovim context. The overlay files contain agent-specific tool references and skill invocation syntax.

## Skills

Skills live in `skills/` at the repo root and symlink to both `~/.claude/skills/` and `~/.codex/skills/`. Each skill is a directory containing `SKILL.md` (with optional supporting files and scripts).

Skills forked from the Stripe internal marketplace (`superpowers` plugin) have upstream tracking metadata in their frontmatter (`plugin`, `version`, `content_hash`). Run `work check-upstream` to detect drift against the marketplace repo clone at `~/.claude/plugins/marketplaces/stripe-internal-marketplace/`.

## Neovim Architecture

Entry point: `init.lua` (repo root). Bootstraps lazy.nvim with interleaved loading:

1. `sodium.config.options`, `sodium.config.diagnostics` — before plugins
2. `lazy.setup({ import = "sodium.plugins" })` — plugin specs
3. `sodium.config.autocmds`, `sodium.config.keymaps` — after plugins
4. `sodium.config.stripe` — conditional, only in stripe repos

**Config modules** (`neovim/lua/sodium/config/`): `options`, `keymaps`, `autocmds`, `diagnostics`, `colorscheme`, `stripe`

**Plugin specs** (`neovim/lua/sodium/plugins/`): one file per feature category, each returns a lazy.nvim spec table or array of tables. Lazy.nvim auto-imports the directory.

**Grouped plugins**: subdirectory with `init.lua` that requires and returns individual specs (see `plugins/lsp/`).

**Extracted modules** (pure functions, testable independently):
- `neovim/lua/sodium/markdown.lua` — markdown list prefix parsing (`get_list_prefix`, `has_text_after_prefix`)
- `neovim/lua/sodium/agentic_utils.lua` — task parsing, slugify, state cycle tables
- `neovim/lua/sodium/utils.lua` — keymaps, augroups, path checks, etc.

**Lockfile**: `lazy-lock.json` (repo root)

## Testing

Runner: `./test-nvim.sh` (plenary.nvim busted harness, headless). Run single file: `./test-nvim.sh neovim/tests/markdown_spec.lua`.

Test files live in `neovim/tests/`. `minimal_init.lua` bootstraps the subprocess with all lazy plugin paths on rtp.

**Unit tests**: `markdown_spec`, `agentic_functions_spec`, `utils_spec`, `statusline_spec` — pure function tests for extracted modules.

**Behavioral tests**: `cursor_restore_spec`, `quickfix_spec`, `markdown_behavior_spec`, `colorscheme_spec` — test autocmds and buffer-local keymaps.

**Registry tests**: `keymaps_spec` (core + plugin keymap declarations), `plugins_spec` (all expected plugins declared in specs).

**Planning requirement**: every implementation plan that touches neovim code must include a testing section. Decide which category applies and describe what tests to add:
- New extracted module or pure function → unit tests
- New autocmd, keymap callback, or window behavior → behavioral test
- New keymap declaration or plugin spec → registry test entry
- If the change is untestable in headless plenary (e.g. requires interactive UI, external plugin runtime), state why explicitly

Caveats:
- Plenary subprocess doesn't fully initialize lazy.nvim plugins. Tests that need plugin side-effects (e.g. colorscheme augroups) must call the config function directly or `require` the spec module.
- Insert-mode `feedkeys` is unreliable in headless. CR continuation tests invoke the callback directly from the buffer-local keymap table.
- Window state leaks between tests in plenary. Create scratch buffers with `nvim_create_buf(false, true)` and delete them with `nvim_buf_delete(buf, { force = true })` in each test. Do not rely on `before_each`/`after_each` for window cleanup.
- To test a local function from a plugin spec, extract the callback via the spec's `keys` table (e.g. find the entry matching the keymap lhs and call its function directly).

## External Integrations

### work-cli

Location: `~/.dotfiles/work-cli/`

Binary: `~/.dotfiles/work-cli/bin/work`

Access: `~/bin/work` symlink, hardcoded full path in `neovim/lua/sodium/plugins/agentic.lua` (work_bin variable).

Also referenced by: `.claude/settings.local.json` (permission allowlist).

Neovim keybindings:
- `<leader>ap` — pick task from work queue
- `<leader>aP` — create new project
- `<leader>at` — add task to project

Work vault: `~/stripe/work/` (configured in `work/config.json`).

### claude/ and codex/

- `claude/CLAUDE.md` — generated from `shared/*.md` + `claude-overlay.md` (do not edit directly)
- `claude/settings.json` → `~/.claude/settings.json` (permissions, hooks, MCP servers)
- `claude/agents/` — plan-reviewer, code-reviewer (Claude-only, no Codex equivalent)
- `claude/commands/` — note, name, archive-plans, etc. (Claude-only)
- `claude/hooks/` — notify-on-stop.sh, session-project.sh
- `codex/AGENTS.md` — generated from `shared/*.md` + `codex-overlay.md` (do not edit directly)
- `codex/config.toml` → `~/.codex/config.toml` (model, sandbox, MCP)
- Project-specific overrides in `.claude/settings.local.json`

### devbox

Devbox initialization clones this repo and runs `bootstrap.sh`, which sets up everything: work-cli symlink, skills, agents, commands, hooks, generated instruction files. The `_devbox_sync_push` function in `zsh/.zshrc` rsyncs `work-cli/` and project files on connect; `_devbox_sync_pull` syncs project changes back on disconnect.

## Committing Changes

After completing a logical unit of work, commit the changes. Do not wait to be asked.

- Stage specific files by name. Do not use `git add -A` or `git add .`.
- Write concise commit messages. Match the style of recent commits in `git log --oneline -10`.
- Do not push unless explicitly asked.
- Do not commit `lazy-lock.json` unless the change was intentional (i.e. a plugin upgrade).