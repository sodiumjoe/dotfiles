#!/usr/bin/env bash
set -euo pipefail

DOTFILES="$(cd "$(dirname "$0")" && pwd)"
user_home="$HOME"
nvim_data_home="${XDG_DATA_HOME:-$user_home/.local/share}"
PLENARY="$nvim_data_home/nvim/lazy/plenary.nvim"
MINIMAL_INIT="$DOTFILES/tests/neovim/minimal_init.lua"
target="${1:-$DOTFILES/tests/neovim/}"
test_runtime_root="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-nvim.XXXXXX")"
test_state_home="$test_runtime_root/state"
test_cache_home="$test_runtime_root/cache"
mkdir -p "$test_state_home" "$test_cache_home"
trap 'rm -rf "$test_runtime_root"' EXIT

export DOTFILES_TEST_ROOT="$DOTFILES"

env \
  HOME="$DOTFILES/home" \
  XDG_DATA_HOME="$nvim_data_home" \
  XDG_STATE_HOME="$test_state_home" \
  XDG_CACHE_HOME="$test_cache_home" \
  DOTFILES_TEST_STATE_HOME="$test_state_home" \
  GIT_AUTHOR_NAME="Test User" \
  GIT_AUTHOR_EMAIL="test@example.com" \
  GIT_COMMITTER_NAME="Test User" \
  GIT_COMMITTER_EMAIL="test@example.com" \
  nvim --headless -i NONE \
  --cmd "set rtp^=$DOTFILES/home/.config/nvim" \
  --cmd "set rtp+=$PLENARY" \
  -u "$DOTFILES/home/.config/nvim/init.lua" \
  -c "PlenaryBustedDirectory $target {minimal_init = '$MINIMAL_INIT'}"
