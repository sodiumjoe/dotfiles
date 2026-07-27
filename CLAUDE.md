# Agent Instructions

Dotfiles repo. See [README.md](README.md) for repo structure, symlink strategy, environment management, and config generation.

## File References

When referring to local files, use plain repo-relative `path:line` references, e.g. `frontend/tsdep/src/commands/move-type.ts:362`. Do not use markdown file links for local file references. If a readable label helps, use `MovePlanningContext - frontend/tsdep/src/commands/move-type.ts:362`.

## Neovim Architecture and Testing

Both are documented in `shared/neovim.md`, which is concatenated into the generated global `claude/CLAUDE.md` and therefore already loaded in every session. Edit that file, not this one.

## Committing Changes

After completing a logical unit of work, commit the changes. Do not wait to be asked.

- Stage specific files by name. Do not use `git add -A` or `git add .`.
- Write concise commit messages. Match the style of recent commits in `git log --oneline -10`.
- Do not push unless explicitly asked.
- Do not commit `lazy-lock.json` unless the change was intentional (i.e. a plugin upgrade).