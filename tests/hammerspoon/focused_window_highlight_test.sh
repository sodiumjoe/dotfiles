#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
config="$repo_root/home/.config/hammerspoon/init.lua"

if ! rg --no-config -q 'hs\.window\.highlight\.start\(\)' "$config"; then
  echo "FAIL: built-in hs.window.highlight is not started"
  exit 1
fi

if rg --no-config -q 'hs\.loadSpoon\("highlight_focused_window"\)' "$config"; then
  echo "FAIL: custom focus-border spoon is loaded alongside built-in hs.window.highlight"
  exit 1
fi

echo "PASS: focused-window highlight uses one implementation"
