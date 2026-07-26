This is my dotfiles repo. There are many like it but this one is mine.

## Install

```bash
xcode-select --install
cd ~
git clone --recursive https://github.com/sodiumjoe/dotfiles.git .dotfiles
cd .dotfiles
./bootstrap.sh
```

`bootstrap.sh` prompts for the environment on first run (or accept `DOTFILES_ENV` from the environment for non-interactive use, e.g. `DOTFILES_ENV=devbox ./bootstrap.sh`). It writes `~/.dotfiles-env`, generates configs, and creates symlinks.

Post-install:
- `./brew.sh` to install Homebrew packages (or `brew-sync` for incremental installs)
- `./macos` to apply macOS defaults
- FileVault, caps-lock-to-ctrl, generate SSH keys, [rustup](https://www.rustup.rs/)

## Symlink Strategy

`bootstrap.sh` creates symlinks in two categories:

**Root files** -> `~/.<file>`: `curlrc`, `cvimrc`, `gitconfig`, `ignore`, `inputrc`, `zshenv`

**XDG directories** -> `~/.config/<dir>`: `alacritty`, `efm-langserver`, `ghostty`, `hammerspoon`, `karabiner`, `rg`, `tmux`, `vivid`, `work`, `zsh`

**Special cases:**
- `init.lua` -> `~/.config/nvim/init.lua`
- `tmux/tmux.conf` -> `~/.tmux.conf`
- `claude/settings.json` -> `~/.claude/settings.json` (generated, see below)
- `claude/hooks/*` -> `~/.claude/hooks/*`
- `claude/agents/*` -> `~/.claude/agents/*`
- `claude/commands/*` -> `~/.claude/commands/*`
- `skills/*/` -> `~/.claude/skills/*/` (and `~/.codex/skills/*/` on `work`/`devbox`)
- `codex/config.toml` -> `~/.codex/config.toml` (`work`/`devbox` only)
- `work-cli/bin/work` -> `~/bin/work` (`work`/`devbox` only)
- `bin/*` -> `~/bin/*`

**Not symlinked:** `stripe-gitconfig` (included via gitconfig `[include]`)

When adding new config: add the file or directory, then add it to the appropriate list in `bootstrap.sh` (`files` array for home dotfiles, `xdg_files` array for XDG configs, or a new `ln -s` for special cases).

## Environment Management

The repo serves three environments via `DOTFILES_ENV`:

| Value    | Machine      | OS    |
|----------|--------------|-------|
| `work`   | Work laptop  | macOS |
| `devbox` | Work devbox  | Linux |
| `home`   | Home laptop  | macOS |

**Identity:** `~/.dotfiles-env` declares `DOTFILES_ENV`. Created by `bootstrap.sh` on first run (or set via env var for non-interactive use: `DOTFILES_ENV=devbox ./bootstrap.sh`). Exported by `zshenv`. Defaults to `home` if missing.

### Config Generation

`bin/dotfiles-generate` produces config files from base + environment overlays. It distinguishes two categories:

Static files (always regenerated -- tools never modify them):
- `Brewfile.base` + `Brewfile.$DOTFILES_ENV` -> `Brewfile` (macOS only, skipped on devbox)
- `shared/*.md` + overlay -> `claude/CLAUDE.md`, `codex/AGENTS.md`

Mutable files (generated once on first bootstrap, then hands-off -- tools modify them at runtime):
- `claude/settings.base.json` + `claude/settings.work|home.json` -> `claude/settings.json` (merged via `claude/settings-merge.jq`)
- `codex/config.base.toml` -> `codex/config.toml`

Use `dotfiles-generate --reset` to force-regenerate mutable files.

### Config Drift

`bin/dotfiles-diff` shows what tools have changed in mutable configs (settings.json, config.toml) vs. what the source files would generate. The workflow for promoting runtime changes back to source:

1. Run `dotfiles-diff` to see what changed
2. Edit the appropriate source file (base or overlay)
3. Run `dotfiles-generate --reset`

### Post-merge Hook

`hooks/post-merge` regenerates static files after `git pull` when sources changed, and runs `dotfiles-diff --quiet` to warn about drift in mutable files. Does not fire on `git pull --rebase` (uses `ORIG_HEAD`, which rebase doesn't set).

### Conditional Symlinks

Codex config, codex skills, and work-cli are only symlinked when `DOTFILES_ENV` is `work` or `devbox`.

### Runtime Config

`zsh/.zshrc` sources `zsh/work.zsh` or `zsh/home.zsh` based on `$DOTFILES_ENV`. Neovim reads `$DOTFILES_ENV` for ACP provider selection (`codex-acp` at work, `claude-agent-acp` at home).

### Package Sync

- Vim plugins: `lazy-lock.json` (commit after `:Lazy update`, restore with `:Lazy restore`)
- Homebrew: `brew-sync` (installs missing packages via `brew bundle --no-upgrade`; intentional upgrades via `bin/upgrade`)

### Testing

`test-env.sh` generates configs for all three environments and validates key properties (work-only permissions aren't in home, stripe plugins aren't in home, Brewfile contents match environment, etc.). Run from the repo root; it restores the current environment's configs when done.

## Agent Instruction Architecture

Both Claude Code and Codex CLI receive instructions generated from a shared base with agent-specific overlays:

```
shared/base-instructions.md  --+
shared/work-tracking.md      --+--> claude/CLAUDE.md  (+ shared/neovim.md + claude-overlay.md)
                               |
                                `--> codex/AGENTS.md   (+ codex-overlay.md)
```

`shared/neovim.md` is included only in `claude/CLAUDE.md` (not AGENTS.md). AGENTS.md is generated only for `work` and `devbox` environments.

`dotfiles-generate` concatenates these on every run. The generated files are gitignored -- edit the source files in `shared/` or the overlay files, never the generated output.

`shared/` contains agent-agnostic content: communication style, code conventions, work tracking. The overlay files contain agent-specific tool references and skill invocation syntax.

## Skills

Skills live in `skills/` at the repo root and symlink to both `~/.claude/skills/` and `~/.codex/skills/`. Each skill is a directory containing `SKILL.md` (with optional supporting files and scripts).

## External Integrations

### work-cli

Location: `~/.dotfiles/work-cli/`; binary at `work-cli/bin/work`, symlinked to `~/bin/work`. Also referenced by `.claude/settings.local.json` (permission allowlist) and `neovim/lua/sodium/plugins/agentic.lua` (work_bin variable).

Work vault: `~/stripe/work/` (configured in `work/config.json`).

Neovim keybindings: `<leader>ap` (pick task), `<leader>aP` (create project), `<leader>at` (add task).

### claude/ and codex/

- `claude/CLAUDE.md` -- generated (do not edit directly)
- `claude/settings.json` -> `~/.claude/settings.json` (permissions, hooks, MCP servers)
- `claude/settings-merge.jq` -- jq filter for merging base + overlay settings
- `claude/agents/` -- plan-reviewer, code-reviewer (Claude-only)
- `claude/commands/` -- note, name, archive-plans, etc. (Claude-only)
- `claude/hooks/` -- notify-on-idle.sh, notify-on-stop.sh, repro-stop-hook.sh, session-project.sh
- `codex/AGENTS.md` -- generated (do not edit directly)
- `codex/config.toml` -> `~/.codex/config.toml` (model, sandbox, MCP)
- Project-specific overrides in `.claude/settings.local.json`

### devbox

Devbox initialization clones this repo and runs `bootstrap.sh`, which sets up everything: work-cli symlink, skills, agents, commands, hooks, generated instruction files. The `_devbox_sync` function in `zsh/.zshrc` syncs `~/stripe/work/` bidirectionally via Unison on connect and disconnect, and `_devbox_sync_loop` maintains a persistent 5-second polling loop during active SSH sessions.

## Update

- `zimfw update` / `zimfw upgrade`
- `brew-sync` (incremental) or `bin/upgrade` (full upgrade)
- `vivid generate sodium`
- `fast-theme zsh/sodium`