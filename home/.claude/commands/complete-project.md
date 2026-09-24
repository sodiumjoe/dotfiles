---
description: Close out a project (active) or plan (evergreen) with task triage, findings extraction, and changelog summary
allowed-tools: Read, Edit, Bash(date:*), Bash(work:*), AskUserQuestion
---

# Complete Project

Close out a project or an evergreen project's plan. Auto-detects mode from project frontmatter.

## Arguments

- `file` (optional): path to project file. If not provided, infer from `$CLAUDE_PROJECT` or ask.

## Steps

### 1. Identify the project

If a file path was provided, use it. Otherwise check `$CLAUDE_PROJECT` environment variable. If neither, ask the user which project to complete.

Read the project file. Determine the mode from frontmatter `status`:
- `active` → **project completion** (proceed to step 2a)
- `evergreen` → **plan completion** (proceed to step 2b)

### 2a. Project completion — triage open tasks

Read the `## Tasks` section. If open tasks exist (`[ ]` or `[/]`):

Present each open task to the user and ask: **done** or **skipped**?

Collect the line numbers of skipped tasks. Then run:

```bash
work close-tasks '<project-file>' --skip=<line1,line2,...> --date=$(date +%Y-%m-%d)
```

If no open tasks, skip to step 3a.

### 2b. Plan completion — select plan

Read the `## Plans` section. Collect wikilinks to plan files.

For each linked plan, resolve its file path within the project directory. Read each plan file. Filter to plans with `status: active` (exclude `done`, `completed`).

If multiple active plans, ask the user which one to complete. If one, use it. If none, tell the user there are no active plans to close.

### 3a. Project completion — extract findings and summarize

Read the project file and all linked plan files (from `## Plans` wikilinks).

Identify anything worth preserving:
- Patterns, gotchas, workarounds discovered
- Architectural decisions and rationale
- Debugging insights

Present findings to the user (or note "no notable findings").

Generate a one-line changelog summary from the project tasks, changelog, and plan content. The summary should capture the overall accomplishment, not enumerate individual tasks.

Run:

```bash
work close-project '<slug>' '<summary>' --date=$(date +%Y-%m-%d)
```

If findings exist, ensure the daily note is ready and add review tasks:

```bash
work ensure
```

Then edit the daily note to append to `## Tasks`:
```
- [ ] Review findings from "<project title>": <finding summary>
```

### 3b. Plan completion — extract findings and summarize

Read the plan file and its parent project file.

Extract findings (same criteria as 3a). Present to user.

Generate a one-line changelog summary for this phase of work.

Log the summary to the project's changelog:

```bash
work complete '<project-file>' '<summary>'
```

Close the plan:

```bash
work close-plan '<plan-file>'
```

If findings exist, add review tasks to today's daily note (same as 3a).

### 4. Report

Tell the user what was done:
- Tasks completed / cancelled (if any)
- Summary written
- Findings extracted (if any)
- What happens next (tick will archive the plan on next run, or project will be proposed for archival)