#!/usr/bin/env bash
set -euo pipefail

DOTFILES="$HOME/.dotfiles"
PLENARY="$HOME/.local/share/nvim/lazy/plenary.nvim"
MINIMAL_INIT="$DOTFILES/neovim/tests/minimal_init.lua"
target="${1:-$DOTFILES/neovim/tests/}"

nvim --headless \
  --cmd "set rtp+=$PLENARY" \
  -u "$DOTFILES/init.lua" \
  -c "PlenaryBustedDirectory $target {minimal_init = '$MINIMAL_INIT'}"