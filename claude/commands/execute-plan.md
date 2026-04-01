---
description: Execute an implementation plan task-by-task with review checkpoints
---

# Executing Plans

## Overview

Load plan, review critically, execute tasks in batches, report for review between batches.

**Core principle:** Batch execution with checkpoints for review.

**Announce at start:** "I'm using the work:execute-plan skill to implement this plan."

## The Process

### Step 1: Load and Review Plan
1. Read plan file (path provided by user or derived from project context)
2. Review critically — identify any questions or concerns
3. If concerns: raise them before starting
4. If no concerns: create TodoWrite and proceed

### Step 2: Execute Batch
**Default: first 3 tasks**

**Always use subagent mode** (`work:subagent-driven-development`) to execute tasks. Do not use parallel agent dispatch or execute tasks sequentially in the main context.

For each task:
1. Mark as in_progress
2. Follow each step exactly (plan has bite-sized steps)
3. Run verifications as specified
4. Mark as completed

### Step 3: Report
When batch complete:
- Show what was implemented
- Show verification output
- Say: "Ready for feedback."

### Step 4: Continue
Based on feedback:
- Apply changes if needed
- Execute next batch
- Repeat until complete

### Step 5: Complete
After all tasks complete and verified:
1. Set `status: completed` in the plan's frontmatter
2. Log completion to the project changelog:
   ```bash
   work complete <project-file> "<plan-title>"
   ```
3. Use work:finishing-a-development-branch to complete the work

## When to Stop

**STOP executing immediately when:**
- Hit a blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

## Remember
- Review plan critically first
- Follow plan steps exactly
- Don't skip verifications
- Between batches: report and wait
- Stop when blocked, don't guess
- Never start implementation on main/master branch without explicit user consent