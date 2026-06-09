#!/usr/bin/env zsh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
source "$repo_root/zsh/work_sync.zsh"

pass=0
fail=0
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/work-sync-test.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

capture_status=0
capture_output=""

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

assert_contains() {
  local desc="$1"
  local needle="$2"
  local haystack="$3"

  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  PASS: $desc"
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    echo "    missing:  $needle"
    echo "    actual:   $haystack"
    fail=$((fail + 1))
  fi
}

run_capture() {
  local output_file="$tmpdir/output"
  set +e
  "$@" >"$output_file" 2>&1
  capture_status=$?
  set -e
  capture_output="$(cat "$output_file")"
}

ssh() {
  local host="$1"
  shift
  case "$host" in
    remote-dirty)
      print -r -- "remote-junk"
      ;;
    remote-clean|remote-missing)
      return 0
      ;;
    *)
      print -u2 -- "unexpected host: $host"
      return 1
      ;;
  esac
}

echo "=== Test: invalid top-level project directories ==="
local_home="$tmpdir/home-local"
export HOME="$local_home"
mkdir -p "$HOME/stripe/work/projects/valid"
mkdir -p "$HOME/stripe/work/projects/junk"
mkdir -p "$HOME/stripe/work/projects/-pay-src-pay-server"
print -r -- "# Valid" > "$HOME/stripe/work/projects/valid/project.md"
print -r -- "# Legacy" > "$HOME/stripe/work/projects/legacy.md"
assert_eq \
  "lists only invalid top-level directories" \
  $'-pay-src-pay-server\njunk' \
  "$(_work_invalid_project_dirs "$HOME/stripe/work/projects")"

echo "=== Test: local invalid directories block sync ==="
run_capture _devbox_sync_preflight remote-clean
assert_eq "local invalid directories return non-zero" "1" "$capture_status"
assert_contains "local invalid message mentions directory" "junk" "$capture_output"
assert_contains "local invalid message mentions block reason" "local invalid project directories" "$capture_output"

echo "=== Test: remote invalid directories block sync ==="
rm -rf "$HOME/stripe/work/projects/junk" "$HOME/stripe/work/projects/-pay-src-pay-server"
run_capture _devbox_sync_preflight remote-dirty
assert_eq "remote invalid directories return non-zero" "1" "$capture_status"
assert_contains "remote invalid message mentions directory" "remote-junk" "$capture_output"
assert_contains "remote invalid message mentions host" "remote-dirty" "$capture_output"

echo "=== Test: clean local and remote inventories allow sync ==="
run_capture _devbox_sync_preflight remote-missing
assert_eq "clean preflight exits zero" "0" "$capture_status"
assert_eq "clean preflight is quiet" "" "$capture_output"

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
