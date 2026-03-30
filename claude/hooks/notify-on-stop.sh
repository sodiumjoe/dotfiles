#!/bin/bash

PANE="$TMUX_PANE"
if [ -z "$PANE" ]; then
  exit 0
fi

PANE_SLUG=$(echo "$PANE" | tr -d '%')
PID_FILE="/tmp/claude-notify-${PANE_SLUG}.pid"
DELAY=60

if [ -f /pay/conf/box-type ]; then
  tmux set -gu @notify_bell 2>/dev/null
fi

if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null
  rm -f "$PID_FILE"
fi

PROJECT="${CLAUDE_PROJECT:-}"
WINDOW=$(tmux display-message -p -t "$PANE" '#{window_name}' 2>/dev/null)

(
  sleep "$DELAY"

  WINDOW_ACTIVE=$(tmux display-message -p -t "$PANE" '#{window_active}' 2>/dev/null)
  PANE_ACTIVE=$(tmux display-message -p -t "$PANE" '#{pane_active}' 2>/dev/null)

  if [ "$WINDOW_ACTIVE" = "1" ] && [ "$PANE_ACTIVE" = "1" ]; then
    rm -f "$PID_FILE"
    exit 0
  fi

  LABEL="${WINDOW:-$PROJECT}"
  if [ -n "$LABEL" ]; then
    MSG="Claude is waiting for input ($LABEL)"
  else
    MSG="Claude is waiting for input"
  fi

  if [ -f /pay/conf/box-type ]; then
    tmux set -g @notify_bell 1
  else
    osascript -e "display notification \"$MSG\" with title \"Claude Code\""
  fi

  rm -f "$PID_FILE"
) &
echo $! > "$PID_FILE"

exit 0