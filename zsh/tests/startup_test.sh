#!/usr/bin/env zsh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

pass=0
fail=0
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/startup-test.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

capture_status=0
capture_output=""
capture_error=""

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

assert_not_contains() {
  local desc="$1"
  local needle="$2"
  local haystack="$3"

  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  FAIL: $desc"
    echo "    unexpected: $needle"
    echo "    actual:     $haystack"
    fail=$((fail + 1))
  else
    echo "  PASS: $desc"
    pass=$((pass + 1))
  fi
}

run_zshenv() {
  local os_name="$1"
  local script="$2"
  local home="$tmpdir/home-$os_name"
  local bin="$home/bin"
  local output_file="$tmpdir/output-$os_name"
  local error_file="$tmpdir/error-$os_name"

  mkdir -p "$home/.config" "$home/.stripe/shellinit" "$bin"
  ln -s "$repo_root/zshenv" "$home/.zshenv"

  cat >"$bin/uname" <<EOF
#!/bin/sh
if [ "\$1" = "-s" ]; then
  printf '%s\n' "$os_name"
else
  /usr/bin/uname "\$@"
fi
EOF
  chmod +x "$bin/uname"

  set +e
  HOME="$home" PATH="$bin:$PATH" zsh <<EOF >"$output_file" 2>"$error_file"
$script
EOF
  capture_status=$?
  set -e
  capture_output="$(cat "$output_file")"
  capture_error="$(cat "$error_file")"
}

run_startup() {
  local term="$1"
  local home="$tmpdir/home-$term"
  local output_file="$tmpdir/output-$term"
  local error_file="$tmpdir/error-$term"

  mkdir -p "$home/.config" "$home/.stripe/shellinit"
  ln -s "$repo_root/zshenv" "$home/.zshenv"
  ln -s "$repo_root/zsh" "$home/.config/zsh"

  cat >"$home/.stripe/shellinit/zshrc" <<'EOF'
_fake_completion_fn() { :; }
complete -F _fake_completion_fn fake
EOF

  set +e
  HOME="$home" TERM="$term" TTY=/dev/null zsh -ic exit >"$output_file" 2>"$error_file"
  capture_status=$?
  set -e
  capture_output="$(cat "$output_file")"
  capture_error="$(cat "$error_file")"
}

echo "=== Test: TERM=dumb startup tolerates later bash completion hooks ==="
run_startup dumb
assert_eq "TERM=dumb startup exits zero" "0" "$capture_status"
assert_not_contains "TERM=dumb startup avoids compdef error" "command not found: compdef" "$capture_error"

echo ""
echo "=== Test: Linux zshenv preserves global compinit for bash completion wrappers ==="
run_zshenv Linux '
print -r -- "skip:${skip_global_compinit:-}"
if [[ -z "${skip_global_compinit:-}" ]]; then
  autoload -Uz compinit
  compinit -C -d "${ZDOTDIR:-${HOME}}/.zcompdump-test"
fi
autoload -Uz bashcompinit
bashcompinit
_fake_completion_fn() { :; }
complete -F _fake_completion_fn fake
complete -p fake >/dev/null 2>&1
'
assert_eq "Linux zshenv leaves global compinit enabled" "skip:" "$capture_output"
assert_eq "Linux completion registration exits zero" "0" "$capture_status"
assert_not_contains "Linux completion registration avoids compdef error" "command not found: compdef" "$capture_error"

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
