---
name: review
description: Use when the user invokes /review to review a PR or branch changes. Reads all diffs, produces a granular summary, then the user navigates files via picker with comment overlay for feedback.
allowed-tools: Bash(*/skills/review/scripts/* *), Bash(*/skills/review/../neovim/scripts/nvim-open *), Bash(*/skills/review/../neovim/scripts/nvim-diff *), Bash(*/skills/review/../neovim/scripts/nvim-lua *)
---

# Review

Unified code review skill for PRs and branch changes. The agent pre-digests all diffs, produces a granular summary, then the user drives file navigation via a Snacks.picker. Comments are collected via nvim-comment-overlay and handled at the end (submitted to GitHub for PRs, acted on as instructions for branches).

## Mode Detection

Parse `$ARGUMENTS` to determine the mode:

- Argument is a number or matches `PR#<number>` -> PR mode with that PR number
- No arguments -> branch mode, base auto-detected by `review-enter`
- One or two arguments that aren't PR numbers -> branch mode with explicit base

## Phase 0 — Enter

Run the enter script:

```
${CLAUDE_SKILL_DIR}/scripts/review-enter <mode> [<args>]
```

Examples:
- PR mode: `${CLAUDE_SKILL_DIR}/scripts/review-enter pr 482`
- Branch mode: `${CLAUDE_SKILL_DIR}/scripts/review-enter branch`
- Branch with explicit base: `${CLAUDE_SKILL_DIR}/scripts/review-enter branch main`

The script outputs JSON: `{ mode, id, base_ref, head_ref, toplevel, stashed, previous_branch }`. If the output contains `"error"`, report it and stop.

After the script succeeds, initialize the neovim session state:

```
${CLAUDE_SKILL_DIR}/../neovim/scripts/nvim-lua "local r = require('sodium.review') r.start_session({ id = '<id>', mode = '<mode>', base_ref = '<base_ref>', head_ref = '<head_ref>', toplevel = '<toplevel>' }) r.set_previous_branch('<previous_branch>') r.set_stashed(<stashed>) return 0"
```

For PR mode, also fetch the current GitHub user and set up the comment overlay actor:

```
${CLAUDE_SKILL_DIR}/../neovim/scripts/nvim-lua "local user = vim.trim(vim.system({'gh', 'api', 'user', '--jq', '.login'}, {text=true}):wait().stdout or '') require('sodium.review').set_current_user(user) vim.g.comment_overlay_actor = user return 0"
```

For PR mode, fetch and display existing PR comments:

```
${CLAUDE_SKILL_DIR}/../neovim/scripts/nvim-lua "
local review = require('sodium.review')
local s = review.get_session()
local r = vim.system({'gh', 'api', 'repos/{owner}/{repo}/pulls/' .. s.id .. '/comments', '--paginate'}, {text=true}):wait()
if r.code == 0 and r.stdout ~= '' then
  local by_id, files = review.parse_gh_comments(r.stdout)
  if next(by_id) then
    review.write_comments_json(s.toplevel .. '/.nvim-comments.json', review.build_comments_v2(by_id, files))
    pcall(vim.cmd, 'CommentRefresh')
  end
end
return 0
"
```

## Phase 1 — Digest

Read all diffs to build understanding. In **PR mode**, pass `--pr <id>` as the first arguments to use fast server-side diffs (critical for large monorepos where local `git diff` can take minutes).

**Commit history** (for internal context):
```
# PR mode:
${CLAUDE_SKILL_DIR}/scripts/review-commits --pr <id>
# Branch mode:
${CLAUDE_SKILL_DIR}/scripts/review-commits <base_ref>
```

**Consolidated diff** (for the summary):
```
# PR mode:
${CLAUDE_SKILL_DIR}/scripts/review-diff --pr <id> <base_ref>
# Branch mode:
${CLAUDE_SKILL_DIR}/scripts/review-diff <base_ref>
```

Produce a granular summary for the user:
- Group files by area or concern (e.g., "Core logic", "Tests", "Config", "Infra")
- For each file, describe the net change in 1-2 sentences
- Note cross-file relationships and dependencies
- Flag anything questionable, risky, or worth closer attention
- If the commit history reveals intent not obvious from the diff (e.g., a refactor followed by a feature addition), mention it

The summary should be detailed enough that the user could decide which files to prioritize or skip without opening them.

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
> Ask me anything about the changes. Say **done** when finished.

Then **wait for user input**. Do not open the picker automatically. The user drives navigation; the agent answers questions as asked.

If the user asks to open the picker programmatically:
```
# PR mode:
${CLAUDE_SKILL_DIR}/scripts/review-picker --pr <id> <base_ref> <head_ref>
# Branch mode:
${CLAUDE_SKILL_DIR}/scripts/review-picker <base_ref> <head_ref>
```

## Phase 3 — Exit

When the user says they're done (e.g., "done", "finish", "submit"), run the exit script:

```
${CLAUDE_SKILL_DIR}/scripts/review-exit <toplevel> [--restore-branch <branch>] [--pop-stash] [--user <login>]
```

Build the flags from session state:
- If `previous_branch` is set and mode is "pr": add `--restore-branch <branch>`
- If `stashed` is true: add `--pop-stash`
- If `current_user` is set: add `--user <login>`

The script outputs a JSON array of local comments on stdout.

**PR mode:** If there are local comments, show them to the user. Ask for review type: approve, comment, or request changes. Ask for an optional review body. Then submit:

```
echo '<comments_json>' | ${CLAUDE_SKILL_DIR}/scripts/review-submit <pr_number> <EVENT> [<body>]
```

Report success or failure.

**Branch mode:** If there are local comments, read each one and act on it as an instruction. Each comment has `file`, `line`/`line_start`, and `body` fields. The body is the user's instruction — apply edits, note feedback, or take whatever action is described. Report what was done.

If there are no comments in either mode, say "No comments collected. Review complete."