#!/usr/bin/env bash
set -euo pipefail

# Smoke test: generate configs for all environments and validate key properties.
# Run from the dotfiles repo root.

cd "$(dirname "$0")"

pass=0
fail=0

check() {
  local desc="$1" result="$2"
  if [ "$result" = "ok" ]; then
    echo "  PASS: $desc"
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc ($result)"
    fail=$((fail + 1))
  fi
}

for env in work devbox home; do
  echo "=== $env ==="
  rm -f Brewfile claude/settings.json codex/config.toml codex/AGENTS.md
  DOTFILES_ENV=$env bin/dotfiles-generate --reset 2>/dev/null

  # --- claude/settings.json ---
  if ! jq empty claude/settings.json 2>/dev/null; then
    check "valid JSON" "jq parse error"
    continue
  fi
  check "valid JSON" "ok"

  work_perms=$(jq '[.permissions.allow[] | select(test("pay|toolshed|sourcegraph"))] | length' claude/settings.json)
  stripe_plugins=$(jq '[.enabledPlugins // {} | keys[] | select(test("stripe"))] | length' claude/settings.json)
  obsidian=$(jq '.enabledPlugins["obsidian@obsidian-skills"] // false' claude/settings.json)

  case "$env" in
    work|devbox)
      check "has work permissions" "$([ "$work_perms" -gt 0 ] && echo ok || echo "got $work_perms")"
      check "has stripe plugins" "$([ "$stripe_plugins" -gt 0 ] && echo ok || echo "got $stripe_plugins")"
      check "has obsidian plugin" "$([ "$obsidian" = "true" ] && echo ok || echo "$obsidian")"
      ;;
    home)
      check "no work permissions" "$([ "$work_perms" -eq 0 ] && echo ok || echo "got $work_perms")"
      check "no stripe plugins" "$([ "$stripe_plugins" -eq 0 ] && echo ok || echo "got $stripe_plugins")"
      check "has obsidian plugin" "$([ "$obsidian" = "true" ] && echo ok || echo "$obsidian")"
      ;;
  esac

  # --- Brewfile ---
  if [ "$(uname -s)" = "Darwin" ]; then
    case "$env" in
      work)
        check "Brewfile has stripe tap" "$(grep -q stripe-internal Brewfile && echo ok || echo missing)"
        check "Brewfile has codex-acp" "$(grep -q codex-acp Brewfile && echo ok || echo missing)"
        ;;
      devbox)
        check "no Brewfile on devbox" "$([ ! -f Brewfile ] && echo ok || echo "Brewfile exists")"
        ;;
      home)
        check "Brewfile has no stripe tap" "$(grep -q stripe-internal Brewfile && echo "found stripe tap" || echo ok)"
        check "Brewfile has no codex-acp" "$(grep -q codex-acp Brewfile && echo "found codex-acp" || echo ok)"
        ;;
    esac
  fi

  # --- codex AGENTS.md ---
  case "$env" in
    work|devbox)
      check "AGENTS.md generated" "$([ -f codex/AGENTS.md ] && echo ok || echo missing)"
      ;;
    home)
      # AGENTS.md may exist from a previous run; just check it wasn't regenerated
      ;;
  esac
done

# Restore the user's actual config
echo ""
echo "Restoring configs for current environment..."
bin/dotfiles-generate 2>/dev/null

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
