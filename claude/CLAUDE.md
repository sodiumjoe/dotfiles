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
- When requesting approval, list any destructive or modifying bash commands that will be needed (write operations, deletions, installations, deployments, etc.)
- Do not request permission for read-only operations (file reads, git status, ls, grep, etc.)

## Work Tracking

- Log work in the plan file under a `## Changelog` section
- Format changelog entries as completed tasks with date: `- [x] YYYY-MM-DD HH:MM Description of work done`
  - This allows the daily note to query completed work from all plans
- Maintain notes in the plan file documenting:
  - What was investigated or implemented
  - What was found or discovered
- Update the plan file as work progresses
