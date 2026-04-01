---
description: Archive completed projects, write a monthly work summary
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(date:*), Bash(mkdir:*), Bash(mv:*), Bash(ls:*), Bash(work:*)
---

# Archive Projects

Archive completed projects and generate a monthly work summary.

## Steps

### 1. Get the current month

Run `date +%Y-%m` to get `YYYY-MM`.

### 2. Scan for completed projects

Run `work list-projects` and filter for projects with `status: completed`.

For each completed project, read the project file at `~/stripe/work/projects/<slug>/project.md` and collect:
- Title
- `completed_at` date from frontmatter
- Changelog entries for the current month

Present the list to the user and ask which to archive.

### 3. Archive confirmed projects

For each confirmed project:
```bash
work archive-project '<slug>'
```

This moves the entire project directory (project file + plans) to `archive/projects/<slug>/`.

### 4. Write monthly summary

**File:** `~/stripe/work/monthly/YYYY-MM.md`

Create the `monthly/` directory if it does not exist: `mkdir -p ~/stripe/work/monthly`

Format — group by project:
```markdown
# YYYY-MM Work Summary

## Project Title 1

- [x] Completed entry 1 ✅ YYYY-MM-DD
- [x] Completed entry 2 ✅ YYYY-MM-DD

## Project Title 2

- [x] Completed entry 1 ✅ YYYY-MM-DD
```

Include changelog entries from ALL project files (both active and archived) whose date falls within the current month. Read project files from both `~/stripe/work/projects/` and `~/stripe/work/archive/projects/` to capture everything.

If the summary file already exists, replace its content entirely.

### 5. Report

Tell the user:
- How many projects were archived
- How many remain active
- Path to the monthly summary file
