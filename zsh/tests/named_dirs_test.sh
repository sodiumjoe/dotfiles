#!/usr/bin/env zsh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
source "$repo_root/zsh/named_dirs.zsh"

pass=0
fail=0
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/named-dirs-test.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

assert_eq() {
  local desc="$1"
  local expected="$2"
  local actual="$3"

  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $desc"
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail=$((fail + 1))
  fi
}

assert_undefined() {
  local desc="$1"
  local name="$2"
  local output

  if output="$(eval "print -r -- ~$name" 2>/dev/null)"; then
    echo "  FAIL: $desc"
    echo "    expected: undefined named directory"
    echo "    actual:   $output"
    fail=$((fail + 1))
  else
    echo "  PASS: $desc"
    pass=$((pass + 1))
  fi
}

clear_named_dirs() {
  unhash -d pay 2>/dev/null || true
  unhash -d dashboard 2>/dev/null || true
}

echo "=== Test: prefers devbox root ==="
devbox_home="$tmpdir/home-devbox"
devbox_root="$tmpdir/devbox/pay-server"
mkdir -p "$devbox_root/manage/frontend"
mkdir -p "$devbox_home/stripe/mint/pay-server/manage/frontend"
export HOME="$devbox_home"
clear_named_dirs
_sodium_define_stripe_named_dirs "$devbox_root" "$HOME/stripe/mint/pay-server"
assert_eq "pay prefers devbox root" "$devbox_root" "$(print -r -- ~pay)"
assert_eq "dashboard derives from devbox root" "$devbox_root/manage/frontend" "$(print -r -- ~dashboard)"

echo "=== Test: falls back to local root ==="
fallback_home="$tmpdir/home-fallback"
mkdir -p "$fallback_home/stripe/mint/pay-server/manage/frontend"
export HOME="$fallback_home"
clear_named_dirs
_sodium_define_stripe_named_dirs "$tmpdir/missing/pay-server" "$HOME/stripe/mint/pay-server"
assert_eq "pay falls back to local root" "$HOME/stripe/mint/pay-server" "$(print -r -- ~pay)"
assert_eq "dashboard falls back to local root" "$HOME/stripe/mint/pay-server/manage/frontend" "$(print -r -- ~dashboard)"

echo "=== Test: skips undefined directories ==="
empty_home="$tmpdir/home-empty"
mkdir -p "$empty_home"
export HOME="$empty_home"
clear_named_dirs
_sodium_define_stripe_named_dirs "$tmpdir/missing/pay-server" "$HOME/stripe/mint/pay-server"
assert_undefined "pay stays undefined without matching roots" "pay"
assert_undefined "dashboard stays undefined without matching roots" "dashboard"

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
