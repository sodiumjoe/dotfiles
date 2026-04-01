#!/usr/bin/env bash
# SessionStart hook: injects project context into Claude sessions.
# Reads CLAUDE_PROJECT env var set by the Neovim project picker.

if [ -z "$CLAUDE_PROJECT" ]; then
  exit 0
fi

PROJECT_FILE="$HOME/stripe/work/projects/$CLAUDE_PROJECT/project.md"

if [ ! -f "$PROJECT_FILE" ]; then
  exit 0
fi

CONTENT=$(cat "$PROJECT_FILE")

CONTEXT="## Session Context

Project: $CLAUDE_PROJECT
Project file: $PROJECT_FILE

### Project

$CONTENT

### Instructions

- This session is scoped to the project above. Prioritize work items from this project.
- Use \`work complete\` to record completions against this project."

jq -n \
  --arg ctx "$CONTEXT" \
  --arg msg "Project context loaded for $CLAUDE_PROJECT" \
  '{
    "hookSpecificOutput": {
      "hookEventName": "SessionStart",
      "additionalContext": $ctx
    },
    "systemMessage": $msg
  }'