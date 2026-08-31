#!/usr/bin/env bash
set -euo pipefail

# Smoke test: generate configs for all environments and validate key properties.
#
# Generation is directed at a temp directory via `dotfiles-generate --out`.
# Nothing in the working tree is touched — earlier versions of this script
# deleted the live claude/settings.json, which is the file a running Claude
# Code process reads and rewrites.

cd "$(dirname "$0")"

pass=0
fail=0

tmproot=$(mktemp -d)
trap 'rm -rf "$tmproot"' EXIT

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
  out="$tmproot/$env"
  mkdir -p "$out"
  DOTFILES_ENV=$env bin/dotfiles-generate --reset --out "$out" >/dev/null

  settings="$out/claude/settings.json"
  claude_instructions="$out/claude/CLAUDE.md"

  # --- claude/settings.json ---
  if ! jq empty "$settings" 2>/dev/null; then
    check "valid JSON" "jq parse error"
    continue
  fi
  check "valid JSON" "ok"

  work_perms=$(jq '[.permissions.allow[] | select(test("pay|toolshed|sourcegraph"))] | length' "$settings")
  stripe_plugins=$(jq '[.enabledPlugins // {} | keys[] | select(test("stripe"))] | length' "$settings")
  obsidian=$(jq '.enabledPlugins["obsidian@obsidian-skills"] // false' "$settings")
  hooks_intact=$(jq '[.hooks | keys[]] | length' "$settings")

  # Base hooks must survive the overlay merge in every environment.
  check "base hooks preserved" "$([ "$hooks_intact" -eq 3 ] && echo ok || echo "got $hooks_intact")"
  check "Claude instructions constrain Markdown tables" \
    "$(grep -Fq 'Use Markdown tables only for compact data' "$claude_instructions" && echo ok || echo missing)"

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
        check "Brewfile has stripe tap" "$(grep -q stripe-internal "$out/Brewfile" && echo ok || echo missing)"
        check "Brewfile has no ACP providers" "$(grep -q acp "$out/Brewfile" && echo "found acp" || echo ok)"
        ;;
      devbox)
        check "no Brewfile on devbox" "$([ ! -f "$out/Brewfile" ] && echo ok || echo "Brewfile exists")"
        ;;
      home)
        check "Brewfile has no stripe tap" "$(grep -q stripe-internal "$out/Brewfile" && echo "found stripe tap" || echo ok)"
        check "Brewfile has no ACP providers" "$(grep -q acp "$out/Brewfile" && echo "found acp" || echo ok)"
        ;;
    esac
  fi

  # --- codex ---
  case "$env" in
    work|devbox)
      check "AGENTS.md generated" "$([ -f "$out/codex/AGENTS.md" ] && echo ok || echo missing)"
      check "config.toml generated" "$([ -f "$out/codex/config.toml" ] && echo ok || echo missing)"
      check "js-infra-internal Codex plugin enabled" \
        "$(python3 -c 'import sys, tomllib; print("ok" if tomllib.load(open(sys.argv[1], "rb")).get("plugins", {}).get("js-infra-internal@stripe-internal-marketplace", {}).get("enabled") is True else "missing")' "$out/codex/config.toml")"
      check "Codex instructions constrain Markdown tables" \
        "$(grep -Fq 'Use Markdown tables only for compact data' "$out/codex/AGENTS.md" && echo ok || echo missing)"
      ;;
    home)
      check "no AGENTS.md on home" "$([ ! -f "$out/codex/AGENTS.md" ] && echo ok || echo exists)"
      check "no config.toml on home" "$([ ! -f "$out/codex/config.toml" ] && echo ok || echo exists)"
      ;;
  esac
done

# --- Invalid environment is rejected ---

echo "=== validation ==="
if DOTFILES_ENV=bogus bin/dotfiles-generate --out "$tmproot/bogus" >/dev/null 2>&1; then
  check "invalid DOTFILES_ENV rejected" "exited 0"
else
  check "invalid DOTFILES_ENV rejected" "ok"
fi

# --- Link helper ---
#
# The dangerous case: dest's parent is a symlink into the repo (as ~/.claude
# is on some machines), so src and dest are the same file. A regression here
# destroys real config files on the next bootstrap.

echo "=== dotfiles-link ==="
linkdir="$tmproot/link"
mkdir -p "$linkdir/repo" "$linkdir/home"
echo "content" > "$linkdir/repo/file"
ln -s "$linkdir/repo" "$linkdir/home/dotdir"

bin/dotfiles-link "$linkdir/repo/file" "$linkdir/home/dotdir/file"
check "self-link skipped, content preserved" \
  "$([ ! -L "$linkdir/repo/file" ] && [ "$(cat "$linkdir/repo/file")" = "content" ] && echo ok || echo destroyed)"

bin/dotfiles-link "$linkdir/repo/file" "$linkdir/home/file2"
check "distinct dest gets working symlink" \
  "$([ -L "$linkdir/home/file2" ] && [ "$(cat "$linkdir/home/file2")" = "content" ] && echo ok || echo broken)"

bin/dotfiles-link "$linkdir/repo/missing" "$linkdir/home/file3" 2>/dev/null
check "missing source creates nothing" \
  "$([ ! -e "$linkdir/home/file3" ] && [ ! -L "$linkdir/home/file3" ] && echo ok || echo "created dangling link")"

echo "replaced" > "$linkdir/repo/other"
bin/dotfiles-link "$linkdir/repo/other" "$linkdir/home/file2"
check "existing symlink retargeted" \
  "$([ "$(cat "$linkdir/home/file2")" = "replaced" ] && echo ok || echo stale)"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]