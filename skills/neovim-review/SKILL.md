---
name: neovim-review
description: Use when the user invokes /neovim-review for a pull request or a local :Review session in Neovim.
allowed-tools: Bash
---

# Neovim Review

Provide judgment and explanation while the user reviews files in Neovim. Determine the mode from the invocation before inspecting changes.

## Quick reference

| Invocation | Mechanics | Coverage source |
| --- | --- | --- |
| `/neovim-review <number>` | `work review enter-pr` | `.review/files` |
| `/neovim-review self <base>` | Read-only Git inspection | Git diff plus untracked files |

## Entry modes

### Pull request

For `/neovim-review <number>`, run:

    work review enter-pr <number>

The command returns `{ mode, id, base_ref, head_ref, toplevel }`. Report an `error` response and stop. Read `<toplevel>/.review/commits`, `<toplevel>/.review/diff`, and `<toplevel>/.review/files`.

### Self-review

For `/neovim-review self <merge-base>`, do not run `work review`, check out a ref, or mutate Git state. Inspect with:

    git rev-parse --show-toplevel
    git rev-parse --verify '<merge-base>^{commit}'
    git log --format='%h %s' <merge-base>..HEAD
    git diff --no-renames <merge-base>
    git diff --no-renames --name-only <merge-base>
    git ls-files --others --exclude-standard

Read every untracked file because it has no Git diff. The tracked and untracked file lists together form the coverage manifest.

Any other invocation is invalid. Report `Usage: /neovim-review <number> | /neovim-review self <merge-base>` and stop.

## Analysis contract

Return one complete overview organized by logical concern, not review order. For each concern, state its intent, behavior change, involved files, important implementation details, cross-file relationships, and suspected defects or regression risks. Identify missing or inadequate tests. Use `path:line` references where a specific line matters.

Every file in the coverage manifest must appear under a concern. End with a separate `Issues` section ordered by severity. State `No issues identified` when appropriate. Then wait for questions; do not open files or mark them reviewed.

Example shape:

    ## Concern: Request validation
    Intent: Reject malformed input before persistence.
    Files: src/api.lua, tests/api_spec.lua
    Risks: The new branch lacks coverage for empty values.

    ## Issues
    - Important — src/api.lua:42 accepts whitespace-only input.

## Common mistakes

- Running `work review` or changing Git state in self mode.
- Omitting untracked files because they do not appear in `git diff`.
- Narrating files individually instead of explaining logical concerns.

## PR support

Neovim owns normal submission and teardown through `<leader>pa` and `<leader>px`. Only when explicitly asked in chat, use:

- `work review submit <APPROVE|REQUEST_CHANGES|COMMENT> ["body"]`
- `work review exit`