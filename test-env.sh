#!/usr/bin/env bash
set -euo pipefail

# Smoke test: generate configs for all environments and validate key properties.
#
# Generation is directed at a temp directory via `dotfiles-generate --out`.
# Nothing in the working tree is touched — earlier versions of this script
# deleted the live claude/settings.json, which is the file a running Claude
# Code process reads and rewrites.

cd "$(dirname "$0")"
repo_root=$PWD

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
  DOTFILES_ENV=$env home/bin/dotfiles-generate --reset --out "$out" >/dev/null

  settings="$out/.claude/settings.json"
  claude_instructions="$out/.claude/CLAUDE.md"
  codex_instructions="$out/.codex/AGENTS.md"
  codex_config="$out/.codex/config.toml"

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
      check "AGENTS.md generated" "$([ -f "$codex_instructions" ] && echo ok || echo missing)"
      check "config.toml generated" "$([ -f "$codex_config" ] && echo ok || echo missing)"
      check "js-infra-internal Codex plugin enabled" \
        "$(python3 -c 'import re, sys; text=open(sys.argv[1]).read(); match=re.search(r"\[plugins\.\"js-infra-internal@stripe-internal-marketplace\"\]\n(.*?)(?=\n\[|\Z)", text, re.S); print("ok" if match and re.search(r"^enabled = true$", match.group(1), re.M) else "missing")' "$codex_config")"
      check "Codex instructions constrain Markdown tables" \
        "$(grep -Fq 'Use Markdown tables only for compact data' "$codex_instructions" && echo ok || echo missing)"
      check "Codex config has no provisioning usernames" \
        "$(grep -Eq '/Users/moon|/home/moon|/home/owner' codex/config.base.toml "$codex_config" && echo found || echo ok)"
      check "toolshed shims have laptop and devbox paths" \
        "$(python3 -c 'import re, sys; text=open(sys.argv[1]).read(); blocks=re.findall(r"^\[mcp_servers\.[^]]+\]\n(.*?)(?=\n\[|\Z)", text, re.M | re.S); entries=[block for block in blocks if "toolshed_stdio_shim.sh" in block]; print("ok" if len(entries) == 2 and all(re.search(r"^command = \"sh\"$", block, re.M) and "args = [\"-lc\"" in block and "$HOME/stripe/mint/gocode/.cursor/toolshed_stdio_shim.sh" in block and "/pay/src/gocode/.cursor/toolshed_stdio_shim.sh" in block for block in entries) else f"got {len(entries)} non-portable entries")' "$codex_config")"
      ;;
    home)
      check "no AGENTS.md on home" "$([ ! -f "$codex_instructions" ] && echo ok || echo exists)"
      check "no config.toml on home" "$([ ! -f "$codex_config" ] && echo ok || echo exists)"
      ;;
  esac
done

source_root="$tmproot/source"
mkdir -p "$source_root"
cp -R shared claude codex "$source_root/"
cp claude-overlay.md codex-overlay.md Brewfile.base Brewfile.work "$source_root/"
out="$tmproot/regeneration"
DOTFILES_DIR="$source_root" DOTFILES_ENV=work "$repo_root/home/bin/dotfiles-generate" --reset --out "$out" >/dev/null
jq '.runtime_mutation = true' "$out/.claude/settings.json" > "$out/.claude/settings.next"
mv "$out/.claude/settings.next" "$out/.claude/settings.json"
printf '\n# runtime mutation\n' >> "$out/.codex/config.toml"
settings_before=$(shasum -a 256 "$out/.claude/settings.json" | awk '{print $1}')
config_before=$(shasum -a 256 "$out/.codex/config.toml" | awk '{print $1}')
claude_before=$(shasum -a 256 "$out/.claude/CLAUDE.md" | awk '{print $1}')
codex_before=$(shasum -a 256 "$out/.codex/AGENTS.md" | awk '{print $1}')
printf '\nCLAUDE_STATIC_SOURCE_CHANGE\n' >> "$source_root/claude-overlay.md"
printf '\nCODEX_STATIC_SOURCE_CHANGE\n' >> "$source_root/codex-overlay.md"
DOTFILES_DIR="$source_root" DOTFILES_ENV=work "$repo_root/home/bin/dotfiles-generate" --out "$out" >/dev/null
settings_after=$(shasum -a 256 "$out/.claude/settings.json" | awk '{print $1}')
config_after=$(shasum -a 256 "$out/.codex/config.toml" | awk '{print $1}')
claude_after=$(shasum -a 256 "$out/.claude/CLAUDE.md" | awk '{print $1}')
codex_after=$(shasum -a 256 "$out/.codex/AGENTS.md" | awk '{print $1}')
check "Claude mutable output survives regeneration" "$([ "$settings_before" = "$settings_after" ] && echo ok || echo changed)"
check "Codex mutable output survives regeneration" "$([ "$config_before" = "$config_after" ] && echo ok || echo changed)"
check "Claude static output follows source changes" "$([ "$claude_before" != "$claude_after" ] && echo ok || echo unchanged)"
check "Codex static output follows source changes" "$([ "$codex_before" != "$codex_after" ] && echo ok || echo unchanged)"

out="$tmproot/home-transition"
DOTFILES_ENV=work home/bin/dotfiles-generate --reset --out "$out" >/dev/null
printf 'runtime\n' > "$out/.codex/session.json"
DOTFILES_ENV=home home/bin/dotfiles-generate --out "$out" >/dev/null
check "home removes generated Codex instructions" "$([ ! -e "$out/.codex/AGENTS.md" ] && echo ok || echo exists)"
check "home removes generated Codex config" "$([ ! -e "$out/.codex/config.toml" ] && echo ok || echo exists)"
check "home preserves unrelated Codex runtime files" "$(grep -Fxq runtime "$out/.codex/session.json" && echo ok || echo missing)"

# --- Invalid environment is rejected ---

echo "=== validation ==="
if DOTFILES_ENV=bogus home/bin/dotfiles-generate --out "$tmproot/bogus" >/dev/null 2>&1; then
  check "invalid DOTFILES_ENV rejected" "exited 0"
else
  check "invalid DOTFILES_ENV rejected" "ok"
fi

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]

python3 test-home-reconcile.py
python3 test-bootstrap.py
