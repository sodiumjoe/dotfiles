This is my dotfiles repo. There are many like it but this one is mine.

## Install

```bash
xcode-select --install
cd ~
git clone --recursive https://github.com/sodiumjoe/dotfiles.git .dotfiles
cd .dotfiles
./bootstrap.sh
```

`bootstrap.sh` prompts for the environment on first run, or takes it as a flag for non-interactive use (`./bootstrap.sh --env=devbox`). It writes `~/.dotfiles-env`, generates configs, creates symlinks, and installs the pinned npm tools in `node-bin/`.

Post-install:
- `brew-sync` to install Homebrew packages (`brew.sh` is deprecated)
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

**`~/.claude` may be the repo directory.** On some machines `~/.claude` is itself a symlink to `~/.dotfiles/claude`, so every destination above collapses onto its own source. `ln -sf` in that situation silently replaces the file with a self-referential symlink and destroys the contents, which is why `bootstrap.sh` routes all of these through `bin/dotfiles-link`, which compares `readlink -f` on both sides and skips when they match (it also refuses to create a symlink to a nonexistent source). Do not replace those calls with bare `ln -sf`. The guard is covered by `test-env.sh`.

When adding new config: add the file or directory, then add it to the appropriate list in `bootstrap.sh` (`files` array for home dotfiles, `xdg_files` array for XDG configs, or a new `ln -s` for special cases).

## Environment Management

The repo serves three environments via `DOTFILES_ENV`:

| Value    | Machine      | OS    |
|----------|--------------|-------|
| `work`   | Work laptop  | macOS |
| `devbox` | Work devbox  | Linux |
| `home`   | Home laptop  | macOS |

**Identity:** `~/.dotfiles-env` declares `DOTFILES_ENV`. Created by `bootstrap.sh` on first run, or non-interactively via `./bootstrap.sh --env=devbox`. Exported by `zshenv`, defaulting to `home` if the file is missing.

Bootstrap deliberately ignores the ambient `$DOTFILES_ENV`, since `zshenv` always exports it. Trusting the variable would make the prompt unreachable and would silently re-commit a stale value whenever you delete `~/.dotfiles-env` in order to re-select.

**To switch environments:** `./bootstrap.sh --env=<name>` followed by `dotfiles-generate --reset`, then restart your shell. The `--reset` is what rewrites the mutable configs; bootstrap alone leaves an existing `settings.json` in place.

### Migrating an existing machine

A machine on pre-multi-env master has `claude/settings.json`, `codex/config.toml`, and `Brewfile` as tracked files, almost certainly with local runtime modifications. A plain `git pull` refuses to proceed over those (harmless, but stuck). The migration script handles backup, reset, pull, and re-bootstrap — but it lives in the very commits being pulled, so fetch it from origin first:

```bash
cd ~/.dotfiles
echo "DOTFILES_ENV=work" > ~/.dotfiles-env   # or devbox — BEFORE pulling, see below
git fetch origin
git show origin/master:bin/migrate-multi-env > /tmp/migrate && bash /tmp/migrate
```

Write `~/.dotfiles-env` first because the new `zshenv` defaults `DOTFILES_ENV` to `home` when the file is missing: any shell opened between pull and bootstrap on a work machine would otherwise silently load home config (no Stripe shellinit, no work aliases). Run the script from a downloaded copy, not piped into bash — it may prompt, and a piped script's stdin is the script itself.

After migration, the script prints diff commands comparing your backed-up configs against the generated ones. Actually run them: months of accumulated runtime permissions live in the old `settings.json`, and promoting them into `settings.base.json`/`settings.work.json` is a manual step.

**Devbox provisioning must be updated**: the new bootstrap deliberately ignores an ambient `DOTFILES_ENV` variable, so `DOTFILES_ENV=devbox ./bootstrap.sh` (the old contract) now fails at the interactive prompt when non-interactive. Update `.devbox-init` to call `./bootstrap.sh --env=devbox`. Bootstrap also now hard-requires `jq` (it refuses to write settings without it rather than silently dropping every overlay) — confirm the devbox image provides it.

### Config Generation

`bin/dotfiles-generate` produces config files from base + environment overlays. All per-environment decisions live in one table at the top of the script (which settings overlay, which Brewfile overlay, whether codex applies); nothing further down branches on `DOTFILES_ENV`.

