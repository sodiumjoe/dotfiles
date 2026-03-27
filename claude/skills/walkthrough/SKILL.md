---
name: walkthrough
description: Use when the user invokes /walkthrough to interactively review recent commits file-by-file with diffs in neovim, collecting suggestions for code edits and commit operations
allowed-tools: Bash(*/skills/walkthrough/scripts/walkthrough-commits *), Bash(*/skills/walkthrough/scripts/walkthrough-show *), Bash(*/skills/neovim/scripts/nvim-open *)
---

# Walkthrough

Interactive post-commit code review. Walk through recent branch commits file-by-file, opening each diff in neovim, explaining changes, and collecting suggestions. At the end, present suggestions for user editing, then execute them.

## Phase 1 — Gather

Run the commit enumeration script with an optional base branch argument:

```bash
${CLAUDE_SKILL_DIR}/scripts/walkthrough-commits $ARGUMENTS
```

This outputs one JSON object per line: `{"commit":"<sha>","subject":"<msg>","file":"<path>"}`. Commits are oldest-first. Parse the output and report to the user:

> **Walkthrough:** N commits, M files. Starting with commit `<short-sha>`: "<subject>"

If the output contains `{"error":"..."}`, report the error and stop.

## Phase 2 — Walk

Iterate through each `(commit, file)` entry. For each one:

1. Run the show script to print diff context and open the visual diff:
   ```bash
   ${CLAUDE_SKILL_DIR}/scripts/walkthrough-show <file> <commit>
   ```
2. Read the diff output from stdout. Explain what changed and why, inferred from the diff and commit message. Keep explanations concise — a few sentences, not a paragraph per line.
3. **Wait for user input.** Do not proceed until the user responds. The user can:
   - Say "next" or "n" to continue to the next file
   - Ask questions about the change
   - Suggest a code edit — record it with: file path, line/region context, description of the change
   - Suggest a commit operation (squash, reword, split, reorder) — record it with: commit SHA(s), operation, details

When moving to a new commit (i.e. the commit SHA changes from the previous entry), announce:

> **Commit `<short-sha>`:** "<subject>"

## Phase 3 — Review

After all files are walked, if there are accumulated suggestions:

1. Write them to `/tmp/walkthrough-suggestions.md` as a markdown checklist:

   ```markdown
   # Walkthrough Suggestions

   ## Code Edits
   - [x] `src/foo.py:42` — extract helper function for validation logic
   - [x] `src/bar.py:15` — rename `x` to `connection_count`

   ## Commit Operations
   - [x] squash abc123 into def456 — "both fix the same bug"
   - [x] reword ghi789 — "add foo and bar support"
   ```

   Items start checked. The user unchecks items to skip them.

2. Open the file in neovim:
   ```bash
   ${CLAUDE_SKILL_DIR}/../neovim/scripts/nvim-open --editor '/tmp/walkthrough-suggestions.md'
   ```

3. Tell the user: "Edit the suggestions file — uncheck items to skip, modify descriptions, reorder. Say **go** when ready."

4. **Wait for the user to say "go".**

If there are no suggestions, say "No suggestions collected. Walkthrough complete." and stop.

## Phase 4 — Execute

Read `/tmp/walkthrough-suggestions.md` back. For each checked item:

**Code edits:** Apply using the Edit tool. Read the target file first, locate the region described, make the edit.

**Commit operations:**
- **reword**: `git commit --amend -m "<new message>"` if HEAD, otherwise `git rebase -i` with `reword` for older commits
- **squash**: `git rebase -i` with `squash` or `fixup` for the target commits
- **split/reorder**: explain what manual steps are needed and offer to help

Execute commit operations after all code edits are applied. Report each action as it completes.

When done, summarize what was executed and what was skipped.