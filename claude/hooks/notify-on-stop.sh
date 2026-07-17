#!/bin/bash

PANE="$TMUX_PANE"
if [ -z "$PANE" ]; then
  exit 0
fi

PANE_SLUG=$(echo "$PANE" | tr -d '%')
PID_FILE="/tmp/claude-notify-${PANE_SLUG}.pid"
DELAY=60
APP_NAME="${NOTIFY_AGENT_NAME:-Agent}"
BOX_TYPE_FILE="${BOX_TYPE_FILE:-/pay/conf/box-type}"

if [ -f "$BOX_TYPE_FILE" ]; then
  tmux set -gu @notify_bell 2>/dev/null
fi

if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null
  rm -f "$PID_FILE"
fi

LABEL="${CLAUDE_PROJECT:-$remote_name}"
if [ -z "$LABEL" ]; then
  LABEL=$(tmux show-environment remote_name 2>/dev/null | grep -v '^-' | cut -d= -f2-)
fi
if [ -z "$LABEL" ]; then
  LABEL=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null)
fi

(
  sleep "$DELAY"

  if [ ! -f "$BOX_TYPE_FILE" ]; then
    WINDOW_ACTIVE=$(tmux display-message -p -t "$PANE" '#{window_active}' 2>/dev/null)
    PANE_ACTIVE=$(tmux display-message -p -t "$PANE" '#{pane_active}' 2>/dev/null)

    if [ "$WINDOW_ACTIVE" = "1" ] && [ "$PANE_ACTIVE" = "1" ]; then
      rm -f "$PID_FILE"
      exit 0
    fi
  fi

  if [ -f "$BOX_TYPE_FILE" ]; then
    ORIGIN="${remote_name:-devbox}"
  else
    ORIGIN="local"
  fi

  if [ -n "$LABEL" ]; then
    MSG="$APP_NAME is waiting for input on $ORIGIN ($LABEL)"
  else
    MSG="$APP_NAME is waiting for input on $ORIGIN"
  fi

  if [ -f "$BOX_TYPE_FILE" ]; then
    tmux set -g @notify_bell 1
  else
    osascript -e "display notification \"$MSG\" with title \"$APP_NAME\""
  fi

  rm -f "$PID_FILE"
) </dev/null >/dev/null 2>&1 &
echo $! > "$PID_FILE"

exit 0
