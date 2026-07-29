---
name: neovim-review
description: Use when the user invokes /review with a PR number. Checks out the PR, pre-digests the diff into a granular summary, then answers questions while the user reviews in neovim. Self-review (own branch) needs no skill — the user runs :Review in neovim.
allowed-tools: Bash
---

# PR Review

All mechanics (checkout, caching, session state, comment submission, cleanup)
are owned by `work review` (run it from inside the repo). This skill does
judgment work only: digest the change, answer questions.

## Phase 0 — Enter

    work review enter-pr <number>

Outputs JSON `{ mode, id, base_ref, head_ref, toplevel }`. On `{"error": ...}`,
report it and stop. A stale previous session is recovered automatically.

## Phase 1 — Digest

Read `<toplevel>/.review/commits` and `<toplevel>/.review/diff`. Produce a
granular summary: group files by concern, 1-2 sentences per file, cross-file
relationships, flag anything risky. Gate: every file in `.review/files` must
appear in the summary.

## Phase 2 — Support

Tell the user the session is ready (keymaps are shown in neovim; `<leader>p?`
redisplays them). Then wait and answer questions about the changes.

Do not track submission or run cleanup — `<leader>pa` (submit) and
`<leader>px` (abort) handle everything including session teardown. Only if
the user explicitly asks in chat:

- submit: `work review submit <APPROVE|REQUEST_CHANGES|COMMENT> ["body"]`
- abort: `work review exit`