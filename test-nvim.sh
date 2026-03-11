#!/usr/bin/env bash
set -euo pipefail

DOTFILES="$HOME/.dotfiles"
PLENARY="$HOME/.local/share/nvim/lazy/plenary.nvim"
target="${1:-$DOTFILES/neovim/tests/}"

nvim --headless \
  --cmd "set rtp+=$PLENARY" \
  -u "$DOTFILES/init.lua" \
  -c "PlenaryBustedDirectory $target {minimal_init = '$DOTFILES/init.lua'}"