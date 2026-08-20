#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
config="$repo_root/hammerspoon/init.lua"

if rg -q 'resetScreenRotations|:rotate\(' "$config"; then
  echo "FAIL: layout configuration still enforces display rotation"
  exit 1
fi

echo "PASS: layout leaves display rotation to macOS"
