---
description: Create implementation plan with bite-sized tasks
aliases: []
id: write-plan
tags: []
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for the codebase. Document everything they need: which files to touch, code, testing, how to verify. Bite-sized tasks. DRY. YAGNI. Frequent commits.

**Announce at start:** "I'm using the work:write-plan skill to create the implementation plan."

## Plan Location

Plans are saved to the current project's directory in the Obsidian vault:

1. Determine the project slug from session context (`$CLAUDE_PROJECT` environment variable, injected by the SessionStart hook)
2. If no session context, ask the user which project this plan belongs to
3. Save to: `~/stripe/work/projects/<slug>/YYYY-MM-DD-<feature-name>.md`
4. After writing, open the file in neovim:
   ```bash
   ~/.claude/skills/neovim/scripts/nvim-open --editor '<absolute-path-to-plan-file>'
   ```

## Plan Frontmatter

Every plan file starts with:

```yaml
---
status: active
project: "[[projects/<slug>/project]]"
---
```

## After Writing the Plan

1. Add a wikilink to the project file's `## Plans` section:
   ```markdown
   - [[YYYY-MM-DD-<feature-name>]]
   ```
2. Open the plan file in neovim

## Bite-Sized Task Granularity

Each step is one action (2-5 minutes):
- "Write the failing test" — step
- "Run it to make sure it fails" — step
- "Implement the minimal code to make the test pass" — step
- "Run the tests and make sure they pass" — step
- "Commit" — step

## Plan Document Header

Every plan MUST start with this header:

```markdown
# [Feature Name] Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use work:execute-plan to implement this plan task-by-task.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file`
- Modify: `exact/path/to/existing:123-145`
- Test: `tests/exact/path/to/test`

**Step 1: [action]**

[complete code or exact command]

**Step 2: [action]**

[complete code or exact command]

**Step N: Commit**

```bash
git add <files>
git commit -m "feat: description"
```
````

## Remember
- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- DRY, YAGNI, frequent commits

## Execution Handoff

After saving the plan, hand off to work:subagent-driven-development to execute it in the current session.
