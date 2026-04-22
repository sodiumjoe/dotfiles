---
name: neovim-review
description: Use when the user invokes /review to review a PR or branch changes. Reads all diffs, produces a granular summary, then the user navigates files via picker with comment overlay for feedback.
allowed-tools: Bash
---

# Review

Unified code review skill for PRs and branch changes. The agent pre-digests all diffs, produces a granular summary, then the user drives file navigation via a Snacks.picker. Comments are collected via nvim-comment-overlay and handled at the end (submitted to GitHub for PRs, acted on as instructions for branches).

## Mode Detection

Parse `$ARGUMENTS` to determine the mode:

- Argument is a number or matches `PR#<number>` -> PR mode with that PR number
- No arguments -> branch mode, base auto-detected by `review-enter`
- One or two arguments that aren't PR numbers -> branch mode with explicit base

## Phase 0 — Enter

Run the enter script. This performs ALL git and network I/O for the entire session: checkout, diff fetching, file listing, commit history, and neovim session initialization.

```
${CLAUDE_SKILL_DIR}/scripts/review-enter <mode> [<args>]
```

Examples:
- PR mode: `${CLAUDE_SKILL_DIR}/scripts/review-enter pr 482`
- Branch mode: `${CLAUDE_SKILL_DIR}/scripts/review-enter branch`
- Branch with explicit base: `${CLAUDE_SKILL_DIR}/scripts/review-enter branch main`

The script outputs JSON: `{ mode, id, base_ref, head_ref, toplevel, stashed, previous_branch }`. If the output contains `"error"`, report it and stop.

The script also:
- Caches diff, file list, and commits to `$toplevel/.review/`
- Initializes neovim session state (session, files, file_diffs, user, previous_branch, stashed)
- Loads existing PR comments into nvim-comment-overlay (PR mode)

No further initialization is needed after this script completes.

## Phase 1 — Digest

Read the cached data from disk to build understanding. No scripts needed — read the files directly.

**Commit history** (for internal context):
```
cat <toplevel>/.review/commits
```

**Consolidated diff** (for the summary):
```
cat <toplevel>/.review/diff
```

Where `<toplevel>` is the `toplevel` field from the Phase 0 JSON output.

Produce a granular summary for the user:
- Group files by area or concern (e.g., "Core logic", "Tests", "Config", "Infra")
- For each file, describe the net change in 1-2 sentences
- Note cross-file relationships and dependencies
- Flag anything questionable, risky, or worth closer attention
- If the commit history reveals intent not obvious from the diff (e.g., a refactor followed by a feature addition), mention it

The summary should be detailed enough that the user could decide which files to prioritize or skip without opening them.

**Gate — summary completeness:** Before transitioning to Phase 2, verify that every changed file from the diff appears in the summary. If any file is missing, add it before proceeding. Do not move on until summary file count == changed files count.

## Phase 2 — Navigate

After presenting the summary, show the user the available keymaps:

> **Navigation:**
> - `<leader>pf` — open file picker (reviewed state tracked with `[x]/[ ]`)
> - `<leader>pn` — mark current file reviewed and reopen picker
> - `<Tab>` — toggle reviewed state in picker
> - `<C-o>` — open file without diff view
> - Select a file — open its vimdiff (base vs head)
>
> **Comments:**
> - `<leader>ca` — add comment on current line
> - `<leader>cn` / `<leader>cp` — next/previous comment
> - `<leader>cl` — list all comments
> - `<leader>cd` — delete comment
> - `<leader>ce` — edit comment
>
> **Submit (PR mode):**
> - `<leader>pa` — submit review (approve / request changes / comment) and exit
>
> Ask me anything about the changes. Use `<leader>pa` when ready to submit, or say **done** to finish.

Then **wait for user input**. Do not open the picker automatically. The user drives navigation; the agent answers questions as asked.

The picker reads from neovim session state (cached in memory during Phase 0). It opens instantly with no I/O.

## Phase 3 — Exit

Triggered when the user says "done", "finish", "submit", or after the user uses `<leader>pa`.

### Detecting `<leader>pa` completion

After the user presses `<leader>pa`, the `review-approve` script handles everything: comment extraction, PR submission, branch restore, and stash pop. The neovim review session is reset. When the agent detects this (the user says "done" or indicates they submitted), check whether the session still exists:

```
${CLAUDE_SKILL_DIR}/scripts/nvim-lua "
local ok, r = pcall(require, 'sodium.review')
if not ok then return 'no_session' end
local s = r.get_session()
return s and 'active' or 'no_session'
"
```

If the result is `no_session`, the `<leader>pa` keybinding already handled everything. Report "Review complete." and stop. Do not re-submit or re-run cleanup.

### PR mode (manual submission)

If the session is still active (the user said "done" without using `<leader>pa`):

1. Extract local comments from `.nvim-comments.json`:
```
${CLAUDE_SKILL_DIR}/scripts/nvim-lua "
local review = require('sodium.review')
local s = review.get_session()
local data = review.read_comments_json(s.toplevel .. '/.nvim-comments.json')
local user = review.get_current_user()
local comments = review.filter_local_comments(data, user)
return vim.json.encode(comments)
"
```

2. Show any local comments to the user. Ask for review type: APPROVE, COMMENT, or REQUEST_CHANGES. Ask for an optional review body.

3. Submit:
```
echo '<comments_json>' | ${CLAUDE_SKILL_DIR}/scripts/review-submit <pr_number> <EVENT> [<body>]
```

4. Clean up:
```
${CLAUDE_SKILL_DIR}/scripts/review-exit <toplevel> [--restore-branch <branch>] [--pop-stash]
```

Build the flags from the Phase 0 JSON:
- If `previous_branch` is set: add `--restore-branch <branch>`
- If `stashed` is true: add `--pop-stash`

### Branch mode

Run `review-exit` to clean up. If there are local comments (extracted as above, omitting `--user`), read each one and act on it as an instruction. Each comment has `file`, `line`/`line_start`, and `body` fields. The body is the user's instruction — apply edits, note feedback, or take whatever action is described. Report what was done. If there are no comments, say "No comments collected. Review complete."
