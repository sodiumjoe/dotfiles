#!/bin/bash

PANE="$TMUX_PANE"
APP_NAME="${NOTIFY_AGENT_NAME:-Claude}"
BOX_TYPE_FILE="${BOX_TYPE_FILE:-/pay/conf/box-type}"

if [ -n "$PANE" ] && [ -f "$BOX_TYPE_FILE" ]; then
  tmux set -gu @notify_bell 2>/dev/null
fi

LABEL="${CLAUDE_PROJECT:-$remote_name}"
if [ -z "$LABEL" ] && [ -n "$PANE" ]; then
  LABEL=$(tmux show-environment remote_name 2>/dev/null | grep -v '^-' | cut -d= -f2-)
fi
if [ -z "$LABEL" ]; then
  LABEL=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null)
fi

if [ -n "$PANE" ] && [ -f "$BOX_TYPE_FILE" ]; then
  ORIGIN="${remote_name:-devbox}"
else
  ORIGIN="local"
fi

if [ -n "$LABEL" ]; then
  MSG="$APP_NAME is waiting for input on $ORIGIN ($LABEL)"
else
  MSG="$APP_NAME is waiting for input on $ORIGIN"
fi

if [ -n "$PANE" ] && [ ! -f "$BOX_TYPE_FILE" ]; then
  WINDOW_ACTIVE=$(tmux display-message -p -t "$PANE" '#{window_active}' 2>/dev/null)
  PANE_ACTIVE=$(tmux display-message -p -t "$PANE" '#{pane_active}' 2>/dev/null)

  if [ "$WINDOW_ACTIVE" = "1" ] && [ "$PANE_ACTIVE" = "1" ]; then
    exit 0
  fi
fi

if [ -n "$PANE" ] && [ -f "$BOX_TYPE_FILE" ]; then
  tmux set -g @notify_bell 1
else
  osascript - "$MSG" "$APP_NAME" <<'APPLESCRIPT'
on run argv
  display notification (item 1 of argv) with title (item 2 of argv)
end run
APPLESCRIPT
fi

exit 0
