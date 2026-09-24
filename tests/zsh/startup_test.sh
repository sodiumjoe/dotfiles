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
  ln -s "$repo_root/home/.zshenv" "$home/.zshenv"

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
  local env_name="$1"
  local term="$2"
  local command="${3:-exit}"
  local home="$tmpdir/home-$env_name-$term"
  local bin="$home/bin"
  local output_file="$tmpdir/output-$env_name-$term"
  local error_file="$tmpdir/error-$env_name-$term"

  rm -rf "$home"
  mkdir -p "$home/.config/zsh/.zim" "$home/.stripe/shellinit" "$home/.dotfiles/node-bin/bin" "$home/.dotfiles/node-bin/node_modules/.bin" "$home/.fzf/bin" "$home/.nodenv/shims" "$bin"
  ln -s "$repo_root/home/.zshenv" "$home/.zshenv"
  for config in .zimrc .zshrc home.zsh named_dirs.zsh tmux-pending.zsh work.zsh work_sync.zsh; do
    ln -s "$repo_root/home/.config/zsh/$config" "$home/.config/zsh/$config"
  done
  printf ':\n' >"$home/.config/zsh/.zim/init.zsh"
  printf ':\n' >"$home/.config/zsh/.zim/zimfw.zsh"
  printf 'DOTFILES_ENV=%s\n' "$env_name" >"$home/.dotfiles-env"

  cat >"$bin/nodenv" <<'EOF'
#!/bin/sh
if [ "$1" = "init" ]; then
  printf '%s\n' 'export PATH="$HOME/.nodenv/shims:${PATH}"'
fi
EOF
  chmod +x "$bin/nodenv"
  touch "$home/.dotfiles/node-bin/bin/codex-acp" "$home/.dotfiles/node-bin/node_modules/.bin/codex" "$home/.nodenv/shims/codex"
  chmod +x "$home/.dotfiles/node-bin/bin/codex-acp" "$home/.dotfiles/node-bin/node_modules/.bin/codex" "$home/.nodenv/shims/codex"

  : >"$home/fzf-invocations"
  cat >"$home/.fzf/bin/fzf" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$HOME/fzf-invocations"
if [ "$1" = "--zsh" ]; then
  printf '%s\n' 'export STARTUP_FZF_INITIALIZED=1'
fi
EOF
  chmod +x "$home/.fzf/bin/fzf"
  cat >"$home/.fzf.zsh" <<'EOF'
print sourced >"$HOME/fzf-zsh-sourced"
EOF

  cat >"$home/.stripe/shellinit/zshrc" <<'EOF'
_fake_completion_fn() { :; }
complete -F _fake_completion_fn fake
if [ -z "${__STRIPE_SHELLINIT_ZSH_SKIP_NODENV}" ]; then
  if command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init -)"
  fi
fi
EOF

  set +e
  HOME="$home" PATH="$bin:$home/.dotfiles/node-bin/node_modules/.bin:$home/node-bin/node_modules/.bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" TERM="$term" TTY=/dev/null zsh -ic "$command" >"$output_file" 2>"$error_file"
  capture_status=$?
  set -e
  capture_output="$(cat "$output_file")"
  capture_error="$(cat "$error_file")"
}

run_login_startup() {
  local fixture="$1"
  local command="${2:-exit}"
  local home="$tmpdir/login-$fixture"
  local bin="$home/bin"
  local output_file="$tmpdir/login-output-$fixture"
  local error_file="$tmpdir/login-error-$fixture"

  rm -rf "$home"
  mkdir -p "$home/.config/zsh/.zim" "$bin"
  ln -s "$repo_root/home/.zshenv" "$home/.zshenv"
  ln -s "$repo_root/home/.config/zsh/.zlogin" "$home/.config/zsh/.zlogin"

  if [[ "$fixture" == "present" ]]; then
    cat >"$home/.config/zsh/.zim/login_init.zsh" <<'EOF'
print initialized >"$HOME/login-init-ran"
EOF
  fi

  set +e
  HOME="$home" PATH="$bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" TERM=dumb TTY=/dev/null zsh -lc "$command" >"$output_file" 2>"$error_file"
  capture_status=$?
  set -e
  capture_output="$(cat "$output_file")"
  capture_error="$(cat "$error_file")"
}

