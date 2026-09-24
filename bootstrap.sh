#!/usr/bin/env bash
set -euo pipefail

# Everything below is repo-root-relative. Safe to resolve via $0 because
# bootstrap.sh, unlike home/bin/*, is never invoked through a symlink.
cd "$(dirname "$0")"

# --- Environment detection ---
#
# Precedence: --env flag, then ~/.dotfiles-env, then interactive prompt.
#
# The ambient $DOTFILES_ENV is deliberately NOT consulted: zshenv exports it
# unconditionally (defaulting to home), so trusting it would make the prompt
# unreachable and would silently re-commit a stale value whenever ~/.dotfiles-env
# is deleted in order to re-select. Non-interactive callers pass --env.

selected_env=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "bootstrap.sh: --env requires a value" >&2; exit 2; }
      selected_env="$2"; shift 2
      ;;
    --env=*)
      selected_env="${1#--env=}"
      [ -n "$selected_env" ] || { echo "bootstrap.sh: --env requires a value" >&2; exit 2; }
      shift
      ;;
    *) echo "bootstrap.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [ -n "$selected_env" ]; then
  DOTFILES_ENV="$selected_env"
elif [ -f ~/.dotfiles-env ]; then
  . ~/.dotfiles-env
else
  if [ ! -t 0 ]; then
    echo "bootstrap.sh: no ~/.dotfiles-env and stdin is not a tty — pass --env=<work|devbox|home>" >&2
    if [ -n "${DOTFILES_ENV:-}" ]; then
      echo "bootstrap.sh: note: ambient DOTFILES_ENV='$DOTFILES_ENV' is deliberately ignored; use --env=$DOTFILES_ENV" >&2
    fi
    exit 2
  fi
  printf "No ~/.dotfiles-env found. Select environment:\n"
  printf "  1) work\n"
  printf "  2) devbox\n"
  printf "  3) home\n"
  printf "Choice: "
  read choice
  case "$choice" in
    1) DOTFILES_ENV=work ;;
    2) DOTFILES_ENV=devbox ;;
    3) DOTFILES_ENV=home ;;
    *) echo "Invalid choice" >&2; exit 1 ;;
  esac
fi

case "$DOTFILES_ENV" in
  work|devbox|home) ;;
  *) echo "bootstrap.sh: invalid environment '$DOTFILES_ENV' (expected work, devbox, or home)" >&2; exit 1 ;;
esac

echo "DOTFILES_ENV=$DOTFILES_ENV" > ~/.dotfiles-env
echo "Using DOTFILES_ENV=$DOTFILES_ENV (wrote ~/.dotfiles-env)"

export DOTFILES_ENV

# --- Generate configs ---

home/bin/dotfiles-generate
home/bin/dotfiles-reconcile

# --- Git hooks ---

if [ -d .git ]; then
  mkdir -p .git/hooks
  ln -sf ../../hooks/post-merge .git/hooks/post-merge
fi

# --- Pinned npm tool binaries (ACP providers, language servers, formatters) ---
#
# Last on purpose: this is the only step that needs the network, and a registry
# failure shouldn't abort the symlink and git-hook setup above.

if command -v npm &>/dev/null; then
  echo "Installing node-bin packages..."
  if [ -f node-bin/package-lock.json ]; then
    npm ci --prefix node-bin || echo "bootstrap.sh: npm ci failed — run 'npm ci --prefix node-bin' when the network is back" >&2
  else
    npm install --prefix node-bin || echo "bootstrap.sh: npm install failed — run 'npm install --prefix node-bin' when the network is back" >&2
  fi
  npm run sync-bins --prefix node-bin || echo "bootstrap.sh: node-bin bin sync failed — run 'npm run sync-bins --prefix node-bin' after npm install succeeds" >&2
else
  echo "npm not found, skipping node-bin (ACP providers will be unavailable)" >&2
fi
