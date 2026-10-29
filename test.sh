#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

node_version=$(node -p 'process.versions.node' 2>/dev/null || true)
if [[ "$node_version" != 24.13.0 ]]; then
  node_bin="${NODENV_ROOT:-$HOME/.nodenv}/versions/24.13.0/bin"
  [[ -x "$node_bin/node" ]] || { echo "Node 24.13.0 is required; install 24.13.0 with nodenv." >&2; exit 1; }
  export PATH="$node_bin:$PATH"
fi
for dependency in node npm python3 jq tmux nvim zsh git; do
  command -v "$dependency" >/dev/null || { echo "Missing dependency: $dependency" >&2; exit 1; }
done
[[ -x agency/node_modules/.bin/tsc ]] || { echo "Run npm ci --prefix agency first." >&2; exit 1; }
[[ -f node-bin/node_modules/@agentclientprotocol/codex-acp/dist/index.js ]] || { echo "Run npm ci --prefix node-bin first." >&2; exit 1; }

logs=$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-tests.XXXXXX")
SECONDS=0
run() {
  local label="$1"
  shift
  if "$@" >"$logs/$label.log" 2>&1; then
    printf '%s passed\n' "$label"
  else
    cat "$logs/$label.log" >&2
    printf 'Test logs: %s\n' "$logs" >&2
    return 1
  fi
}

run deployment bash test-env.sh
run work-cli npm --prefix work-cli test
run agency-build npm --prefix agency run build
run agency bash -c 'cd agency && node dist/scripts/test-groups.js'
run node-bin npm --prefix node-bin test
run shell python3 tests/zsh/test_agency_enrollment.py
run neovim bash test-nvim.sh
run tmux python3 tests/tmux/test_hop_integration.py
printf 'All workflow tests passed in %ss. Logs: %s\n' "$SECONDS" "$logs"