Static files (always regenerated -- tools never modify them):
- `Brewfile.base` + `Brewfile.$DOTFILES_ENV` -> `Brewfile` (skipped on devbox, which declares no Brewfile, and on Linux, which has no Homebrew -- separate conditions)
- `shared/*.md` + overlay -> `claude/CLAUDE.md`, `codex/AGENTS.md`

Mutable files (generated once on first bootstrap, then hands-off -- tools modify them at runtime):
- `claude/settings.base.json` + `claude/settings.work|home.json` -> `claude/settings.json` (merged via `claude/settings-merge.jq`)
- `codex/config.base.toml` -> `codex/config.toml`

`settings-merge.jq` is a generic recursive merge: objects merge key-by-key, arrays concatenate (base first), scalars take the overlay's value. Adding a new array-valued key to the settings needs no change to the filter. Note that arrays concatenating means an overlay can only add hooks and permissions, never remove one the base declares.

Use `dotfiles-generate --reset` to force-regenerate mutable files, and `--out DIR` to generate into a scratch directory without touching the working tree.

Generation fails loudly rather than degrading: a missing `jq` or a missing overlay aborts, because writing base-only settings would silently drop every work permission, MCP server, and plugin.

### Config Drift

`bin/dotfiles-diff` shows what tools have changed in mutable configs (settings.json, config.toml) vs. what the source files would generate. It works by running `dotfiles-generate --out` into a temp directory and diffing against the live files, so drift detection stays consistent with generation by construction. Exit codes are `0` no drift, `1` drift, `2` could not check.

Codex rewrites `last_updated` and `last_revision` in its marketplace block on every refresh; those keys are stripped from both sides before diffing, and should never be committed to `config.base.toml`.

The workflow for promoting runtime changes back to source:

1. Run `dotfiles-diff` to see what changed
2. Edit the appropriate source file (base or overlay)
3. Run `dotfiles-generate --reset`

### Post-merge Hook

`hooks/post-merge` regenerates static files after `git pull` when sources changed, and runs `dotfiles-diff --quiet` to warn about drift in mutable files. Git does not run `post-merge` for rebases at all, so `git pull --rebase` skips it; run `dotfiles-generate` by hand after one.

### Conditional Symlinks

Codex config, codex skills, and work-cli are only symlinked when `DOTFILES_ENV` is `work` or `devbox`.

### Runtime Config

`zsh/.zshrc` sources `zsh/work.zsh` or `zsh/home.zsh` based on `$DOTFILES_ENV`. Neovim reads `$DOTFILES_ENV` for ACP provider selection (`codex-acp` at work, `claude-agent-acp` at home).

### Package Sync

Three lockfiles, one rule: commit them, so every environment resolves to the same versions.

- Vim plugins: `lazy-lock.json` (commit after `:Lazy update`, restore with `:Lazy restore`)
- npm tools: `node-bin/package-lock.json` (installed by `bootstrap.sh` via `npm ci`, updated by `upgrade --npm`)
- Homebrew: `brew-sync` (installs missing packages via `brew bundle --no-upgrade`; intentional upgrades via `bin/upgrade`)

`node-bin/` holds pinned npm tool binaries -- ACP providers, language servers, formatters. It is the right home for anything that has to exist on both macOS and Linux, because the Brewfile is skipped entirely on devbox. Both ACP providers (`claude-agent-acp`, `codex-acp`) live here for exactly that reason; do not add them to a Brewfile, where work and devbox would end up on different implementations.

`zsh/.zshrc` prepends `node-bin/node_modules/.bin` to `PATH` *after* `nodenv init`, which prepends its own shims. Appending instead would let stray `npm install -g` copies shadow the pinned versions.

### Testing

`test-env.sh` generates configs for all three environments and validates key properties (work-only permissions aren't in home, stripe plugins aren't in home, base hooks survive the overlay merge, Brewfile contents match environment, invalid environments are rejected). It generates into a temp directory via `dotfiles-generate --out` and never touches the working tree -- an earlier version deleted the live `claude/settings.json`, which is the file a running Claude Code process reads and rewrites.

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

Code review workflow:
- `work review enter-pr <n>` -- check out PR n for review and write session state under `.review/`
- `work review submit <EVENT> [body]` -- submit a PR review and exit the session
- `work review exit` -- restore the previous branch/stash and remove review session state

PR review recovery state lives in `.review/session.json`, which is written before checkout or stash mutation. `work review exit` is session-driven and idempotent; rerun it to recover branch/stash state after an interrupted review.

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