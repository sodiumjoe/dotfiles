This is my dotfiles repo. There are many like it but this one is mine.

## Install

```bash
xcode-select --install
cd ~
git clone --recursive https://github.com/sodiumjoe/dotfiles.git .dotfiles
cd .dotfiles
./bootstrap.sh
```

`bootstrap.sh` prompts for the environment on first run, or takes it as a flag for non-interactive use (`./bootstrap.sh --env=devbox`). It stages prospective generated configs and checks every deployment destination before publishing the configs, reconciling symlinks, and writing `~/.dotfiles-env`. A failed preflight leaves the existing environment identity, canonical generated files, and live links unchanged. Bootstrap then installs the pinned npm tools in `node-bin/`.

Post-install:
- `brew-sync` to install Homebrew packages (`brew.sh` is deprecated)
- `./macos` to apply macOS defaults
- FileVault, caps-lock-to-ctrl, generate SSH keys, [rustup](https://www.rustup.rs/)

## Deployed-home model

- Template inputs remain outside `home/`.
- `home/` contains deployed content and ignored generated outputs.
- Bootstrap creates real directories and relative file links.
- `.agents/skills` is canonical; Claude aliases individual skills; Codex reads `.agents/skills` directly.
- Runtime roots remain outside the repository.
- Legacy ignored runtime state is not migrated.

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
git show origin/master:home/bin/migrate-multi-env > /tmp/migrate && bash /tmp/migrate
```

Write `~/.dotfiles-env` first because the new `zshenv` defaults `DOTFILES_ENV` to `home` when the file is missing: any shell opened between pull and bootstrap on a work machine would otherwise silently load home config (no Stripe shellinit, no work aliases). Run the script from a downloaded copy, not piped into bash — it may prompt, and a piped script's stdin is the script itself.

The script backs up dirty tracked configs from both the legacy `claude/` and `codex/` paths and the current `home/.claude/` and `home/.codex/` paths, including staged changes, before resetting those files and pulling. After migration, it prints diff commands comparing the backups with the canonical generated outputs under `home/`. Run those commands: accumulated runtime permissions in the old `settings.json` must be promoted into `claude/settings.base.json` or `claude/settings.work.json` manually.

**Devbox provisioning must be updated**: the new bootstrap deliberately ignores an ambient `DOTFILES_ENV` variable, so `DOTFILES_ENV=devbox ./bootstrap.sh` (the old contract) now fails at the interactive prompt when non-interactive. Update `.devbox-init` to call `./bootstrap.sh --env=devbox`. Bootstrap also now hard-requires `jq` (it refuses to write settings without it rather than silently dropping every overlay) — confirm the devbox image provides it.

### Config Generation

`home/bin/dotfiles-generate` produces config files from base + environment overlays. All per-environment decisions live in one table at the top of the script (which settings overlay, which Brewfile overlay, whether codex applies); nothing further down branches on `DOTFILES_ENV`.

Static files (always regenerated -- tools never modify them):
- `Brewfile.base` + `Brewfile.$DOTFILES_ENV` -> `Brewfile` (skipped on devbox, which declares no Brewfile, and on Linux, which has no Homebrew -- separate conditions)
- `shared/*.md` + overlay -> `home/.claude/CLAUDE.md`, `home/.codex/AGENTS.md`

Mutable files (generated once on first bootstrap, then hands-off -- tools modify them at runtime):
- `claude/settings.base.json` + `claude/settings.work|home.json` -> `home/.claude/settings.json` (merged via `claude/settings-merge.jq`)
- `codex/config.base.toml` -> `home/.codex/config.toml`

`settings-merge.jq` is a generic recursive merge: objects merge key-by-key, arrays concatenate (base first), scalars take the overlay's value. Adding a new array-valued key to the settings needs no change to the filter. Note that arrays concatenating means an overlay can only add hooks and permissions, never remove one the base declares.

Use `dotfiles-generate --reset` to force-regenerate mutable files, and `--out DIR` to generate into a scratch directory without touching the working tree. Scratch output includes `Brewfile` on macOS; bootstrap publishes it at the repository root, never into the deployed home tree.

Generation fails loudly rather than degrading: a missing `jq` or a missing overlay aborts, because writing base-only settings would silently drop every work permission, MCP server, and plugin.

### Config Drift

`home/bin/dotfiles-diff` shows what tools have changed in mutable configs (settings.json, config.toml) vs. what the source files would generate. It works by running `dotfiles-generate --out` into a temp directory and diffing against the canonical files under `home/`, so drift detection stays consistent with generation by construction. Exit codes are `0` no drift, `1` drift, `2` could not check.

Codex rewrites `last_updated` and `last_revision` in its marketplace block on every refresh; those keys are stripped from both sides before diffing, and should never be committed to `config.base.toml`.

The workflow for promoting runtime changes back to source:

1. Run `dotfiles-diff` to see what changed
2. Edit the appropriate source file (base or overlay)
3. Run `dotfiles-generate --reset`

### Post-merge Hook

`hooks/post-merge` regenerates static files after `git pull` when sources changed, and runs `dotfiles-diff --quiet` to warn about drift in mutable files. Git does not run `post-merge` for rebases at all, so `git pull --rebase` skips it; run `dotfiles-generate` by hand after one.

### Conditional Symlinks

Codex instructions, Codex config, and work-cli are only symlinked when `DOTFILES_ENV` is `work` or `devbox`. Skills are deployed under `~/.agents/skills` in every environment, with individual Claude aliases under `~/.claude/skills`. Codex reads the shared skill directory directly.

### Runtime Config

`home/.config/zsh/.zshrc` sources `work.zsh` or `home.zsh` from the same directory based on `$DOTFILES_ENV`. Neovim reads `$DOTFILES_ENV` for ACP provider selection (`codex-acp` at work, `claude-agent-acp` at home).

### Package Sync

Three lockfiles, one rule: commit them, so every environment resolves to the same versions.

- Vim plugins: `lazy-lock.json` (commit after `:Lazy update`, restore with `:Lazy restore`)
- npm tools: `node-bin/package-lock.json` (installed by `bootstrap.sh` via `npm ci`, updated by `upgrade --npm`)
- Homebrew: `brew-sync` (installs missing packages via `brew bundle --no-upgrade`; intentional upgrades via `home/bin/upgrade`)

`node-bin/` holds pinned npm tool binaries -- ACP providers, language servers, formatters. It is the right home for anything that has to exist on both macOS and Linux, because the Brewfile is skipped entirely on devbox. Both ACP providers (`claude-agent-acp`, `codex-acp`) live here for exactly that reason; do not add them to a Brewfile, where work and devbox would end up on different implementations.

`node-bin/bin` is generated from direct dependencies only by `npm run sync-bins --prefix node-bin`. Use that directory on `PATH`, not `node-bin/node_modules/.bin`, because npm exposes transitive dependency binaries there.

### Testing

`test-env.sh` generates configs for all three environments and validates key properties (work-only permissions aren't in home, stripe plugins aren't in home, base hooks survive the overlay merge, Brewfile contents match environment, invalid environments are rejected). It also runs `test-home-reconcile.py` and `test-bootstrap.py`, which cover read-only preflight, failed transitions, mutable-config preservation, and migration from a dirty legacy checkout. These tests use temporary output trees and local Git fixtures; they do not modify live configuration or install packages.

## Agent Instruction Architecture

Both Claude Code and Codex CLI receive instructions generated from a shared base with agent-specific overlays:

```
shared/base-instructions.md  --+
shared/work-tracking.md      --+--> home/.claude/CLAUDE.md  (+ shared/neovim.md + claude-overlay.md)
                               |
                                `--> home/.codex/AGENTS.md   (+ codex-overlay.md)
```

`shared/neovim.md` is included only in `home/.claude/CLAUDE.md` (not AGENTS.md). AGENTS.md is generated only for `work` and `devbox` environments.

`dotfiles-generate` concatenates these on every run. The generated files are gitignored -- edit the source files in `shared/` or the overlay files, never the generated output.

`shared/` contains agent-agnostic content: communication style, code conventions, work tracking. The overlay files contain agent-specific tool references and skill invocation syntax.

## Skills

Skills live in `home/.agents/skills/` and deploy to `~/.agents/skills/`. Claude aliases each skill through `home/.claude/skills/`; Codex uses `~/.agents/skills/` directly. Each skill is a directory containing `SKILL.md` (with optional supporting files and scripts).

## External Integrations

### work-cli

Location: `~/.dotfiles/work-cli/`; binary at `work-cli/bin/work`, symlinked to `~/bin/work`. Also referenced by `.claude/settings.local.json` (permission allowlist) and `neovim/lua/sodium/plugins/agentic.lua` (work_bin variable).

Work vault: `~/stripe/work/` (configured in `home/.config/work/config.json`).

Neovim keybindings: `<leader>ap` (pick task), `<leader>aP` (create project), `<leader>at` (add task).

Code review workflow:
- `work review enter-pr <n>` -- check out PR n for review and write session state under `.review/`
- `work review submit <EVENT> [body]` -- submit a PR review and exit the session
- `work review exit` -- restore the previous branch/stash and remove review session state

PR review recovery state lives in `.review/session.json`, which is written before checkout or stash mutation. `work review exit` is session-driven and idempotent; rerun it to recover branch/stash state after an interrupted review.

### Claude and Codex

- `home/.claude/CLAUDE.md` -- generated (do not edit directly)
- `home/.claude/settings.json` -> `~/.claude/settings.json` (permissions, hooks, MCP servers)
- `claude/settings-merge.jq` -- jq filter for merging base + overlay settings
- `home/.claude/agents/` -- plan-reviewer, code-reviewer (Claude-only)
- `home/.claude/commands/` -- note, name, archive-plans, etc. (Claude-only)
- `home/.claude/hooks/` -- notify-on-idle.sh, notify-on-stop.sh, repro-stop-hook.sh, session-project.sh
- `home/.codex/AGENTS.md` -- generated (do not edit directly)
- `home/.codex/config.toml` -> `~/.codex/config.toml` (model, sandbox, MCP)
- `claude/` and `codex/` -- template inputs for generated settings and config
- Project-specific overrides in `.claude/settings.local.json`

### devbox

Devbox initialization clones this repo and runs `bootstrap.sh`, which sets up everything: work-cli symlink, skills, agents, commands, hooks, generated instruction files. The `_devbox_sync` function in `home/.config/zsh/.zshrc` syncs `~/stripe/work/` bidirectionally via Unison on connect and disconnect, and `_devbox_sync_loop` maintains a persistent 5-second polling loop during active SSH sessions.

## Update

- `zimfw update` / `zimfw upgrade`
- `brew-sync` (incremental) or `home/bin/upgrade` (full upgrade)
- `vivid generate sodium`
- `fast-theme home/.config/zsh/sodium`
