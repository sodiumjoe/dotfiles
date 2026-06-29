#!/bin/bash

LOG="${REPRO_STOP_LOG:-/tmp/stop-hook-repro.log}"
EVENT_JSON=$(cat)

{
  printf '%s\n' "--- Stop hook fired $(date '+%Y-%m-%dT%H:%M:%S%z') ---"
  printf 'cwd=%s\n' "$PWD"
  printf '%s\n' "$EVENT_JSON"
} >> "$LOG"

osascript -e 'display notification "Stop hook fired now" with title "Codex Stop hook repro"' 2>/dev/null

exit 0
