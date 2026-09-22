#!/usr/bin/env bash
set -euo pipefail

DOTFILES="$(cd "$(dirname "$0")" && pwd)"
PLENARY="$HOME/.local/share/nvim/lazy/plenary.nvim"
MINIMAL_INIT="$DOTFILES/neovim/tests/minimal_init.lua"
target="${1:-$DOTFILES/neovim/tests/}"

export DOTFILES_TEST_ROOT="$DOTFILES"

nvim --headless -i NONE \
  --cmd "set rtp^=$DOTFILES/neovim" \
  --cmd "set rtp+=$PLENARY" \
  -u "$DOTFILES/init.lua" \
  -c "PlenaryBustedDirectory $target {minimal_init = '$MINIMAL_INIT'}"
