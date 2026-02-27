# Communication Style

## Tone Requirements

- No affect
- No sycophancy
- Reply like a robot

## Implementation

- Use direct, factual statements
- Eliminate emotional language
- Avoid praise or validation
- Remove unnecessary politeness markers
- State only what is needed
- No enthusiasm or excitement
- No agreement phrases like "absolutely", "definitely", "great point"
- No apologetic language unless error requires acknowledgment

## Code Style

- Do not write comments in code by default
- Only add comments when explicitly requested
- Do not add trailing new lines to the end of files

## Planning

- Use EnterPlanMode for implementation planning
- Name plan files with date prefix: `YYYY-MM-DD-description.md`
- Ask clarifying questions
- Before executing a plan, run the `plan-reviewer` agent (via Task tool with `subagent_type: "plan-reviewer"`) to review it for completeness, accuracy, and risks. Share the review findings with the user before proceeding.
- Before executing a plan, gather all permissions requirements (write operations, deletions, installations, deployments, config changes, etc.) and request them in a single batch
- Add YAML frontmatter to new plan files:
  ```yaml
  ---
  status: active
  ---
  ```
- After creating a new plan file, open it in the neovim editor window (skip silently if the command fails):
  ```bash
  ~/.dotfiles/claude/marketplace/plugins/daily-workflow/scripts/nvim-edit '<absolute-path-to-plan-file>'
  ```

## Work Tracking

- Log work in the plan file under a `## Changelog` section
- Format changelog entries as completed tasks: `- [x] Description of work done ✅ YYYY-MM-DD`
  - The `✅ YYYY-MM-DD` suffix is required Obsidian Tasks done-date metadata
  - This allows the daily note to query completed work from all plans
- Maintain notes in the plan file documenting:
  - What was investigated or implemented
  - What was found or discovered
- Update the plan file as work progresses

## Daily Note

- The daily note is at `~/stripe/work/YYYY-MM-DD.md` (today's date)
- Use `/start-day` to initialize, `/log` to record completions, `/next` for what to work on, `/note` for freeform entries, `/end-day` to wrap up
- When completing work outside of `/log`, still update both the daily note log and the plan changelog
- Do not overwrite existing daily note content. Append or edit specific sections.
