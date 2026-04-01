## Planning

- Use the brainstorming skill to start new work (brainstorm + create project)
- Use the writing-plans skill to create implementation plans within a project
- Use the executing-plans skill to execute plans from any session
- Before executing a plan, run the plan-reviewer agent to review it for completeness, accuracy, and risks. Share the review findings with the user before proceeding.
- Before executing a plan, gather all permissions requirements and request them in a single batch

## Work Tracking

### Completing Work

When completing a task, use the `work complete` command:

```bash
work complete <file> <description>
```

This single command:

- Marks the item complete in the source file (project or plan)
- Adds it to today's daily note log with proper metadata
- Handles project/plan context automatically

Example:

```bash
work complete ~/stripe/work/projects/dotfiles/project.md "Fix shell config"
```

Do not manually call `work check-off` or `work append-log` separately. Always use `work complete` for consistency.

### Changelog Format

- All plans must have a `project` field, so always log work in the **project file's** `## Changelog` section
- Format changelog entries as completed tasks: `- [x] Description of work done ✅ YYYY-MM-DD`
  - The `✅ YYYY-MM-DD` suffix is required Obsidian Tasks done-date metadata
  - This allows the daily note to query completed work from all plans and projects
- Maintain notes in the plan file documenting:
  - What was investigated or implemented
  - What was found or discovered
- Update the plan file as work progresses

## Daily Note

- The daily note is at `~/stripe/work/YYYY-MM-DD.md` (today's date)
- Use `/start-day` to initialize, `/log` to record completions, `/next` for what to work on, `/note` for freeform entries, `/end-day` to wrap up
- When completing work outside of `/log`, still update both the daily note log and the project/plan changelog
- Do not overwrite existing daily note content. Append or edit specific sections.