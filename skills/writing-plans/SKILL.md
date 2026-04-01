---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
plugin: superpowers@stripe-internal-marketplace
version: 1.0.1
skill: writing-plans
content_hash: 8a9198d4d9efbcad6e019b17c422c182113062c864b6154ec2a3ba2ed0b6b9d0
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for the codebase. Document everything they need: which files to touch, code, testing, how to verify. Bite-sized tasks. DRY. YAGNI. Frequent commits.

**Announce at start:** "I'm using the work:writing-plans skill to create the implementation plan."

## Plan Location

Plans are saved to the current project's directory in the Obsidian vault:

1. Determine the project slug from session context (`$CLAUDE_PROJECT` environment variable, injected by the SessionStart hook)
2. If no session context, ask the user which project this plan belongs to
3. Save to: `~/stripe/work/projects/<slug>/YYYY-MM-DD-<feature-name>.md`
4. After writing, open the file in neovim:
   ```bash
   nvim-open --editor '<absolute-path-to-plan-file>'
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

> **For Claude:** REQUIRED SUB-SKILL: Use work:executing-plans to implement this plan task-by-task.

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

After saving the plan, offer execution choice:

**"Plan saved to `<path>`. Two execution options:**

**1. Subagent-Driven (this session)** — dispatch fresh subagent per task, review between tasks

**2. Parallel Session (separate)** — open new session, use work:executing-plans

**Which approach?"**

If Subagent-Driven: use work:subagent-driven-development.
If Parallel Session: guide user to open new session and invoke work:executing-plans.