run_empty_tty_source() {
  local home="$tmpdir/home-work-xterm"
  local bin="$home/bin"
  local output_file="$tmpdir/empty-tty-output"
  local error_file="$tmpdir/empty-tty-error"

  run_startup work xterm
  set +e
  HOME="$home" PATH="$bin:$home/.dotfiles/node-bin/node_modules/.bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" TERM=xterm TTY= zsh -c 'source "$HOME/.config/zsh/.zshrc"' >"$output_file" 2>"$error_file"
  capture_status=$?
  set -e
  capture_output="$(cat "$output_file")"
  capture_error="$(cat "$error_file")"
}

echo "=== Test: noninteractive zshrc source tolerates empty TTY ==="
run_empty_tty_source
assert_eq "empty TTY source exits zero" "0" "$capture_status"
assert_not_contains "empty TTY source avoids redirection error" "no such file or directory" "$capture_error"

echo "=== Test: TERM=dumb startup tolerates later bash completion hooks ==="
run_startup work dumb
assert_eq "TERM=dumb startup exits zero" "0" "$capture_status"
assert_not_contains "TERM=dumb startup avoids compdef error" "command not found: compdef" "$capture_error"

echo ""
echo "=== Test: fzf initialization follows the runtime home ==="
run_startup work xterm '[[ ":$PATH:" == *":$HOME/.fzf/bin:"* ]] && print present'
assert_eq "startup prepends .fzf/bin to PATH" "present" "$capture_output"
run_startup work xterm 'cat "$HOME/fzf-invocations"'
assert_eq "startup invokes fzf --zsh exactly once" "--zsh" "$capture_output"
run_startup work xterm '[[ ! -e "$HOME/fzf-zsh-sourced" ]] && print not-sourced'
assert_eq "startup does not source legacy ~/.fzf.zsh" "not-sourced" "$capture_output"

for env_name in work devbox home; do
  echo ""
  echo "=== Test: $env_name startup resolves codex from /usr/local/bin ==="
  run_startup "$env_name" xterm 'command -v codex'
  assert_eq "$env_name startup resolves codex from /usr/local/bin" "/usr/local/bin/codex" "$capture_output"

  echo ""
  echo "=== Test: $env_name startup exposes direct node-bin binaries ==="
  run_startup "$env_name" xterm 'command -v codex-acp'
  assert_eq "$env_name startup resolves codex-acp from node-bin/bin" "$tmpdir/home-$env_name-xterm/.dotfiles/node-bin/bin/codex-acp" "$capture_output"

  echo ""
  echo "=== Test: $env_name startup excludes node_modules bin directory ==="
  run_startup "$env_name" xterm 'print -r -- ":$PATH:"'
  assert_not_contains "$env_name startup excludes node_modules/.bin" "node_modules/.bin" "$capture_output"
done

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
echo "=== Test: login shell tolerates absent Zim runtime ==="
run_login_startup missing 'print login-ok'
assert_eq "login shell exits zero without Zim runtime" "0" "$capture_status"
assert_eq "login shell runs command without Zim runtime" "login-ok" "$capture_output"
assert_not_contains "login shell avoids missing Zim runtime warning" "login_init.zsh" "$capture_error"

echo ""
echo "=== Test: login shell initializes Zim runtime when present ==="
run_login_startup present 'for _ in {1..100}; do [[ -f "$HOME/login-init-ran" ]] && break; sleep 0.01; done; cat "$HOME/login-init-ran"'
assert_eq "login shell initializes present Zim runtime" "initialized" "$capture_output"
assert_eq "login shell with Zim runtime exits zero" "0" "$capture_status"

echo ""
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
